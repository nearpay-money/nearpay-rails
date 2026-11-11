/**
 * Refund legs (lld/rails.md §6 `POST /internal/refund_executions`, §8.1 with `kind: refund`; payments §8.4, §17).
 *
 * A refund leg moves value from the merchant destination (`source`) back to the payer (`recipient`, INV-7):
 * - `route_quote`: a 1Click route without app fee or tag. `EXACT_INPUT` quotes `amount` in (the payer absorbs route
 *   costs; the verification floor is the quote's `minAmountOut`); `EXACT_OUTPUT` quotes the value of `amount` out in
 *   the recipient asset, converted by §8.2 pricing (the merchant absorbs). Both are bounded against §8.2 pricing
 *   (`checkRefundBounds`: payer floor within slippage, price band, merchant cost cap); pricing unavailable refuses. `refundTo` is the merchant destination.
 *   An Intents-account source deposits with `depositType INTENTS`: the merchant signs one Verifier transfer to the
 *   deposit address carrying a binding memo (`refund.transfer`, relayed by agentpay).
 * - `intents_transfer`: one Verifier transfer merchant → payer Intents account, same asset, bound by `np1:` memo
 *   (provider `direct_intents`; the indexer attributes it by binding).
 * Evidence before success holds as for payments (INV-2): the payer-side transfer is verified (verifier on the
 * provider's destination tx, or the indexer's binding match); a provider status alone never settles a leg.
 * The kill switch blocks new live legs (§8.1 step 0); legs already funded keep being tracked (INV-3).
 */

import { destinationKey, validateAddress } from "@nearpay-internal/chains";
import { toUuid, uuidv7 } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import type {
  createRefundExecution as createRefundExecutionRoute,
  Execution,
  OneClickQuoteRequest,
  OneClickQuoteResponse,
} from "@nearpay-internal/spec";
import { NearAccountId, type RouteBody } from "@nearpay-money/spec";
import { binding as bindingOf, executionDeadline } from "../domain/execution/amounts.js";
import { checkQuote, checkRefundBounds, REFUND_PRICE_BAND_BPS } from "../domain/execution/integrity.js";
import { nextPollAt } from "../domain/execution/schedule.js";
import { PricingError, settle, usdMicros } from "../domain/pricing/pricing.js";
import { routeClass as classify, type RouteClass } from "../domain/token-registry/registry.js";
import type { RefundRow } from "../infra/db/schema.js";
import { tierAtCreate } from "./chain-tier.js";
import type { Rails } from "./context.js";
import { byKey, flag, pricingApiError, railUnavailable, replay, unsupported } from "./executions.js";
import { readKillSwitch } from "./kill-switch.js";
import { emitExecution } from "./ledger.js";
import { observationValues } from "./observations.js";
import { policyFor, pricedToken } from "./pricing.js";
import { tokenContractOf } from "./queries.js";
import { tokenOf } from "./tokens.js";
import { executionView, type TokenRowDb } from "./views.js";

export type RefundBody = RouteBody<typeof createRefundExecutionRoute>;

const NEAR = "near:mainnet";
const isUniqueViolation = (e: unknown, constraint?: string) =>
  (e as { code?: string }).code === "23505" &&
  (constraint === undefined || (e as { constraint?: string }).constraint === constraint);

interface Leg {
  id: string;
  accountId: string;
  s: TokenRowDb;
  d: TokenRowDb;
  sourceAddress: string;
  sourceChain: string;
  sourceIntents: boolean;
  recipientNorm: string;
  recipientIntents: boolean;
  route: RouteClass;
  deadline: Date;
  amount: bigint;
  /** EXACT_OUTPUT: the converted amount the payer must receive (recipient base units). */
  convertedOut: bigint | null;
  /**
   * Route legs: `settle(amount)` in recipient base units (§8.2) — the value the quote is bounded against (audit
   * finding 4). EXACT_OUTPUT: equal to `convertedOut`. Null for `intents_transfer`.
   */
  pricedOut: bigint | null;
  snapshot: Record<string, unknown> | null;
  amountUsdMicros: bigint | null;
}

function nearAccount(v: string, param: string): string {
  const a = v.toLowerCase();
  if (!NearAccountId.safeParse(a).success) throw ApiError.invalid("not a NEAR account id", param);
  return a;
}

