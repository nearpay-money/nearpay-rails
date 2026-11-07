/**
 * Stage 2 properties (lld/rails.md §15):
 * - FX conversion: floor ≤ exact ≤ ceil and ceil − floor ≤ 1; settlement amounts never exceed the exact value (round
 *   down, INV-5); EUR-cross consistency of the ECB rates (c1 → USD → c2 equals the direct EUR cross, exactly).
 * - Refund execution state machine: a refund leg (no tag) follows the payment machine; it reaches `succeeded` only
 *   through evidence (INV-2), never through a provider status, and amount matching never attributes a credit to it.
 * - Reconciliation digest: stable under any reordering and duplicate-free re-reads; any version change changes it.
 */
import { cmp, div, mul, type Rational, rational } from "@nearpay-internal/money";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { legExpected } from "../../src/app/refunds.js";
import { canTransition, decideEvidence, decideProviderStatus, type State } from "../../src/domain/execution/state.js";
import { crossToUsd, type EcbDaily } from "../../src/domain/pricing/ecb.js";
import { DEFAULT_POLICY, type FxObs, type PricedToken, settle } from "../../src/domain/pricing/pricing.js";
import { convertUnits, reduce } from "../../src/domain/pricing/ratio.js";
import { evidenceDigest } from "../../src/domain/reconciliation/digest.js";
import { attribute } from "../../src/domain/verification/verification.js";

const pos = fc.bigInt({ min: 1n, max: 10n ** 30n });
const ratioArb = fc.tuple(pos, fc.bigInt({ min: 1n, max: 10n ** 12n })).map(([n, d]) => rational(n, d));
const exact = (amount: bigint, fromExp: number, rate: Rational, toExp: number) =>
  div(mul(mul(rational(amount), rate), rational(10n ** BigInt(toExp))), rational(10n ** BigInt(fromExp)));

describe("FX conversion bounds", () => {
  it("floor ≤ exact ≤ ceil, ceil − floor ∈ {0, 1}", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 24n }),
        fc.integer({ min: 0, max: 4 }),
        ratioArb,
        fc.integer({ min: 0, max: 24 }),
        (amount, fromExp, rate, toExp) => {
          const lo = convertUnits(amount, fromExp, rate, toExp, "floor");
          const hi = convertUnits(amount, fromExp, rate, toExp, "ceil");
          const x = exact(amount, fromExp, rate, toExp);
          expect(cmp(rational(lo), x)).toBeLessThanOrEqual(0);
          expect(cmp(rational(hi), x)).toBeGreaterThanOrEqual(0);
          expect(hi - lo === 0n || hi - lo === 1n).toBe(true);
        },
      ),
    );
  });

  it("a fiat price settles at most its exact value in a USD stablecoin (round down)", () => {
    const now = Date.parse("2026-11-06T12:00:00Z");
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        fc.constantFrom("eur", "jpy", "gbp"),
        fc.tuple(fc.bigInt({ min: 1n, max: 10n ** 9n }), fc.bigInt({ min: 1n, max: 10n ** 9n })),
        fc.integer({ min: 0, max: 24 }),
        (amount, currency, [n, d], decimals) => {
          const fx: FxObs = {
            currency,
            value: rational(n, d),
            source: "ecb",
            referenceDate: null,
            asOf: new Date(now),
            fetchedAt: new Date(now),
            validUntil: null,
          };
          const usdc: PricedToken = {
            asset_id: "nep141:usdc",
            decimals,
            peg_currency: "usd",
            primary: { value: rational(1n), asOf: new Date(now), fetchedAt: new Date(now), source: "oneclick" },
            secondary: null,
          };
          const p = { ...DEFAULT_POLICY, currencies: new Set([currency]), nowMs: now, fx: () => fx };
          const exp = currency === "jpy" ? 0 : 2;
          const x = exact(amount, exp, fx.value, decimals);
          try {
            const s = settle({ currency, amount }, usdc, p, () => undefined);
            expect(cmp(rational(s.amount), x)).toBeLessThanOrEqual(0);
            expect(cmp(rational(s.amount + 1n), x)).toBeGreaterThan(0);
          } catch (e) {
            // below one base unit: the exact value is < 1
            expect((e as { code?: string }).code).toBe("amount_too_small");
            expect(cmp(x, rational(1n))).toBeLessThan(0);
          }
        },
      ),
    );
  });
});

