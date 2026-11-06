/** Spec route bindings (lld/rails.md §6). Auth and scopes are enforced from the spec by the bootstrap. */
import { listAssets } from "@nearpay/spec";
import { implement, type RouteBinding } from "@nearpay-internal/service";
import {
  createExecution as createExecutionRoute,
  getDestinationMinimums,
  getExecution,
  getInternalAsset,
  listChainProfiles,
  listEvidence,
  listInternalOptions,
  lookupExecutionByDeposit,
  signalExecution as signalRoute,
  submitExecutionDepositTx,
} from "@nearpay-internal/spec";
import type { Rails } from "../app/context.js";
import { createExecution, getExecutionRow, signalExecution, submitDepositTx } from "../app/executions.js";
import { assetsList, assetView, depositLookup, evidencePage, minimums, options } from "../app/queries.js";
import { executionView } from "../app/views.js";

export function railsRoutes(r: Rails): RouteBinding[] {
  return [
    implement(createExecutionRoute, async (ctx) => createExecution(r, ctx.body)),
    implement(getExecution, async (ctx) => executionView(await getExecutionRow(r, ctx.params.id))),
    implement(lookupExecutionByDeposit, async (ctx) => depositLookup(r, ctx.query)),
    implement(getInternalAsset, async (ctx) => assetView(r, ctx.params.asset_id, ctx.query.livemode)),
    implement(submitExecutionDepositTx, async (ctx) => {
      await submitDepositTx(r, ctx.params.id, ctx.body);
    }),
    implement(signalRoute, async (ctx) => {
      await signalExecution(r, ctx.params.id);
    }),
    implement(listInternalOptions, async (ctx) => options(r, ctx.query)),
    implement(getDestinationMinimums, async (ctx) => minimums(r, ctx.query.keys)),
    implement(listChainProfiles, async () => ({ profiles: r.profiles.all().map((p) => r.profiles.view(p)) })),
    implement(listEvidence, async (ctx) => evidencePage(r, ctx.query)),
    implement(listAssets, async () => assetsList(r)),
  ];
}
