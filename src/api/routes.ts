/** Spec route bindings (lld/rails.md §6). Auth, scopes, ops roles and step-up are enforced from the spec by the kit. */
import { listAssets } from "@nearpay/spec";
import { ApiError, implement, type RouteBinding } from "@nearpay-internal/service";
import {
  abandonExecution as abandonExecutionRoute,
  createExecution as createExecutionRoute,
  createRefundExecution as createRefundExecutionRoute,
  estimateSettlement,
  getDestinationMinimums,
  getEvidenceSummary,
  getExecution,
  getInternalAsset,
  getOpsExecution,
  listChainProfiles,
  listEvidence,
  listExecutionObservations,
  listFxRates,
  listInternalOptions,
  listOpsExecutionObservations,
  listOpsExecutions,
  lookupExecutionByDeposit,
  reverifyOpsExecution,
  signalExecution as signalRoute,
  submitExecutionDepositTx,
} from "@nearpay-internal/spec";
import { abandonExecution } from "../app/abandon.js";
import { forbidden, ownedRow, readableRow, refusalError } from "../app/access.js";
import type { Rails } from "../app/context.js";
import { estimate } from "../app/estimate.js";
import { evidenceSummary, observationsPage } from "../app/evidence.js";
import { createExecution, getExecutionRow, signalExecution, submitDepositTx } from "../app/executions.js";
import { fxRatesView } from "../app/fx.js";
import { type Operator, opsExecutions, reverify } from "../app/ops.js";
import { assetsList, assetView, depositLookup, evidencePage, minimums, options } from "../app/queries.js";
import { createRefundExecution } from "../app/refunds.js";
import { executionView } from "../app/views.js";
import { callerOf, listOwnerFilter, mayManageRefundLegs } from "../domain/execution/owner.js";

/** The console operator of an ops request (the kit has already checked `ops_role` against the route). */
function operatorOf(principal: { sub?: string; ops_role?: string } | null): Operator {
  const role = principal?.ops_role;
  if (!principal?.sub || (role !== "ops" && role !== "ops_admin"))
    throw new ApiError("permission_denied", { message: "ops principal required" });
  return { sub: principal.sub, role };
}

export function railsRoutes(r: Rails): RouteBinding[] {
  return [
    // ownership (§20): decided by the caller's service identity, fail closed (domain/execution/owner.ts)
    implement(createExecutionRoute, async (ctx) => createExecution(r, ctx.body, callerOf(ctx.principal))),
    implement(createRefundExecutionRoute, async (ctx) => {
      if (!mayManageRefundLegs(callerOf(ctx.principal))) throw forbidden("create refund legs", "payments only");
      return createRefundExecution(r, ctx.body);
    }),
    implement(abandonExecutionRoute, async (ctx) => {
      if (!mayManageRefundLegs(callerOf(ctx.principal))) throw forbidden("abandon refund legs", "payments only");
      return abandonExecution(r, ctx.params.id, ctx.body);
    }),
    implement(getExecution, async (ctx) => executionView(await readableRow(r, callerOf(ctx.principal), ctx.params.id))),
    implement(lookupExecutionByDeposit, async (ctx) => {
      const f = listOwnerFilter(callerOf(ctx.principal), undefined);
      if (!("ok" in f)) throw refusalError(f, "look up deposits");
      return depositLookup(r, ctx.query, f.owner);
    }),
    implement(getInternalAsset, async (ctx) => assetView(r, ctx.params.asset_id, ctx.query.livemode)),
    implement(submitExecutionDepositTx, async (ctx) => {
      await ownedRow(r, callerOf(ctx.principal), ctx.params.id);
      await submitDepositTx(r, ctx.params.id, ctx.body);
    }),
    implement(signalRoute, async (ctx) => {
      await ownedRow(r, callerOf(ctx.principal), ctx.params.id);
      await signalExecution(r, ctx.params.id);
    }),
    implement(listInternalOptions, async (ctx) => options(r, ctx.query)),
    implement(getDestinationMinimums, async (ctx) => minimums(r, ctx.query.keys)),
    implement(listChainProfiles, async () => ({ profiles: r.profiles.all().map((p) => r.profiles.view(p)) })),
    implement(listEvidence, async (ctx) => {
      const f = listOwnerFilter(callerOf(ctx.principal), ctx.query.owner);
      if (!("ok" in f)) throw refusalError(f, "list evidence of this owner");
      return evidencePage(r, ctx.query, f.owner);
    }),
    implement(getEvidenceSummary, async (ctx) => {
      // the summary has no owner filter (spec 0.3.0): agentpay may not read payments' totals
      const f = listOwnerFilter(callerOf(ctx.principal), undefined);
      if (!("ok" in f) || f.owner !== undefined) throw forbidden("read evidence summaries", "not for agentpay");
      return evidenceSummary(r, ctx.query);
    }),
    implement(listExecutionObservations, async (ctx) => {
      await readableRow(r, callerOf(ctx.principal), ctx.params.id);
      return observationsPage(r, ctx.params.id, ctx.query);
    }),
    implement(listFxRates, async (ctx) => fxRatesView(r, ctx.query.livemode ?? true, ctx.query.currencies)),
    implement(estimateSettlement, async (ctx) => estimate(r, ctx.query)),
    implement(listAssets, async () => assetsList(r)),
    // console (ops) routes, served by rails on the identity-console `/ops/…` table
    implement(listOpsExecutions, async (ctx) => opsExecutions(r, ctx.query)),
    implement(getOpsExecution, async (ctx) => executionView(await getExecutionRow(r, ctx.params.id))),
    implement(listOpsExecutionObservations, async (ctx) => observationsPage(r, ctx.params.id, ctx.query)),
    implement(reverifyOpsExecution, async (ctx) =>
      reverify(r, ctx.params.id, ctx.body.note, operatorOf(ctx.principal)),
    ),
  ];
}
