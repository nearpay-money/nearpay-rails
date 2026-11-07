/**
 * Settlement pricing (lld/rails.md §8.2, domain-model §3, INV-5/INV-6). Pure, exact (bigint rationals; no floats).
 *
 * - **Prices**: primary = 1Click `/v0/tokens` (valid ≤ 120 s after `priceUpdatedAt`), secondary = CoinGecko keyless
 *   (valid ≤ 300 s after `last_updated_at`); a non-par price needs both valid and agreeing within 1.5 % (→ primary).
 * - **Par policy**: a stablecoin of `peg_currency` (USDC/USDT → `usd`; `NP_STABLE_PEGS` for others) settles at par
 *   while its primary price (≤ 5 min old) is within ±2 % of `fx(peg)`, and a valid secondary passes the same band
 *   (depeg guard). Outside it par is disabled for the asset and the non-par rules apply.
 * - **FX**: a fiat price converts to USD with the stored rate of its currency while `now < valid_until` (ECB
 *   publication-calendar bound); a stale rate is never used (`fx_rate_unavailable`). `usd` needs no rate.
 * - Conversions to the settlement amount round **down** (foundations §6).
 */
import { cmp, div, minorUnits, mul, type Rational, rational } from "@nearpay-internal/money";
import type { PriceRate } from "@nearpay-internal/spec";
import { convertUnits, ratioToWire, relDiff, toDisplayDecimal } from "./ratio.js";

export interface PriceObs {
  /** USD per one whole token. */
  readonly value: Rational;
  /** When the source says the value applies. */
  readonly asOf: Date;
  readonly fetchedAt: Date;
  readonly source: string;
}

export interface PricedToken {
  readonly asset_id: string;
  readonly decimals: number;
  /** Fiat currency the asset is a stablecoin of (`usd`, `eur`, …), or null. */
  readonly peg_currency: string | null;
  readonly primary: PriceObs | null;
  readonly secondary: PriceObs | null;
}

export interface FxObs {
  readonly currency: string;
  /** USD per one unit of `currency`. */
  readonly value: Rational;
  readonly source: "ecb" | "fixed";
  readonly referenceDate: string | null;
  readonly asOf: Date;
  readonly fetchedAt: Date;
  /** Null = no bound (fixed test table). */
  readonly validUntil: Date | null;
}

export interface PricingPolicy {
  readonly nowMs: number;
  /** Accepted fiat pricing currencies (`NP_PRICING_CURRENCIES`). */
  readonly currencies: ReadonlySet<string>;
  /** Primary price validity for the dual-source rule (120 s). */
  readonly primaryMaxAgeMs: number;
  /** Secondary price validity (300 s). */
  readonly secondaryMaxAgeMs: number;
  /** Agreement band between the two sources (1.5 %). */
  readonly agreement: Rational;
  /** Primary price freshness for the depeg guard (5 min). */
  readonly parMaxAgeMs: number;
  /** Depeg band around `fx(peg)` (2 %). */
  readonly depegBand: Rational;
  /** The stored rate of a currency (this mode), or undefined. */
  readonly fx: (currency: string) => FxObs | undefined;
}

export type PolicyConfig = Omit<PricingPolicy, "nowMs" | "fx">;

export const DEFAULT_POLICY: PolicyConfig = {
  currencies: new Set(["usd"]),
  primaryMaxAgeMs: 120_000,
  secondaryMaxAgeMs: 300_000,
  agreement: rational(15n, 1000n),
  parMaxAgeMs: 300_000,
  depegBand: rational(2n, 100n),
};

export type PricingErrorCode =
  | "pricing_unavailable"
  | "amount_too_small"
  | "currency_unsupported"
  | "fx_rate_unavailable";

export class PricingError extends Error {
  override readonly name = "PricingError";
  constructor(
    readonly code: PricingErrorCode,
    /** Asset id (prices) or currency (FX). */
    readonly subject: string,
    detail: string,
  ) {
    super(detail);
  }
  /** Back-compat name used by Stage 1 callers. */
  get assetId(): string {
    return this.subject;
  }
}

const ONE = rational(1n);
/** Clock skew tolerated for a source timestamp in the future. */
const SKEW_MS = 60_000;

