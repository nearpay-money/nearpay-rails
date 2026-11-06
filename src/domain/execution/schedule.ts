/**
 * Hot-poller schedule (lld/rails.md §8.4). Pure.
 *
 * - Signalled executions and executions with a deposit in flight poll fast: 2, 4, 8, 15, 15, … s by
 *   poll count, slowing to every 5 min once they have been in flight for 2 h.
 * - Awaiting a deposit without a signal: one sweep at deadline + 10 min (when the Explorer feed
 *   nudges executions), or every `awaitingSweepS` while the feed is off — Stage 1 has no Explorer
 *   token (L-RL-03), so the poller itself must notice unsignalled deposits.
 * - Expired executions are swept every 15 min for late refunds until deadline + 24 h.
 * - `verifying`: the verifier owns it (no polls).
 */
import type { State } from "./state.js";

export const EXPIRY_GRACE_MS = 10 * 60_000;
export const LATE_REFUND_WINDOW_MS = 24 * 3_600_000;
const FAST = [2, 4, 8, 15] as const;

export interface ScheduleInput {
  readonly state: State;
  readonly hasSignal: boolean;
  readonly pollCount: number;
  readonly createdAtMs: number;
  readonly deadlineMs: number;
  readonly nowMs: number;
  readonly explorerEnabled: boolean;
  readonly awaitingSweepS: number;
}

/** Next poll time (ms), or null when the hot poller should stop polling this execution. */
export function nextPollAt(i: ScheduleInput): number | null {
  switch (i.state) {
    case "succeeded":
    case "refunded":
    case "failed":
    case "verifying":
    case "quoting":
      return null;
    case "expired_unpaid":
      return i.nowMs >= i.deadlineMs + LATE_REFUND_WINDOW_MS ? null : i.nowMs + 15 * 60_000;
    case "held":
      // keep watching for the provider's resolution (refund) at a slow pace
      return i.nowMs + 5 * 60_000;
    case "awaiting_deposit":
      if (!i.hasSignal) {
        const sweep = i.deadlineMs + EXPIRY_GRACE_MS;
        if (i.explorerEnabled || i.nowMs >= sweep) return Math.max(sweep, i.nowMs + 60_000);
        return Math.min(i.nowMs + i.awaitingSweepS * 1000, sweep);
      }
      return fast(i);
    default:
      return fast(i);
  }
}

function fast(i: ScheduleInput): number {
  if (i.nowMs - i.createdAtMs > 2 * 3_600_000) return i.nowMs + 5 * 60_000;
  const s = FAST[Math.min(i.pollCount, FAST.length - 1)] as number;
  return i.nowMs + s * 1000;
}

/** Expiry (§5): no deposit and still `PENDING_DEPOSIT` past deadline + 10 min. */
export function isExpired(i: {
  state: State;
  depositSeen: boolean;
  providerStatus: string | null;
  deadlineMs: number;
  nowMs: number;
}): boolean {
  return (
    i.state === "awaiting_deposit" &&
    !i.depositSeen &&
    (i.providerStatus === null || i.providerStatus === "PENDING_DEPOSIT") &&
    i.nowMs > i.deadlineMs + EXPIRY_GRACE_MS
  );
}
