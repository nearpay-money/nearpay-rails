/**
 * Create an execution (lld/rails.md §8.1) and the payer-side inputs (deposit tx, signals).
 *
 * `route_quote`: kill switch → idempotency → tokens → route class + fee → settlement price →
 * screening → deadline → amount tag → provider quote → integrity → one transaction (execution,
 * observation, transition, outbox). Any failure after the tag is allocated releases it.
 * `intents_transfer`: no provider; the payer signs two Verifier transfers carrying a binding memo
 * that the indexer attributes (§8.6).
 */
import { createHash } from "node:crypto";
import { NearAccountId, type RouteBody } from "@nearpay/spec";
import { destinationKey, getChain, validateAddress } from "@nearpay-internal/chains";
import { sql } from "@nearpay-internal/db";
import { toUuid, uuidv7 } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import type { createExecution as createExecutionRoute, Execution, OneClickQuoteRequest } from "@nearpay-internal/spec";
import {
  baseAfterBearer,
  binding as bindingOf,
  executionDeadline,
  intentsFee,
  tagCandidates,
  tagSpace,
} from "../domain/execution/amounts.js";
import { checkQuote } from "../domain/execution/integrity.js";
import { nextPollAt } from "../domain/execution/schedule.js";
import {
  type Pricing,
  PricingError,
  type PricingPolicy,
  settle,
  unitsForUsdMicros,
  unitValue,
  usdMicros,
} from "../domain/pricing/pricing.js";
import { routeClass as classify, type RouteClass } from "../domain/token-registry/registry.js";
import type { Rails } from "./context.js";
import { applyChange, emitExecution, lockExecution } from "./ledger.js";
import { observationValues } from "./observations.js";
import { policyFor } from "./pricing.js";
import { tokenOf } from "./tokens.js";
import { type ExecutionRow, executionView, pricedToken, type TokenRowDb } from "./views.js";

export type CreateBody = RouteBody<typeof createExecutionRoute>;

const NEAR = "near:mainnet";
const isUniqueViolation = (e: unknown, constraint?: string) =>
  (e as { code?: string }).code === "23505" &&
  (constraint === undefined || (e as { constraint?: string }).constraint === constraint);

export async function flag(r: Rails, name: string): Promise<boolean> {
  const row = await r.db.selectFrom("control_flags").select("value").where("name", "=", name).executeTakeFirst();
  return row?.value ?? true;
}

/** Maps a domain pricing failure to its API error (§6 errors of `createExecution`). */
export function pricingApiError(r: Rails, e: PricingError, amountParam: string): ApiError {
  if (e.code === "amount_too_small") return ApiError.invalid(e.message, amountParam);
  if (e.code === "currency_unsupported")
    return new ApiError("currency_unsupported", { params: { currency: e.subject }, param: "pricing.currency" });
  if (e.code === "fx_rate_unavailable") {
    r.log.warn({ currency: e.subject }, "ALERT fx_stale: FX rate unavailable");
    return new ApiError("fx_rate_unavailable", { params: { currency: e.subject } });
  }
  r.metrics.pricingUnavailable(e.subject);
  return new ApiError("pricing_unavailable", { params: { asset_id: e.subject } });
}

export async function byKey(r: Rails, key: string): Promise<ExecutionRow | undefined> {
  return r.db.selectFrom("executions").selectAll().where("idempotency_key", "=", key).executeTakeFirst();
}

export function replay(row: ExecutionRow, accountId: string, livemode: boolean): Execution {
  if (row.account_id !== accountId || row.livemode !== livemode)
    throw new ApiError("idempotency_key_reused", { param: "idempotency_key" });
  return executionView(row);
}

export function unsupported(assetId: string, param: string): ApiError {
  return new ApiError("asset_unsupported", { params: { asset_id: assetId }, param });
}

export function railUnavailable(reason: string): ApiError {
  return new ApiError("rail_unavailable", { params: { reason } });
}

