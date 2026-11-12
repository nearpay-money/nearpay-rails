import { rational } from "@nearpay-internal/money";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  dualPrice,
  type FxObs,
  fxRate,
  fxUsable,
  indicativeUsd,
  type PricedToken,
  PricingError,
  type PricingPolicy,
  parCheck,
  pricesOf,
  secondaryBackoff,
  settle,
  settlementPrice,
  unitsForUsdMicros,
  unitValue,
  usdMicros,
  usdValue,
} from "../../src/domain/pricing/pricing.js";
import { parseExactDecimal } from "../../src/domain/pricing/ratio.js";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000);
const obs = (v: string, ageS = 10, source = "oneclick") => ({
  value: parseExactDecimal(v),
  asOf: ago(ageS),
  fetchedAt: ago(ageS),
  source,
});
const fx = (currency: string, v: string, validUntil: Date | null = new Date(NOW + 3_600_000)): FxObs => ({
  currency,
  value: parseExactDecimal(v),
  source: "ecb",
  referenceDate: "2026-11-05",
  asOf: ago(3600),
  fetchedAt: ago(60),
  validUntil,
});
const FX = new Map<string, FxObs>([
  ["eur", fx("eur", "1.08")],
  ["jpy", fx("jpy", "0.0067")],
  ["gbp", fx("gbp", "1.27", ago(1))], // stale
]);
const p: PricingPolicy = {
  ...DEFAULT_POLICY,
  currencies: new Set(["usd", "eur", "jpy", "gbp"]),
  nowMs: NOW,
  fx: (c) => FX.get(c),
};

const usdc = (over: Partial<PricedToken> = {}): PricedToken => ({
  asset_id: "nep141:usdc",
  decimals: 6,
  peg_currency: "usd",
  primary: obs("0.9995"),
  secondary: null,
  ...over,
});
const eurc = (over: Partial<PricedToken> = {}): PricedToken => ({
  asset_id: "nep141:eurc",
  decimals: 6,
  peg_currency: "eur",
  primary: obs("1.081"),
  secondary: obs("1.079", 30, "coingecko"),
  ...over,
});
const eth = (over: Partial<PricedToken> = {}): PricedToken => ({
  asset_id: "nep141:eth",
  decimals: 18,
  peg_currency: null,
  primary: obs("2500"),
  secondary: obs("2520", 100, "coingecko"),
  ...over,
});

describe("fx(c) and the staleness bound", () => {
  it("usd is exactly one without a source; others need a stored rate inside valid_until", () => {
    expect(fxRate("usd", p).value).toEqual(rational(1n));
    expect(fxRate("eur", p).value).toEqual(parseExactDecimal("1.08"));
    expect(() => fxRate("gbp", p)).toThrow(PricingError);
    expect(() => fxRate("chf", p)).toThrow(/no FX rate/);
    try {
      fxRate("gbp", p);
    } catch (e) {
      expect((e as PricingError).code).toBe("fx_rate_unavailable");
      expect((e as PricingError).subject).toBe("gbp");
      expect((e as PricingError).assetId).toBe("gbp");
    }
    expect(fxUsable(FX.get("eur"), NOW)).toBe(true);
    expect(fxUsable(FX.get("gbp"), NOW)).toBe(false);
    expect(fxUsable(undefined, NOW)).toBe(false);
    expect(fxUsable(fx("x", "1", null), NOW)).toBe(true);
    expect(() => fxRate("zero", { ...p, fx: () => fx("zero", "0") })).toThrow(PricingError);
  });
});

