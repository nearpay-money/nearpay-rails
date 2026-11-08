/**
 * Spec 0.2.1 properties (lld/rails.md §"Spec 0.2.1 contract changes"):
 * - Abandoning a refund leg: only a `kind: refund` execution before any deposit is abandoned (→ `expired_unpaid`,
 *   an allowed transition); a payment, a leg where money may have moved, or a terminal one is a conflict (INV-3);
 *   an abandoned leg always replays.
 * - Fee money: the payer's fee share of `amount_in` and the observed route fee never exceed the amount they are
 *   taken from, are integers (bigint), monotone in the amount, and the fee share is 0 when the merchant bears it.
 */
import { bpsOf } from "@nearpay-internal/money";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decideAbandon } from "../../src/domain/execution/abandon.js";
import { feeShareOfAmountIn, observedRouteFee } from "../../src/domain/execution/amounts.js";
import { canTransition, isTerminal, STATES, type State } from "../../src/domain/execution/state.js";

const facts = fc.record({
  kind: fc.constantFrom("payment" as const, "refund" as const),
  state: fc.constantFrom(...STATES),
  abandoned: fc.boolean(),
  depositTxHashes: fc.integer({ min: 0, max: 3 }),
  depositedAmount: fc.option(fc.bigInt({ min: 0n, max: 10n ** 20n }), { nil: null }),
  providerStatus: fc.option(
    fc.constantFrom("PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS", "REFUNDED", "FAILED", "WEIRD"),
    { nil: null },
  ),
});

describe("abandonExecution decision (property)", () => {
  it("abandons only pre-deposit refund legs, into an allowed transition; never once money may have moved", () => {
    fc.assert(
      fc.property(facts, (x) => {
        const d = decideAbandon(x);
        if (x.abandoned) {
          expect(d.kind).toBe("replay");
          return;
        }
        if (d.kind === "abandon") {
          expect(x.kind).toBe("refund");
          expect(["quoting", "awaiting_deposit", "expired_unpaid"]).toContain(x.state);
          expect(x.depositTxHashes).toBe(0);
          expect(x.depositedAmount ?? 0n).toBe(0n);
          expect([null, "PENDING_DEPOSIT"]).toContain(x.providerStatus);
          expect(canTransition(x.state as State, d.to)).toBe(true);
        } else {
          expect(d.kind).toBe("conflict");
        }
        if (x.kind === "payment" || isTerminal(x.state as State) || x.depositTxHashes > 0)
          expect(d.kind).toBe("conflict");
      }),
      { numRuns: 2000 },
    );
  });
});

describe("fee money (property)", () => {
  const amount = fc.bigInt({ min: 0n, max: 10n ** 30n });
  const bps = fc.integer({ min: 0, max: 500 });
  it("fee share of amount_in: ≤ amount_in, = bpsOf for the payer, 0 for the merchant, monotone", () => {
    fc.assert(
      fc.property(amount, amount, bps, (a, b, f) => {
        const payer = feeShareOfAmountIn(a.toString(), f, "payer") as bigint;
        expect(payer).toBe(f === 0 ? 0n : bpsOf(a, f));
        expect(payer <= a).toBe(true);
        expect(feeShareOfAmountIn(a.toString(), f, "merchant")).toBe(0n);
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        expect(
          (feeShareOfAmountIn(lo.toString(), f, "payer") as bigint) <=
            (feeShareOfAmountIn(hi.toString(), f, "payer") as bigint),
        ).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it("observed route fee: the sum of reported bps on the settled amountIn; unknown inputs stay null", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 30n }),
        fc.array(fc.integer({ min: 0, max: 300 }), { maxLength: 3 }),
        (a, fees) => {
          const got = observedRouteFee(
            a.toString(),
            fees.map((fee) => ({ fee })),
          );
          const total = fees.reduce((s, x) => s + x, 0);
          expect(got).toBe(bpsOf(a, total));
          expect((got as bigint) <= a).toBe(true);
          expect(observedRouteFee(a.toString(), null)).toBeNull();
          expect(
            observedRouteFee(
              "0",
              fees.map((fee) => ({ fee })),
            ),
          ).toBeNull();
        },
      ),
      { numRuns: 1000 },
    );
  });
});