async function prepareLeg(r: Rails, b: RefundBody, accountId: string): Promise<Leg> {
  const lm = b.livemode;
  const [s, d] = await Promise.all([tokenOf(r, lm, b.source.asset_id), tokenOf(r, lm, b.recipient.asset_id)]);
  if (!s?.enabled) throw unsupported(b.source.asset_id, "source.asset_id");
  if (!d?.enabled) throw unsupported(b.recipient.asset_id, "recipient.asset_id");
  const amount = BigInt(b.amount);
  if (amount <= 0n) throw ApiError.invalid("amount must be positive", "amount");

  // merchant side
  const sourceIntents = b.source.type === "intents_account";
  let sourceAddress: string;
  let sourceChain: string;
  if (sourceIntents) {
    if (b.source.chain !== NEAR) throw ApiError.invalid("Intents accounts use chain near:mainnet", "source.chain");
    sourceAddress = nearAccount(b.source.address, "source.address");
    sourceChain = NEAR;
  } else {
    if (b.source.chain !== s.chain)
      throw ApiError.invalid(`source.chain must be ${s.chain} for ${s.asset_id}`, "source.chain");
    const v = validateAddress(s.chain, b.source.address);
    if (!v.ok) throw ApiError.invalid(`source address: ${v.reason}`, "source.address");
    sourceAddress = b.source.address;
    sourceChain = s.chain;
  }
  // payer side (INV-7: payments sends the attempt's recorded refund address)
  const recipientIntents = b.recipient.type === "intents";
  let recipientNorm: string;
  if (recipientIntents) {
    if (b.recipient.chain !== NEAR)
      throw ApiError.invalid("Intents accounts use chain near:mainnet", "recipient.chain");
    recipientNorm = nearAccount(b.recipient.address, "recipient.address");
  } else {
    if (b.recipient.chain !== d.chain)
      throw ApiError.invalid(`recipient.chain must be ${d.chain} for ${d.asset_id}`, "recipient.chain");
    const v = validateAddress(d.chain, b.recipient.address);
    if (!v.ok) throw ApiError.invalid(`recipient address: ${v.reason}`, "recipient.address");
    recipientNorm = v.normalized;
  }
  const sourceProfile = r.profiles.get(sourceChain);
  const destProfile = r.profiles.get(b.recipient.chain);
  if (!sourceProfile) throw unsupported(s.asset_id, "source.asset_id");
  if (!destProfile || destProfile.memoMode === "required") throw unsupported(d.asset_id, "recipient.asset_id");

  let route: RouteClass;
  if (b.method === "intents_transfer") {
    if (!sourceIntents || !recipientIntents || s.asset_id !== d.asset_id)
      throw new ApiError("route_unavailable", {
        params: { origin_asset_id: s.asset_id, destination_asset_id: d.asset_id },
        message: "An Intents refund transfers the settlement asset from the merchant's to the payer's Intents account.",
      });
    route = "intents_transfer";
  } else {
    route = classify(s, d);
  }

  const p = await policyFor(r, lm);
  let convertedOut: bigint | null = null;
  let pricedOut: bigint | null = null;
  let snapshot: Record<string, unknown> | null = null;
  // Every route leg is priced, EXACT_INPUT too: its quote is bounded against this value (audit finding 4), so
  // pricing unavailable refuses the leg (fail closed) before any quote is asked.
  if (b.method === "route_quote") {
    try {
      const st = settle({ currency: "asset", assetId: s.asset_id, amount }, pricedToken(d), p, (id) =>
        id === s.asset_id ? pricedToken(s) : undefined,
      );
      pricedOut = st.amount;
      if (b.swap_type === "EXACT_OUTPUT") {
        convertedOut = st.amount;
        snapshot = st.snapshot as unknown as Record<string, unknown>;
      }
    } catch (e) {
      if (e instanceof PricingError) throw pricingApiError(r, e, "amount");
      throw e;
    }
  }
  const dl = executionDeadline(r.now(), null, sourceProfile);
  if (!dl.ok) throw new ApiError("deadline_too_short", { params: { chain: sourceChain } });
  return {
    id: uuidv7(),
    accountId,
    s,
    d,
    sourceAddress,
    sourceChain,
    sourceIntents,
    recipientNorm,
    recipientIntents,
    route,
    deadline: dl.deadline,
    amount,
    convertedOut,
    pricedOut,
    snapshot,
    amountUsdMicros: usdMicros(amount, pricedToken(s), p),
  };
}

