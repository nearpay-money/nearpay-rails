/**
 * Solana JSON-RPC pool (lld/rails.md §21.2–§21.4): `getSignaturesForAddress` and `getTransaction` at `finalized`
 * commitment, `jsonParsed`, `maxSupportedTransactionVersion: 0`. 3 s timeout, hedged reads, 429 → back off ×2.
 */
import { z } from "zod";
import type { SolanaTx } from "../../domain/chains/solana.js";
import { endpointPool, type PoolHealthView, PoolRateLimited, PoolUnavailable } from "./pool.js";

export interface SignatureInfo {
  readonly signature: string;
  readonly slot: number;
  readonly err: unknown;
  readonly blockTime: number | null;
}

export interface SolanaRpc {
  readonly urls: readonly string[];
  /** Newest first, `finalized`; `until`/`before` are signatures (exclusive). */
  signatures(
    address: string,
    o: { until?: string | null; before?: string | null; limit: number },
  ): Promise<SignatureInfo[]>;
  /** null = not found or not finalized yet. `urlIndex` reads one specific endpoint (agreement). */
  transaction(signature: string, urlIndex?: number): Promise<SolanaTx | null>;
  health(): PoolHealthView;
}

const SigInfo = z.object({
  signature: z.string().min(32).max(100),
  slot: z.number().int().min(0),
  err: z.unknown().optional(),
  blockTime: z.number().int().nullable().optional(),
});

const TokenBalance = z.looseObject({
  accountIndex: z.number().int().min(0),
  mint: z.string(),
  owner: z.string().nullish(),
  programId: z.string().nullish(),
  uiTokenAmount: z.looseObject({ amount: z.string(), decimals: z.number().int().optional() }),
});

/** The fields of `getTransaction` rails reads; anything else passes through untouched. */
export const SolanaTxResult = z.looseObject({
  slot: z.number().int().min(0),
  blockTime: z.number().int().nullable().optional(),
  meta: z
    .looseObject({
      err: z.unknown(),
      preBalances: z.array(z.number().int().min(0)),
      postBalances: z.array(z.number().int().min(0)),
      preTokenBalances: z.array(TokenBalance).nullish(),
      postTokenBalances: z.array(TokenBalance).nullish(),
      loadedAddresses: z
        .looseObject({ writable: z.array(z.string()).optional(), readonly: z.array(z.string()).optional() })
        .nullish(),
    })
    .nullable(),
  transaction: z.looseObject({
    signatures: z.array(z.string()).min(1),
    message: z.looseObject({
      accountKeys: z.array(z.union([z.string(), z.looseObject({ pubkey: z.string(), source: z.string().optional() })])),
    }),
  }),
});

export function solanaRpc(o: {
  urls: readonly string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
  hedgeMs?: number;
  now?: () => number;
  onCall?: (outcome: "ok" | "error" | "rate_limited") => void;
}): SolanaRpc {
  const f = o.fetch ?? fetch;
  const pool = endpointPool({
    urls: o.urls,
    timeoutMs: o.timeoutMs ?? 3_000,
    hedgeMs: o.hedgeMs ?? 1_000,
    ...(o.now ? { now: o.now } : {}),
    ...(o.onCall ? { onCall: o.onCall } : {}),
  });
  const rpc = (method: string, params: unknown[]) => async (url: string, signal: AbortSignal) => {
    const res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal,
    });
    if (res.status === 429) throw new PoolRateLimited(`${method} rate-limited`);
    if (!res.ok) throw new PoolUnavailable(`${method} responded ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string } };
    if (body.error) {
      if (body.error.code === 429 || body.error.code === -32429) throw new PoolRateLimited(`${method} rate-limited`);
      throw new PoolUnavailable(`${method}: ${body.error.message ?? "rpc error"}`);
    }
    return body.result ?? null;
  };
  const txParams = (sig: string) => [
    sig,
    { commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
  ];
  const parseTx = (raw: unknown): SolanaTx | null => {
    if (raw === null) return null;
    const r = SolanaTxResult.safeParse(raw);
    if (!r.success) throw new PoolUnavailable(`getTransaction: unexpected result (${r.error.issues[0]?.message})`);
    return r.data as unknown as SolanaTx;
  };
  return {
    urls: o.urls,
    async signatures(address, q) {
      const cfg: Record<string, unknown> = { commitment: "finalized", limit: q.limit };
      if (q.until) cfg.until = q.until;
      if (q.before) cfg.before = q.before;
      const raw = await pool.run(rpc("getSignaturesForAddress", [address, cfg]));
      const r = z.array(SigInfo).safeParse(raw ?? []);
      if (!r.success) throw new PoolUnavailable("getSignaturesForAddress: unexpected result");
      return r.data.map((s) => ({
        signature: s.signature,
        slot: s.slot,
        err: s.err ?? null,
        blockTime: s.blockTime ?? null,
      }));
    },
    async transaction(sig, urlIndex) {
      const call = rpc("getTransaction", txParams(sig));
      return parseTx(urlIndex === undefined ? await pool.run(call) : await pool.one(urlIndex, call));
    },
    health: pool.health,
  };
}
