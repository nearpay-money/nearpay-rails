/**
 * Ownership enforcement at the use-case boundary (lld/rails.md §20; rules in domain/execution/owner.ts).
 * A row the caller may not read is answered like a missing one (`404 resource_missing`), so agentpay cannot
 * probe payments' executions; a create for another owner is `403 permission_denied`.
 */
import { toUuid } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import { type Caller, mayRead, mayWrite, type OwnerRefusal } from "../domain/execution/owner.js";
import type { Rails } from "./context.js";
import type { ExecutionRow } from "./views.js";

export function refusalError(f: OwnerRefusal, action: string): ApiError {
  if (f.kind === "invalid") return ApiError.invalid(f.message, f.param);
  return new ApiError("permission_denied", { params: { action }, message: f.message });
}

export function forbidden(action: string, message: string): ApiError {
  return new ApiError("permission_denied", { params: { action }, message });
}

async function getExecutionRow(r: Rails, exId: string): Promise<ExecutionRow> {
  const row = await r.db.selectFrom("executions").selectAll().where("id", "=", toUuid(exId, "ex")).executeTakeFirst();
  if (!row) throw ApiError.missing("execution", exId, "id");
  return row;
}

/** The execution, if the caller may read it; otherwise `resource_missing` (fail closed, no existence leak). */
export async function readableRow(r: Rails, caller: Caller, exId: string): Promise<ExecutionRow> {
  const row = await getExecutionRow(r, exId);
  if (!mayRead(caller, row)) {
    r.log.warn({ execution: row.id, owner: row.owner, caller }, "execution read refused: not the caller's");
    throw ApiError.missing("execution", exId, "id");
  }
  return row;
}

/** The execution, if the caller owns it (payer inputs: `deposit_tx`, `signals`); otherwise `resource_missing`. */
export async function ownedRow(r: Rails, caller: Caller, exId: string): Promise<ExecutionRow> {
  const row = await getExecutionRow(r, exId);
  if (!mayWrite(caller, row)) {
    r.log.warn({ execution: row.id, owner: row.owner, caller }, "execution write refused: not the owner");
    throw ApiError.missing("execution", exId, "id");
  }
  return row;
}
