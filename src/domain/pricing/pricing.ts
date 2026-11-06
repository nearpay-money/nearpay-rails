/**
 * Settlement pricing (lld/rails.md §8.2, domain-model §3, INV-5/INV-6). Pure, exact (bigint
 * rationals; no floats).
 *
 * - **Par policy**: a USD stablecoin whose primary price is fresh and within ±2 % of 1 settles at par
 *   (USD 1.00 = 10^decimals base units). Outside the band the depeg guard disables par for it.
 * - **Non-par** needs two agreeing (≤ 1.5 %) prices, both fresher than 60 s. Stage 1 has no secondary
 *   source, so non-par settlement is `pricing_unavailable` (rails §11 "Stage 1 pricing posture").
 * - Fiat pricing converts through FX; Stage 1 prices in `usd` only.
 */
import {
  cmp,
  div,
  floor,
  minorUnits,
  mul,
  parseDecimal,
  type Rational,
  rational,
  relativeDiff,
  sub,
} from "@nearpay-internal/money";

export interface PricedToken {
  readonly asset_id: string;
  readonly decimals: number;
  readonly is_usd_stable: boolean;
  readonly price_usd: string | null;
  readonly price_updated_at: Date | null;
  readonly secondary_price_usd: string | null;
  readonly secondary_updated_at: Date | null;
}

export interface PricingPolicy {
  readonly nowMs: number;
  /** Fiat currencies accepted for pricing (Stage 1: `usd`). */
  readonly currencies: ReadonlySet<string>;
  /** Freshness of both sources for a non-par price (60 s). */
  readonly dualMaxAgeMs: number;
  /** Agreement band between the two sources (1.5 %). */
  readonly agreement: Rational;
  /** Freshness of the primary price for the depeg guard (5 min: 1Click refreshes about once a minute). */
  readonly parMaxAgeMs: number;
  /** Depeg band around 1.00 (2 %). */
  readonly depegBand: Rational;
}

export const DEFAULT_POLICY: Omit<PricingPolicy, "nowMs"> = {
  currencies: new Set(["usd"]),
  dualMaxAgeMs: 60_000,
  agreement: rational(15n, 1000n),
  parMaxAgeMs: 300_000,
  depegBand: rational(2n, 100n),
};

export class PricingError extends Error {
  override readonly name = "PricingError";
  constructor(
    readonly code: "pricing_unavailable" | "amount_too_small",
    readonly assetId: string,
    detail: string,
  ) {
    super(detail);
  }
}

const ONE = rational(1n);

function fresh(at: Date | null, maxAgeMs: number, nowMs: number): boolean {
  return at !== null && nowMs - at.getTime() <= maxAgeMs && at.getTime() <= nowMs + 60_000;
}

function decimal(s: string | null): Rational | null {
  if (s === null) return null;
  try {
    const r = parseDecimal(s);
    return r.num > 0n ? r : null;
  } catch {
    return null;
  }
}

export type ParCheck = { ok: true } | { ok: false; reason: "not_stable" | "stale" | "depeg" };

/** Depeg guard (§8.2 `parOk`). */
export function parCheck(t: PricedToken, p: PricingPolicy): ParCheck {
  if (!t.is_usd_stable) return { ok: false, reason: "not_stable" };
  const price = decimal(t.price_usd);
  if (!price || !fresh(t.price_updated_at, p.parMaxAgeMs, p.nowMs)) return { ok: false, reason: "stale" };
  return cmp(relativeDiff(price, ONE), p.depegBand) <= 0 ? { ok: true } : { ok: false, reason: "depeg" };
}

export type DualPrice = { ok: true; usd: Rational } | { ok: false; reason: "missing" | "stale" | "disagree" };

/** §8.2 `price(t)`: two fresh, agreeing sources (the primary is the provider's). */
export function dualPrice(t: PricedToken, p: PricingPolicy): DualPrice {
  const a = decimal(t.price_usd);
  const b = decimal(t.secondary_price_usd);
  if (!a || !b) return { ok: false, reason: "missing" };
  if (!fresh(t.price_updated_at, p.dualMaxAgeMs, p.nowMs) || !fresh(t.secondary_updated_at, p.dualMaxAgeMs, p.nowMs))
    return { ok: false, reason: "stale" };
  if (cmp(relativeDiff(a, b), p.agreement) > 0) return { ok: false, reason: "disagree" };
  return { ok: true, usd: a };
}