/** Screens the payer recipient (context `refund`). An owner override (`screen: true`) fails closed. */
async function screenRecipient(r: Rails, b: RefundBody, x: Leg): Promise<void> {
  const out = await r.screening.screen({
    subjectType: x.recipientIntents ? "near_account" : "address",
    chain: b.recipient.chain,
    subject: b.recipient.address,
    accountId: b.account_id,
    livemode: b.livemode,
    amountUsdMicros: x.amountUsdMicros,
    context: "refund",
    // spec 0.2.1 (CR-22-RL-01): an owner-overridden recipient is screened now, never from the cache
    ...(b.screen ? { fresh: true } : {}),
  });
  if (out.kind === "block") throw new ApiError("screening_blocked", { param: "recipient.address" });
  if (out.kind === "unavailable") {
    if (b.screen || x.amountUsdMicros === null || x.amountUsdMicros >= r.screeningFailClosedUsdMicros)
      throw new ApiError("screening_unavailable");
    r.log.warn({ detail: out.detail }, "refund screening unavailable below the fail-closed threshold");
  }
}

export async function createRefundExecution(r: Rails, b: RefundBody): Promise<Execution> {
  const accountId = toUuid(b.account_id, "acct");
  const existing = await byKey(r, b.idempotency_key);
  if (existing) {
    if (existing.kind !== "refund") throw new ApiError("idempotency_key_reused", { param: "idempotency_key" });
    return replay(existing, accountId, b.livemode);
  }
  if (b.livemode) {
    // the kill switch blocks new live refund legs too (lead decision, payments §17 item 16)
    // spec 0.2.1: an unknown kill-switch state (never read, no event) refuses live quoting too (fail closed)
    const ks = await readKillSwitch(r);
    if (ks !== "released")
      throw railUnavailable(ks === "engaged" ? "kill switch engaged" : "kill switch state unknown");
    if (!r.treasury) throw railUnavailable("live mode is not configured");
  }
  if (b.method === "route_quote") {
    if (!(await flag(r, "cross_chain_enabled"))) throw railUnavailable("cross-chain routes paused");
    if (!(b.livemode ? r.providers.live : r.providers.test)) throw railUnavailable("route provider not configured");
  }
  const x = await prepareLeg(r, b, accountId);
  await screenRecipient(r, b, x);
  return b.method === "intents_transfer" ? createIntentsLeg(r, b, x) : createRouteLeg(r, b, x);
}

/**
 * The Verifier nonce of an Intents-source leg (spec 0.2.1 `RefundTransfer.nonce`), issued before the transaction
 * (no I/O under locks). A live salt that cannot be read gives null: payments then derives the nonce itself.
 */
async function issueNonce(r: Rails, livemode: boolean): Promise<string | null> {
  try {
    return await r.nonces.fresh(livemode);
  } catch (e) {
    r.log.warn(
      { err: e instanceof Error ? e.message : String(e) },
      "Verifier salt unreadable: refund leg without nonce",
    );
    return null;
  }
}

function referenceJson(b: RefundBody): string {
  return JSON.stringify({
    payment_intent: b.reference.payment_intent,
    payment_attempt: b.reference.payment_attempt,
    refund: b.reference.refund,
    refund_leg: b.reference.refund_leg,
  });
}

function baseValues(b: RefundBody, x: Leg, now: Date) {
  return {
    id: x.id,
    account_id: x.accountId,
    livemode: b.livemode,
    kind: "refund" as const,
    idempotency_key: b.idempotency_key,
    state: "awaiting_deposit" as const,
    origin_asset_id: x.s.asset_id,
    origin_chain: x.sourceChain,
    refund_to: x.sourceAddress,
    refund_type: x.sourceIntents ? ("intents" as const) : ("origin_chain" as const),
    destination_asset_id: x.d.asset_id,
    recipient: x.recipientIntents ? x.recipientNorm : b.recipient.address,
    recipient_type: x.recipientIntents ? ("intents" as const) : ("destination_chain" as const),
    destination_chain: b.recipient.chain,
    destination_key: destinationKey(b.recipient.chain, x.recipientNorm, x.d.asset_id),
    route_class: x.route,
    origin_decimals: x.s.decimals,
    destination_decimals: x.d.decimals,
    applied_fee_bps: 0,
    fee_recipient: null,
    amount_tag: "0",
    reference: referenceJson(b),
    deadline: x.deadline,
    version: 1,
    created_at: now,
    updated_at: now,
  };
}

