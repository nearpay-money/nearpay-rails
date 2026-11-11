/** Read APIs (lld/rails.md §6): assets, chain profiles, options, minimums, evidence, deposit lookup. */

import { getChain, validateAddress } from "@nearpay-internal/chains";
import { sql } from "@nearpay-internal/db";
import { fromUuid, toUuid } from "@nearpay-internal/ids";
import { ceil, div, mul, rational } from "@nearpay-internal/money";
import { ApiError } from "@nearpay-internal/service";
import type {
  getDestinationMinimums,
  getInternalAsset,
  listEvidence,
  listInternalOptions,
  lookupExecutionByDeposit,
} from "@nearpay-internal/spec";
import type { RouteQuery, RouteResponse } from "@nearpay-money/spec";
import { dualPrice, indicativeUsd, parCheck, pricesOf } from "../domain/pricing/pricing.js";
import { routeClass, tokenContract } from "../domain/token-registry/registry.js";
import type { Rails } from "./context.js";
import { flag } from "./executions.js";
import { readKillSwitch } from "./kill-switch.js";
import { policyFor } from "./pricing.js";
import { enabledTokens, publicAssets, tokenAnyMode } from "./tokens.js";
import { executionView, pricedToken, type TokenRowDb } from "./views.js";

export async function assetView(
  r: Rails,
  assetId: string,
  livemode?: boolean,
): Promise<RouteResponse<typeof getInternalAsset>> {
  const t = await tokenAnyMode(r, assetId, livemode);
  if (!t?.enabled) throw new ApiError("asset_unsupported", { params: { asset_id: assetId }, param: "asset_id" });
  const p = await policyFor(r, t.livemode);
  const priced = pricedToken(t);
  const parOk = parCheck(priced, p).ok;
  return {
    asset_id: t.asset_id,
    chain: t.chain,
    blockchain: t.blockchain,
    symbol: t.symbol,
    decimals: t.decimals,
    family: t.family,
    is_usd_stable: t.is_usd_stable,
    price_usd: t.price_usd === null ? null : trimDecimal(t.price_usd),
    price_ok: parOk || dualPrice(priced, p).ok,
    as_of: t.price_updated_at?.toISOString() ?? null,
    peg_currency: priced.peg_currency,
    par_ok: parOk,
    prices: pricesOf(priced, p),
    token: tokenContractOf(r, t),
  };
}

/** CR-15-06 `TokenContract` of a registry row (by its chain's family). */
export function tokenContractOf(r: Rails, t: TokenRowDb) {
  return tokenContract(r.profiles.get(t.chain)?.family, t.contract_address);
}