/** USD value of one whole token for settlement: 1 at par, else the dual-source price. */
export function settlementPrice(t: PricedToken, p: PricingPolicy): { usd: Rational; par: boolean } {
  if (parCheck(t, p).ok) return { usd: ONE, par: true };
  const d = dualPrice(t, p);
  if (d.ok) return { usd: d.usd, par: false };
  throw new PricingError("pricing_unavailable", t.asset_id, `no reliable price for ${t.asset_id} (${d.reason})`);
}

export type Pricing =
  | { readonly currency: string; readonly amount: bigint }
  | { readonly currency: "asset"; readonly assetId: string; readonly amount: bigint };

export interface PriceSnapshot {
  primary_usd: string | null;
  secondary_usd: string | null;
  fx: string | null;
  par: boolean;
  as_of: string;
}

export interface Settlement {
  /** Settlement amount in `d` base units, before bearer adjustment and tag (rounded down). */
  readonly amount: bigint;
  readonly par: boolean;
  readonly snapshot: PriceSnapshot;
}

const pow10 = (n: number) => rational(10n ** BigInt(n));

/** Base units of `d` worth `usd`, rounded down. */
function toUnits(usd: Rational, d: PricedToken, p: PricingPolicy): { amount: bigint; par: boolean } {
  const price = settlementPrice(d, p);
  return { amount: floor(mul(div(usd, price.usd), pow10(d.decimals))), par: price.par };
}

/**
 * §8.2 `settle(pricing, d)`. `lookup` resolves the pricing asset of asset-priced payments.
 */
export function settle(
  pricing: Pricing,
  d: PricedToken,
  p: PricingPolicy,
  lookup: (assetId: string) => PricedToken | undefined,
): Settlement {
  const snapshot = (par: boolean, fx: string | null = null): PriceSnapshot => ({
    primary_usd: d.price_usd,
    secondary_usd: d.secondary_price_usd,
    fx,
    par,
    as_of: new Date(p.nowMs).toISOString(),
  });
  let out: { amount: bigint; par: boolean };
  if (pricing.currency === "asset") {
    const { assetId } = pricing as Extract<Pricing, { currency: "asset" }>;
    if (assetId === d.asset_id) {
      out = { amount: pricing.amount, par: false };
    } else {
      const src = lookup(assetId);
      if (!src) throw new PricingError("pricing_unavailable", assetId, `${assetId} is not priced`);
      const unit = settlementPrice(src, p);
      out = toUnits(div(mul(rational(pricing.amount), unit.usd), pow10(src.decimals)), d, p);
      out = { amount: out.amount, par: out.par && unit.par };
    }
  } else {
    if (!p.currencies.has(pricing.currency))
      throw new PricingError("pricing_unavailable", d.asset_id, `pricing currency ${pricing.currency} is not enabled`);
    // Stage 1: usd only, so FX = 1 (FX sources arrive in Stage 2 with the other currencies).
    const usd = div(rational(pricing.amount), pow10(minorUnits(pricing.currency)));
    out = toUnits(usd, d, p);
  }
  if (out.amount <= 0n)
    throw new PricingError("amount_too_small", d.asset_id, "the amount is below one base unit of the settlement asset");
  return { amount: out.amount, par: out.par, snapshot: snapshot(out.par) };
}

/** USD micros of `amount` base units of `t` (floor), or null when no reliable price exists. */
export function usdMicros(amount: bigint, t: PricedToken, p: PricingPolicy): bigint | null {
  try {
    const price = settlementPrice(t, p);
    return floor(mul(div(mul(rational(amount), price.usd), pow10(t.decimals)), rational(1_000_000n)));
  } catch {
    return null;
  }
}

/** Base units of `t` worth `micros` USD micros, rounded up (minimums), or null without a price. */
export function unitsForUsdMicros(micros: bigint, t: PricedToken, p: PricingPolicy): bigint | null {
  try {
    const price = settlementPrice(t, p);
    const units = div(mul(rational(micros), pow10(t.decimals)), mul(price.usd, rational(1_000_000n)));
    const f = floor(units);
    return cmp(sub(units, rational(f)), rational(0n)) > 0 ? f + 1n : f;
  } catch {
    return null;
  }
}

/** Indicative USD price (primary only; options and minimums, never settlement). */
export function indicativeUsd(t: PricedToken): Rational | null {
  return decimal(t.price_usd);
}