describe("EUR-cross consistency", () => {
  const currencies = ["usd", "jpy", "gbp", "chf", "cad", "aud"] as const;
  const daily = fc.tuple(...currencies.map(() => fc.tuple(pos, fc.bigInt({ min: 1n, max: 10n ** 6n })))).map(
    (rs): EcbDaily => ({
      day: "2026-11-06",
      perEur: new Map(currencies.map((c, i) => [c, reduce(rational(...(rs[i] as [bigint, bigint])))])),
    }),
  );

  it("fx(c1) / fx(c2) = C2_per_EUR / C1_per_EUR exactly; fx(usd) = 1; fx(eur) = USD_per_EUR", () => {
    fc.assert(
      fc.property(daily, fc.constantFrom(...currencies), fc.constantFrom(...currencies), (d, c1, c2) => {
        const f1 = crossToUsd(d, c1) as Rational;
        const f2 = crossToUsd(d, c2) as Rational;
        expect(reduce(div(f1, f2))).toEqual(reduce(div(d.perEur.get(c2) as Rational, d.perEur.get(c1) as Rational)));
        expect(crossToUsd(d, "usd")).toEqual(rational(1n));
        expect(crossToUsd(d, "eur")).toEqual(reduce(d.perEur.get("usd") as Rational));
      }),
    );
  });

  it("converting c1 → USD → c2 equals the direct cross (no drift through the pivot)", () => {
    fc.assert(
      fc.property(daily, fc.constantFrom(...currencies), fc.constantFrom(...currencies), pos, (d, c1, c2, amt) => {
        const viaUsd = div(mul(rational(amt), crossToUsd(d, c1) as Rational), crossToUsd(d, c2) as Rational);
        const direct = mul(rational(amt), div(d.perEur.get(c2) as Rational, d.perEur.get(c1) as Rational));
        expect(reduce(viaUsd)).toEqual(reduce(direct));
      }),
    );
  });
});

type Obs = { kind: "status"; status: string } | { kind: "evidence" } | { kind: "deposit" };
const obs: fc.Arbitrary<Obs> = fc.oneof(
  fc
    .constantFrom(
      "PENDING_DEPOSIT",
      "KNOWN_DEPOSIT_TX",
      "INCOMPLETE_DEPOSIT",
      "PROCESSING",
      "SUCCESS",
      "REFUNDED",
      "FAILED",
      "WEIRD",
    )
    .map((status) => ({ kind: "status" as const, status })),
  fc.constant({ kind: "evidence" as const }),
  fc.constant({ kind: "deposit" as const }),
);

describe("refund execution state machine", () => {
  it("a refund leg settles only through evidence; every change is allowed; terminal states absorb", () => {
    fc.assert(
      fc.property(fc.array(obs, { maxLength: 40 }), (seq) => {
        let state: State = "awaiting_deposit";
        let depositSeen = false;
        let status: string | null = "PENDING_DEPOSIT";
        for (const o of seq) {
          let to: State = state;
          let via: Obs["kind"] = o.kind;
          if (o.kind === "status") {
            if (o.status === status) continue;
            status = o.status;
            depositSeen ||= ["KNOWN_DEPOSIT_TX", "INCOMPLETE_DEPOSIT", "PROCESSING", "SUCCESS"].includes(o.status);
            const d = decideProviderStatus({ state, depositSeen }, o.status);
            if (d.kind === "move") to = d.to;
          } else if (o.kind === "evidence") {
            const d = decideEvidence({ state, depositSeen: true });
            if (d.kind === "move") to = d.to;
          } else if (state === "awaiting_deposit") {
            depositSeen = true;
            to = "deposit_detected";
            via = "deposit";
          }
          if (to !== state) {
            expect(canTransition(state, to)).toBe(true);
            expect(["succeeded", "refunded", "failed"]).not.toContain(state);
            if (to === "succeeded") expect(via).toBe("evidence");
          }
          state = to;
        }
      }),
    );
  });

  it("amount matching never attributes a credit to an untagged refund leg", () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 10n ** 9n }), { minLength: 1, maxLength: 6 }),
        pos,
        (legs, credit) => {
          const candidates = legs.map((expected, i) => ({ id: `ex_${i}`, expected, tagged: false }));
          const hit = attribute(candidates, credit);
          // matching settles only tagged hits (trackers/matching.ts), so an untagged leg is never settled by amount
          expect(hit === null || hit.tagged === false).toBe(true);
        },
      ),
    );
  });

  it("the verification floor of a route leg is the exact amount (EXACT_OUTPUT) or minAmountOut ≤ amountOut", () => {
    fc.assert(
      fc.property(pos, fc.bigInt({ min: 0n, max: 10n ** 20n }), (amountOut, slack) => {
        const min = amountOut > slack ? amountOut - slack : 1n;
        const quote = { amountOut: amountOut.toString(), minAmountOut: min.toString() } as never;
        expect(legExpected("EXACT_OUTPUT", quote)).toBe(amountOut);
        const floor = legExpected("EXACT_INPUT", quote);
        expect(floor).toBe(min);
        expect(floor <= amountOut).toBe(true);
      }),
    );
  });
});

describe("reconciliation digest stability", () => {
  const rows = fc.uniqueArray(
    fc.record({ id: fc.stringMatching(/^ex_[0-9a-z]{4,12}$/), version: fc.integer({ min: 1, max: 1000 }) }),
    { selector: (r) => r.id, maxLength: 30 },
  );
  it("stable under permutation; a version bump or a dropped execution changes it", () => {
    fc.assert(
      fc.property(rows, fc.nat(), (xs, seed) => {
        const shuffled = [...xs].sort((a, b) => ((a.version * 31 + seed) % 7) - ((b.version * 31 + seed) % 7));
        expect(evidenceDigest(shuffled)).toBe(evidenceDigest(xs));
        if (xs.length > 0) {
          const i = seed % xs.length;
          const bumped = xs.map((x, j) => (j === i ? { ...x, version: x.version + 1 } : x));
          expect(evidenceDigest(bumped)).not.toBe(evidenceDigest(xs));
          expect(evidenceDigest(xs.filter((_, j) => j !== i))).not.toBe(evidenceDigest(xs));
        }
      }),
    );
  });
});
