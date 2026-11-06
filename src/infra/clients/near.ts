/**
 * NEAR clients (lld/rails.md §8.6, §8.8, §10).
 *
 * - **neardata** (FastNEAR) finalized block stream: `GET /v0/last_block/final` (302 → the block) and
 *   `GET /v0/block/{height}` (`null` for skipped heights). Each block carries every shard's receipt
 *   execution outcomes with their logs — what the indexer parses (SP-14 fixtures, 2026-11-06).
 * - **NEAR RPC** pool (hedged reads): `EXPERIMENTAL_tx_status` with `wait_until: NONE` answers at
 *   once (`UNKNOWN_TRANSACTION` for unknown hashes) and reports `final_execution_status`. Nodes that
 *   track all shards (FastNEAR) accept any `sender_account_id` — verified 2026-11-06 — so the
 *   verifier needs only the provider's tx hash.
 */
import { z } from "zod";

const Outcome = z.object({
  executor_id: z.string(),
  logs: z.array(z.string()),
  status: z.record(z.string(), z.unknown()),
});

export const NeardataBlock = z.object({
  block: z.object({
    header: z.object({ height: z.number().int(), hash: z.string(), timestamp_nanosec: z.string().optional() }),
  }),
  shards: z.array(
    z.object({
      shard_id: z.number().int(),
      receipt_execution_outcomes: z.array(
        z.object({
          execution_outcome: z.object({ id: z.string(), block_hash: z.string(), outcome: Outcome }),
          receipt: z.object({ receipt_id: z.string(), receiver_id: z.string(), predecessor_id: z.string() }),
          tx_hash: z.string().nullable().optional(),
        }),
      ),
    }),
  ),
});
export type NeardataBlock = z.infer<typeof NeardataBlock>;

export const TxStatus = z.object({
  final_execution_status: z.string(),
  transaction: z.object({ hash: z.string(), signer_id: z.string(), receiver_id: z.string() }),
  receipts_outcome: z.array(z.object({ id: z.string(), block_hash: z.string(), outcome: Outcome })),
});
export type TxStatus = z.infer<typeof TxStatus>;

export interface Neardata {
  finalHeight(signal?: AbortSignal): Promise<number>;
  /** null: the height was skipped (no block). */
  block(height: number, signal?: AbortSignal): Promise<NeardataBlock | null>;
}

export function neardata(o: { baseUrl: string; fetch?: typeof fetch; timeoutMs?: number }): Neardata {
  const f = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/$/, "");
  const get = async (path: string, signal?: AbortSignal) => {
    const t = AbortSignal.timeout(o.timeoutMs ?? 10_000);
    const res = await f(`${base}${path}`, {
      headers: { accept: "application/json" },
      redirect: "follow",
      signal: signal ? AbortSignal.any([signal, t]) : t,
    });
    if (!res.ok) throw new Error(`neardata ${path} responded ${res.status}`);
    return (await res.json()) as unknown;
  };
  return {
    async finalHeight(signal) {
      const b = NeardataBlock.parse(await get("/v0/last_block/final", signal));
      return b.block.header.height;
    },
    async block(height, signal) {
      const body = await get(`/v0/block/${height}`, signal);
      return body === null ? null : NeardataBlock.parse(body);
    },
  };
}

export type TxLookup =
  | { readonly kind: "found"; readonly final: boolean; readonly tx: TxStatus }
  | { readonly kind: "unknown" }
  | { readonly kind: "error"; readonly detail: string };

export interface NearRpc {
  txStatus(hash: string, senderHint: string): Promise<TxLookup>;
}

/** JSON-RPC pool: providers in order; a tx is unknown only when no provider knows it. */
export function nearRpc(o: { urls: readonly string[]; fetch?: typeof fetch; timeoutMs?: number }): NearRpc {
  const f = o.fetch ?? fetch;
  return {
    async txStatus(hash, senderHint) {
      let last = "no NEAR RPC configured";
      let unknown = false;
      for (const url of o.urls) {
        try {
          const res = await f(url, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: "rails",
              method: "EXPERIMENTAL_tx_status",
              params: { tx_hash: hash, sender_account_id: senderHint, wait_until: "NONE" },
            }),
            signal: AbortSignal.timeout(o.timeoutMs ?? 3_000),
          });
          if (!res.ok) {
            last = `${url} responded ${res.status}`;
            continue;
          }
          const body = (await res.json()) as {
            result?: unknown;
            error?: { cause?: { name?: string }; message?: string };
          };
          if (body.error) {
            if (body.error.cause?.name === "UNKNOWN_TRANSACTION") {
              unknown = true;
              continue;
            }
            last = `${url}: ${body.error.cause?.name ?? body.error.message ?? "rpc error"}`;
            continue;
          }
          const tx = TxStatus.parse(body.result);
          return { kind: "found", final: tx.final_execution_status === "FINAL", tx };
        } catch (e) {
          last = `${url}: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      return unknown ? { kind: "unknown" } : { kind: "error", detail: last };
    },
  };
}