describe("par policy (depeg guard)", () => {
  it("USD stablecoins at par within ±2 % of 1 with a primary ≤ 5 min old", () => {
    expect(parCheck(usdc(), p).ok).toBe(true);
    expect(settlementPrice(usdc(), p)).toEqual({ usd: rational(1n), par: true });
    expect(parCheck(usdc({ primary: obs("0.98") }), p).ok).toBe(true);
    expect(parCheck(usdc({ primary: obs("1.02") }), p).ok).toBe(true);
    expect(parCheck(usdc({ primary: obs("0.979999") }), p)).toEqual({ ok: false, reason: "depeg" });
    expect(parCheck(usdc({ primary: obs("1.0201") }), p)).toEqual({ ok: false, reason: "depeg" });
    expect(parCheck(usdc({ primary: obs("1", 301) }), p)).toEqual({ ok: false, reason: "stale" });
    expect(parCheck(usdc({ primary: null }), p)).toEqual({ ok: false, reason: "stale" });
    expect(parCheck(usdc({ primary: { ...obs("1"), asOf: new Date(NOW + 120_000) } }), p)).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(parCheck(eth(), p)).toEqual({ ok: false, reason: "not_stable" });
  });

  it("a valid secondary must pass the same band; a stale one is ignored", () => {
    expect(parCheck(usdc({ secondary: obs("0.97", 10, "coingecko") }), p)).toEqual({ ok: false, reason: "depeg" });
    expect(parCheck(usdc({ secondary: obs("0.97", 301, "coingecko") }), p).ok).toBe(true);
  });

  it("par via secondary (RAILS-2): a stale or missing primary, a valid secondary within ±1 % of 1 USD", () => {
    const cg = (v: string, ageS = 30) => obs(v, ageS, "coingecko");
    const none = () => undefined;
    // 1Click price 10 min old (or absent), CoinGecko fresh at 0.9993: par via secondary
    expect(parCheck(usdc({ primary: obs("0.9995", 600), secondary: cg("0.9993") }), p)).toMatchObject({
      ok: true,
      via: "secondary",
    });
    expect(parCheck(usdc({ primary: null, secondary: cg("1.0099") }), p)).toMatchObject({ ok: true, via: "secondary" });
    // the single-source band is tighter than the ±2 % band: 0.985 passes with a fresh primary, not alone
    expect(parCheck(usdc({ primary: obs("0.985"), secondary: cg("0.985") }), p)).toMatchObject({ via: "primary" });
    expect(parCheck(usdc({ primary: null, secondary: cg("0.989") }), p)).toEqual({ ok: false, reason: "depeg" });
    expect(parCheck(usdc({ primary: obs("1", 600), secondary: cg("1.011") }), p)).toEqual({
      ok: false,
      reason: "depeg",
    });
    // a stale primary that said depeg is never overridden by the secondary
    expect(parCheck(usdc({ primary: obs("0.95", 600), secondary: cg("1") }), p)).toEqual({
      ok: false,
      reason: "depeg",
    });
    // both stale (or the secondary missing) never pass
    expect(parCheck(usdc({ primary: obs("1", 600), secondary: cg("1", 301) }), p)).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(parCheck(usdc({ primary: obs("1", 600), secondary: null }), p)).toEqual({ ok: false, reason: "stale" });
    // USD pegs only: EURC with a stale primary stays stale (no single-source par through FX)
    expect(parCheck(eurc({ primary: obs("1.081", 600) }), p)).toEqual({ ok: false, reason: "stale" });
    // the secondary that vouched for par is in the snapshot
    const s = settle({ currency: "usd", amount: 1000n }, usdc({ primary: obs("1", 600), secondary: cg("1") }), p, none);
    expect(s).toMatchObject({ amount: 10_000_000n, par: true });
    expect(s.snapshot.rates.map((r) => `${r.base}:${r.role}`)).toEqual(["nep141:usdc:secondary"]);
    const u = unitValue(usdc({ primary: null, secondary: cg("1") }), p);
    expect(u).toMatchObject({ par: true, parCurrency: "usd" });
    expect(u.rates.map((r) => r.role)).toEqual(["secondary"]);
    // EUR pricing settled in a USD stablecoin at par via secondary carries the FX rate and the secondary
    const e = settle({ currency: "eur", amount: 1000n }, usdc({ primary: null, secondary: cg("1") }), p, none);
    expect(e.snapshot.rates.map((r) => `${r.kind}:${r.base}`)).toEqual(["fx:eur", "price:nep141:usdc"]);
  });

  it("the secondary-price back-off never exceeds half the secondary freshness window", () => {
    const o = { baseMs: 60_000, secondaryMaxAgeMs: 300_000 };
    let prev = 60_000;
    const seen: number[] = [];
    for (const rand of [0, 0.5, 0.999, 0.999, 0.999]) {
      const b = secondaryBackoff(prev, { ...o, rand });
      expect(b.delayMs).toBeLessThanOrEqual(150_000);
      seen.push(b.nextMs);
      prev = b.nextMs;
    }
    expect(seen).toEqual([120_000, 150_000, 150_000, 150_000, 150_000]);
    expect(secondaryBackoff(60_000, { ...o, rand: 0 }).delayMs).toBe(96_000);
    // a window shorter than twice the base keeps the base cadence
    expect(secondaryBackoff(60_000, { baseMs: 60_000, secondaryMaxAgeMs: 90_000, rand: 0.5 })).toEqual({
      nextMs: 60_000,
      delayMs: 60_000,
    });
    expect(secondaryBackoff(0, { ...o, rand: -1 }).delayMs).toBe(96_000);
  });

  it("non-USD pegs compare with fx(peg); no usable rate disables par", () => {
    expect(parCheck(eurc(), p).ok).toBe(true);
    expect(parCheck(eurc({ primary: obs("1.11") }), p)).toEqual({ ok: false, reason: "depeg" });
    expect(parCheck(eurc({ peg_currency: "gbp" }), p)).toEqual({ ok: false, reason: "fx_unavailable" });
    expect(unitValue(eurc(), p)).toMatchObject({ par: true, parCurrency: "eur", usd: parseExactDecimal("1.08") });
    expect(unitValue(eurc(), p).rates.map((r) => r.base)).toEqual(["eur"]);
  });
});