function fresh(o: PriceObs | null, maxAgeMs: number, nowMs: number): o is PriceObs {
  if (!o || o.value.num <= 0n) return false;
  const at = o.asOf.getTime();
  return nowMs - at <= maxAgeMs && at <= nowMs + SKEW_MS;
}

/** §8.2 `fx(c)`: the stored rate while `now < valid_until`; `usd` is exactly one. */
export function fxRate(currency: string, p: PricingPolicy): FxObs {
  if (currency === "usd") {
    const now = new Date(p.nowMs);
    return { currency, value: ONE, source: "fixed", referenceDate: null, asOf: now, fetchedAt: now, validUntil: null };
  }
  const f = p.fx(currency);
  if (!f || f.value.num <= 0n) throw new PricingError("fx_rate_unavailable", currency, `no FX rate for ${currency}`);
  if (f.validUntil !== null && p.nowMs >= f.validUntil.getTime())
    throw new PricingError("fx_rate_unavailable", currency, `the FX rate for ${currency} is stale`);
  return f;
}

/** Whether a rate is usable now (present and inside its bound). */
export function fxUsable(f: FxObs | undefined, nowMs: number): boolean {
  return f !== undefined && f.value.num > 0n && (f.validUntil === null || nowMs < f.validUntil.getTime());
}

export type ParCheck =
  | { ok: true; fx: FxObs }
  | { ok: false; reason: "not_stable" | "stale" | "depeg" | "fx_unavailable" };

/** Depeg guard (§8.2 `parOk`). */
export function parCheck(t: PricedToken, p: PricingPolicy): ParCheck {
  if (!t.peg_currency) return { ok: false, reason: "not_stable" };
  let fx: FxObs;
  try {
    fx = fxRate(t.peg_currency, p);
  } catch {
    return { ok: false, reason: "fx_unavailable" };
  }
  if (!fresh(t.primary, p.parMaxAgeMs, p.nowMs)) return { ok: false, reason: "stale" };
  const inBand = (o: PriceObs) => cmp(relDiff(div(o.value, fx.value), ONE), p.depegBand) <= 0;
  if (!inBand(t.primary)) return { ok: false, reason: "depeg" };
  if (fresh(t.secondary, p.secondaryMaxAgeMs, p.nowMs) && !inBand(t.secondary)) return { ok: false, reason: "depeg" };
  return { ok: true, fx };
}

export type DualPrice =
  | { ok: true; usd: Rational; primary: PriceObs; secondary: PriceObs }
  | { ok: false; reason: "missing" | "stale" | "disagree" };

/** §8.2 `price(t)`: both sources valid and agreeing → the primary. */
export function dualPrice(t: PricedToken, p: PricingPolicy): DualPrice {
  if (!t.primary || !t.secondary || t.primary.value.num <= 0n || t.secondary.value.num <= 0n)
    return { ok: false, reason: "missing" };
  if (!fresh(t.primary, p.primaryMaxAgeMs, p.nowMs) || !fresh(t.secondary, p.secondaryMaxAgeMs, p.nowMs))
    return { ok: false, reason: "stale" };
  if (cmp(relDiff(t.primary.value, t.secondary.value), p.agreement) > 0) return { ok: false, reason: "disagree" };
  return { ok: true, usd: t.primary.value, primary: t.primary, secondary: t.secondary };
}

export interface UnitValue {
  /** USD per one whole token. */
  readonly usd: Rational;
  readonly par: boolean;
  readonly parCurrency: string | null;
  readonly rates: PriceRate[];
}

// ---------------------------------------------------------------------------------------------
// PriceRate views (spec 0.2.0)
// ---------------------------------------------------------------------------------------------

export function priceRateOf(t: PricedToken, o: PriceObs, role: "primary" | "secondary", maxAgeMs: number): PriceRate {
  return {
    base: t.asset_id,
    quote: "usd",
    kind: "price",
    role,
    source: o.source,
    value: ratioToWire(o.value),
    decimal: toDisplayDecimal(o.value),
    as_of: o.asOf.toISOString(),
    fetched_at: o.fetchedAt.toISOString(),
    valid_until: new Date(o.asOf.getTime() + maxAgeMs).toISOString(),
  } as PriceRate;
}

export function fxRateView(f: FxObs): PriceRate {
  return {
    base: f.currency,
    quote: "usd",
    kind: "fx",
    role: "reference",
    source: f.source,
    value: ratioToWire(f.value),
    decimal: toDisplayDecimal(f.value),
    as_of: f.asOf.toISOString(),
    fetched_at: f.fetchedAt.toISOString(),
    valid_until: f.validUntil?.toISOString() ?? null,
  } as PriceRate;
}

