/**
 * Console routes over executions (lld/rails.md §6 `/ops/executions…`, served by rails on the identity-console ops
 * table; spec 0.2.0): the executions explorer (one mode at a time, INV-8), Verifier holds (`state=held`), the
 * evidence trail, and `reverify` — which only asks the Verifier to look again (`verify_at = now()`) and records an
 * `operator` observation; it never forces a state (INV-2). Every reverify publishes `evt.rails.ops_action.recorded`
 * (ids only) through the outbox in the same transaction (T-12, unified console audit trail).
 */

import { emit } from "@nearpay-internal/db";
import { fromUuid, toUuid, uuidv7 } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import type { Execution, listOpsExecutions } from "@nearpay-internal/spec";
import type { RouteQuery } from "@nearpay-money/spec";
import type { Rails } from "./context.js";
import { getExecutionRow } from "./executions.js";
import { applyChange, lockExecution } from "./ledger.js";
import { observationValues } from "./observations.js";
import { executionView } from "./views.js";

export interface Operator {
  /** `usr_…` of the ops principal. */
  readonly sub: string;
  readonly role: "ops" | "ops_admin";
}

type ListQuery = RouteQuery<typeof listOpsExecutions>;

export async function opsExecutions(
  r: Rails,
  q: ListQuery,
): Promise<{ object: "list"; data: Execution[]; has_more: boolean; url: string }> {
  const livemode = q.livemode === "true";
  let query = r.db.selectFrom("executions").selectAll().where("livemode", "=", livemode);
  if (q.account) query = query.where("account_id", "=", toUuid(q.account, "acct"));
  if (q.state) query = query.where("state", "=", q.state as never);
  if (q.held_reason) query = query.where("held_reason", "=", q.held_reason);
  if (q.kind) query = query.where("kind", "=", q.kind as "payment" | "refund");
  if (q.provider) query = query.where("provider", "=", q.provider as "oneclick" | "sandbox" | "direct_intents");
  if (q.deposit_address) query = query.where("deposit_address", "=", q.deposit_address);
  const gte = q["created[gte]"];
  const lte = q["created[lte]"];
  if (gte !== undefined) query = query.where("created_at", ">=", new Date(gte * 1000));
  if (lte !== undefined) query = query.where("created_at", "<=", new Date(lte * 1000 + 999));
  const cursor = (s: string, param: string) => {
    try {
      return toUuid(s, "ex");
    } catch {
      throw ApiError.invalid("not an execution id", param);
    }
  };
  // newest first; ids are UUIDv7, so id order is creation order
  if (q.ending_before) {
    const rows = await query
      .where("id", ">", cursor(q.ending_before, "ending_before"))
      .orderBy("id", "asc")
      .limit(q.limit + 1)
      .execute();
    const page = rows.slice(0, q.limit).reverse();
    return { object: "list", data: page.map(executionView), has_more: rows.length > q.limit, url: "/ops/executions" };
  }
  if (q.starting_after) query = query.where("id", "<", cursor(q.starting_after, "starting_after"));
  const rows = await query
    .orderBy("id", "desc")
    .limit(q.limit + 1)
    .execute();
  return {
    object: "list",
    data: rows.slice(0, q.limit).map(executionView),
    has_more: rows.length > q.limit,
    url: "/ops/executions",
  };
}

const REVERIFIABLE = new Set(["held", "verifying"]);

/** `POST /ops/executions/{id}/reverify` (ops + ops_admin, step-up): `verify_at = now()`, never a state change. */
export async function reverify(r: Rails, exId: string, note: string, op: Operator): Promise<Execution> {
  const row = await getExecutionRow(r, exId);
  return r.db.transaction().execute(async (tx) => {
    const cur = await lockExecution(tx, row.id);
    if (!cur) throw ApiError.missing("execution", exId, "id");
    if (!REVERIFIABLE.has(cur.state))
      throw new ApiError("state_conflict", { params: { object: "execution", state: cur.state } });
    const now = new Date(r.now());
    const actionId = uuidv7();
    // rails' own record of the request (the note stays here; the event carries ids only)
    const obs = observationValues(
      cur.id,
      "operator",
      null,
      { action: "execution.reverify_requested", action_id: actionId, operator: op.sub, ops_role: op.role, note },
      null,
      false,
    );
    await tx.insertInto("provider_observations").values(obs).execute();
    const updated = await applyChange(
      r,
      tx,
      cur,
      { verifyAt: now },
      { cause: "operator reverify", actor: "operator", observationId: obs.id },
    );
    await emit(tx, {
      subject: "evt.rails.ops_action.recorded",
      // `ops_action` has no prefix of its own: the outbox keys aggregates by prefixed id, so the action uuid goes out
      // as `aud_…` (it becomes identity's audit event); the object carries the bare uuid (spec `OpsActionEvent`)
      aggregate: { type: "ops_action", id: fromUuid("aud", actionId), version: 1 },
      accountId: cur.account_id,
      livemode: cur.livemode,
      occurredAt: now,
      data: {
        object: {
          id: actionId,
          actor: { sub: op.sub, ops_role: op.role },
          action: "execution.reverify_requested",
          target: { type: "execution", id: fromUuid("ex", cur.id) },
          account_id: fromUuid("acct", cur.account_id),
          approval: null,
          occurred_at: now.toISOString(),
        },
      },
    });
    r.log.info({ execution: cur.id, operator: op.sub, role: op.role }, "operator reverify");
    return executionView(updated);
  });
}
