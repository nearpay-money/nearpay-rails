/**
 * Post-success re-check scheduling (lld/rails.md §8.12, ADR-0022 as amended 2026-11-10 17:10). Every live Tier-A
 * execution settled on one-block evidence (`finality: confirmed`) is followed afterwards, per chain family:
 *
 * - EVM: until the chain's `finalized` tag covers the block (same block hash, status 1) — every
 *   `NP_FINALITY_RECHECK_INTERVAL_S` (60 s) for `NP_FINALITY_RECHECK_WINDOW_S` (2 h);
 * - Solana: until the transaction is served at `finalized` commitment in the same slot (≈ 13 s after `confirmed`) —
 *   every `NP_FINALITY_RECHECK_SOLANA_INTERVAL_S` (15 s) for `NP_FINALITY_RECHECK_SOLANA_WINDOW_S` (30 min);
 * - Bitcoin: until the transaction has `NP_FINALITY_RECHECK_BITCOIN_CONFIRMATIONS` (6) in the same block of the best
 *   chain — every `NP_FINALITY_RECHECK_BITCOIN_INTERVAL_S` (60 s) for `NP_FINALITY_RECHECK_BITCOIN_WINDOW_S` (6 h).
 *
 * NEAR evidence is `final` (Doomslug finality) and needs no re-check; Tier B and test-mode evidence are not re-checked.
 * Scheduling only: no version, no event.
 */
import type { Rails, Tx } from "./context.js";
import type { EvidenceInput } from "./observations.js";
import type { ExecutionRow } from "./views.js";

export type RecheckFamily = "evm" | "solana" | "bitcoin";

const numeric = (s: string | null): s is string => s !== null && /^\d{1,19}$/.test(s);

/** The block hash one-block evidence counted from (EVM / Bitcoin `details.block_hash`, or `Evidence.bitcoin`). */
function blockHashOf(e: EvidenceInput): string | null {
  const d = e.details?.block_hash;
  if (typeof d === "string" && d.length > 0) return d;
  const b = e.chainDetail?.bitcoin?.block_hash;
  return typeof b === "string" && b.length > 0 ? b : null;
}

/**
 * The family whose re-check this evidence needs, or null: live Tier-A one-block evidence (`confirmed`) with a tx hash
 * and what the family's re-check compares against (EVM: block hash; Solana: slot; Bitcoin: block hash and height).
 */
export function recheckFamily(r: Rails, row: ExecutionRow, e: EvidenceInput): RecheckFamily | null {
  if (!row.livemode || e.tier !== "A" || e.finality !== "confirmed" || e.txHash === null) return null;
  const family = r.profiles.get(e.chain)?.family;
  if (family === "evm") return blockHashOf(e) !== null ? "evm" : null;
  if (family === "solana") return numeric(e.blockRef) ? "solana" : null;
  if (family === "bitcoin") return blockHashOf(e) !== null && numeric(e.blockRef) ? "bitcoin" : null;
  return null;
}

export function needsFinalityRecheck(r: Rails, row: ExecutionRow, e: EvidenceInput): boolean {
  return recheckFamily(r, row, e) !== null;
}

/** Cadence and window of a family's re-check (seconds). */
export function recheckPlan(r: Rails, family: RecheckFamily): { intervalS: number; windowS: number } {
  const f = r.finalityRecheck;
  if (family === "solana") return f.solana;
  if (family === "bitcoin") return f.bitcoin;
  return { intervalS: f.intervalS, windowS: f.windowS };
}

export async function scheduleFinalityRecheck(r: Rails, tx: Tx, row: ExecutionRow, e: EvidenceInput): Promise<void> {
  const family = recheckFamily(r, row, e);
  if (family === null) return;
  const plan = recheckPlan(r, family);
  const now = r.now();
  await tx
    .updateTable("executions")
    .set({
      finality_recheck_status: "pending",
      finality_recheck_at: new Date(now + plan.intervalS * 1000),
      finality_recheck_until: new Date(now + plan.windowS * 1000),
      // Solana compares the slot (`evidence.block_ref`), not a block hash
      finality_recheck_block_hash: family === "solana" ? null : blockHashOf(e),
      finality_recheck_detail: JSON.stringify({
        family,
        scheduled_at: new Date(now).toISOString(),
        block_ref: e.blockRef,
        confirmations: e.details?.confirmations ?? null,
        ...(family === "bitcoin" ? { until_confirmations: r.finalityRecheck.bitcoin.confirmations } : {}),
      }),
    })
    .where("id", "=", row.id)
    .execute();
}