/** Primary and secondary prices of `t` as `PriceRate`s (whatever their freshness; `valid_until` says it). */
export function pricesOf(t: PricedToken, p: Pick<PricingPolicy, "primaryMaxAgeMs" | "secondaryMaxAgeMs">): PriceRate[] {
  const out: PriceRate[] = [];
  if (t.primary) out.push(priceRateOf(t, t.primary, "primary", p.primaryMaxAgeMs));
  if (t.secondary) out.push(priceRateOf(t, t.secondary, "secondary", p.secondaryMaxAgeMs));
  return out;
}

/** USD value of one whole token for settlement: `fx(peg)` at par, else the dual-source price. */
export function unitValue(t: PricedToken, p: PricingPolicy): UnitValue {
  const par = parCheck(t, p);
  if (par.ok)
    return {
      usd: par.fx.value,
      par: true,
      parCurrency: t.peg_currency,
      rates: t.peg_currency === "usd" ? [] : [fxRateView(par.fx)],
    };
  const d = dualPrice(t, p);
  if (d.ok)
    return {
      usd: d.usd,
      par: false,
      parCurrency: null,
      rates: [
        priceRateOf(t, d.primary, "primary", p.primaryMaxAgeMs),
        priceRateOf(t, d.secondary, "secondary", p.secondaryMaxAgeMs),
      ],
    };
  throw new PricingError("pricing_unavailable", t.asset_id, `no reliable price for ${t.asset_id} (${d.reason})`);
}

/** Back-compat: `{usd, par}` of `unitValue`. */
export function settlementPrice(t: PricedToken, p: PricingPolicy): { usd: Rational; par: boolean } {
  const u = unitValue(t, p);
  return { usd: u.usd, par: u.par };
}

export type Pricing =
  | { readonly currency: string; readonly amount: bigint }
  | { readonly currency: "asset"; readonly assetId: string; readonly amount: bigint };

/** `PriceSnapshot` (spec 0.2.0): Stage 1 fields + `currency`, `par_currency`, `rates`. */
export interface PriceSnapshot {
  primary_usd: string | null;
  secondary_usd: string | null;
  fx: string | null;
  par: boolean;
  as_of: string;
  currency: string;
  par_currency: string | null;
  rates: PriceRate[];
}

export interface Settlement {
  /** Settlement amount in `d` base units, before bearer adjustment and tag (rounded down). */
  readonly amount: bigint;
  readonly par: boolean;
  /** USD value of the price (exact), null for same-asset pricing. */
  readonly usd: Rational | null;
  readonly snapshot: PriceSnapshot;
}

const pow10 = (n: number) => rational(10n ** BigInt(n));

