/**
 * Routing health (pure): can payments in one mode be routed right now, and if not, why. One source of truth for
 * `options()` reasons, the `nearpay_rails_routing_*` gauges, the `ALERT routing_blocked` log and the ops CLI.
 *
 * The blocking conditions are exactly those `options()` always applied (lld/rails.md §6, §7, §8.2); this module only
 * names them with stable machine codes. It never relaxes or adds a pricing rule: a settlement asset is settleable iff
 * `parCheck` or `dualPrice` passes, as before.
 *
 * - live only: kill switch not `released` (`kill_switch_engaged`, or `kill_switch_unknown` while rails has not learnt
 *   sentinel's state), live treasury unset (`treasury_unset`);
 * - `cross_chain_enabled` false (`cross_chain_paused`; Intents transfers are not affected, RB-01);
 * - the settlement asset not settleable: `settlement_price_stale` / `_missing` / `_depeg` / `_disagree`,
 *   `fx_unavailable` (no usable rate for its peg currency).
 *
 * `token_registry_stale` (no successful registry refresh for 3 × the refresh interval) is a warning: it does not
 * block by itself, but it is usually why the settlement price goes stale a few minutes later.
 */
import { dualPrice, type PricedToken, type PricingPolicy, parCheck } from "../pricing/pricing.js";

export const ROUTING_REASONS = [
  "kill_switch_engaged",
  "kill_switch_unknown",
  "treasury_unset",
  "cross_chain_paused",
  "settlement_price_stale",
  "settlement_price_missing",
  "settlement_price_depeg",
  "settlement_price_disagree",
  "fx_unavailable",
  "token_registry_stale",
] as const;

export type RoutingReason = (typeof ROUTING_REASONS)[number];

export type SettlementReason = Extract<
  RoutingReason,
  | "settlement_price_stale"
  | "settlement_price_missing"
  | "settlement_price_depeg"
  | "settlement_price_disagree"
  | "fx_unavailable"
>;

/** Reasons that are about prices (payments maps them to the payer-facing `pricing_unavailable`). */
export const PRICE_REASONS: ReadonlySet<RoutingReason> = new Set<RoutingReason>([
  "settlement_price_stale",
  "settlement_price_missing",
  "settlement_price_depeg",
  "settlement_price_disagree",
  "fx_unavailable",
]);

/** The human sentence of each reason (logs, ops CLI). */
export const REASON_TEXT: Readonly<Record<RoutingReason, string>> = {
  kill_switch_engaged: "payments are paused: the kill switch is engaged",
  kill_switch_unknown: "payments are paused: rails does not know sentinel's kill-switch state (fail closed)",
  treasury_unset: "payments are paused: the live fee recipient (NP_TREASURY_ACCOUNT) is not configured",
  cross_chain_paused: "cross-chain routes are paused (control flag cross_chain_enabled = false)",
  settlement_price_stale: "no reliable price for the settlement asset: its price is too old",
  settlement_price_missing: "no reliable price for the settlement asset: a price source has no value for it",
  settlement_price_depeg: "no reliable price for the settlement asset: it is off its peg",
  settlement_price_disagree: "no reliable price for the settlement asset: the price sources disagree",
  fx_unavailable: "no reliable price for the settlement asset: no current FX rate for its peg currency",
  token_registry_stale: "the token registry has not refreshed from the route provider recently",
};

/** The first thing an operator should do about each reason (ops CLI, beta smoke, alert text). */
export const REASON_FIX: Readonly<Record<RoutingReason, string>> = {
  kill_switch_engaged:
    "release the kill switch in the console (ops > Kill switch) once the cause is understood; already released? rails re-reads sentinel every 60 s — check `ops rails flags` (source_version) and rails logs for 'ALERT kill_switch_copy_diverged'",
  kill_switch_unknown:
    "check rails-api logs for 'ALERT kill_switch_unknown' (sentinel unreachable, auth, NP_SENTINEL_URL unset); it clears as soon as sentinel answers",
  treasury_unset: "set NP_TREASURY_ACCOUNT for rails (live overlay) and restart rails-api",
  cross_chain_paused: "rails ops flag-set cross_chain_enabled true <reason>",
  settlement_price_stale:
    "check rails-feeds logs ('ALERT token_registry_refresh_failed') and the egress proxy's access to 1Click",
  settlement_price_missing:
    "check rails-feeds logs: the 1Click token list or the CoinGecko secondary price lacks the settlement asset",
  settlement_price_depeg: "the settlement stablecoin is off its peg: wait, or ask merchants to settle in another asset",
  settlement_price_disagree: "1Click and CoinGecko disagree: check rails-feeds logs (secondary-prices) and wait",
  fx_unavailable: "check rails-feeds logs for the ECB FX feed (fx) and the egress proxy",
  token_registry_stale:
    "check rails-feeds logs ('ALERT token_registry_refresh_failed') and that the egress proxy reaches 1Click",
};