function normalizedDestination(b: CreateBody): string {
  const { type, chain, address } = b.destination;
  if (type === "intents_account") {
    if (chain !== NEAR) throw ApiError.invalid("Intents accounts use chain near:mainnet", "destination.chain");
    const a = address.toLowerCase();
    if (!NearAccountId.safeParse(a).success) throw ApiError.invalid("not a NEAR account id", "destination.address");
    return a;
  }
  const v = validateAddress(chain, address);
  if (!v.ok) throw ApiError.invalid(`destination address: ${v.reason}`, "destination.address");
  return v.normalized;
}

function checkRefund(b: CreateBody): void {
  const { refund_type, refund_to, chain } = b.origin;
  if (refund_type === "intents") {
    if (!NearAccountId.safeParse(refund_to).success)
      throw ApiError.invalid("refund_to must be a NEAR Intents account", "origin.refund_to");
    return;
  }
  const v = validateAddress(chain, refund_to);
  if (!v.ok) throw ApiError.invalid(`refund address: ${v.reason}`, "origin.refund_to");
}

function pricingOf(b: CreateBody): Pricing {
  const p = b.pricing as { currency: string; amount: number | string; asset_id?: string };
  if (p.currency === "asset") return { currency: "asset", assetId: p.asset_id as string, amount: BigInt(p.amount) };
  return { currency: p.currency, amount: BigInt(p.amount) };
}

/** `Execution.reference` (spec 0.2.0): the payments object served, echoed from the create request. */
function referenceOf(b: CreateBody): string | null {
  if (!b.reference) return null;
  return JSON.stringify({
    payment_intent: b.reference.payment_intent,
    payment_attempt: b.reference.payment_attempt,
    refund: null,
    refund_leg: null,
  });
}

/** Scenario selector for the sandbox: the payment's pricing amount (sandbox LLD §4). */
function scenarioAmount(b: CreateBody): string {
  return String((b.pricing as { amount: number | string }).amount);
}

/**
 * Reserves an amount tag (§8.3): random draws, then the smallest free tag; `base + tag` must be
 * unique among in-flight executions to the destination. 0 = untagged.
 */
export async function allocateTag(
  r: Rails,
  executionId: string,
  key: string,
  base: bigint,
  space: number,
): Promise<bigint> {
  if (space <= 0) return 0n;
  const reserve = async (t: bigint): Promise<boolean> => {
    try {
      await r.db
        .insertInto("amount_tags")
        .values({ destination_key: key, tag: t.toString(), expected: (base + t).toString(), execution_id: executionId })
        .execute();
      return true;
    } catch (e) {
      if (isUniqueViolation(e)) return false;
      throw e;
    }
  };
  for (const t of tagCandidates(space, r.random)) if (await reserve(BigInt(t))) return BigInt(t);
  for (let attempt = 0; attempt < 3; attempt++) {
    const taken = await r.db
      .selectFrom("amount_tags")
      .select("expected")
      .where("destination_key", "=", key)
      .where("released_at", "is", null)
      .where(
        sql<boolean>`expected between ${(base + 1n).toString()}::numeric and ${(base + BigInt(space)).toString()}::numeric`,
      )
      .execute();
    const used = new Set(taken.map((x) => BigInt(x.expected) - base));
    let free = 0n;
    for (let t = 1n; t <= BigInt(space); t++) {
      if (!used.has(t)) {
        free = t;
        break;
      }
    }
    if (free === 0n) break;
    if (await reserve(free)) return free;
  }
  r.metrics.tagsExhausted();
  return 0n;
}

export async function releaseTag(r: Rails, executionId: string): Promise<void> {
  await r.db
    .updateTable("amount_tags")
    .set({ released_at: new Date(r.now()) })
    .where("execution_id", "=", executionId)
    .where("released_at", "is", null)
    .execute();
}

interface Prepared {
  id: string;
  accountId: string;
  o: TokenRowDb;
  d: TokenRowDb;
  addressNorm: string;
  key: string;
  route: RouteClass;
  bps: number;
  base: bigint;
  snapshot: Record<string, unknown>;
  deadline: Date;
  originChain: string;
  amountUsdMicros: bigint | null;
  policy: PricingPolicy;
}

