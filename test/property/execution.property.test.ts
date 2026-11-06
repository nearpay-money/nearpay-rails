/**
 * lld/rails.md §15 property: for any sequence of observations (duplicates, reordering, conflicting
 * sources) an execution never leaves a terminal state; `expired_unpaid` only resolves to `refunded`,
 * `succeeded` (late evidence) or `held`; `held` only to `succeeded` or `refunded`; `succeeded` only through
 * evidence (INV-2); and tags stay unique among in-flight executions per destination.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { tagCandidates } from "../../src/domain/execution/amounts.js";
import { isExpired } from "../../src/domain/execution/schedule.js";
import {
  canTransition,
  decideEvidence,
  decideProviderStatus,
  isTerminal,
  type State,
} from "../../src/domain/execution/state.js";
import { attribute } from "../../src/domain/verification/verification.js";

type Obs = { kind: "status"; status: string } | { kind: "evidence" } | { kind: "deposit" } | { kind: "expire" };

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
      "MYSTERY",
    )
    .map((status) => ({ kind: "status" as const, status })),
  fc.constant({ kind: "evidence" as const }),
  fc.constant({ kind: "deposit" as const }),
  fc.constant({ kind: "expire" as const }),
);

/** Mirrors app/observations.ts: a provider status, evidence, a submitted deposit or the expiry sweep. */
function run(seq: readonly Obs[]) {
  let state: State = "awaiting_deposit";
  let depositSeen = false;
  let providerStatus: string | null = "PENDING_DEPOSIT";
  const path: { from: State; to: State; via: Obs["kind"] }[] = [];
  const go = (to: State, via: Obs["kind"]) => {
    if (to !== state) path.push({ from: state, to, via });
    state = to;
  };
  for (const o of seq) {
    if (o.kind === "status") {
      if (o.status === providerStatus) continue; // app/observations.ts: only a changed status moves the state
      providerStatus = o.status;
      if (o.status !== "PENDING_DEPOSIT")
        depositSeen ||= ["KNOWN_DEPOSIT_TX", "INCOMPLETE_DEPOSIT", "PROCESSING", "SUCCESS"].includes(o.status);
      const d = decideProviderStatus({ state, depositSeen }, o.status);
      if (d.kind === "move") go(d.to, "status");
    } else if (o.kind === "evidence") {
      const d = decideEvidence({ state, depositSeen: true });
      if (d.kind === "move") go(d.to, "evidence");
    } else if (o.kind === "deposit") {
      if (state === "awaiting_deposit") {
        depositSeen = true;
        go("deposit_detected", "deposit");
      }
    } else if (isExpired({ state, depositSeen, providerStatus, deadlineMs: 0, nowMs: 1e12 })) {
      go("expired_unpaid", "expire");
    }
  }
  return { state, path };
}

describe("execution state machine under arbitrary observation sequences", () => {
  it("every change is an allowed transition; terminal states are absorbing", () => {
    fc.assert(
      fc.property(fc.array(obs, { maxLength: 40 }), (seq) => {
        const { path } = run(seq);
        for (const step of path) {
          expect(canTransition(step.from, step.to)).toBe(true);
          expect(isTerminal(step.from)).toBe(false);
          if (step.from === "expired_unpaid") expect(["refunded", "succeeded", "held"]).toContain(step.to);
          if (step.from === "held") expect(["succeeded", "refunded"]).toContain(step.to);
        }
      }),
      { numRuns: 2_000 },
    );
  });

  it("succeeded only through evidence (INV-2)", () => {
    fc.assert(
      fc.property(fc.array(obs, { maxLength: 40 }), (seq) => {
        for (const step of run(seq).path) if (step.to === "succeeded") expect(step.via).toBe("evidence");
      }),
      { numRuns: 2_000 },
    );
  });

  it("duplicates and reorderings of the same observations never break the invariants", () => {
    fc.assert(
      fc.property(fc.array(obs, { minLength: 1, maxLength: 20 }), fc.integer({ min: 1, max: 3 }), (seq, k) => {
        const dup = seq.flatMap((o) => Array.from({ length: k }, () => o));
        const a = run(seq);
        const b = run(dup);
        // replaying each observation k times converges to the same state
        expect(b.state).toBe(a.state);
        const rev = run([...seq].reverse());
        for (const step of rev.path) expect(canTransition(step.from, step.to)).toBe(true);
      }),
      { numRuns: 1_000 },
    );
  });
});

describe("amount attribution", () => {
  it("allocated tags keep base + tag unique, so an exact amount names one execution", () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1_000_000n, max: 1_000_200n }), { minLength: 1, maxLength: 60 }),
        fc.integer({ min: 100, max: 300 }),
        (bases, space) => {
          // the database's unique (destination_key, expected) index, simulated
          const taken = new Set<bigint>();
          const live: { id: number; expected: bigint }[] = [];
          bases.forEach((base, id) => {
            const candidates = [
              ...tagCandidates(space, Math.random),
              ...Array.from({ length: space }, (_, i) => i + 1),
            ];
            for (const t of candidates) {
              const expected = base + BigInt(t);
              if (taken.has(expected)) continue;
              taken.add(expected);
              live.push({ id, expected });
              break;
            }
          });
          for (const x of live) expect(attribute(live, x.expected)?.id).toBe(x.id);
        },
      ),
      { numRuns: 300 },
    );
  });
});
