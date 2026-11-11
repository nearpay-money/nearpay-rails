/**
 * Post-success re-check (lld/rails.md §8.12, ADR-0022 as amended 2026-11-10 17:10), run by `rails-tracker` next to
 * the verifier. One-block evidence (`finality: confirmed`) settled its execution at once; this loop follows each such
 * transaction until its chain's finality covers it, per family:
 *
 * - EVM — the chain's `finalized` tag: same block hash, status 1, block ≤ `finalized` → `finalized`; at finality the
 *   receipt gone, in another block (hash changed) or status ≠ 1 → `failed`.
 * - Solana — `finalized` commitment (`getTransaction` + `getSlot` at `finalized`, ≈ 13 s after `confirmed`): served
 *   at `finalized` in the same slot without `meta.err` → `finalized`; another slot or failed → `failed`; the finalized
 *   slot has passed the evidence slot and the transaction is gone (not even `confirmed` in that slot) → `failed`.
 * - Bitcoin — `NP_FINALITY_RECHECK_BITCOIN_CONFIRMATIONS` (6) in the best chain: once the tip is that deep over the
 *   evidence block, the transaction must still be confirmed in the same block hash → `finalized`; unknown, back in the
 *   mempool or in another block → `failed`.
 * - Not final when the family's window ends (EVM 2 h, Solana 30 min, Bitcoin 6 h) → `timeout`.
 *
 * `failed` and `timeout` never move the execution (terminal states stay terminal, rails §5; the LLD has no
 * post-success contradiction state — gap recorded in ADR-0022): they log `ALERT finalized re-check …`, count
 * `finality_recheck_total{chain,outcome}` (Prometheus `FinalityRecheckFailed` → Telegram), keep
 * `finality_recheck_status` on the row for ops and write a `verifier` observation (applied = false) into the
 * execution's evidence trail (console).
 */

import { sql } from "@nearpay-internal/db";
import { BITCOIN_MAINNET, SOLANA_MAINNET } from "@nearpay-money/spec";
import type { Rails } from "../app/context.js";
import { type RecheckFamily, recheckPlan } from "../app/finality.js";
import { observationValues } from "../app/observations.js";
import type { ExecutionRow } from "../app/views.js";
import type { Esplora } from "../infra/clients/esplora.js";
import type { EvmRpc } from "../infra/clients/evm.js";
import type { SolanaRpc } from "../infra/clients/solana.js";

const LEASE_MS = 60_000;

export type RecheckVerdict =
  | { readonly kind: "finalized"; readonly detail: Record<string, unknown> }
  | { readonly kind: "pending"; readonly detail: Record<string, unknown> }
  | { readonly kind: "failed"; readonly detail: Record<string, unknown> };

/** Chain readers the re-check uses (the verifier's: Solana / Bitcoin null when their pool is not configured). */
export interface RecheckReaders {
  readonly evm: ReadonlyMap<string, EvmRpc>;
  readonly solana?: SolanaRpc | null;
  readonly esplora?: Esplora | null;
}

/** EVM: one re-check of `txHash`, confirmed in block `blockRef` with hash `blockHash`, against the `finalized` tag. */
export async function recheckFinality(
  rpc: EvmRpc,
  t: { readonly txHash: string; readonly blockHash: string; readonly blockRef: string | null },
): Promise<RecheckVerdict> {
  const finalized = await rpc.finalizedBlock();
  const receipt = await rpc.receipt(t.txHash);
  const original = t.blockRef !== null && /^\d+$/.test(t.blockRef) ? BigInt(t.blockRef) : null;
  const base = { finalized: finalized.toString(), block: t.blockRef, block_hash: t.blockHash };
  if (!receipt) {
    // a missing receipt is a contradiction once finality has passed the block the evidence counted from
    if (original !== null && original <= finalized)
      return { kind: "failed", detail: { ...base, reason: "transaction not found at finality" } };
    return { kind: "pending", detail: { ...base, reason: "receipt not found (block not finalized yet)" } };
  }
  const block = BigInt(receipt.blockNumber);
  if (block > finalized || (original !== null && original > finalized))
    return { kind: "pending", detail: { ...base, reason: "not finalized yet", receipt_block: block.toString() } };
  const seen = { receipt_block: block.toString(), receipt_block_hash: receipt.blockHash, status: receipt.status };
  if (receipt.status !== "0x1")
    return { kind: "failed", detail: { ...base, ...seen, reason: "receipt status at finality is not 1" } };
  if (receipt.blockHash.toLowerCase() !== t.blockHash.toLowerCase() || (original !== null && block !== original))
    return { kind: "failed", detail: { ...base, ...seen, reason: "block hash changed at finality" } };
  return { kind: "finalized", detail: { ...base, ...seen } };
}