async function prepare(r: Rails, b: CreateBody, accountId: string): Promise<Prepared> {
  const lm = b.livemode;
  const [o, d] = await Promise.all([tokenOf(r, lm, b.origin.asset_id), tokenOf(r, lm, b.destination.asset_id)]);
  if (!o?.enabled) throw unsupported(b.origin.asset_id, "origin.asset_id");
  if (!d?.enabled) throw unsupported(b.destination.asset_id, "destination.asset_id");

  // chains: the origin deposit chain is the origin token's chain unless the payer pays from Intents
  const originChain = b.origin.refund_type === "intents" ? NEAR : o.chain;
  if (b.origin.chain !== originChain)
    throw ApiError.invalid(`origin.chain must be ${originChain} for ${o.asset_id}`, "origin.chain");
  if (b.destination.type === "chain_address" && b.destination.chain !== d.chain)
    throw ApiError.invalid(`destination.chain must be ${d.chain} for ${d.asset_id}`, "destination.chain");
  checkRefund(b);
  const addressNorm = normalizedDestination(b);
  const originProfile = r.profiles.get(originChain);
  const destProfile = r.profiles.get(b.destination.chain);
  if (!originProfile) throw unsupported(o.asset_id, "origin.asset_id");
  if (!destProfile) throw unsupported(d.asset_id, "destination.asset_id");
  if (destProfile.memoMode === "required") throw unsupported(d.asset_id, "destination.asset_id");

  let route: RouteClass;
  if (b.method === "intents_transfer") {
    if (b.destination.type !== "intents_account" || o.asset_id !== d.asset_id || b.origin.refund_type !== "intents")
      throw new ApiError("route_unavailable", {
        params: { origin_asset_id: o.asset_id, destination_asset_id: d.asset_id },
        message: "An Intents transfer pays the destination's own asset from the payer's Intents account.",
      });
    route = "intents_transfer";
  } else {
    route = classify(o, d);
  }
  const rule = b.fee.schedule.rules[route];
  const bps = b.kind === "payment" ? rule.total_bps : 0;
  if (bps > 500) throw ApiError.invalid("fee above 500 bps (1Click appFees cap)", "fee.schedule");

  const p = await policyFor(r, lm);
  const pricing = pricingOf(b);
  const pricingAsset =
    pricing.currency === "asset" ? await tokenOf(r, lm, (pricing as { assetId: string }).assetId) : undefined;
  let base: bigint;
  let snapshot: Record<string, unknown>;
  try {
    const s = settle(pricing, pricedToken(d), p, (id) =>
      pricingAsset?.enabled && pricingAsset.asset_id === id ? pricedToken(pricingAsset) : undefined,
    );
    base = baseAfterBearer(s.amount, bps, b.fee.bearer);
    snapshot = s.snapshot as unknown as Record<string, unknown>;
  } catch (e) {
    if (e instanceof PricingError) throw pricingApiError(r, e, "pricing.amount");
    throw e;
  }
  if (base <= 0n) throw ApiError.invalid("the amount does not cover the fee", "pricing.amount");

  const dl = executionDeadline(r.now(), b.deadline_cap ? new Date(b.deadline_cap) : null, originProfile);
  if (!dl.ok) throw new ApiError("deadline_too_short", { params: { chain: originChain } });

  return {
    id: uuidv7(),
    accountId,
    o,
    d,
    addressNorm,
    key: destinationKey(b.destination.chain, addressNorm, d.asset_id),
    route,
    bps,
    base,
    snapshot,
    deadline: dl.deadline,
    originChain,
    amountUsdMicros: usdMicros(base, pricedToken(d), p),
    policy: p,
  };
}

