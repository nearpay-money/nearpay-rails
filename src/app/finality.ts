/**
 * Post-success `finalized` re-check scheduling (lld/rails.md §8.12, ADR-0022). EVM evidence accepted on L2 block
 * confirmations (`finality: confirmed`) settles the execution at once; the re-check then follows the transaction
 * until the chain's `finalized` tag covers it (or the window ends). Scheduling only: no version, no event.
 */
import type { Rails, Tx } from "./context.js";
import type { EvidenceInput } from "./observations.js";
import type { ExecutionRow } from "./views.js";

/** Live Tier-A EVM evidence that counted on confirmations (not `finalized`) and names the block it counted from. */
export function needsFinalityRecheck(r: Rails, row: ExecutionRow, e: EvidenceInput): boolean {
  return (
    row.livemode &&
    e.tier === "A" &&
    e.finality === "confirmed" &&
    e.txHash !== null &&
    r.profiles.get(e.chain)?.family === "evm" &&
    typeof e.details?.block_hash === "string"
  );
}

export async function scheduleFinalityRecheck(r: Rails, tx: Tx, row: ExecutionRow, e: EvidenceInput): Promise<void> {
  const now = r.now();
  await tx
    .updateTable("executions")
    .set({
      finality_recheck_status: "pending",
      finality_recheck_at: new Date(now + r.finalityRecheck.intervalS * 1000),
      finality_recheck_until: new Date(now + r.finalityRecheck.windowS * 1000),
      finality_recheck_block_hash: String(e.details?.block_hash),
      finality_recheck_detail: JSON.stringify({
        scheduled_at: new Date(now).toISOString(),
        confirmations: e.details?.confirmations ?? null,
      }),
    })
    .where("id", "=", row.id)
    .execute();
}
