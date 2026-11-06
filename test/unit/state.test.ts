import { describe, expect, it } from "vitest";
import {
  canTransition,
  decideEvidence,
  decideProviderStatus,
  isTerminal,
  STATES,
  type State,
  TRANSITIONS,
} from "../../src/domain/execution/state.js";

const facts = (state: State, depositSeen = state !== "awaiting_deposit") => ({ state, depositSeen });
const to = (state: State, status: string, depositSeen?: boolean) => {
  const d = decideProviderStatus(facts(state, depositSeen), status);
  return d.kind === "move" ? d.to : null;
};

describe("provider status → execution state (domain-model §4.3 table)", () => {
  it.each([
    ["awaiting_deposit", "PENDING_DEPOSIT", null],
    ["awaiting_deposit", "KNOWN_DEPOSIT_TX", "deposit_detected"],
    ["awaiting_deposit", "INCOMPLETE_DEPOSIT", "incomplete_deposit"],
    ["awaiting_deposit", "PROCESSING", "settling"],
    ["awaiting_deposit", "SUCCESS", "verifying"],
    ["awaiting_deposit", "REFUNDED", "refunded"],
    ["deposit_detected", "PROCESSING", "settling"],
    ["deposit_detected", "INCOMPLETE_DEPOSIT", "incomplete_deposit"],
    ["deposit_detected", "KNOWN_DEPOSIT_TX", null],
    ["incomplete_deposit", "PROCESSING", "settling"],
    ["incomplete_deposit", "REFUNDED", "refunded"],
    ["settling", "SUCCESS", "verifying"],
    ["settling", "REFUNDED", "refunded"],
    ["settling", "PROCESSING", null],
    ["verifying", "SUCCESS", null],
    ["verifying", "PROCESSING", null],
    ["held", "REFUNDED", "refunded"],
    ["held", "SUCCESS", null],
    ["expired_unpaid", "REFUNDED", "refunded"],
    ["expired_unpaid", "PENDING_DEPOSIT", null],
    ["quoting", "PENDING_DEPOSIT", "awaiting_deposit"],
  ] as const)("%s + %s → %s", (from, status, want) => {
    expect(to(from, status)).toBe(want);
  });

  it("never lets a provider status alone succeed an execution (INV-2)", () => {
    for (const s of STATES) expect(to(s, "SUCCESS")).not.toBe("succeeded");
  });

  it("FAILED fails an execution without a deposit, holds one with a deposit", () => {
    expect(to("awaiting_deposit", "FAILED", false)).toBe("failed");
    expect(to("awaiting_deposit", "FAILED", true)).toBe("held");
    const d = decideProviderStatus(facts("settling"), "FAILED");
    expect(d).toEqual({ kind: "move", to: "held", heldReason: "failed_after_deposit" });
    expect(to("verifying", "FAILED")).toBe("held");
    expect(to("held", "FAILED")).toBeNull();
  });

  it("holds on unknown statuses and on contradictions, with an alert", () => {
    const d = decideProviderStatus(facts("settling"), "SOMETHING_NEW");
    expect(d).toMatchObject({ kind: "move", to: "held", heldReason: "unknown_status" });
    expect(decideProviderStatus(facts("held"), "SOMETHING_NEW").kind).toBe("none");
    const refundedAfterSuccess = decideProviderStatus(facts("verifying"), "REFUNDED");
    expect(refundedAfterSuccess).toMatchObject({ kind: "move", to: "held", alert: "REFUNDED after SUCCESS" });
  });

  it("an expired execution only refunds, or is held when the provider progresses", () => {
    expect(to("expired_unpaid", "PROCESSING")).toBe("held");
    expect(to("expired_unpaid", "SUCCESS")).toBe("held");
    expect(to("expired_unpaid", "SOMETHING_NEW")).toBe("held");
    expect(to("expired_unpaid", "FAILED")).toBe("held");
  });

  it("terminal states are absorbing", () => {
    for (const s of ["succeeded", "refunded", "failed"] as const) {
      expect(isTerminal(s)).toBe(true);
      expect(TRANSITIONS[s]).toEqual([]);
      for (const status of ["PENDING_DEPOSIT", "SUCCESS", "REFUNDED", "FAILED", "X"]) expect(to(s, status)).toBeNull();
      expect(decideEvidence(facts(s)).kind).toBe("none");
    }
  });
});

describe("evidence", () => {
  it("settles any open execution, an expired one too (a late settlement the merchant received)", () => {
    for (const s of [
      "awaiting_deposit",
      "deposit_detected",
      "incomplete_deposit",
      "settling",
      "verifying",
      "held",
      "expired_unpaid",
    ] as const)
      expect(decideEvidence(facts(s))).toEqual({ kind: "move", to: "succeeded" });
    expect(decideEvidence(facts("quoting")).kind).toBe("none");
  });

  it("every decision is an allowed transition", () => {
    for (const s of STATES) {
      for (const status of [
        "PENDING_DEPOSIT",
        "KNOWN_DEPOSIT_TX",
        "INCOMPLETE_DEPOSIT",
        "PROCESSING",
        "SUCCESS",
        "REFUNDED",
        "FAILED",
        "?",
      ]) {
        for (const seen of [true, false]) {
          const d = decideProviderStatus({ state: s, depositSeen: seen }, status);
          if (d.kind === "move") expect(canTransition(s, d.to)).toBe(true);
        }
      }
      const e = decideEvidence(facts(s));
      if (e.kind === "move") expect(canTransition(s, e.to)).toBe(true);
    }
    expect(canTransition("succeeded", "succeeded")).toBe(true);
    expect(canTransition("held", "settling")).toBe(false);
  });
});
