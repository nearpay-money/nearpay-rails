/**
 * Poller nudges from chain watchers (lld/rails.md §21.2): a watcher that sees activity on a deposit or destination
 * address of an in-flight execution sets `has_signal` and makes it due now, like the Explorer feed (§8.5). A nudge is
 * scheduling only — it never moves a state (INV-2): the hot poller then reads the provider's status (which carries
 * the destination tx hash the verifier needs). For an execution the verifier already owns (`verifying`, or `held` while
 * the provider claims success), {@link verifyNow} makes its next verification due at once instead (ADR-0022 as
 * amended: time-to-"Paid").
 */
import type { Rails } from "../app/context.js";

/** States the hot poller owns (verifying/held belong to the verifier; terminal and expired need no nudge). */
export const NUDGEABLE_STATES = ["awaiting_deposit", "deposit_detected", "incomplete_deposit", "settling"] as const;

export async function nudge(r: Rails, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const now = new Date(r.now());
  const res = await r.db
    .updateTable("executions")
    .set({ has_signal: true, next_poll_at: now, priority: 2 })
    .where("id", "in", [...new Set(ids)])
    .where("livemode", "=", true)
    .where("terminal_at", "is", null)
    .where("state", "in", [...NUDGEABLE_STATES])
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0n);
}

/** States whose next step is the verifier's (§8.8). */
export const VERIFIABLE_STATES = ["verifying", "held"] as const;

/**
 * Chain activity for executions the verifier owns: `verify_at = now()` when their next verification is scheduled
 * later (a retry, or a claim's lease — a second concurrent attempt is harmless: evidence applies under the row lock and
 * a settled row is skipped). Scheduling only — evidence still comes from the verifier's own read (INV-2).
 */
export async function verifyNow(r: Rails, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const now = new Date(r.now());
  const res = await r.db
    .updateTable("executions")
    .set({ verify_at: now })
    .where("id", "in", [...new Set(ids)])
    .where("livemode", "=", true)
    .where("terminal_at", "is", null)
    .where("state", "in", [...VERIFIABLE_STATES])
    .where("verify_at", "is not", null)
    .where("verify_at", ">", now)
    .executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0n);
}
