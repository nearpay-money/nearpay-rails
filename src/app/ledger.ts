/**
 * The one way an execution changes (foundations §7, AGENTS "one transaction per state change"):
 * aggregate row + transition row + outbox event in the caller's transaction, version-checked (the
 * row is locked `FOR UPDATE` by the caller). Terminal states release the amount tag in the same
 * transaction (§5 "Tag release").
 */
import { emit } from "@nearpay-internal/db";
import { fromUuid, uuidv7 } from "@nearpay-internal/ids";
import { canTransition, type HeldReason, isTerminal, type State } from "../domain/execution/state.js";
import type { EvidenceRow, ExecutionState } from "../infra/db/schema.js";
import type { Rails, Tx } from "./context.js";
import { type ExecutionRow, executionView } from "./views.js";

export interface Change {
  state?: State;
  heldReason?: HeldReason | null;
  providerStatus?: string | null;
  providerUpdatedAt?: Date | null;
  settledAmount?: bigint | null;
  refundedAmount?: bigint | null;
  refundReason?: string | null;
  providerAmountOut?: bigint | null;
  depositTxHashes?: string[];
  destinationTxHashes?: string[];
  evidence?: EvidenceRow | null;
  failureCode?: string | null;
  // scheduling (not material: no version, no event)
  nextPollAt?: Date | null;
  pollCount?: number;
  notFoundCount?: number;
  hasSignal?: boolean;
  priority?: number;
  verifyAt?: Date | null;
  trackingUntil?: Date | null;
}

export interface ChangeMeta {
  cause: string;
  actor: "api" | "hot_poll" | "explorer" | "indexer" | "watcher" | "verifier" | "operator" | "sweeper";
  observationId?: string | null;
  evidence?: unknown;
}

export class IllegalTransition extends Error {
  override readonly name = "IllegalTransition";
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const num = (v: bigint | null | undefined) => (v === undefined ? undefined : v === null ? null : v.toString());

export function subjectFor(prev: State, next: State): string {
  if (next === prev) return "evt.rails.execution.updated";
  if (next === "succeeded") return "evt.rails.execution.settled";
  if (next === "refunded") return "evt.rails.execution.refunded";
  if (next === "failed") return "evt.rails.execution.failed";
  if (next === "held") return "evt.rails.execution.held";
  return "evt.rails.execution.updated";
}

/** Applies `c` to the locked row `cur`. Returns the updated row (unchanged row when nothing applies). */
export async function applyChange(
  r: Rails,
  tx: Tx,
  cur: ExecutionRow,
  c: Change,
  meta: ChangeMeta,
): Promise<ExecutionRow> {
  const prev = cur.state as State;
  const next = c.state ?? prev;
  if (!canTransition(prev, next)) throw new IllegalTransition(`execution ${cur.id}: ${prev} → ${next} is not allowed`);
  const now = new Date(r.now());
  const patch: Record<string, unknown> = {};
  const set = (col: string, v: unknown, current: unknown) => {
    if (v !== undefined && !same(v, current)) patch[col] = v;
  };
  set("state", next, prev);
  set(
    "held_reason",
    next === "held" ? (c.heldReason ?? cur.held_reason ?? "unknown_status") : c.heldReason,
    cur.held_reason,
  );
  set("provider_status", c.providerStatus, cur.provider_status);
  set(
    "provider_updated_at",
    c.providerUpdatedAt?.toISOString() ?? c.providerUpdatedAt,
    cur.provider_updated_at?.toISOString() ?? null,
  );
  set("settled_amount", num(c.settledAmount), cur.settled_amount);
  set("refunded_amount", num(c.refundedAmount), cur.refunded_amount);
  set("refund_reason", c.refundReason, cur.refund_reason);
  set("provider_amount_out", num(c.providerAmountOut), cur.provider_amount_out);
  set("deposit_tx_hashes", c.depositTxHashes, cur.deposit_tx_hashes);
  set("destination_tx_hashes", c.destinationTxHashes, cur.destination_tx_hashes);
  set(
    "evidence",
    c.evidence === undefined ? undefined : c.evidence === null ? null : JSON.stringify(c.evidence),
    cur.evidence === null ? null : JSON.stringify(cur.evidence),
  );
  set("failure_code", c.failureCode, cur.failure_code);
  if (patch.evidence === JSON.stringify(cur.evidence)) delete patch.evidence;
  const material = Object.keys(patch).length > 0;

  // scheduling
  const sched: Record<string, unknown> = {};
  const setS = (col: string, v: unknown, current: unknown) => {
    if (
      v !== undefined &&
      !same(v instanceof Date ? v.toISOString() : v, current instanceof Date ? current.toISOString() : current)
    )
      sched[col] = v;
  };
  setS("next_poll_at", c.nextPollAt, cur.next_poll_at);
  setS("poll_count", c.pollCount, cur.poll_count);
  setS("not_found_count", c.notFoundCount, cur.not_found_count);
  setS("has_signal", c.hasSignal, cur.has_signal);
  setS("priority", c.priority, cur.priority);
  setS("verify_at", c.verifyAt, cur.verify_at);
  setS("tracking_until", c.trackingUntil, cur.tracking_until);
  if (next !== prev) {
    if (next === "verifying") {
      sched.verify_at = c.verifyAt ?? now;
      sched.verifying_since = now;
      sched.next_poll_at = null;
    }
    if (isTerminal(next)) {
      sched.terminal_at = now;
      sched.next_poll_at = null;
      sched.verify_at = null;
    }
  }
  if (!material && Object.keys(sched).length === 0) return cur;

  const version = material ? cur.version + 1 : cur.version;
  const updated = await tx
    .updateTable("executions")
    .set({ ...patch, ...sched, ...(material ? { version, updated_at: now } : {}) } as never)
    .where("id", "=", cur.id)
    .where("version", "=", cur.version)
    .returningAll()
    .executeTakeFirst();
  if (!updated) throw new IllegalTransition(`execution ${cur.id} changed concurrently (version ${cur.version})`);
  if (!material) return updated;

  if (next !== prev) {
    await tx
      .insertInto("execution_transitions")
      .values({
        id: uuidv7(),
        execution_id: cur.id,
        from_state: prev,
        to_state: next,
        cause: meta.cause.slice(0, 500),
        actor: meta.actor,
        observation_id: meta.observationId ?? null,
        evidence: meta.evidence === undefined ? null : JSON.stringify(meta.evidence),
      })
      .execute();
    r.metrics.transition(next);
    if (isTerminal(next)) {
      await tx
        .updateTable("amount_tags")
        .set({ released_at: now })
        .where("execution_id", "=", cur.id)
        .where("released_at", "is", null)
        .execute();
    }
    if (next === "succeeded")
      r.metrics.timeToEvidence(
        cur.route_class,
        cur.destination_chain,
        (now.getTime() - cur.created_at.getTime()) / 1000,
      );
  }
  await emitExecution(tx, updated, subjectFor(prev, next), prev);
  return updated;
}

export async function emitExecution(
  tx: Tx,
  row: ExecutionRow,
  subject: string,
  previousState?: ExecutionState | State,
) {
  await emit(tx, {
    subject,
    aggregate: { type: "execution", id: fromUuid("ex", row.id), version: Math.max(1, row.version) },
    accountId: row.account_id,
    livemode: row.livemode,
    data: {
      object: executionView(row),
      ...(previousState && previousState !== row.state ? { previous: { state: previousState } } : {}),
    },
  });
}

export async function lockExecution(tx: Tx, id: string): Promise<ExecutionRow | undefined> {
  return tx.selectFrom("executions").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
}
