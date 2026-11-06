/**
 * Explorer feed (lld/rails.md §8.5), leader-elected, live only, off until the owner provides an
 * Explorer token (`NP_EXPLORER_ENABLED`, L-RL-03). Every 5 s one request, rotating three windows:
 * (a) in-flight statuses, newest 1,000; (b) recently terminal since cursor − 30 min; (c) all
 * statuses since the cursor. A row whose status differs from the execution's raises it to the hot
 * poller at once (the poller applies the provider's own `/v0/status`, never the feed row).
 */
import type { Rails } from "../../app/context.js";
import { observationValues } from "../../app/observations.js";
import { ALL_STATUSES, type Explorer, ExplorerRateLimited, type ExplorerTx } from "../../infra/clients/explorer.js";
import { readCursor, writeCursor } from "../cursors.js";

const WINDOWS = ["inflight", "terminal", "recent"] as const;

export async function nudge(r: Rails, rows: readonly ExplorerTx[]): Promise<number> {
  if (rows.length === 0) return 0;
  const addresses = [...new Set(rows.map((x) => x.depositAddress))];
  const execs = await r.db
    .selectFrom("executions")
    .select(["id", "deposit_address", "deposit_memo", "provider_status"])
    .where("provider", "=", "oneclick")
    .where("deposit_address", "in", addresses)
    .where("terminal_at", "is", null)
    .execute();
  let nudged = 0;
  for (const x of execs) {
    const row = rows.find((t) => t.depositAddress === x.deposit_address && (t.depositMemo ?? null) === x.deposit_memo);
    if (!row || row.status === x.provider_status) continue;
    await r.db.transaction().execute(async (tx) => {
      await tx
        .insertInto("provider_observations")
        .values(observationValues(x.id, "explorer", row.status, row, null, false))
        .execute();
      await tx
        .updateTable("executions")
        .set({ has_signal: true, next_poll_at: new Date(r.now()), priority: 2 })
        .where("id", "=", x.id)
        .where("terminal_at", "is", null)
        .execute();
    });
    nudged++;
  }
  return nudged;
}

/** One feed request; returns the delay before the next (5 s, 10 s after a 429). */
export async function explorerOnce(r: Rails, ex: Explorer, turn: number): Promise<number> {
  const cursor = (await readCursor<{ at: string }>(r, "explorer"))?.at;
  const since = cursor ? new Date(cursor) : new Date(r.now() - 30 * 60_000);
  const w = WINDOWS[turn % WINDOWS.length];
  try {
    const rows =
      w === "inflight"
        ? await ex.transactions({ statuses: ["PROCESSING", "INCOMPLETE_DEPOSIT"], limit: 1000 })
        : w === "terminal"
          ? await ex.transactions({
              statuses: ["SUCCESS", "REFUNDED", "FAILED"],
              startTimestamp: new Date(since.getTime() - 30 * 60_000),
              limit: 1000,
            })
          : await ex.transactions({ statuses: ALL_STATUSES, startTimestamp: since, limit: 1000 });
    await nudge(r, rows);
    if (w === "recent") {
      const newest = rows.reduce((m, x) => {
        const t = x.createdAt ? Date.parse(x.createdAt) : Number.NaN;
        return Number.isFinite(t) && t > m ? t : m;
      }, since.getTime());
      await writeCursor(r, "explorer", { at: new Date(newest).toISOString() });
    }
    return 5_000;
  } catch (e) {
    if (e instanceof ExplorerRateLimited) return 10_000;
    throw e;
  }
}