describe("dual-source price", () => {
  it("both valid (primary ≤ 120 s, secondary ≤ 300 s) and within 1.5 % → primary", () => {
    const d = dualPrice(eth(), p);
    expect(d.ok && d.usd).toEqual(rational(2500n));
    expect(dualPrice(eth({ secondary: obs("2540") }), p)).toEqual({ ok: false, reason: "disagree" });
    expect(dualPrice(eth({ primary: obs("2500", 121) }), p)).toEqual({ ok: false, reason: "stale" });
    expect(dualPrice(eth({ secondary: obs("2500", 301) }), p)).toEqual({ ok: false, reason: "stale" });
    expect(dualPrice(eth({ secondary: obs("2500", 299) }), p).ok).toBe(true);
    expect(dualPrice(eth({ secondary: null }), p)).toEqual({ ok: false, reason: "missing" });
    expect(dualPrice(eth({ primary: obs("0") }), p)).toEqual({ ok: false, reason: "missing" });
  });

  it("no reliable price → pricing_unavailable", () => {
    expect(() => unitValue(eth({ secondary: null }), p)).toThrow(PricingError);
    const u = unitValue(eth(), p);
    expect(u.par).toBe(false);
    expect(u.rates.map((r) => `${r.role}:${r.source}`)).toEqual(["primary:oneclick", "secondary:coingecko"]);
  });
});

