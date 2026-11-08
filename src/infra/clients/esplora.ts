/**
 * Bitcoin Esplora pool (lld/rails.md §21.3–§21.4; mempool.space / blockstream.info, keyless): `GET /tx/{txid}`,
 * `GET /blocks/tip/height`, `GET /address/{addr}/txs`. 5 s timeout, hedged reads, 429 → back off ×2.
 */
import { z } from "zod";
import type { EsploraTx } from "../../domain/chains/bitcoin.js";
import { endpointPool, type PoolHealthView, PoolRateLimited, PoolUnavailable } from "./pool.js";

export interface Esplora {
  readonly urls: readonly string[];
  /** null = unknown txid (404). `urlIndex` reads one specific endpoint (agreement). */
  tx(txid: string, urlIndex?: number): Promise<EsploraTx | null>;
  tipHeight(urlIndex?: number): Promise<number>;
  /** Newest first (mempool first, then up to 25 confirmed). */
  addressTxs(address: string): Promise<EsploraTx[]>;
  health(): PoolHealthView;
}

export const EsploraTxResult = z.looseObject({
  txid: z.string().regex(/^[0-9a-fA-F]{64}$/),
  vout: z.array(z.looseObject({ scriptpubkey: z.string(), value: z.number().int().min(0) })),
  status: z.looseObject({
    confirmed: z.boolean(),
    block_height: z.number().int().min(0).nullish(),
    block_hash: z.string().nullish(),
  }),
});

const NotFound = Symbol("not found");

export function esploraClient(o: {
  urls: readonly string[];
  fetch?: typeof fetch;
  timeoutMs?: number;
  hedgeMs?: number;
  now?: () => number;
  onCall?: (outcome: "ok" | "error" | "rate_limited") => void;
}): Esplora {
  const f = o.fetch ?? fetch;
  const pool = endpointPool({
    urls: o.urls.map((u) => u.replace(/\/+$/, "")),
    timeoutMs: o.timeoutMs ?? 5_000,
    hedgeMs: o.hedgeMs ?? 1_500,
    ...(o.now ? { now: o.now } : {}),
    ...(o.onCall ? { onCall: o.onCall } : {}),
  });
  const get =
    (path: string, kind: "json" | "text") =>
    async (base: string, signal: AbortSignal): Promise<unknown> => {
      const res = await f(`${base}${path}`, { headers: { accept: "application/json, text/plain" }, signal });
      if (res.status === 429) throw new PoolRateLimited(`${path} rate-limited`);
      if (res.status === 404 || res.status === 400) return NotFound;
      if (!res.ok) throw new PoolUnavailable(`${path} responded ${res.status}`);
      return kind === "json" ? res.json() : res.text();
    };
  const parseTx = (raw: unknown): EsploraTx => {
    const r = EsploraTxResult.safeParse(raw);
    if (!r.success) throw new PoolUnavailable("esplora: unexpected transaction shape");
    return r.data as unknown as EsploraTx;
  };
  return {
    urls: o.urls,
    async tx(txid, urlIndex) {
      if (!/^[0-9a-f]{64}$/.test(txid)) return null;
      const call = get(`/tx/${txid}`, "json");
      const raw = urlIndex === undefined ? await pool.run(call) : await pool.one(urlIndex, call);
      return raw === NotFound ? null : parseTx(raw);
    },
    async tipHeight(urlIndex) {
      const call = get("/blocks/tip/height", "text");
      const raw = urlIndex === undefined ? await pool.run(call) : await pool.one(urlIndex, call);
      const n = typeof raw === "string" && /^\d{1,9}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
      if (!Number.isSafeInteger(n)) throw new PoolUnavailable("esplora: bad tip height");
      return n;
    },
    async addressTxs(address) {
      if (!/^[a-zA-Z0-9]{14,90}$/.test(address)) return [];
      const raw = await pool.run(get(`/address/${address}/txs`, "json"));
      if (raw === NotFound) return [];
      if (!Array.isArray(raw)) throw new PoolUnavailable("esplora: address txs not an array");
      return raw.map(parseTx);
    },
    health: pool.health,
  };
}