async function screen(r: Rails, b: CreateBody, x: Prepared): Promise<void> {
  const out = await r.screening.screen({
    subjectType: b.origin.refund_type === "intents" ? "near_account" : "address",
    chain: x.originChain,
    subject: b.origin.refund_to,
    accountId: b.account_id,
    livemode: b.livemode,
    amountUsdMicros: x.amountUsdMicros,
  });
  if (out.kind === "block") throw new ApiError("screening_blocked", { param: "origin.refund_to" });
  if (out.kind === "unavailable") {
    if (x.amountUsdMicros === null || x.amountUsdMicros >= r.screeningFailClosedUsdMicros)
      throw new ApiError("screening_unavailable");
    r.log.warn(
      { detail: out.detail },
      "screening unavailable below the fail-closed threshold; compliance post-screens",
    );
  }
}

export async function createExecution(r: Rails, b: CreateBody): Promise<Execution> {
  const accountId = toUuid(b.account_id, "acct");
  const existing = await byKey(r, b.idempotency_key);
  if (existing) {
    if (existing.kind !== "payment") throw new ApiError("idempotency_key_reused", { param: "idempotency_key" });
    return replay(existing, accountId, b.livemode);
  }

  if (b.livemode) {
    if (!(await flag(r, "quoting_enabled"))) throw railUnavailable("kill switch engaged");
    if (!r.treasury) throw railUnavailable("live mode is not configured");
  }
  if (b.method === "route_quote") {
    if (!(await flag(r, "cross_chain_enabled"))) throw railUnavailable("cross-chain routes paused");
    if (!(b.livemode ? r.providers.live : r.providers.test)) throw railUnavailable("route provider not configured");
  }

  const x = await prepare(r, b, accountId);
  await screen(r, b, x);
  return b.method === "intents_transfer" ? createIntentsTransfer(r, b, x) : createRouteQuote(r, b, x);
}

async function createRouteQuote(r: Rails, b: CreateBody, x: Prepared): Promise<Execution> {
  const lm = b.livemode;
  const provider = (lm ? r.providers.live : r.providers.test) as NonNullable<Rails["providers"]["live"]>;
  const space = tagSpace(unitValue(pricedToken(x.d), x.policy).usd, x.d.decimals);
  const tag = await allocateTag(r, x.id, x.key, x.base, space);
  const feeRecipient = lm ? (r.treasury as string) : r.testTreasury;
  const route = x.route as Exclude<RouteClass, "intents_transfer">;
  const originProfile = r.profiles.get(x.originChain);
  if (!originProfile) throw unsupported(x.o.asset_id, "origin.asset_id");
  const intentsDeposit = b.origin.refund_type === "intents";
  const req: OneClickQuoteRequest = {
    dry: false,
    depositMode: originProfile.memoMode === "required" ? "MEMO" : "SIMPLE",
    swapType: "EXACT_OUTPUT",
    slippageTolerance: b.slippage_bps ?? r.slippageBps[route],
    originAsset: x.o.asset_id,
    depositType: intentsDeposit ? "INTENTS" : "ORIGIN_CHAIN",
    destinationAsset: x.d.asset_id,
    amount: (x.base + tag).toString(),
    refundTo: b.origin.refund_to,
    refundType: intentsDeposit ? "INTENTS" : "ORIGIN_CHAIN",
    recipient: b.destination.address,
    recipientType: b.destination.type === "intents_account" ? "INTENTS" : "DESTINATION_CHAIN",
    deadline: x.deadline.toISOString(),
    referral: r.referral,
    quoteWaitingTimeMs: 3_000,
    appFees: x.bps > 0 ? [{ recipient: feeRecipient, fee: x.bps }] : [],
  };
  try {
    const started = r.now();
    const out = await provider.quote(
      lm,
      req,
      lm
        ? undefined
        : {
            amount: scenarioAmount(b),
            kind: "payment",
            ...(b.reference ? { group: b.reference.payment_intent } : {}),
          },
    );
    const seconds = (r.now() - started) / 1000;
    if (!out.ok) {
      r.metrics.quote(provider.name, out.kind, seconds);
      if (out.kind === "rejected") throw new ApiError("quote_rejected", { params: { provider_message: out.message } });
      if (out.kind === "malformed") {
        r.metrics.integrityFailure(provider.name);
        r.log.error(
          { detail: out.detail, provider: provider.name },
          "ALERT quote integrity: malformed provider response",
        );
        throw new ApiError("quote_integrity_failed");
      }
      throw railUnavailable("route provider");
    }
    const res = out.response;
    const integrity = checkQuote({
      sent: req,
      response: res,
      treasury: feeRecipient,
      feeBps: x.bps,
      split: r.providerSplit,
      stableRoute: route !== "volatile",
      nowMs: r.now(),
      minDeadlineS: originProfile.minDeadlineS,
      validDeposit: (a) => (intentsDeposit ? NearAccountId.safeParse(a).success : validateAddress(x.originChain, a).ok),
    });
    const failures = integrity.ok ? [] : [...integrity.failures];
    if (!provider.verifySignature(res)) failures.push("provider signature does not verify");
    if (failures.length) {
      r.metrics.quote(provider.name, "integrity_failed", seconds);
      r.metrics.integrityFailure(provider.name);
      r.log.error(
        { failures, provider: provider.name, correlation: res.correlationId },
        "ALERT quote integrity failed",
      );
      throw new ApiError("quote_integrity_failed");
    }
    r.metrics.quote(provider.name, "ok", seconds);
    return await insertRouteQuote(r, b, x, { tag, req, res, raw: out.raw, provider: provider.name, feeRecipient });
  } catch (e) {
    await releaseTag(r, x.id).catch((err) => r.log.error({ err }, "tag release failed (orphan sweep will release it)"));
    throw e;
  }
}