/** Solana: one re-check of `signature`, confirmed in `slot`, against `finalized` commitment. */
export async function recheckSolana(
  rpc: SolanaRpc,
  t: { readonly signature: string; readonly slot: number },
): Promise<RecheckVerdict> {
  const finalizedSlot = await rpc.slot("finalized");
  const base = { finalized_slot: finalizedSlot, slot: t.slot };
  const failed = (x: { slot: number; meta: { err: unknown } | null }) => x.meta !== null && x.meta.err != null;
  const tx = await rpc.transactionAt(t.signature, "finalized");
  if (tx) {
    const seen = { ...base, tx_slot: tx.slot };
    if (tx.meta === null) return { kind: "pending", detail: { ...seen, reason: "finalized result without meta" } };
    if (failed(tx)) return { kind: "failed", detail: { ...seen, reason: "transaction failed at finality" } };
    if (tx.slot !== t.slot) return { kind: "failed", detail: { ...seen, reason: "slot changed at finality" } };
    return { kind: "finalized", detail: seen };
  }
  if (finalizedSlot < t.slot) return { kind: "pending", detail: { ...base, reason: "slot not finalized yet" } };
  // finality passed the slot but this read has no finalized result: a lagging endpoint still shows it `confirmed` in
  // the same slot (look again), otherwise the transaction was dropped with its fork or moved
  const confirmed = await rpc.transactionAt(t.signature, "confirmed");
  if (confirmed && confirmed.slot === t.slot && !failed(confirmed))
    return { kind: "pending", detail: { ...base, reason: "finalized slot passed; endpoint has not served it yet" } };
  return {
    kind: "failed",
    detail: confirmed
      ? { ...base, tx_slot: confirmed.slot, reason: "slot changed at finality" }
      : { ...base, reason: "transaction not found at finality" },
  };
}

/** Bitcoin: one re-check of `txid`, confirmed in block `height`/`blockHash`, at `depth` confirmations. */
export async function recheckBitcoin(
  esplora: Esplora,
  t: { readonly txid: string; readonly blockHash: string; readonly height: number },
  depth: number,
): Promise<RecheckVerdict> {
  const tip = await esplora.tipHeight();
  const confirmations = Math.max(0, tip - t.height + 1);
  const base = { tip, block_height: t.height, block_hash: t.blockHash, confirmations, required: depth };
  if (confirmations < depth) return { kind: "pending", detail: { ...base, reason: `awaiting ${depth} confirmations` } };
  const tx = await esplora.tx(t.txid.toLowerCase());
  if (!tx) return { kind: "failed", detail: { ...base, reason: `transaction not found at ${depth} confirmations` } };
  const seen = {
    ...base,
    tx_confirmed: tx.status.confirmed,
    tx_block_height: tx.status.block_height ?? null,
    tx_block_hash: tx.status.block_hash ?? null,
  };
  if (!tx.status.confirmed)
    return { kind: "failed", detail: { ...seen, reason: "transaction left the best chain (back in the mempool)" } };
  if ((tx.status.block_hash ?? "").toLowerCase() !== t.blockHash.toLowerCase())
    return { kind: "failed", detail: { ...seen, reason: `block hash changed by ${depth} confirmations` } };
  return { kind: "finalized", detail: seen };
}

async function claim(r: Rails, limit: number): Promise<ExecutionRow[]> {
  const res = await sql<ExecutionRow>`
    update executions set finality_recheck_at = now() + make_interval(secs => ${LEASE_MS / 1000})
    where id in (
      select id from executions
      where finality_recheck_status = 'pending' and finality_recheck_at is not null and finality_recheck_at <= now()
      order by finality_recheck_at limit ${limit} for update skip locked)
    returning *`.execute(r.db);
  return res.rows;
}

type Outcome = "finalized" | "failed" | "timeout";

const WHAT: Record<RecheckFamily, { evidence: string; at: string }> = {
  evm: { evidence: "confirmed EVM evidence", at: "at finality" },
  solana: { evidence: "confirmed Solana evidence", at: "at finalized commitment" },
  bitcoin: { evidence: "1-confirmation Bitcoin evidence", at: "at 6 confirmations" },
};

function familyOf(r: Rails, row: ExecutionRow): RecheckFamily | null {
  const f = r.profiles.get(row.destination_chain)?.family;
  return f === "evm" || f === "solana" || f === "bitcoin" ? f : null;
}

