/**
 * Post-success `finalized` re-check (lld/rails.md §8.12, ADR-0022), run by `rails-tracker` next to the verifier.
 *
 * EVM evidence accepted on L2 block confirmations settled its execution at once. This loop follows each such
 * transaction until the chain's `finalized` tag covers it:
 * - same block hash, status 1, block ≤ `finalized` → `finalized` (done);
 * - at finality the receipt is gone, sits in another block (hash changed) or has status ≠ 1 → `failed`;
 * - not covered by `finalized` when the window (`NP_FINALITY_RECHECK_WINDOW_S`, 2 h) ends → `timeout`.
 * `failed` and `timeout` never move the execution (terminal states stay terminal, rails §5; the LLD has no
 * post-success contradiction state — gap recorded in ADR-0022): they log `ALERT …`, count
 * `finality_recheck_total{outcome}` (Prometheus → Telegram), keep `finality_recheck_status` on the row for ops and
 * write a `verifier` observation (applied = false) into the execution's evidence trail (console).
 */
import { sql } from "@nearpay-internal/db";
import type { Rails } from "../app/context.js";
import { observationValues } from "../app/observations.js";
import type { ExecutionRow } from "../app/views.js";
import type { EvmRpc } from "../infra/clients/evm.js";

const LEASE_MS = 60_000;

export type RecheckVerdict =
  | { readonly kind: "finalized"; readonly detail: Record<string, unknown> }
  | { readonly kind: "pending"; readonly detail: Record<string, unknown> }
  | { readonly kind: "failed"; readonly detail: Record<string, unknown> };

/** One re-check of `txHash`, confirmed in block `blockRef` with hash `blockHash`, against the `finalized` tag. */
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

async function finish(r: Rails, row: ExecutionRow, outcome: Outcome, detail: Record<string, unknown>) {
  const checkedAt = new Date(r.now()).toISOString();
  const payload = {
    finality_recheck: {
      outcome,
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
  if (outcome === "failed")
    r.log.error(
      { execution: row.id, state: row.state, ...payload.finality_recheck },
      "ALERT finalized re-check failed: confirmed EVM evidence contradicted at finality (execution left as is; ops review)",
    );
  else if (outcome === "timeout")
    r.log.error(
      { execution: row.id, state: row.state, ...payload.finality_recheck },
      "ALERT finalized re-check timed out: confirmed EVM evidence not finalized within the window (ops review)",
    );
}

/** One pass over due re-checks; returns rows handled. */
export async function finalityRecheckOnce(r: Rails, evm: ReadonlyMap<string, EvmRpc>, batch = 20): Promise<number> {
  const rows = await claim(r, batch);
  for (const row of rows) {
    const txHash = row.evidence?.tx_hash ?? null;
    const blockHash = row.finality_recheck_block_hash;
    let v: RecheckVerdict;
    const rpc = evm.get(row.destination_chain);
    if (!txHash || !blockHash) v = { kind: "failed", detail: { reason: "evidence lacks a tx hash or block hash" } };
    else if (!rpc) v = { kind: "pending", detail: { reason: "no RPC for chain" } };
    else
      v = await recheckFinality(rpc, { txHash, blockHash, blockRef: row.evidence?.block_ref ?? null }).catch(
        (e: unknown) => ({ kind: "pending" as const, detail: { reason: e instanceof Error ? e.message : String(e) } }),
      );
    if (v.kind === "finalized" || v.kind === "failed") {
      await finish(r, row, v.kind, v.detail);
      continue;
    }
    const now = r.now();
    if (row.finality_recheck_until && now >= row.finality_recheck_until.getTime()) {
      await finish(r, row, "timeout", v.detail);
      continue;
    }
    await r.db
      .updateTable("executions")
      .set({
        finality_recheck_at: new Date(now + r.finalityRecheck.intervalS * 1000),
        finality_recheck_detail: JSON.stringify({ ...v.detail, checked_at: new Date(now).toISOString() }),
      })
      .where("id", "=", row.id)
      .where("finality_recheck_status", "=", "pending")
      .execute();
  }
  return rows.length;
}

export function finalityRecheckTask(r: Rails, evm: ReadonlyMap<string, EvmRpc>, o: { tickMs?: number } = {}) {
  return {
    name: "finality-recheck",
    start() {
      let stopped = false;
      let timer: NodeJS.Timeout | undefined;
      let running: Promise<void> = Promise.resolve();
      const tick = () => {
        if (stopped) return;
        running = finalityRecheckOnce(r, evm)
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