async function insertRouteQuote(
  r: Rails,
  b: CreateBody,
  x: Prepared,
  q: {
    tag: bigint;
    req: OneClickQuoteRequest;
    res: import("@nearpay-internal/spec").OneClickQuoteResponse;
    raw: unknown;
    provider: "oneclick" | "sandbox";
    feeRecipient: string;
  },
): Promise<Execution> {
  const now = new Date(r.now());
  const deposit = q.res.quote;
  try {
    return await r.db.transaction().execute(async (tx) => {
      const values = {
        id: x.id,
        account_id: x.accountId,
        livemode: b.livemode,
        kind: b.kind,
        method: "route_quote" as const,
        provider: q.provider,
        idempotency_key: b.idempotency_key,
        state: "awaiting_deposit" as const,
        provider_status: "PENDING_DEPOSIT",
        provider_updated_at: null,
        origin_asset_id: x.o.asset_id,
        origin_chain: b.origin.chain,
        refund_to: b.origin.refund_to,
        refund_type: b.origin.refund_type,
        destination_asset_id: x.d.asset_id,
        recipient: b.destination.address,
        recipient_type:
          b.destination.type === "intents_account" ? ("intents" as const) : ("destination_chain" as const),
        destination_chain: b.destination.chain,
        destination_key: x.key,
        route_class: x.route,
        applied_fee_bps: x.bps,
        fee_recipient: x.bps > 0 ? q.feeRecipient : null,
        fee_amount: null,
        amount_out_base: x.base.toString(),
        amount_tag: q.tag.toString(),
        amount_out_expected: (x.base + q.tag).toString(),
        price_snapshot: JSON.stringify(x.snapshot),
        quote_request: JSON.stringify(q.req),
        quote_response: JSON.stringify(q.raw),
        correlation_id: q.res.correlationId,
        deposit_address: deposit.depositAddress ?? null,
        deposit_memo: deposit.depositMemo ?? null,
        amount_in: deposit.amountIn,
        min_amount_in: deposit.minAmountIn,
        binding: null,
        deadline: x.deadline,
        time_when_inactive: deposit.timeWhenInactive ? new Date(deposit.timeWhenInactive) : null,
        next_poll_at: new Date(
          nextPollAt({
            state: "awaiting_deposit",
            hasSignal: false,
            pollCount: 0,
            createdAtMs: now.getTime(),
            deadlineMs: x.deadline.getTime(),
            nowMs: now.getTime(),
            explorerEnabled: r.explorerEnabled,
            awaitingSweepS: r.awaitingSweepS,
          }) ?? now.getTime(),
        ),
        version: 1,
        created_at: now,
        updated_at: now,
        reference: referenceOf(b),
      };
      const row = await tx.insertInto("executions").values(values).returningAll().executeTakeFirstOrThrow();
      const obs = observationValues(x.id, "quote", "PENDING_DEPOSIT", q.raw, null, true);
      await tx.insertInto("provider_observations").values(obs).execute();
      await tx
        .insertInto("execution_transitions")
        .values({
          id: uuidv7(),
          execution_id: x.id,
          from_state: null,
          to_state: "awaiting_deposit",
          cause: "quote issued",
          actor: "api",
          observation_id: obs.id,
          evidence: null,
        })
        .execute();
      await emitExecution(tx, row, "evt.rails.execution.updated");
      r.metrics.transition("awaiting_deposit");
      return executionView(row);
    });
  } catch (e) {
    if (isUniqueViolation(e, "executions_idempotency_key_key")) {
      const winner = await byKey(r, b.idempotency_key);
      if (winner) {
        await releaseTag(r, x.id);
        return replay(winner, x.accountId, b.livemode);
      }
    }
    if (isUniqueViolation(e, "ex_deposit")) {
      r.metrics.integrityFailure(q.provider);
      r.log.error({ deposit: deposit.depositAddress }, "ALERT quote integrity: deposit address already issued");
      throw new ApiError("quote_integrity_failed");
    }
    throw e;
  }
}

