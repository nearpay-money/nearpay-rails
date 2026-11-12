/**
 * Hot poller (lld/rails.md §8.4), run by every `rails-tracker` replica: due executions are claimed
 * with `FOR UPDATE SKIP LOCKED` and a 30 s lease (the claim commits before any provider call, so no
 * row lock is held across the network), polled within the status budget, and applied in their own
 * transaction. `direct_intents` executions have no provider: the poller only expires them.
 */
import { sql } from "@nearpay-internal/db";
import type { BackgroundTask, Heartbeat } from "@nearpay-internal/service";
import type { Rails } from "../../app/context.js";
import { applyChange, lockExecution } from "../../app/ledger.js";
import { applyStatus, scheduleFor } from "../../app/observations.js";
import type { ExecutionRow } from "../../app/views.js";
import { EXPIRY_GRACE_MS } from "../../domain/execution/schedule.js";

const LEASE_S = 30;

export async function claimDue(r: Rails, limit: number): Promise<ExecutionRow[]> {
  const res = await sql<ExecutionRow>`
    update executions set next_poll_at = now() + make_interval(secs => ${LEASE_S})
    where id in (
      select id from executions
      where terminal_at is null and next_poll_at is not null and next_poll_at <= now() and state <> 'verifying'
      order by priority, next_poll_at
      limit ${limit}
      for update skip locked)
    returning *`.execute(r.db);
  return res.rows;
}

async function stopTracking(r: Rails, row: ExecutionRow, cause: string): Promise<void> {
  await r.db.transaction().execute(async (tx) => {
    const cur = await lockExecution(tx, row.id);
    if (!cur) return;
    await applyChange(r, tx, cur, { nextPollAt: null }, { cause, actor: "sweeper" });
    await tx
      .updateTable("amount_tags")
      .set({ released_at: new Date(r.now()) })
      .where("execution_id", "=", cur.id)
      .where("released_at", "is", null)
      .execute();
  });
}

/** `direct_intents`: no provider status; past deadline + grace without evidence it expires. */
async function expireIntents(r: Rails, row: ExecutionRow): Promise<void> {
  await r.db.transaction().execute(async (tx) => {
    const cur = await lockExecution(tx, row.id);
    if (!cur || cur.terminal_at) return;
    const expiry = cur.deadline.getTime() + EXPIRY_GRACE_MS;
    if (cur.state === "awaiting_deposit" && r.now() > expiry) {
      await applyChange(
        r,
        tx,
        cur,
        { state: "expired_unpaid", nextPollAt: null },
        {
          cause: "binding deadline passed without a transfer",
          actor: "sweeper",
        },
      );
    } else {
      await applyChange(
        r,
        tx,
        cur,
        { nextPollAt: cur.state === "awaiting_deposit" ? new Date(Math.max(expiry, r.now() + 60_000)) : null },
        {
          cause: "reschedule",
          actor: "sweeper",
        },
      );
    }
  });
}

async function pollOne(r: Rails, row: ExecutionRow): Promise<"ok" | "budget" | "error"> {
  if (row.provider === "direct_intents") {
    await expireIntents(r, row);
    return "ok";
  }
  if (row.state === "expired_unpaid" && row.tracking_until && r.now() >= row.tracking_until.getTime()) {
    await stopTracking(r, row, "late-refund window closed");
    return "ok";
  }
  const provider = row.livemode ? r.providers.live : r.providers.test;
  if (!provider || !row.deposit_address) {
    await reschedule(r, row, 60_000);
    return "error";
  }
  const out = await provider.status(row.livemode, row.deposit_address, row.deposit_memo);
  r.metrics.statusCall("hot_poll", out.ok ? "ok" : out.kind);
  if (!out.ok && out.kind === "unavailable") {
    const budget = out.detail === "status budget exhausted";
    await reschedule(r, row, budget ? 1_000 : 15_000);
    return budget ? "budget" : "error";
  }
  await r.db.transaction().execute(async (tx) => {
    const cur = await lockExecution(tx, row.id);
    if (!cur || cur.terminal_at) return;
    if (out.ok) {
      await applyStatus(r, tx, cur, out.status, out.raw, "hot_poll", true);
      return;
    }
    // 404: the provider does not know the deposit address — held after 3 tries (§10)
    const misses = cur.not_found_count + 1;
    if (misses >= 3 && cur.state !== "held") {
      r.log.error(
        { execution: cur.id, deposit: cur.deposit_address },
        "ALERT provider does not know the deposit address",
      );
      await applyChange(
        r,
        tx,
        cur,
        {
          state: "held",
          heldReason: "unknown_status",
          notFoundCount: misses,
          nextPollAt: scheduleFor(r, cur, "held", cur.poll_count),
        },
        { cause: "provider 404 ×3", actor: "hot_poll" },
      );
    } else {
      await applyChange(
        r,
        tx,
        cur,
        { notFoundCount: misses, nextPollAt: new Date(r.now() + 15_000) },
        { cause: "provider 404", actor: "hot_poll" },
      );
    }
  });
  return "ok";
}

async function reschedule(r: Rails, row: ExecutionRow, inMs: number): Promise<void> {
  await r.db
    .updateTable("executions")
    .set({ next_poll_at: new Date(r.now() + inMs) })
    .where("id", "=", row.id)
    .where("terminal_at", "is", null)
    .execute();
}

/**
 * One poller tick: claims up to `batch` due executions and polls them. Returns executions handled. `beat` (liveness)
 * is called after every execution, so a full batch of slow provider calls never looks like a hung loop.
 */
export async function pollOnce(r: Rails, batch = 50, beat?: () => void): Promise<number> {
  const rows = await claimDue(r, batch);
  let budgetOut = false;
  for (const row of rows) {
    if (budgetOut) {
      await reschedule(r, row, 1_000);
      continue;
    }
    try {
      if ((await pollOne(r, row)) === "budget") budgetOut = true;
    } catch (e) {
      r.log.warn({ err: e, execution: row.id }, "poll failed");
      await reschedule(r, row, 15_000).catch(() => {});
    }
    beat?.();
  }
  return rows.length;
}

/** Liveness budget of the hot poller (kit 0.6.0, KIT-4): it beats after every tick and every polled execution. */
export const POLLER_MAX_SILENCE_MS = 120_000;

export function pollerTask(
  r: Rails,
  o: { tickMs?: number; batch?: number; maxSilenceMs?: number } = {},
): BackgroundTask {
  return {
    name: "hot-poller",
    maxSilenceMs: o.maxSilenceMs ?? POLLER_MAX_SILENCE_MS,
    start(heartbeat?: Heartbeat) {
      const beat = () => heartbeat?.beat();
      let stopped = false;
      let timer: NodeJS.Timeout | undefined;
      let running: Promise<void> = Promise.resolve();
      const tick = () => {
        if (stopped) return;
        running = pollOnce(r, o.batch ?? 50, beat)
          .then((n) => {
            beat();
            if (!stopped) timer = setTimeout(tick, n >= (o.batch ?? 50) ? 0 : (o.tickMs ?? 500));
          })
          .catch((e) => {
            r.log.error({ err: e }, "hot poller tick failed");
            beat(); // a failed tick (e.g. DB down) is readiness, not liveness
            if (!stopped) timer = setTimeout(tick, 2_000);
          });
      };
      tick();
      return {
        async stop() {
          stopped = true;
          clearTimeout(timer);
          await running;
        },
      };
    },
  };
}