async function createRouteLeg(r: Rails, b: RefundBody, x: Leg): Promise<Execution> {
  const lm = b.livemode;
  const provider = (lm ? r.providers.live : r.providers.test) as NonNullable<Rails["providers"]["live"]>;
  const sourceProfile = r.profiles.get(x.sourceChain);
  if (!sourceProfile) throw unsupported(x.s.asset_id, "source.asset_id");
  const route = x.route as Exclude<RouteClass, "intents_transfer">;
  const exactOut = b.swap_type === "EXACT_OUTPUT";
  const quoteAmount = exactOut ? (x.convertedOut as bigint) : x.amount;
  const req: OneClickQuoteRequest = {
    dry: false,
    depositMode: sourceProfile.memoMode === "required" ? "MEMO" : "SIMPLE",
    swapType: b.swap_type,
    slippageTolerance: r.slippageBps[route],
    originAsset: x.s.asset_id,
    depositType: x.sourceIntents ? "INTENTS" : "ORIGIN_CHAIN",
    destinationAsset: x.d.asset_id,
    amount: quoteAmount.toString(),
    refundTo: x.sourceAddress,
    refundType: x.sourceIntents ? "INTENTS" : "ORIGIN_CHAIN",
    recipient: x.recipientIntents ? x.recipientNorm : b.recipient.address,
    recipientType: x.recipientIntents ? "INTENTS" : "DESTINATION_CHAIN",
    deadline: x.deadline.toISOString(),
    referral: r.referral,
    quoteWaitingTimeMs: 3_000,
    appFees: [],
  };
  const started = r.now();
  const out = await provider.quote(
    lm,
    req,
    lm ? undefined : { amount: x.amount.toString(), group: b.reference.refund, kind: "refund" },
  );
  const seconds = (r.now() - started) / 1000;
  if (!out.ok) {
    r.metrics.quote(provider.name, out.kind, seconds);
    if (out.kind === "rejected") throw new ApiError("quote_rejected", { params: { provider_message: out.message } });
    if (out.kind === "malformed") {
      r.metrics.integrityFailure(provider.name);
      r.log.error({ detail: out.detail, provider: provider.name }, "ALERT quote integrity: malformed refund quote");
      throw new ApiError("quote_integrity_failed");
    }
    throw railUnavailable("route provider");
  }
  const res = out.response;
  const integrity = checkQuote({
    sent: req,
    response: res,
    treasury: null,
    feeBps: 0,
    split: r.providerSplit,
    stableRoute: route !== "volatile",
    nowMs: r.now(),
    minDeadlineS: sourceProfile.minDeadlineS,
    validDeposit: (a) => (x.sourceIntents ? NearAccountId.safeParse(a).success : validateAddress(x.sourceChain, a).ok),
  });
  const failures = integrity.ok ? [] : [...integrity.failures];
  // refund bounds (audit finding 4): what the payer receives / the merchant pays, against §8.2 pricing
  failures.push(
    ...checkRefundBounds({
      swapType: b.swap_type,
      amount: x.amount,
      pricedOut: x.pricedOut as bigint,
      slippageBps: req.slippageTolerance,
      bandBps: REFUND_PRICE_BAND_BPS,
      quote: res.quote,
    }),
  );
  if (!provider.verifySignature(res)) failures.push("provider signature does not verify");
  if (failures.length) {
    r.metrics.quote(provider.name, "integrity_failed", seconds);
    r.metrics.integrityFailure(provider.name);
    r.log.error(
      { failures, provider: provider.name, correlation: res.correlationId },
      "ALERT quote integrity failed (refund)",
    );
    throw new ApiError("quote_integrity_failed");
  }
  r.metrics.quote(provider.name, "ok", seconds);
  return insertRouteLeg(r, b, x, { req, res, raw: out.raw, provider: provider.name });
}

/** The verification floor of a route leg: the exact amount (EXACT_OUTPUT) or the quote's `minAmountOut`. */
export function legExpected(swapType: "EXACT_INPUT" | "EXACT_OUTPUT", quote: OneClickQuoteResponse["quote"]): bigint {
  return swapType === "EXACT_OUTPUT" ? BigInt(quote.amountOut) : BigInt(quote.minAmountOut);
}