describe("settle (§8.2)", () => {
  const none = () => undefined;
  it("USD pricing settles USD stablecoins at par (no FX, no secondary)", () => {
    const s = settle({ currency: "usd", amount: 1234n }, usdc(), p, none);
    expect(s.amount).toBe(12_340_000n);
    expect(s.par).toBe(true);
    expect(s.snapshot).toMatchObject({ currency: "usd", par_currency: "usd", fx: null, rates: [] });
  });

  it("EUR pricing into EURC at par; into USDC via the EUR rate; into ETH via both prices", () => {
    expect(settle({ currency: "eur", amount: 1000n }, eurc(), p, none)).toMatchObject({
      amount: 10_000_000n,
      par: true,
    });
    const u = settle({ currency: "eur", amount: 1000n }, usdc(), p, none);
    expect(u.amount).toBe(10_800_000n); // 10.00 EUR × 1.08
    expect(u.snapshot.fx).toBe("1.08");
    expect(u.snapshot.rates.map((r) => r.base)).toEqual(["eur"]);
    const e = settle({ currency: "eur", amount: 250_000n }, eth(), p, none); // 2,500 EUR = 2,700 USD = 1.08 ETH
    expect(e.amount).toBe(1_080_000_000_000_000_000n);
    expect(e.par).toBe(false);
    expect(e.snapshot.rates.map((r) => `${r.kind}:${r.base}`)).toEqual([
      "fx:eur",
      "price:nep141:eth",
      "price:nep141:eth",
    ]);
  });

  it("JPY (exponent 0) and floor rounding", () => {
    const s = settle({ currency: "jpy", amount: 1000n }, usdc(), p, none); // 1000 × 0.0067 = 6.7 USD
    expect(s.amount).toBe(6_700_000n);
    const tiny = settle({ currency: "usd", amount: 1n }, eth(), p, none); // 0.01 / 2500 ETH
    expect(tiny.amount).toBe(4_000_000_000_000n);
  });

  it("refuses unaccepted currencies, stale FX, no price, sub-unit amounts", () => {
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as PricingError).code;
      }
      return null;
    };
    expect(code(() => settle({ currency: "chf", amount: 100n }, usdc(), p, none))).toBe("currency_unsupported");
    expect(code(() => settle({ currency: "chf", amount: 100n }, { ...eurc(), peg_currency: "chf" }, p, none))).toBe(
      "currency_unsupported",
    );
    expect(code(() => settle({ currency: "gbp", amount: 100n }, usdc(), p, none))).toBe("fx_rate_unavailable");
    expect(code(() => settle({ currency: "usd", amount: 100n }, eth({ secondary: null }), p, none))).toBe(
      "pricing_unavailable",
    );
    const big: PricedToken = { ...eth(), decimals: 0, primary: obs("1000000"), secondary: obs("1000000") };
    expect(code(() => settle({ currency: "usd", amount: 1n }, big, p, none))).toBe("amount_too_small");
  });

  it("asset pricing: same asset passes through; another asset via its unit value", () => {
    expect(settle({ currency: "asset", assetId: "nep141:eth", amount: 5n }, eth(), p, none).amount).toBe(5n);
    const s = settle(
      { currency: "asset", assetId: "nep141:usdc", amount: 2_000_000n },
      usdc({ asset_id: "x" }),
      p,
      (id) => (id === "nep141:usdc" ? usdc() : undefined),
    );
    expect(s).toMatchObject({ amount: 2_000_000n, par: true });
    expect(() => settle({ currency: "asset", assetId: "nep141:none", amount: 1n }, usdc(), p, none)).toThrow(
      PricingError,
    );
    const v = usdValue({ currency: "asset", assetId: "nep141:eth", amount: 10n ** 18n }, p, () => eth());
    expect(v.usd).toEqual(rational(2500n));
  });

  it("par disabled (depeg) falls back to the dual-source price", () => {
    const depegged = usdc({ primary: obs("0.95"), secondary: obs("0.951", 10, "coingecko") });
    const s = settle({ currency: "usd", amount: 100n }, depegged, p, none);
    expect(s.par).toBe(false);
    expect(s.amount).toBe(1_052_631n); // floor(1 / 0.95 × 10^6)
  });
});

describe("micros helpers", () => {
  it("usdMicros floors; unitsForUsdMicros ceils; both null without a price", () => {
    expect(usdMicros(1_234_567n, usdc(), p)).toBe(1_234_567n);
    expect(unitsForUsdMicros(1_000_000n, usdc(), p)).toBe(1_000_000n);
    const weird: PricedToken = { ...eth(), decimals: 0, primary: obs("3"), secondary: obs("3") };
    expect(unitsForUsdMicros(1_000_000n, weird, p)).toBe(1n); // ceil(1/3)
    expect(usdMicros(1n, eth({ secondary: null }), p)).toBeNull();
    expect(unitsForUsdMicros(1n, eth({ secondary: null }), p)).toBeNull();
    expect(indicativeUsd(eth())).toEqual(rational(2500n));
    expect(indicativeUsd(usdc({ primary: null }))).toBeNull();
    expect(pricesOf(eth(), p).map((r) => r.role)).toEqual(["primary", "secondary"]);
    expect(pricesOf(eth({ primary: null, secondary: null }), p)).toEqual([]);
  });
});
