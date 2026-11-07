/**
 * Audit finding 4 (stage 2): a refund quote must bound what the payer receives (EXACT_INPUT) and what the merchant
 * pays (EXACT_OUTPUT) against NearPay's own pricing (lld/rails.md §8.1 step 10, §8.2):
 * - EXACT_INPUT: minAmountOut ≥ floor(amountOut × (10 000 − SLIPPAGE[route]) / 10 000) and amountOut within the
 *   dual-source agreement band (150 bps) of settle(amount);
 * - EXACT_OUTPUT: amountIn ≤ amount × (10 000 + band + SLIPPAGE[route]) / 10 000 (amount = the priced value of the
 *   requested amountOut, in source units).
 * Properties over random quotes: every accepted quote satisfies the bounds; every quote violating one is refused.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkRefundBounds, REFUND_PRICE_BAND_BPS } from "../../src/domain/execution/integrity.js";

const SLIPPAGE = { same_asset: 30, stable_pair: 50, volatile: 100 } as const;
const slip = fc.constantFrom(...Object.values(SLIPPAGE));
const big = fc.bigInt({ min: 1n, max: 10n ** 27n });
const TEN_K = 10_000n;

const exin = (amount: bigint, pricedOut: bigint, slippageBps: number, amountOut: bigint, minAmountOut: bigint) =>
  checkRefundBounds({
    swapType: "EXACT_INPUT",
    amount,
    pricedOut,
    slippageBps,
    bandBps: REFUND_PRICE_BAND_BPS,
    quote: { amountIn: amount.toString(), amountOut: amountOut.toString(), minAmountOut: minAmountOut.toString() },
  });
const exout = (amount: bigint, pricedOut: bigint, slippageBps: number, amountIn: bigint) =>
  checkRefundBounds({
    swapType: "EXACT_OUTPUT",
    amount,
    pricedOut,
    slippageBps,
    bandBps: REFUND_PRICE_BAND_BPS,
    quote: { amountIn: amountIn.toString(), amountOut: pricedOut.toString(), minAmountOut: pricedOut.toString() },
  });

describe("refund quote bounds — examples", () => {
  it("the band is the dual-source agreement band (1.5 %)", () => {
    expect(REFUND_PRICE_BAND_BPS).toBe(150);
  });

  it("EXACT_INPUT: accepts a 1 % route cost with minAmountOut at the route slippage", () => {
    // 5 USDC → USDC, priced 5 000 000 out; quote 4 950 000 out, floor at 30 bps
    expect(exin(5_000_000n, 5_000_000n, 30, 4_950_000n, 4_935_150n)).toEqual([]);
  });

  it("EXACT_INPUT: refuses a minAmountOut below the route slippage (the payer's floor is unbounded)", () => {
    expect(exin(5_000_000n, 5_000_000n, 30, 4_950_000n, 4_935_149n)).toEqual([
      "minAmountOut 4935149 < 4935150 (amountOut 4950000 − 30 bps slippage)",
    ]);
    // the audit scenario: minAmountOut = 1 passes the old 0 < minAmountOut ≤ amountOut check
    expect(exin(5_000_000n, 5_000_000n, 30, 4_950_000n, 1n).length).toBe(1);
  });

  it("EXACT_INPUT: refuses an amountOut outside the price band, either side", () => {
    expect(exin(5_000_000n, 5_000_000n, 30, 4_925_000n, 4_925_000n)).toEqual([]); // exactly −150 bps
    expect(exin(5_000_000n, 5_000_000n, 30, 4_924_999n, 4_924_999n)).toEqual([
      "amountOut 4924999 outside ±150 bps of the priced 5000000",
    ]);
    expect(exin(5_000_000n, 5_000_000n, 30, 5_075_000n, 5_075_000n)).toEqual([]); // exactly +150 bps
    expect(exin(5_000_000n, 5_000_000n, 30, 5_075_001n, 5_075_001n).length).toBe(1);
    // a quote delivering a tenth of the value (the payer loses 90 %)
    expect(exin(5_000_000n, 5_000_000n, 30, 500_000n, 500_000n).length).toBe(1);
  });

  it("EXACT_OUTPUT: caps amountIn at band + slippage above the priced value", () => {
    // 5 USDC priced → 5 000 000 out; cap = 5 000 000 × (10 000 + 150 + 30) / 10 000 = 5 090 000
    expect(exout(5_000_000n, 5_000_000n, 30, 5_050_000n)).toEqual([]);
    expect(exout(5_000_000n, 5_000_000n, 30, 5_090_000n)).toEqual([]);
    expect(exout(5_000_000n, 5_000_000n, 30, 5_090_001n)).toEqual([
      "amountIn 5090001 > 5090000 (priced 5000000 + 150 bps band + 30 bps slippage)",
    ]);
    expect(exout(5_000_000n, 5_000_000n, 30, 50_000_000n).length).toBe(1);
  });

  it("refuses unparseable amounts and a zero priced value (fail closed)", () => {
    expect(
      checkRefundBounds({
        swapType: "EXACT_INPUT",
        amount: 1n,
        pricedOut: 0n,
        slippageBps: 30,
        bandBps: 150,
        quote: { amountIn: "1", amountOut: "1", minAmountOut: "1" },
      }),
    ).toEqual(["priced value of the refund is zero"]);
    expect(
      checkRefundBounds({
        swapType: "EXACT_INPUT",
        amount: 1n,
        pricedOut: 1n,
        slippageBps: 30,
        bandBps: 150,
        quote: { amountIn: "1", amountOut: "1e3", minAmountOut: "1" },
      }),
    ).toEqual(["refund quote amounts are not base-unit integers"]);
  });
});

describe("refund quote bounds — properties over random quotes", () => {
  it("EXACT_INPUT: accepted ⇔ minAmountOut ≥ floor(amountOut × (1 − slippage)) and amountOut within the band", () => {
    fc.assert(
      fc.property(
        big,
        big,
        slip,
        big,
        fc.bigInt({ min: 0n, max: TEN_K }),
        (amount, pricedOut, s, amountOut, minBps) => {
          // minAmountOut anywhere from 0 to amountOut (the old check already refuses outside that range)
          const minAmountOut = (amountOut * minBps) / TEN_K;
          const failures = exin(amount, pricedOut, s, amountOut, minAmountOut);
          const floorOk = minAmountOut >= (amountOut * (TEN_K - BigInt(s))) / TEN_K;
          const bandOk =
            amountOut * TEN_K >= pricedOut * (TEN_K - 150n) && amountOut * TEN_K <= pricedOut * (TEN_K + 150n);
          expect(failures.length === 0).toBe(floorOk && bandOk);
          if (failures.length === 0) {
            // what the payer is guaranteed: at least (1 − band)(1 − slippage) of the priced value, less one unit
            expect(minAmountOut * TEN_K * TEN_K + TEN_K * TEN_K).toBeGreaterThanOrEqual(
              pricedOut * (TEN_K - 150n) * (TEN_K - BigInt(s)),
            );
          }
        },
      ),
    );
  });

  it("EXACT_INPUT: a quote near the price with the provider's own slippage floor is always accepted", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 10n ** 4n, max: 10n ** 27n }),
        slip,
        fc.integer({ min: -150, max: 150 }),
        (p, s, dev) => {
          const amountOut = (p * (TEN_K + BigInt(dev))) / TEN_K;
          // 1Click/sandbox: minAmountOut = floor(amountOut × (10 000 − slippage) / 10 000)
          const minAmountOut = (amountOut * (TEN_K - BigInt(s))) / TEN_K;
          const inBand = amountOut * TEN_K >= p * (TEN_K - 150n);
          expect(exin(p, p, s, amountOut, minAmountOut).length === 0).toBe(inBand);
        },
      ),
    );
  });

  it("EXACT_OUTPUT: accepted ⇔ amountIn ≤ amount × (1 + band + slippage)", () => {
    fc.assert(
      fc.property(big, big, slip, big, (amount, pricedOut, s, amountIn) => {
        const ok = amountIn * TEN_K <= amount * (TEN_K + 150n + BigInt(s));
        expect(exout(amount, pricedOut, s, amountIn).length === 0).toBe(ok);
      }),
    );
  });
});
