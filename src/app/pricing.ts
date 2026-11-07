/**
 * Pricing inputs from the database (lld/rails.md §8.2): token prices (exact rationals, primary + secondary) and the
 * mode's stored FX rates, assembled into the pure policy of `domain/pricing`.
 */
import { sql } from "@nearpay-internal/db";
import { parseDecimal, type Rational, rational } from "@nearpay-internal/money";
import type { FxObs, PricedToken, PriceObs, PricingPolicy } from "../domain/pricing/pricing.js";
import { parseExactDecimal } from "../domain/pricing/ratio.js";
import type { Rails } from "./context.js";
import type { TokenRowDb } from "./views.js";

const ratio = (num: string | null, den: string | null, decimal: string | null): Rational | null => {
  try {
    if (num !== null && den !== null) {
      const n = BigInt(num.split(".")[0] as string);
      const d = BigInt(den.split(".")[0] as string);
      return d > 0n && n > 0n ? rational(n, d) : null;
    }
    if (decimal !== null) {
      const r = parseDecimal(decimal);
      return r.num > 0n ? r : null;
    }
  } catch {}
  return null;
};

/** The pure pricing view of a registry row. */
export function pricedToken(t: TokenRowDb): PricedToken {
  const pv = ratio(t.price_num, t.price_den, t.price_usd);
  const sv = ratio(t.secondary_num, t.secondary_den, t.secondary_price_usd);
  const primary: PriceObs | null =
    pv && t.price_updated_at
      ? { value: pv, asOf: t.price_updated_at, fetchedAt: t.refreshed_at, source: t.livemode ? "oneclick" : "sandbox" }
      : null;
  const secondary: PriceObs | null =
    sv && t.secondary_updated_at
      ? {
          value: sv,
          asOf: t.secondary_updated_at,
          fetchedAt: t.secondary_fetched_at ?? t.secondary_updated_at,
          source: t.secondary_source ?? (t.livemode ? "coingecko" : "sandbox"),
        }
      : null;
  return {
    asset_id: t.asset_id,
    decimals: t.decimals,
    peg_currency: t.peg_currency ?? (t.is_usd_stable ? "usd" : null),
    primary,
    secondary,
  };
}

/** Test mode: the fixed table `NP_TEST_FX_RATES` (source `fixed`, no staleness bound), straight from config. */
export function testFxRates(r: Rails): Map<string, FxObs> {
  const out = new Map<string, FxObs>();
  const now = new Date(r.now());
  for (const [currency, rate] of Object.entries(r.fx.testRates)) {
    if (currency === "usd") continue;
    try {
      const value = parseExactDecimal(rate);
      if (value.num > 0n)
        out.set(currency, {
          currency,
          value,
          source: "fixed",
          referenceDate: null,
          asOf: now,
          fetchedAt: now,
          validUntil: null,
        });
    } catch {}
  }
  return out;
}

/** The FX rates of one mode: live = the stored ECB rates; test = the fixed table. */
export async function fxRates(r: Rails, livemode: boolean): Promise<Map<string, FxObs>> {
  if (!livemode) return testFxRates(r);
  const rows = await r.db
    .selectFrom("fx_rates")
    .selectAll()
    .select(sql<string | null>`reference_date::text`.as("reference_day"))
    .where("livemode", "=", livemode)
    .execute();
  const out = new Map<string, FxObs>();
  for (const x of rows) {
    out.set(x.currency, {
      currency: x.currency,
      value: rational(BigInt(x.num), BigInt(x.den)),
      source: x.source,
      referenceDate: x.reference_day,
      asOf: x.as_of,
      fetchedAt: x.fetched_at,
      validUntil: x.valid_until,
    });
  }
  return out;
}

/** The pricing policy of one mode now (config + that mode's FX table). */
export async function policyFor(r: Rails, livemode: boolean): Promise<PricingPolicy> {
  const fx = await fxRates(r, livemode);
  return { ...r.pricing, nowMs: r.now(), fx: (c) => fx.get(c) };
}

/** Policy without FX (USD-only callers such as Tier-B limits on USD stablecoins fall back to it on errors). */
export function policyWith(r: Rails, fx: ReadonlyMap<string, FxObs>): PricingPolicy {
  return { ...r.pricing, nowMs: r.now(), fx: (c) => fx.get(c) };
}