/** numeric(38,18) → shortest decimal ("0.999442000…" → "0.999442"). */
export function trimDecimal(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

export async function assetsList(r: Rails) {
  const rows = await publicAssets(r);
  return {
    object: "list" as const,
    data: rows.map((t) => ({
      asset_id: t.asset_id,
      object: "asset" as const,
      chain: t.chain,
      symbol: t.symbol,
      decimals: t.decimals,
      family: t.family,
      is_usd_stable: t.is_usd_stable,
    })),
    has_more: false as const,
    url: "/v1/assets" as const,
  };
}

type OptionsQuery = RouteQuery<typeof listInternalOptions>;
type Option = RouteResponse<typeof listInternalOptions>["options"][number];

/** Indicative amount in (never a quote): amount_out × price(d)/price(o) × (1 + fee + slippage). */
function estimate(amountOut: bigint, o: TokenRowDb, d: TokenRowDb, bps: number): bigint | null {
  const po = indicativeUsd(pricedToken(o));
  const pd = indicativeUsd(pricedToken(d));
  if (!po || !pd) return null;
  const value = div(mul(rational(amountOut), pd), rational(10n ** BigInt(d.decimals)));
  const units = mul(div(value, po), rational(10n ** BigInt(o.decimals)));
  return ceil(mul(units, rational(10_000n + BigInt(bps), 10_000n)));
}

export async function options(r: Rails, q: OptionsQuery): Promise<RouteResponse<typeof listInternalOptions>> {
  const livemode = q.livemode;
  const d = await tokenAnyMode(r, q.destination_asset, livemode);
  if (!d?.enabled) return { options: [] };
  const lm = livemode ?? d.livemode;
  const amountOut = BigInt(q.amount_out);
  const crossChain = await flag(r, "cross_chain_enabled");
  const quoting = lm ? (await readKillSwitch(r)) === "released" && r.treasury !== null : true;
  const out: Option[] = [];
  const tokens = await enabledTokens(r, lm);
  const p = await policyFor(r, lm);
  const settleable = parCheck(pricedToken(d), p).ok || dualPrice(pricedToken(d), p).ok;
  for (const o of tokens) {
    if (q.chain && o.chain !== q.chain) continue;
    if (q.wallet && !validateAddress(o.chain, q.wallet).ok) continue;
    const profile = r.profiles.get(o.chain);
    if (!profile || !getChain(o.chain)) continue;
    const rc = routeClass(o, d);
    const bps = r.indicativeFeeBps[rc];
    const reason = !quoting
      ? "payments are paused"
      : !crossChain
        ? "cross-chain routes are paused"
        : !settleable
          ? "no reliable price for the settlement asset"
          : null;
    out.push({
      method: "route_quote",
      origin_asset_id: o.asset_id,
      chain: o.chain,
      symbol: o.symbol,
      decimals: o.decimals,
      estimated_amount_in: estimate(amountOut, o, d, bps + r.slippageBps[rc])?.toString() ?? null,
      route_class: rc,
      applied_fee_bps: bps,
      min_deadline_s: profile.minDeadlineS,
      available: reason === null,
      reason,
      token: tokenContractOf(r, o),
    });
  }
  if (q.destination_type === "intents_account" && (!q.chain || q.chain === "near:mainnet")) {
    const near = r.profiles.get("near:mainnet");
    const bps = r.indicativeFeeBps.intents_transfer;
    out.unshift({
      method: "intents_transfer",
      origin_asset_id: d.asset_id,
      chain: "near:mainnet",
      symbol: d.symbol,
      decimals: d.decimals,
      estimated_amount_in: (amountOut + (amountOut * BigInt(bps) + 9_999n) / 10_000n).toString(),
      route_class: "intents_transfer",
      applied_fee_bps: bps,
      min_deadline_s: near?.minDeadlineS ?? 120,
      available: quoting && settleable,
      reason: !quoting ? "payments are paused" : settleable ? null : "no reliable price for the settlement asset",
      // paid from the payer's Intents balance: a Verifier transfer, no chain token recipe
      token: null,
    });
  }
  return { options: out };
}

export async function minimums(r: Rails, keysParam: string): Promise<RouteResponse<typeof getDestinationMinimums>> {
  const keys = [
    ...new Set(
      keysParam
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean),
    ),
  ].slice(0, 200);
  const out: RouteResponse<typeof getDestinationMinimums> = {};
  const none = { min_amount_base: null, min_usd_micros: null, computed_at: null };
  for (const key of keys) {
    const [chain, address, asset] = key.split("|");
    if (!chain || !address || !asset) {
      out[key] = none;
      continue;
    }
    const watched = await r.db
      .selectFrom("watched_destinations")
      .select(["livemode", "type"])
      .where("chain", "=", chain)
      .where("address_norm", "=", address)
      .where("asset_id", "=", asset)
      .where("active", "=", true)
      .orderBy("livemode", "desc")
      .executeTakeFirst();
    if (!watched) {
      out[key] = none;
      continue;
    }
    const m = await r.db
      .selectFrom("destination_minimums")
      .selectAll()
      .where("livemode", "=", watched.livemode)
      .where("chain", "=", chain)
      .where("asset_id", "=", asset)
      .where("kind", "=", watched.type === "intents_account" ? "intents" : "chain")
      .executeTakeFirst();
    out[key] =
      m?.computed_at && m.min_amount_base !== null && m.min_usd_micros !== null
        ? {
            min_amount_base: BigInt(m.min_amount_base).toString(),
            min_usd_micros: Number(m.min_usd_micros),
            computed_at: m.computed_at.toISOString(),
          }
        : none;
  }
  return out;
}

/**
 * `listEvidence`. `owner` (spec 0.3.0, §20): only that owner's executions — payments' reconciliation sends
 * `payments` so agentpay's x402 executions never look like unmatched payments. The route passes the filter
 * already narrowed by caller (agentpay only ever sees `agentpay`).
 */
export async function evidencePage(
  r: Rails,
  q: RouteQuery<typeof listEvidence>,
  owner: "payments" | "agentpay" | undefined = q.owner as "payments" | "agentpay" | undefined,
): Promise<RouteResponse<typeof listEvidence>> {
  const account = toUuid(q.account_id, "acct");
  const start = new Date(`${q.day}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 86_400_000);
  let query = r.db
    .selectFrom("executions")
    .selectAll()
    .where("account_id", "=", account)
    .where("livemode", "=", q.livemode)
    .where("state", "in", (q.states?.split(",") ?? ["succeeded"]) as ("succeeded" | "refunded" | "failed")[])
    .where("terminal_at", ">=", start)
    .where("terminal_at", "<", end);
  if (q.kind) query = query.where("kind", "=", q.kind as "payment" | "refund");
  if (owner) query = query.where("owner", "=", owner);
  if (q.starting_after) query = query.where("id", ">", toUuid(q.starting_after, "ex"));
  const rows = await query
    .orderBy("id")
    .limit(q.limit + 1)
    .execute();
  return { data: rows.slice(0, q.limit).map(executionView), has_more: rows.length > q.limit };
}

export async function depositLookup(
  r: Rails,
  q: RouteQuery<typeof lookupExecutionByDeposit>,
  owner?: "payments" | "agentpay",
): Promise<RouteResponse<typeof lookupExecutionByDeposit>> {
  let query = r.db
    .selectFrom("executions")
    .select(["id", "account_id", "livemode"])
    .where("deposit_address", "=", q.deposit_address)
    .where(sql<boolean>`coalesce(deposit_memo, '') = ${q.memo ?? ""}`);
  if (owner) query = query.where("owner", "=", owner);
  const row = await query.orderBy("created_at", "desc").executeTakeFirst();
  if (!row) return { exists: false, execution_id: null, account_id: null, livemode: null };
  return {
    exists: true,
    execution_id: fromUuid("ex", row.id),
    account_id: fromUuid("acct", row.account_id),
    livemode: row.livemode,
  };
}