async function createIntentsTransfer(r: Rails, b: CreateBody, x: Prepared): Promise<Execution> {
  const p = x.policy;
  const rule = b.fee.schedule.rules.intents_transfer;
  const minFee =
    rule.min_fee_usd_micros > 0 ? unitsForUsdMicros(BigInt(rule.min_fee_usd_micros), pricedToken(x.d), p) : 0n;
  if (minFee === null) throw new ApiError("pricing_unavailable", { params: { asset_id: x.d.asset_id } });
  const feeTo = b.livemode ? (r.treasury as string) : r.testTreasury;
  const feeAmount = intentsFee(x.base, x.bps, minFee);
  const bind = bindingOf({
    executionId: x.id,
    payTo: x.addressNorm,
    token: x.d.asset_id,
    amount: x.base,
    feeTo,
    feeAmount,
    deadline: x.deadline,
  });
  const now = new Date(r.now());
  try {
    return await r.db.transaction().execute(async (tx) => {
      const row = await tx
        .insertInto("executions")
        .values({
          id: x.id,
          account_id: x.accountId,
          livemode: b.livemode,
          kind: b.kind,
          method: "intents_transfer",
          provider: "direct_intents",
          idempotency_key: b.idempotency_key,
          state: "awaiting_deposit",
          provider_status: null,
          origin_asset_id: x.o.asset_id,
          origin_chain: NEAR,
          refund_to: b.origin.refund_to,
          refund_type: "intents",
          destination_asset_id: x.d.asset_id,
          recipient: x.addressNorm,
          recipient_type: "intents",
          destination_chain: NEAR,
          destination_key: x.key,
          route_class: "intents_transfer",
          applied_fee_bps: x.bps,
          fee_recipient: feeTo,
          fee_amount: feeAmount.toString(),
          amount_out_base: x.base.toString(),
          amount_tag: "0",
          amount_out_expected: x.base.toString(),
          price_snapshot: JSON.stringify(x.snapshot),
          binding: bind,
          deadline: x.deadline,
          // no provider to poll: one check after the deadline expires it (§5 "Expiry")
          next_poll_at: new Date(x.deadline.getTime() + 10 * 60_000),
          reference: referenceOf(b),
          version: 1,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await tx
        .insertInto("execution_transitions")
        .values({
          id: uuidv7(),
          execution_id: x.id,
          from_state: null,
          to_state: "awaiting_deposit",
          cause: "intents requirement issued",
          actor: "api",
          observation_id: null,
          evidence: JSON.stringify({ binding: bind }),
        })
        .execute();
      await emitExecution(tx, row, "evt.rails.execution.updated");
      r.metrics.transition("awaiting_deposit");
      return executionView(row);
    });
  } catch (e) {
    if (isUniqueViolation(e, "executions_idempotency_key_key")) {
      const winner = await byKey(r, b.idempotency_key);
      if (winner) return replay(winner, x.accountId, b.livemode);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// Payer inputs
// ---------------------------------------------------------------------------------------------

const OPEN_FOR_DEPOSIT = new Set(["awaiting_deposit", "deposit_detected", "incomplete_deposit"]);

export async function getExecutionRow(r: Rails, exId: string): Promise<ExecutionRow> {
  const row = await r.db.selectFrom("executions").selectAll().where("id", "=", toUuid(exId, "ex")).executeTakeFirst();
  if (!row) throw ApiError.missing("execution", exId, "id");
  return row;
}

/** §6 `POST /internal/executions/{id}/deposit_tx`: record, raise priority, forward to the provider. */
export async function submitDepositTx(r: Rails, exId: string, b: { tx_hash: string; sender?: string | undefined }) {
  const row = await getExecutionRow(r, exId);
  const updated = await r.db.transaction().execute(async (tx) => {
    const cur = await lockExecution(tx, row.id);
    if (!cur) throw ApiError.missing("execution", exId, "id");
    if (cur.deposit_tx_hashes.includes(b.tx_hash)) return cur;
    if (!OPEN_FOR_DEPOSIT.has(cur.state))
      throw new ApiError("state_conflict", { params: { object: "execution", state: cur.state } });
    return applyChange(
      r,
      tx,
      cur,
      {
        depositTxHashes: [...cur.deposit_tx_hashes, b.tx_hash].slice(-20),
        ...(cur.state === "awaiting_deposit" ? { state: "deposit_detected" as const } : {}),
        hasSignal: true,
        priority: 1,
        nextPollAt: new Date(r.now()),
        pollCount: 0,
      },
      { cause: "deposit tx submitted", actor: "api" },
    );
  });
  // best effort: the provider learns of the tx sooner (§10 `/v0/deposit/submit`)
  const provider = updated.livemode ? r.providers.live : r.providers.test;
  if (updated.provider !== "direct_intents" && provider && updated.deposit_address) {
    const sender = b.sender;
    void provider
      .submitDeposit(updated.livemode, {
        txHash: b.tx_hash,
        depositAddress: updated.deposit_address,
        memo: updated.deposit_memo,
        ...(sender ? { sender } : {}),
      })
      .then((out) => r.metrics.statusCall("submit", out.ok ? "ok" : out.kind))
      .catch((e) => r.log.warn({ err: e }, "deposit submit failed"));
  }
}

/** §6 `POST /internal/executions/{id}/signals`: the payer says it sent — poll now and fast. */
export async function signalExecution(r: Rails, exId: string): Promise<void> {
  const row = await getExecutionRow(r, exId);
  await r.db.transaction().execute(async (tx) => {
    const cur = await lockExecution(tx, row.id);
    if (!cur || cur.terminal_at || cur.provider === "direct_intents") return;
    if (cur.has_signal && cur.priority <= 2) return;
    await applyChange(
      r,
      tx,
      cur,
      { hasSignal: true, priority: Math.min(cur.priority, 2), nextPollAt: new Date(r.now()), pollCount: 0 },
      { cause: "payer signal", actor: "api" },
    );
  });
}

/** sha256 of a payload, for observations (`payload_sha256`). */
export function payloadHash(payload: unknown): Buffer {
  return createHash("sha256").update(JSON.stringify(payload)).digest();
}

/** Whether `addr` is valid on `chain` (deposit addresses). */
export function chainKnown(chain: string): boolean {
  return getChain(chain) !== undefined;
}
