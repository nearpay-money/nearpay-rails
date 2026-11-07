/**
 * Explorer feed (lld/rails.md §8.5), leader-elected. Live: runs with the owner's Explorer token, one request every
 * 5 s (10 s after a 429); test mode: the sandbox mirror every 1 s, same code. Three windows rotate:
 * (a) `inflight` — `PENDING_DEPOSIT,INCOMPLETE_DEPOSIT,PROCESSING` newest 1,000;
 * (b) `terminal` — `SUCCESS,REFUNDED,FAILED` since cursor − 30 min;
 * (c) `recent`   — every status since the cursor (advances the cursor by the newest `createdAt`).
 * A window that returns a full page (1,000) continues on its next turn with `lastDepositAddress`/`lastDepositMemo`
 * (`direction=next`) until a page is short.
 *
 * Change detection: only rows whose status differs from `executions.explorer_status` are recorded (observation
 * `explorer`, payload hash) and stored on the row; for a non-terminal execution they also nudge the hot poller,
 * which applies the provider's own `/v0/status` (the feed row never moves a state, INV-2). An unknown status is
 * recorded and nudges too (the status mapping decides `held`). Terminal executions keep receiving
 * `explorer_status` (Tier-B cross-check, §8.10). Rows of unknown deposit addresses are ignored and counted.
 */
import type { Rails } from "../../app/context.js";
import { observationValues } from "../../app/observations.js";
import {
  ALL_STATUSES,
  type Explorer,
  ExplorerRateLimited,
  type ExplorerTx,
  ExplorerUnavailable,
} from "../../infra/clients/explorer.js";
import { readCursor, writeCursor } from "../cursors.js";

export const WINDOWS = ["inflight", "terminal", "recent"] as const;
type Window = (typeof WINDOWS)[number];
const PAGE = 1000;
const WINDOW_STATUSES: Record<Window, readonly string[]> = {
  inflight: ["PENDING_DEPOSIT", "INCOMPLETE_DEPOSIT", "PROCESSING"],
  terminal: ["SUCCESS", "REFUNDED", "FAILED"],
  recent: ALL_STATUSES,
};

interface Page {
  readonly depositAddress: string;
  readonly depositMemo: string | null;
  /** Fixed lower bound of the window being paged (terminal/recent). */
  readonly since?: string;
}

export interface ExplorerCursor {
  /** Newest `createdAt` seen by the `recent` window. */
  at?: string;
  /** Continuation of a window whose last page was full. */
  pages?: Partial<Record<Window, Page>>;
}

export const cursorName = (livemode: boolean) => (livemode ? "explorer" : "explorer:test");

export interface FeedResult {
  readonly rows: number;
  readonly recorded: number;
  readonly nudged: number;
  readonly unmatched: number;
}

/** Applies one page of rows: change detection against `explorer_status`, observation, nudge. */
export async function applyRows(r: Rails, livemode: boolean, rows: readonly ExplorerTx[]): Promise<FeedResult> {
  if (rows.length === 0) return { rows: 0, recorded: 0, nudged: 0, unmatched: 0 };
  const addresses = [...new Set(rows.map((x) => x.depositAddress))];
  const execs = await r.db
    .selectFrom("executions")
    .select(["id", "deposit_address", "deposit_memo", "explorer_status", "terminal_at"])
    .where("livemode", "=", livemode)
    .where("provider", "=", livemode ? "oneclick" : "sandbox")
    .where("deposit_address", "in", addresses)
    .execute();
  const key = (a: string, m: string | null | undefined) => `${a}\u0000${m ?? ""}`;
  const byKey = new Map(execs.map((x) => [key(x.deposit_address as string, x.deposit_memo), x]));
  let recorded = 0;
  let nudged = 0;
  let unmatched = 0;
  const seen = new Set<string>();
  for (const row of rows) {
    const k = key(row.depositAddress, row.depositMemo);
    if (seen.has(k)) continue; // one row per deposit per page (newest first)
    seen.add(k);
    const x = byKey.get(k);
    if (!x) {
      unmatched++;
      continue;
    }
    if (row.status === x.explorer_status) continue;
    const now = new Date(r.now());
    const open = x.terminal_at === null;
    await r.db.transaction().execute(async (tx) => {
      await tx
        .insertInto("provider_observations")
        .values(observationValues(x.id, "explorer", row.status, row, null, false))
        .execute();
      await tx
        .updateTable("executions")
        .set({
          explorer_status: row.status,
          explorer_seen_at: now,
          ...(open ? { has_signal: true, next_poll_at: now, priority: 2 } : {}),
        })
        .where("id", "=", x.id)
        .execute();
    });
    recorded++;
    if (open) nudged++;
  }
  if (unmatched) r.log.debug({ unmatched, livemode }, "explorer rows of unknown deposit addresses ignored");
  return { rows: rows.length, recorded, nudged, unmatched };
}

/** @deprecated Stage 1 name. */
export const nudge = (r: Rails, rows: readonly ExplorerTx[]) => applyRows(r, true, rows).then((x) => x.nudged);

/**
 * One feed request (the window rotates with `turn`); returns the delay before the next. Live: 5 s, 10 s after a
 * 429. Test mode: 1 s; 60 s while the sandbox build has no mirror.
 */
export async function explorerOnce(r: Rails, ex: Explorer, turn: number): Promise<number> {
  const name = cursorName(ex.livemode);
  const cadence = ex.livemode ? 5_000 : 1_000;
  const c: ExplorerCursor = (await readCursor<ExplorerCursor>(r, name)) ?? {};
  const since = c.at ? new Date(c.at) : new Date(r.now() - 30 * 60_000);
  const w = WINDOWS[turn % WINDOWS.length] as Window;
  const page = c.pages?.[w];
  const lower =
    w === "inflight"
      ? undefined
      : page?.since
        ? new Date(page.since)
        : w === "terminal"
          ? new Date(since.getTime() - 30 * 60_000)
          : since;
  try {
    const rows = await ex.transactions({
      statuses: WINDOW_STATUSES[w],
      limit: PAGE,
      ...(lower ? { startTimestamp: lower } : {}),
      ...(page ? { after: { depositAddress: page.depositAddress, depositMemo: page.depositMemo } } : {}),
    });
    const res = await applyRows(r, ex.livemode, rows);
    r.metrics.explorer(res);
    const next: ExplorerCursor = { ...c, pages: { ...c.pages } };
    const last = rows[rows.length - 1];
    if (rows.length >= PAGE && last) {
      (next.pages as Record<string, Page>)[w] = {
        depositAddress: last.depositAddress,
        depositMemo: last.depositMemo ?? null,
        ...(lower ? { since: lower.toISOString() } : {}),
      };
    } else {
      delete (next.pages as Record<string, Page>)[w];
    }
    if (w === "recent") {
      const newest = rows.reduce((m, x) => {
        const t = Date.parse(x.createdAt);
        return Number.isFinite(t) && t > m ? t : m;
      }, since.getTime());
      next.at = new Date(newest).toISOString();
    }
    await writeCursor(r, name, next);
    return cadence;
  } catch (e) {
    if (e instanceof ExplorerRateLimited) return ex.livemode ? 10_000 : cadence;
    if (e instanceof ExplorerUnavailable) return 60_000;
    throw e;
  }
}
