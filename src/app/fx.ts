/**
 * FX rates and secondary prices (lld/rails.md §8.2, §9): the ECB refresh (live, every 30 min, conditional GET), the
 * fixed test table (test mode, at boot), the CoinGecko batch (live, every 60 s) and the `GET /internal/fx-rates`
 * view. A rate past its `valid_until` is reported stale and never used; payments reads this view to answer
 * `currency_unsupported` / `fx_rate_unavailable`.
 */
import { minorUnits, rational } from "@nearpay-internal/money";
import type { FxRates } from "@nearpay-internal/spec";
import { ecbQuotes } from "../domain/pricing/ecb.js";
import { fxRateView, fxUsable } from "../domain/pricing/pricing.js";
import { parseExactDecimal, ratioToWire, toDisplayDecimal } from "../domain/pricing/ratio.js";
import type { FxFetch } from "../providers/fx/ecb.js";
import type { PriceProvider } from "../providers/prices/port.js";
import type { Rails } from "./context.js";
import { fxRates } from "./pricing.js";

interface FxRowIn {
  currency: string;
  num: string;
  den: string;
  source: "ecb" | "fixed";
  reference_date: string | null;
  as_of: Date;
  fetched_at: Date;
  valid_until: Date | null;
}

async function upsertFx(r: Rails, livemode: boolean, rows: readonly FxRowIn[]): Promise<void> {
  if (rows.length === 0) return;
  await r.db
    .insertInto("fx_rates")
    .values(rows.map((x) => ({ livemode, ...x })))
    .onConflict((oc) =>
      oc
        .columns(["livemode", "currency"])
        .doUpdateSet((eb) => ({
          num: eb.ref("excluded.num"),
          den: eb.ref("excluded.den"),
          source: eb.ref("excluded.source"),
          reference_date: eb.ref("excluded.reference_date"),
          as_of: eb.ref("excluded.as_of"),
          fetched_at: eb.ref("excluded.fetched_at"),
          valid_until: eb.ref("excluded.valid_until"),
        }))
        // never replace a newer reference day with an older one (a stale cache answering)
        .where((eb) => eb("excluded.as_of", ">=", eb.ref("fx_rates.as_of"))),
    )
    .execute();
}

/** One ECB refresh; returns the currencies written (0 when not modified). Alerts on currencies left stale. */
export async function refreshEcb(r: Rails, ecb: FxFetch): Promise<number> {
  const daily = await ecb.daily();
  let written = 0;
  if (daily) {
    const now = new Date(r.now());
    const quotes = ecbQuotes(daily, [...r.pricing.currencies], { graceS: r.fx.graceS, maxAgeS: r.fx.maxAgeS });
    await upsertFx(
      r,
      true,
      quotes.map((q) => ({
        currency: q.currency,
        ...ratioToWire(q.value),
        source: "ecb" as const,
        reference_date: q.referenceDate,
        as_of: q.asOf,
        fetched_at: now,
        valid_until: q.validUntil,
      })),
    );
    written = quotes.length;
  }
  await alertStale(r);
  return written;
}

/** `fx_stale{currency}` for every accepted live currency without a usable rate (§8.2). */
export async function alertStale(r: Rails): Promise<string[]> {
  const fx = await fxRates(r, true);
  const stale = [...r.pricing.currencies].filter((c) => c !== "usd" && !fxUsable(fx.get(c), r.now()));
  if (stale.length) r.log.error({ currencies: stale, alert: "fx_stale" }, "ALERT fx_stale: FX rates unavailable");
  return stale;
}

/** `GET /internal/fx-rates`: the accepted currencies (`usd` first) with their rate and freshness. */
export async function fxRatesView(r: Rails, livemode: boolean, only?: string): Promise<FxRates> {
  const fx = await fxRates(r, livemode);
  const now = new Date(r.now());
  const wanted = only ? new Set(only.split(",")) : null;
  const accepted = ["usd", ...[...r.pricing.currencies].filter((c) => c !== "usd").sort()].filter(
    (c) => r.pricing.currencies.has(c) && (!wanted || wanted.has(c)),
  );
  return {
    base: "usd",
    livemode,
    currencies: accepted.map((currency) => {
      if (currency === "usd")
        return {
          currency,
          exponent: 2,
          available: true,
          stale: false,
          reference_date: null,
          rate: fxRateView({
            currency,
            value: rational(1n),
            source: "fixed",
            referenceDate: null,
            asOf: now,
            fetchedAt: now,
            validUntil: null,
          }),
        };
      const f = fx.get(currency);
      const usable = fxUsable(f, now.getTime());
      return {
        currency,
        exponent: minorUnits(currency),
        available: usable,
        stale: f !== undefined && !usable,
        reference_date: f?.referenceDate ?? null,
        rate: f ? fxRateView(f) : null,
      };
    }),
    as_of: now.toISOString(),
  } as FxRates;
}

/**
 * One secondary-price refresh (live): every enabled live token with a CoinGecko id, one batched call. Tokens the
 * feed does not answer keep their last value (its `as_of` makes it stale in time).
 */
export async function refreshSecondary(r: Rails, provider: PriceProvider): Promise<number> {
  const rows = await r.db
    .selectFrom("tokens")
    .select(["asset_id", "coingecko_id"])
    .where("livemode", "=", true)
    .where("enabled", "=", true)
    .where("coingecko_id", "is not", null)
    .execute();
  if (rows.length === 0) return 0;
  const prices = await provider.prices(rows.map((x) => x.coingecko_id as string));
  const now = new Date(r.now());
  let written = 0;
  await r.db.transaction().execute(async (tx) => {
    for (const t of rows) {
      const p = prices.get(t.coingecko_id as string);
      if (!p) continue;
      const exact = parseExactDecimal(p.usd);
      const v = ratioToWire(exact);
      await tx
        .updateTable("tokens")
        .set({
          secondary_price_usd: toDisplayDecimal(exact),
          secondary_num: v.num,
          secondary_den: v.den,
          secondary_updated_at: p.updatedAt,
          secondary_source: provider.source,
          secondary_fetched_at: now,
        })
        .where("livemode", "=", true)
        .where("asset_id", "=", t.asset_id)
        .execute();
      written++;
    }
  });
  return written;
}
