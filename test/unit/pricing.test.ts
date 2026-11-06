import { rational } from "@nearpay-internal/money";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  dualPrice,
  indicativeUsd,
  type PricedToken,
  PricingError,
  parCheck,
  settle,
  settlementPrice,
  unitsForUsdMicros,
  usdMicros,
} from "../../src/domain/pricing/pricing.js";

const NOW = Date.UTC(2026, 10, 6, 6, 0, 0);
const p = { ...DEFAULT_POLICY, nowMs: NOW };
const ago = (s: number) => new Date(NOW - s * 1000);

const token = (over: Partial<PricedToken> = {}): PricedToken => ({
  asset_id: "nep141:usdc.near",
  decimals: 6,
  is_usd_stable: true,
  price_usd: "0.999442",
  price_updated_at: ago(50),
  secondary_price_usd: null,
  secondary_updated_at: null,
  ...over,
});
const ETH = token({ asset_id: "nep141:eth.near", decimals: 18, is_usd_stable: false, price_usd: "2500" });

describe("par policy and depeg guard (§8.2)", () => {
  it("settles a fresh, pegged stablecoin at par", () => {
    expect(parCheck(token(), p)).toEqual({ ok: true });
    expect(settlementPrice(token(), p)).toEqual({ usd: rational(1n), par: true });
  });

  it("guards the ±2 % band (inclusive) and freshness", () => {
    expect(parCheck(token({ price_usd: "0.98" }), p).ok).toBe(true);
    expect(parCheck(token({ price_usd: "1.02" }), p).ok).toBe(true);
    expect(parCheck(token({ price_usd: "0.979999" }), p)).toEqual({ ok: false, reason: "depeg" });
    expect(parCheck(token({ price_usd: "1.0201" }), p)).toEqual({ ok: false, reason: "depeg" });
    expect(parCheck(token({ price_updated_at: ago(301) }), p)).toEqual({ ok: false, reason: "stale" });
    expect(parCheck(token({ price_updated_at: null }), p)).toEqual({ ok: false, reason: "stale" });
    expect(parCheck(token({ price_updated_at: new Date(NOW + 120_000) }), p)).toEqual({ ok: false, reason: "stale" });
    expect(parCheck(token({ price_usd: null }), p)).toEqual({ ok: false, reason: "stale" });
    expect(parCheck(token({ price_usd: "garbage" }), p)).toEqual({ ok: false, reason: "stale" });
    expect(parCheck(token({ price_usd: "0" }), p)).toEqual({ ok: false, reason: "stale" });
    expect(parCheck(ETH, p)).toEqual({ ok: false, reason: "not_stable" });
  });
});

describe("dual-source price (non-par)", () => {
  const both = (a: string, b: string, ageA = 10, ageB = 10) =>
    token({
      ...ETH,
      price_usd: a,
      price_updated_at: ago(ageA),
      secondary_price_usd: b,
      secondary_updated_at: ago(ageB),
    });

  it("needs two fresh prices within 1.5 %", () => {
    expect(dualPrice(both("2500", "2520"), p)).toEqual({ ok: true, usd: rational(2500n) });
    expect(dualPrice(both("2500", "2540"), p)).toEqual({ ok: false, reason: "disagree" });
    expect(dualPrice(both("2500", "2500", 61), p)).toEqual({ ok: false, reason: "stale" });
    expect(dualPrice(both("2500", "2500", 10, 61), p)).toEqual({ ok: false, reason: "stale" });
    expect(dualPrice(ETH, p)).toEqual({ ok: false, reason: "missing" });
  });

  it("Stage 1 has no secondary source: non-par settlement is pricing_unavailable", () => {
    expect(() => settle({ currency: "usd", amount: 1000n }, ETH, p, () => undefined)).toThrow(PricingError);
    try {
      settlementPrice(ETH, p);
    } catch (e) {
      expect(e).toMatchObject({ code: "pricing_unavailable", assetId: "nep141:eth.near" });
    }
  });

  it("settles a non-par asset through the dual price, rounded down", () => {
    const eth = both("2500", "2510");
    const s = settle({ currency: "usd", amount: 2501n }, eth, p, () => undefined); // USD 25.01
    expect(s.amount).toBe(10_004_000_000_000_000n); // 25.01 / 2500 ETH
    expect(s.par).toBe(false);
    const odd = settle({ currency: "usd", amount: 1n }, both("3", "3"), p, () => undefined);
    expect(odd.amount).toBe(3_333_333_333_333_333n); // floor(0.01 / 3 × 10^18)
  });
});

describe("settle()", () => {
  it("fiat usd at par is exact: minor units × 10^(decimals − 2)", () => {
    const s = settle({ currency: "usd", amount: 1999n }, token(), p, () => undefined);
    expect(s.amount).toBe(19_990_000n);
    expect(s.par).toBe(true);
    expect(s.snapshot).toEqual({
      primary_usd: "0.999442",
      secondary_usd: null,
      fx: null,
      par: true,
      as_of: new Date(NOW).toISOString(),
    });
  });

  it("refuses currencies that are not enabled (Stage 1: usd only)", () => {
    expect(() => settle({ currency: "eur", amount: 100n }, token(), p, () => undefined)).toThrow(/not enabled/);
  });

  it("asset pricing: same asset passes through; another asset converts through both prices", () => {
    expect(
      settle({ currency: "asset", assetId: "nep141:usdc.near", amount: 123n }, token(), p, () => undefined).amount,
    ).toBe(123n);
    const usdt = token({ asset_id: "nep141:usdt.near" });
    const s = settle({ currency: "asset", assetId: "nep141:usdt.near", amount: 5_000_000n }, token(), p, (id) =>
      id === usdt.asset_id ? usdt : undefined,
    );
    expect(s).toMatchObject({ amount: 5_000_000n, par: true });
    expect(() =>
      settle({ currency: "asset", assetId: "nep141:x.near", amount: 1n }, token(), p, () => undefined),
    ).toThrow(/not priced/);
  });

  it("rejects amounts below one base unit", () => {
    const btc = token({
      ...ETH,
      decimals: 0,
      price_usd: "80000",
      secondary_price_usd: "80000",
      price_updated_at: ago(1),
      secondary_updated_at: ago(1),
    });
    expect(() => settle({ currency: "usd", amount: 100n }, btc, p, () => undefined)).toThrow(
      expect.objectContaining({ code: "amount_too_small" }),
    );
  });
});

describe("USD conversions", () => {
  it("usdMicros floors; unitsForUsdMicros ceils; both null without a price", () => {
    expect(usdMicros(1_234_567n, token(), p)).toBe(1_234_567n);
    expect(unitsForUsdMicros(1_000_000n, token(), p)).toBe(1_000_000n);
    const t18 = token({ decimals: 18 });
    expect(unitsForUsdMicros(1n, t18, p)).toBe(1_000_000_000_000n);
    const weird = token({
      ...ETH,
      price_usd: "3",
      secondary_price_usd: "3",
      price_updated_at: ago(1),
      secondary_updated_at: ago(1),
      decimals: 0,
    });
    expect(unitsForUsdMicros(1_000_000n, weird, p)).toBe(1n); // ceil(1/3)
    expect(usdMicros(1n, ETH, p)).toBeNull();
    expect(unitsForUsdMicros(1n, ETH, p)).toBeNull();
    expect(indicativeUsd(ETH)).toEqual(rational(2500n));
    expect(indicativeUsd(token({ price_usd: null }))).toBeNull();
  });
});