async function insertRouteLeg(
  r: Rails,
  b: RefundBody,
  x: Leg,
  q: { req: OneClickQuoteRequest; res: OneClickQuoteResponse; raw: unknown; provider: "oneclick" | "sandbox" },
): Promise<Execution> {
  const now = new Date(r.now());
  const quote = q.res.quote;
  const depositAddress = quote.depositAddress as string;
  const sends = BigInt(quote.amountIn);
  const expected = legExpected(b.swap_type, quote);
  const nonce = x.sourceIntents ? await issueNonce(r, b.livemode) : null;
  const bind = x.sourceIntents
    ? bindingOf({
        executionId: x.id,
        payTo: depositAddress,
        token: x.s.asset_id,
        amount: sends,
        feeTo: "",
        feeAmount: 0n,
        deadline: x.deadline,
      })
    : null;
  const refund: RefundRow = {
    swap_type: b.swap_type,
    amount: sends.toString(),
    amount_out_expected: quote.amountOut,
    min_amount_out: quote.minAmountOut,
    token: x.sourceIntents ? null : tokenContractOf(r, x.s),
    transfer: bind
      ? {
          signer_id: x.sourceAddress,
          receiver_id: depositAddress,
          token: x.s.asset_id,
          amount: sends.toString(),
          memo: bind,
          deadline: x.deadline.toISOString(),
          nonce,
        }
      : null,
  };
  try {
    // §21.4: the tier this leg is verified with, fixed at create
    const verificationTier = await tierAtCreate(r, b.recipient.chain);
    return await r.db.transaction().execute(async (tx) => {
      const row = await tx
        .insertInto("executions")
        .values({
          ...baseValues(b, x, now),
          verification_tier: verificationTier,
          method: "route_quote",
          provider: q.provider,
          provider_status: "PENDING_DEPOSIT",
          amount_out_base: expected.toString(),
          amount_out_expected: expected.toString(),
          price_snapshot: x.snapshot ? JSON.stringify(x.snapshot) : null,
          quote_request: JSON.stringify(q.req),
          quote_response: JSON.stringify(q.raw),
          correlation_id: q.res.correlationId,
          deposit_address: depositAddress,
          deposit_memo: quote.depositMemo ?? null,
          amount_in: quote.amountIn,
          min_amount_in: quote.minAmountIn,
          fee_amount_in: "0", // refund legs carry no app fee (spec 0.2.1)
          binding: bind,
          time_when_inactive: quote.timeWhenInactive ? new Date(quote.timeWhenInactive) : null,
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
          refund: JSON.stringify(refund),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const obs = observationValues(x.id, "quote", "PENDING_DEPOSIT", q.raw, null, true);
      await tx.insertInto("provider_observations").values(obs).execute();
      await tx
        .insertInto("execution_transitions")
        .values({
          id: uuidv7(),
          execution_id: x.id,
          from_state: null,
          to_state: "awaiting_deposit",
          cause: "refund quote issued",
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
      if (winner) return replay(winner, x.accountId, b.livemode);
    }
    if (isUniqueViolation(e, "ex_deposit")) {
      r.metrics.integrityFailure(q.provider);
      r.log.error({ deposit: depositAddress }, "ALERT quote integrity: deposit address already issued");
      throw new ApiError("quote_integrity_failed");
    }
    throw e;
  }
}

async function createIntentsLeg(r: Rails, b: RefundBody, x: Leg): Promise<Execution> {
  const nonce = await issueNonce(r, b.livemode);
  const now = new Date(r.now());
  const bind = bindingOf({
    executionId: x.id,
    payTo: x.recipientNorm,
    token: x.s.asset_id,
    amount: x.amount,
    feeTo: "",
    feeAmount: 0n,
    deadline: x.deadline,
  });
  const refund: RefundRow = {
    swap_type: null,
    amount: x.amount.toString(),
    amount_out_expected: x.amount.toString(),
    min_amount_out: null,
    token: null,
    transfer: {
      signer_id: x.sourceAddress,
      receiver_id: x.recipientNorm,
      token: x.s.asset_id,
      amount: x.amount.toString(),
      memo: bind,
      deadline: x.deadline.toISOString(),
      nonce,
    },
  };
  try {
    return await r.db.transaction().execute(async (tx) => {
      const row = await tx
        .insertInto("executions")
        .values({
          ...baseValues(b, x, now),
          method: "intents_transfer",
          provider: "direct_intents",
          provider_status: null,
          amount_out_base: x.amount.toString(),
          amount_out_expected: x.amount.toString(),
          binding: bind,
          // no provider to poll: one check after the deadline expires it (§5 "Expiry")
          next_poll_at: new Date(x.deadline.getTime() + 10 * 60_000),
          refund: JSON.stringify(refund),
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
          cause: "refund transfer issued",
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