function dedupe(rates: PriceRate[]): PriceRate[] {
  const seen = new Set<string>();
  return rates.filter((r) => {
    const k = `${r.kind}|${r.base}|${r.role}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The USD value of a price (§8.2 first half): asset prices via the pricing asset's unit value, fiat via FX.
 * Returns the exact USD value and the rates used.
 */
export function usdValue(
  pricing: Pricing,
  p: PricingPolicy,
  lookup: (assetId: string) => PricedToken | undefined,
): { usd: Rational; par: boolean; fx: FxObs | null; rates: PriceRate[] } {
  if (pricing.currency === "asset") {
    const { assetId } = pricing as Extract<Pricing, { currency: "asset" }>;
    const src = lookup(assetId);
    if (!src) throw new PricingError("pricing_unavailable", assetId, `${assetId} is not priced`);
    const u = unitValue(src, p);
    return {
      usd: div(mul(rational(pricing.amount), u.usd), pow10(src.decimals)),
      par: u.par,
      fx: null,
      rates: u.rates,
    };
  }
  if (!p.currencies.has(pricing.currency))
    throw new PricingError(
      "currency_unsupported",
      pricing.currency,
      `pricing currency ${pricing.currency} is not accepted`,
    );
  const fx = fxRate(pricing.currency, p);
  return {
    usd: mul(div(rational(pricing.amount), pow10(minorUnits(pricing.currency))), fx.value),
    par: true,
    fx: pricing.currency === "usd" ? null : fx,
    rates: pricing.currency === "usd" ? [] : [fxRateView(fx)],
  };
}

/** §8.2 `settle(pricing, d)`. `lookup` resolves the pricing asset of asset-priced payments. */
export function settle(
  pricing: Pricing,
  d: PricedToken,
  p: PricingPolicy,
  lookup: (assetId: string) => PricedToken | undefined,
): Settlement {
  const display = (o: PriceObs | null) => (o ? toDisplayDecimal(o.value) : null);
  const snapshot = (par: boolean, parCurrency: string | null, fx: FxObs | null, rates: PriceRate[]): PriceSnapshot => ({
    primary_usd: display(d.primary),
    secondary_usd: display(d.secondary),
    fx: fx ? toDisplayDecimal(fx.value) : null,
    par,
    as_of: new Date(p.nowMs).toISOString(),
    currency: pricing.currency,
    par_currency: parCurrency,
    rates: dedupe(rates),
  });
  const done = (s: Settlement): Settlement => {
    if (s.amount <= 0n)
      throw new PricingError(
        "amount_too_small",
        d.asset_id,
        "the amount is below one base unit of the settlement asset",
      );
    return s;
  };

  if (pricing.currency === "asset" && (pricing as { assetId: string }).assetId === d.asset_id)
    return done({ amount: pricing.amount, par: false, usd: null, snapshot: snapshot(false, null, null, []) });

  // same-currency par: USDC for usd, EURC for eur (no USD leg, no FX needed for the amount itself)
  if (pricing.currency !== "asset" && d.peg_currency === pricing.currency) {
    if (!p.currencies.has(pricing.currency))
      throw new PricingError(
        "currency_unsupported",
        pricing.currency,
        `pricing currency ${pricing.currency} is not accepted`,
      );
    const par = parCheck(d, p);
    if (par.ok) {
      const amount = convertUnits(pricing.amount, minorUnits(pricing.currency), ONE, d.decimals, "floor");
      const fx = pricing.currency === "usd" ? null : par.fx;
      return done({
        amount,
        par: true,
        usd: mul(div(rational(pricing.amount), pow10(minorUnits(pricing.currency))), par.fx.value),
        snapshot: snapshot(true, pricing.currency, fx, fx ? [fxRateView(fx)] : []),
      });
    }
  }

  const v = usdValue(pricing, p, lookup);
  // USD par
  if (d.peg_currency === "usd") {
    const par = parCheck(d, p);
    if (par.ok)
      return done({
        amount: convertUnits(1n, 0, v.usd, d.decimals, "floor"),
        par: v.par,
        usd: v.usd,
        snapshot: snapshot(v.par, v.par ? "usd" : null, v.fx, v.rates),
      });
  }
  // non-par: needs both price sources
  const dp = dualPrice(d, p);
  if (!dp.ok)
    throw new PricingError("pricing_unavailable", d.asset_id, `no reliable price for ${d.asset_id} (${dp.reason})`);
  const rates = [
    ...v.rates,
    priceRateOf(d, dp.primary, "primary", p.primaryMaxAgeMs),
    priceRateOf(d, dp.secondary, "secondary", p.secondaryMaxAgeMs),
  ];
  return done({
    amount: convertUnits(1n, 0, div(v.usd, dp.usd), d.decimals, "floor"),
    par: false,
    usd: v.usd,
    snapshot: snapshot(false, null, v.fx, rates),
  });
}

/** USD micros of `amount` base units of `t` (floor), or null when no reliable price exists. */
export function usdMicros(amount: bigint, t: PricedToken, p: PricingPolicy): bigint | null {
  try {
    return convertUnits(amount, t.decimals, unitValue(t, p).usd, 6, "floor");
  } catch {
    return null;
  }
}

/** Base units of `t` worth `micros` USD micros, rounded up (minimums), or null without a price. */
export function unitsForUsdMicros(micros: bigint, t: PricedToken, p: PricingPolicy): bigint | null {
  try {
    return convertUnits(micros, 6, div(ONE, unitValue(t, p).usd), t.decimals, "ceil");
  } catch {
    return null;
  }
}

/** Indicative USD price (primary only; options and minimums, never settlement). */
export function indicativeUsd(t: PricedToken): Rational | null {
  return t.primary && t.primary.value.num > 0n ? t.primary.value : null;
}
