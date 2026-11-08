/**
 * `POST /internal/executions/{id}/abandon` (spec 0.2.1, caller payments): an orphaned refund leg before any
 * deposit becomes `expired_unpaid` at once with `abandoned_at`/`abandon_reason` (deadline = now,
 * `tracking_until` = now + 24 h, so late money still settles — INV-3); one transaction with the transition and
 * `evt.rails.execution.updated`. A repeat returns the execution unchanged; money moved, a payment execution or a
 * terminal one is `409 state_conflict` (domain/execution/abandon.ts).
 */
import { ApiError } from "@nearpay-internal/service";
import type { Execution } from "@nearpay-internal/spec";
import { decideAbandon } from "../domain/execution/abandon.js";
import { LATE_REFUND_WINDOW_MS } from "../domain/execution/schedule.js";
import type { State } from "../domain/execution/state.js";
import type { Rails } from "./context.js";
import { getExecutionRow } from "./executions.js";
import { applyChange, lockExecution } from "./ledger.js";
import { executionView } from "./views.js";

export async function abandonExecution(
  r: Rails,
  exId: string,
  b: { reason: string; note?: string | undefined },
): Promise<Execution> {
  const row = await getExecutionRow(r, exId);
  const out = await r.db.transaction().execute(async (tx) => {
    const cur = await lockExecution(tx, row.id);
    if (!cur) throw ApiError.missing("execution", exId, "id");
    const d = decideAbandon({
      kind: cur.kind,
      state: cur.state as State,
      abandoned: cur.abandoned_at !== null,
      depositTxHashes: cur.deposit_tx_hashes.length,
      depositedAmount: cur.deposited_amount === null ? null : BigInt(cur.deposited_amount.split(".")[0] as string),
      providerStatus: cur.provider_status,
    });
    if (d.kind === "replay") return { row: cur, abandoned: false };
    if (d.kind === "conflict") {
      r.log.warn({ execution: cur.id, state: cur.state, reason: d.reason }, "abandon refused");
      throw new ApiError("state_conflict", {
        params: { object: "execution", state: cur.state },
        message: `The execution cannot be abandoned: ${d.reason}.`,
      });
    }
    const now = new Date(r.now());
    const updated = await applyChange(
      r,
      tx,
      cur,
      {
        state: d.to,
        abandoned: { at: now, reason: b.reason, note: b.note ?? null },
        deadline: now < cur.deadline ? now : cur.deadline,
        trackingUntil: new Date(now.getTime() + LATE_REFUND_WINDOW_MS),
        // the hot poller keeps watching route legs for late money until tracking ends; direct legs rely on the indexer
        nextPollAt: cur.provider === "direct_intents" ? null : new Date(now.getTime() + 15 * 60_000),
      },
      { cause: `abandoned by payments: ${b.reason}`, actor: "api" },
    );
    return { row: updated, abandoned: true };
  });
  if (out.abandoned)
    r.log.info({ execution: out.row.id, reason: b.reason }, "refund leg abandoned (tracked 24 h for late money)");
  return executionView(out.row);
}