export type SettlementCheck = { ok: true } | { ok: false; reason: SettlementReason };

/**
 * Why a settlement asset is (not) settleable: `parCheck` or `dualPrice` passes → ok (unchanged rule). Otherwise a
 * stablecoin is explained by its par failure, any other asset by its dual-source failure.
 */
export function settlementCheck(t: PricedToken, p: PricingPolicy): SettlementCheck {
  const par = parCheck(t, p);
  if (par.ok) return { ok: true };
  const dual = dualPrice(t, p);
  if (dual.ok) return { ok: true };
  if (t.peg_currency) {
    if (par.reason === "fx_unavailable") return { ok: false, reason: "fx_unavailable" };
    if (par.reason === "depeg") return { ok: false, reason: "settlement_price_depeg" };
    return { ok: false, reason: t.primary ? "settlement_price_stale" : "settlement_price_missing" };
  }
  if (dual.reason === "missing") return { ok: false, reason: "settlement_price_missing" };
  if (dual.reason === "stale") return { ok: false, reason: "settlement_price_stale" };
  return { ok: false, reason: "settlement_price_disagree" };
}

export type KillSwitchState = "engaged" | "released" | "unknown";

export interface RoutingInputs {
  readonly livemode: boolean;
  /** Rails' copy of sentinel's kill switch (ignored in test mode). */
  readonly killSwitch: KillSwitchState;
  /** Live treasury configured (ignored in test mode). */
  readonly treasurySet: boolean;
  readonly crossChainEnabled: boolean;
  /** The settlement assets considered (one for `options()`, those in use for the gauges). */
  readonly settlement: readonly { readonly asset_id: string; readonly check: SettlementCheck }[];
  /** Registry freshness; null when not checked (no provider for the mode, or the caller skips it). */
  readonly registry: { readonly refreshedAt: Date | null; readonly maxAgeMs: number } | null;
  readonly nowMs: number;
}

export interface RoutingHealth {
  readonly livemode: boolean;
  readonly available: boolean;
  /** Blocking reasons, in priority order (the first is what an option reports). */
  readonly reasons: RoutingReason[];
  /** Non-blocking reasons (`token_registry_stale`). */
  readonly warnings: RoutingReason[];
  /** Settlement assets that are not settleable, with why. */
  readonly settlement: { asset_id: string; reason: SettlementReason }[];
  /** Seconds since the last successful registry refresh; null = not checked, Infinity = never refreshed. */
  readonly registryAgeS: number | null;
}

const ORDER = new Map(ROUTING_REASONS.map((r, i) => [r, i]));

export function routingHealth(i: RoutingInputs): RoutingHealth {
  const reasons = new Set<RoutingReason>();
  if (i.livemode) {
    if (i.killSwitch === "engaged") reasons.add("kill_switch_engaged");
    else if (i.killSwitch === "unknown") reasons.add("kill_switch_unknown");
    if (!i.treasurySet) reasons.add("treasury_unset");
  }
  if (!i.crossChainEnabled) reasons.add("cross_chain_paused");
  const settlement: RoutingHealth["settlement"] = [];
  for (const s of i.settlement) {
    if (s.check.ok) continue;
    settlement.push({ asset_id: s.asset_id, reason: s.check.reason });
    reasons.add(s.check.reason);
  }
  const warnings: RoutingReason[] = [];
  let registryAgeS: number | null = null;
  if (i.registry) {
    registryAgeS = i.registry.refreshedAt
      ? Math.max(0, Math.floor((i.nowMs - i.registry.refreshedAt.getTime()) / 1000))
      : Number.POSITIVE_INFINITY;
    if (registryAgeS * 1000 > i.registry.maxAgeMs) warnings.push("token_registry_stale");
  }
  const sorted = [...reasons].sort((a, b) => (ORDER.get(a) ?? 0) - (ORDER.get(b) ?? 0));
  return {
    livemode: i.livemode,
    available: sorted.length === 0,
    reasons: sorted,
    warnings,
    settlement,
    registryAgeS,
  };
}

/**
 * The reason one option reports: the first blocking reason that applies to its method. Intents transfers are not
 * cross-chain routes, so `cross_chain_paused` does not apply to them (RB-01).
 */
export function optionReason(
  h: Pick<RoutingHealth, "reasons">,
  method: "route_quote" | "intents_transfer",
): RoutingReason | null {
  for (const r of h.reasons) {
    if (method === "intents_transfer" && r === "cross_chain_paused") continue;
    return r;
  }
  return null;
}