async function finish(r: Rails, row: ExecutionRow, outcome: Outcome, detail: Record<string, unknown>) {
  const checkedAt = new Date(r.now()).toISOString();
  const family = familyOf(r, row) ?? "evm";
  const payload = {
    finality_recheck: {
      outcome,
      family,
      chain: row.destination_chain,
      tx_hash: row.evidence?.tx_hash ?? null,
      checked_at: checkedAt,
      ...detail,
    },
  };
  await r.db.transaction().execute(async (tx) => {
    await tx
      .updateTable("executions")
      .set({
        finality_recheck_status: outcome,
        finality_recheck_at: null,
        finality_recheck_detail: JSON.stringify(payload.finality_recheck),
      })
      .where("id", "=", row.id)
      .where("finality_recheck_status", "=", "pending")
      .execute();
    // evidence trail (console `/ops/executions/{id}/observations`): never applied, the state does not change
    if (outcome !== "finalized")
      await tx
        .insertInto("provider_observations")
        .values(observationValues(row.id, "verifier", null, payload, null, false))
        .execute();
  });
  r.metrics.finalityRecheck(row.destination_chain, outcome);
  const w = WHAT[family];
  if (outcome === "failed")
    r.log.error(
      { execution: row.id, state: row.state, ...payload.finality_recheck },
      `ALERT finalized re-check failed: ${w.evidence} contradicted ${w.at} (execution left as is; ops review)`,
    );
  else if (outcome === "timeout")
    r.log.error(
      { execution: row.id, state: row.state, ...payload.finality_recheck },
      `ALERT finalized re-check timed out: ${w.evidence} not final within the window (ops review)`,
    );
}

/** One re-check of a claimed row with its family's reader. */
async function recheckRow(r: Rails, readers: RecheckReaders, row: ExecutionRow): Promise<RecheckVerdict> {
  const txHash = row.evidence?.tx_hash ?? null;
  const blockHash = row.finality_recheck_block_hash;
  const blockRef = row.evidence?.block_ref ?? null;
  const height = blockRef !== null && /^\d{1,19}$/.test(blockRef) ? Number(blockRef) : null;
  const family = familyOf(r, row);
  if (!txHash) return { kind: "failed", detail: { reason: "evidence lacks a tx hash" } };
  if (family === "solana") {
    if (height === null) return { kind: "failed", detail: { reason: "evidence lacks a slot" } };
    const rpc = row.destination_chain === SOLANA_MAINNET ? readers.solana : null;
    if (!rpc) return { kind: "pending", detail: { reason: "no Solana RPC pool" } };
    return recheckSolana(rpc, { signature: txHash, slot: height });
  }
  if (family === "bitcoin") {
    if (!blockHash || height === null)
      return { kind: "failed", detail: { reason: "evidence lacks a block hash or height" } };
    const esplora = row.destination_chain === BITCOIN_MAINNET ? readers.esplora : null;
    if (!esplora) return { kind: "pending", detail: { reason: "no Esplora pool for chain" } };
    return recheckBitcoin(esplora, { txid: txHash, blockHash, height }, r.finalityRecheck.bitcoin.confirmations);
  }
  if (!blockHash) return { kind: "failed", detail: { reason: "evidence lacks a tx hash or block hash" } };
  const rpc = readers.evm.get(row.destination_chain);
  if (!rpc) return { kind: "pending", detail: { reason: "no RPC for chain" } };
  return recheckFinality(rpc, { txHash, blockHash, blockRef });
}

/** One pass over due re-checks; returns rows handled. */
export async function finalityRecheckOnce(r: Rails, readers: RecheckReaders, batch = 20): Promise<number> {
  const rows = await claim(r, batch);
  for (const row of rows) {
    const v: RecheckVerdict = await recheckRow(r, readers, row).catch((e: unknown) => ({
      kind: "pending" as const,
      detail: { reason: e instanceof Error ? e.message : String(e) },
    }));
    if (v.kind === "finalized" || v.kind === "failed") {
      await finish(r, row, v.kind, v.detail);
      continue;
    }
    const now = r.now();
    if (row.finality_recheck_until && now >= row.finality_recheck_until.getTime()) {
      await finish(r, row, "timeout", v.detail);
      continue;
    }
    const plan = recheckPlan(r, familyOf(r, row) ?? "evm");
    await r.db
      .updateTable("executions")
      .set({
        finality_recheck_at: new Date(now + plan.intervalS * 1000),
        finality_recheck_detail: JSON.stringify({ ...v.detail, checked_at: new Date(now).toISOString() }),
      })
      .where("id", "=", row.id)
      .where("finality_recheck_status", "=", "pending")
      .execute();
  }
  return rows.length;
}

export function finalityRecheckTask(r: Rails, readers: RecheckReaders, o: { tickMs?: number } = {}) {
  return {
    name: "finality-recheck",
    start() {
      let stopped = false;
      let timer: NodeJS.Timeout | undefined;
      let running: Promise<void> = Promise.resolve();
      const tick = () => {
        if (stopped) return;
        running = finalityRecheckOnce(r, readers)
          .then(() => undefined)
          .catch((e) => r.log.error({ err: e }, "finality re-check tick failed"))
          .then(() => {
            if (!stopped) timer = setTimeout(tick, o.tickMs ?? 5_000);
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
