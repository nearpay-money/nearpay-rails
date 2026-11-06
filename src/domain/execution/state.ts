/**
 * Execution state machine (domain-model §4.3, lld/rails.md §5). Pure.
 *
 * Provider statuses never make an execution succeed (INV-2): `SUCCESS` moves it to `verifying`;
 * only evidence (watcher, indexer, verifier) moves it to `succeeded`. Unknown provider statuses go
 * to `held`. Terminal states (`succeeded`, `refunded`, `failed`) are absorbing; `expired_unpaid`
 * resolves to `refunded`, to `succeeded` when evidence of a (late) settlement arrives — evidence is
 * the truth and the merchant holds the funds (§5 "Success") — or to `held` when the provider reports
 * progress without evidence; `held` only resolves to `succeeded` (with evidence) or `refunded`.
 */

export const STATES = [
  "quoting",
  "awaiting_deposit",
  "deposit_detected",
  "incomplete_deposit",
  "settling",
  "verifying",
  "succeeded",
  "refunded",
  "failed",
  "expired_unpaid",
  "held",
] as const;
export type State = (typeof STATES)[number];

export const TERMINAL: ReadonlySet<State> = new Set(["succeeded", "refunded", "failed"]);
export const isTerminal = (s: State): boolean => TERMINAL.has(s);

/** Allowed transitions (the property tests check every applied change against this graph). */
export const TRANSITIONS: Readonly<Record<State, readonly State[]>> = {
  quoting: ["awaiting_deposit", "failed"],
  awaiting_deposit: [
    "deposit_detected",
    "incomplete_deposit",
    "settling",
    "verifying",
    "succeeded",
    "refunded",
    "failed",
    "expired_unpaid",
    "held",
  ],
  deposit_detected: ["incomplete_deposit", "settling", "verifying", "succeeded", "refunded", "held"],
  incomplete_deposit: ["settling", "verifying", "succeeded", "refunded", "held"],
  settling: ["verifying", "succeeded", "refunded", "held"],
  verifying: ["succeeded", "held"],
  held: ["succeeded", "refunded"],
  expired_unpaid: ["refunded", "succeeded", "held"],
  succeeded: [],
  refunded: [],
  failed: [],
};

export const canTransition = (from: State, to: State): boolean => from === to || TRANSITIONS[from].includes(to);

export type HeldReason = "evidence_mismatch" | "evidence_timeout" | "failed_after_deposit" | "unknown_status";

export const KNOWN_PROVIDER_STATUSES = [
  "PENDING_DEPOSIT",
  "KNOWN_DEPOSIT_TX",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
] as const;

export interface ExecutionFacts {
  readonly state: State;
  /** A deposit was seen (tx submitted, provider reported one, or a deposited amount). */
  readonly depositSeen: boolean;
}

export type Decision =
  | { readonly kind: "none" }
  | { readonly kind: "move"; readonly to: State; readonly heldReason?: HeldReason; readonly alert?: string };

const NONE: Decision = { kind: "none" };
const move = (to: State, heldReason?: HeldReason, alert?: string): Decision => ({
  kind: "move",
  to,
  ...(heldReason ? { heldReason } : {}),
  ...(alert ? { alert } : {}),
});

/**
 * The state a provider status implies for an execution (domain-model §4.3 table). Returns `none`
 * when the status does not move it (same state, a regression, or a status that only an evidence
 * source may resolve).
 */
export function decideProviderStatus(x: ExecutionFacts, status: string): Decision {
  const s = x.state;
  if (isTerminal(s)) return NONE;
  if (s === "expired_unpaid") {
    // Late progress on an expired address: the provider should only refund after the deadline.
    if (status === "REFUNDED") return move("refunded");
    if (status === "PENDING_DEPOSIT") return NONE;
    return move("held", "unknown_status", `provider ${status} after the execution expired`);
  }
  const target = (): Decision => {
    switch (status) {
      case "PENDING_DEPOSIT":
        return s === "quoting" ? move("awaiting_deposit") : NONE;
      case "KNOWN_DEPOSIT_TX":
        return s === "awaiting_deposit" ? move("deposit_detected") : NONE;
      case "INCOMPLETE_DEPOSIT":
        return s === "awaiting_deposit" || s === "deposit_detected" ? move("incomplete_deposit") : NONE;
      case "PROCESSING":
        return ["awaiting_deposit", "deposit_detected", "incomplete_deposit"].includes(s) ? move("settling") : NONE;
      case "SUCCESS":
        // Success needs evidence (INV-2): held executions are re-verified by the verifier instead.
        return ["awaiting_deposit", "deposit_detected", "incomplete_deposit", "settling"].includes(s)
          ? move("verifying")
          : NONE;
      case "REFUNDED":
        return s === "verifying" ? move("held", "unknown_status", "REFUNDED after SUCCESS") : move("refunded");
      case "FAILED":
        if (s === "verifying") return move("held", "failed_after_deposit", "FAILED after SUCCESS");
        if (s === "held") return NONE;
        return x.depositSeen || s !== "awaiting_deposit" ? move("held", "failed_after_deposit") : move("failed");
      default:
        return s === "held" ? NONE : move("held", "unknown_status", `unknown provider status ${status}`);
    }
  };
  const d = target();
  if (d.kind === "none" || d.to === s || !canTransition(s, d.to)) return NONE;
  return d;
}

/** Evidence outcome (watcher, indexer, verifier, operator) → state (§5 "Success", "Short"). */
export function decideEvidence(x: ExecutionFacts): Decision {
  // A tagged/bound match is itself a pass: any open execution may settle; expired ones need a human.
  return canTransition(x.state, "succeeded") && x.state !== "succeeded" ? move("succeeded") : NONE;
}
