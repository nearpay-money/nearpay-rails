/**
 * Poller nudges from chain watchers (lld/rails.md §21.2): a watcher that sees activity on a deposit or destination
 * address of an in-flight execution sets `has_signal` and makes it due now, like the Explorer feed (§8.5). A nudge is
 * scheduling only — it never moves a state (INV-2): the hot poller then reads the provider's status (which carries
 * the destination tx hash the verifier needs).
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
