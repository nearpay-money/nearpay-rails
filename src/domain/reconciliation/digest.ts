/**
 * Reconciliation evidence (lld/rails.md §8.10). Pure.
 *
 * - `evidenceDigest`: sha256 (hex) over `"<ex_id>:<version>\n"` of the day's terminal executions in id order. The
 *   input order does not matter (sorted here); any version change or membership change changes the digest, so an
 *   unchanged digest means unchanged evidence and a later different digest for a closed day means late evidence.
 * - `dayComplete`: the day is closed for rails once it ended over an hour ago, every tracker cursor moved after its
 *   end and nothing created before its end is still open except holds and expired executions past tracking.
 */
import { createHash } from "node:crypto";

export interface VersionedId {
  /** Prefixed execution id (`ex_…`). */
  readonly id: string;
  readonly version: number;
}

export function evidenceDigest(rows: readonly VersionedId[]): string {
  const sorted = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.version - b.version));
  const h = createHash("sha256");
  for (const r of sorted) h.update(`${r.id}:${r.version}\n`);
  return h.digest("hex");
}

export interface CompletenessInput {
  readonly nowMs: number;
  /** Start of the next UTC day (end of the reconciled day). */
  readonly endMs: number;
  /** Last update of each tracker cursor that exists (idle trackers have none: nothing in flight on their chain). */
  readonly cursorUpdatedMs: readonly number[];
  /** Open (non-terminal, non-held, not expired past tracking) executions created before the end whose deadline is before it. */
  readonly openBeforeEnd: number;
}

export const SETTLE_MARGIN_MS = 3_600_000;

export function dayComplete(i: CompletenessInput): boolean {
  if (i.nowMs < i.endMs + SETTLE_MARGIN_MS) return false;
  if (i.cursorUpdatedMs.some((t) => t < i.endMs)) return false;
  return i.openBeforeEnd === 0;
}

/** `[start, end)` of a UTC day `YYYY-MM-DD`. */
export function utcDay(day: string): { start: Date; end: Date } {
  const start = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== day) throw new RangeError("bad day");
  return { start, end: new Date(start.getTime() + 86_400_000) };
}
