/** Stage 4 pools and clients (§21.4) with an injected fetch: failover, hedging, 429 back-off, health; sandbox vault feed. */
import { describe, expect, it } from "vitest";
import type { Rails } from "../../src/app/context.js";
import { esploraClient } from "../../src/infra/clients/esplora.js";
import {
  endpointPool,
  PoolRateLimited,
  PoolUnavailable,
  UNHEALTHY_AFTER_MS,
  unhealthy,
} from "../../src/infra/clients/pool.js";
import { solanaRpc } from "../../src/infra/clients/solana.js";
import { sandboxVaultReceipts } from "../../src/trackers/near-indexer/indexer.js";
import { specVector } from "../support/vectors.js";

// biome-ignore lint/suspicious/noExplicitAny: vector JSON
type Any = any;
const V = specVector<Any>("chains-solana-bitcoin.json");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("endpoint pool", () => {
  it("fails over, prefers the last good endpoint and tracks health", async () => {
    let t = 1_000;
    const calls: string[] = [];
    const pool = endpointPool({ urls: ["a", "b"], timeoutMs: 1_000, now: () => t });
    const ok = await pool.run(async (u) => {
      calls.push(u);
      if (u === "a") throw new PoolUnavailable("down");
      return u;
    });
    expect(ok).toBe("b");
    expect(pool.health()).toEqual({ lastOkMs: 1_000, failingSinceMs: null });
    await pool.run(async (u) => {
      calls.push(u);
      return u;
    });
    expect(calls).toEqual(["a", "b", "b"]); // b is preferred now
    t = 2_000;
    await expect(
      pool.run(async () => {
        throw new PoolUnavailable("all down");
      }),
    ).rejects.toThrow("all down");
    t = 3_000;
    await expect(pool.run(async () => Promise.reject("x"))).rejects.toThrow();
    expect(pool.health().failingSinceMs).toBe(2_000);
    expect(unhealthy(pool.health(), 2_000 + UNHEALTHY_AFTER_MS)).toBe(false);
    expect(unhealthy(pool.health(), 2_001 + UNHEALTHY_AFTER_MS)).toBe(true);
    await expect(endpointPool({ urls: [], timeoutMs: 1 }).run(async () => 1)).rejects.toThrow("no endpoint");
  });

  it("backs off a rate-limited endpoint and hedges a slow one", async () => {
    let t = 0;
    const outcomes: string[] = [];
    const pool = endpointPool({
      urls: ["a", "b"],
      timeoutMs: 1_000,
      hedgeMs: 20,
      now: () => t,
      onCall: (o) => outcomes.push(o),
    });
    await pool.run(async (u) => {
      if (u === "a") throw new PoolRateLimited("429");
      return u;
    });
    // `a` is cooling down: only `b` is tried
    const seen: string[] = [];
    await pool.run(async (u) => {
      seen.push(u);
      return u;
    });
    expect(seen).toEqual(["b"]);
    t = 10_000; // back-off over
    const slow = endpointPool({ urls: ["slow", "fast"], timeoutMs: 1_000, hedgeMs: 10 });
    const v = await slow.run(
      (u, signal) =>
        new Promise<string>((res, rej) => {
          const timer = setTimeout(() => res(u), u === "slow" ? 300 : 5);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            rej(new Error("aborted"));
          });
        }),
    );
    expect(v).toBe("fast");
    expect(outcomes).toEqual(["rate_limited", "ok", "ok"]);
    await expect(slow.one(5, async () => 1)).rejects.toThrow("no endpoint #5");
    expect(await slow.one(0, async (u) => u)).toBe("slow");
  });

  it("aborts an endpoint after its timeout", async () => {
    const pool = endpointPool({ urls: ["a"], timeoutMs: 20 });
    await expect(
      pool.run(
        (_u, signal) =>
          new Promise((_res, rej) => signal.addEventListener("abort", () => rej(new PoolUnavailable("timeout")))),
      ),
    ).rejects.toThrow("timeout");
  });
});

describe("Solana RPC client", () => {
  const tx = V.evidence.solana.cases[0].rpc_result;
  it("reads finalized transactions and signatures; null for unknown; errors and 429s", async () => {
    const bodies: Any[] = [];
    const rpc = solanaRpc({
      urls: ["http://a", "http://b"],
      hedgeMs: 1_000,
      fetch: (async (url: string, init: RequestInit) => {
        const b = JSON.parse(init.body as string);
        bodies.push({ url, ...b });
        if (b.method === "getTransaction") return json({ result: b.params[0] === "known" ? tx : null });
        if (b.method === "getSignaturesForAddress")
          return url === "http://a"
            ? new Response("", { status: 429 })
            : json({ result: [{ signature: "s".repeat(64), slot: 5, err: null, blockTime: null }] });
        return json({ error: { code: -32601, message: "nope" } });
      }) as typeof fetch,
    });
    expect((await rpc.transaction("known"))?.slot).toBe(380000001);
    expect(await rpc.transaction("unknown", 1)).toBeNull();
    expect(bodies[0].params[1]).toEqual({
      commitment: "finalized",
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 0,
    });
    const sigs = await rpc.signatures("acct", { until: "u", before: "b", limit: 7 });
    expect(sigs).toEqual([{ signature: "s".repeat(64), slot: 5, err: null, blockTime: null }]);
    expect(bodies.at(-1).params[1]).toEqual({ commitment: "finalized", limit: 7, until: "u", before: "b" });
    expect(rpc.health().failingSinceMs).toBeNull();
  });

  it("refuses malformed results and JSON-RPC errors", async () => {
    const mk = (body: unknown, status = 200) =>
      solanaRpc({ urls: ["http://a"], fetch: (async () => json(body, status)) as typeof fetch });
    await expect(mk({ result: { slot: "x" } }).transaction("s")).rejects.toThrow("unexpected result");
    await expect(mk({ result: [{ nope: 1 }] }).signatures("a", { limit: 1 })).rejects.toThrow("unexpected result");
    await expect(mk({ error: { code: 429, message: "slow down" } }).transaction("s")).rejects.toThrow("rate-limited");
    await expect(mk({ error: { message: "boom" } }).transaction("s")).rejects.toThrow("boom");
    await expect(mk({}, 500).transaction("s")).rejects.toThrow("responded 500");
    expect(await mk({}).signatures("a", { limit: 1 })).toEqual([]);
  });
});

describe("Esplora client", () => {
  const tx = V.evidence.bitcoin.cases[0].esplora_tx;
  it("reads transactions, the tip and address history; 404 → null; 429 backs off", async () => {
    const paths: string[] = [];
    const esplora = esploraClient({
      urls: ["http://a/api/", "http://b/api"],
      fetch: (async (url: string) => {
        paths.push(url);
        if (url.startsWith("http://a") && url.endsWith("/height")) return new Response("", { status: 429 });
        if (url.endsWith("/blocks/tip/height")) return new Response("900001\n");
        if (url.includes(`/tx/${tx.txid}`)) return json(tx);
        if (url.includes("/tx/")) return new Response("Transaction not found", { status: 404 });
        if (url.includes("/address/")) return json([tx]);
        return new Response("", { status: 500 });
      }) as typeof fetch,
    });
    expect(await esplora.tipHeight()).toBe(900001);
    expect((await esplora.tx(tx.txid))?.vout).toHaveLength(2);
    expect(await esplora.tx("ab".repeat(32), 0)).toBeNull();
    expect(await esplora.tx("not-a-txid")).toBeNull();
    expect(await esplora.addressTxs("bc1qgjvrfv789jcls63y95cgan53lq88jnuh32w0fq")).toHaveLength(1);
    expect(await esplora.addressTxs("bad address!")).toEqual([]);
    expect(paths[0]).toBe("http://a/api/blocks/tip/height");
  });

  it("refuses bad shapes", async () => {
    const mk = (r: () => Response) => esploraClient({ urls: ["http://a"], fetch: (async () => r()) as typeof fetch });
    await expect(mk(() => new Response("tip")).tipHeight()).rejects.toThrow("bad tip height");
    await expect(mk(() => json({ txid: "x" })).tx("ab".repeat(32))).rejects.toThrow("unexpected transaction");
    await expect(mk(() => json({})).addressTxs("bc1qgjvrfv789jcls63y95cgan53lq88jnuh32w0fq")).rejects.toThrow(
      "not an array",
    );
    expect(await mk(() => new Response("", { status: 404 })).addressTxs("bc1qgjvrfv789jcls63y95")).toEqual([]);
    await expect(mk(() => new Response("", { status: 503 })).tipHeight(0)).rejects.toThrow("responded 503");
  });
});

describe("sandbox vault stand-in feed (§8.6 v1.10)", () => {
  const VAULT = specVector<Any>("vault.json");
  const r = { intentsContract: "intents.near", vault: { live: null, test: "vault.sandbox.near" } } as unknown as Rails;
  const base = { tx_hash: "4bWb9XzwJ2w3F7C2dWbNN1pYxQX7bGk8C5fDf3h1Jq8y", block_height: 77 };
  it("groups stand-in lines by receipt with their log index; Verifier lines are ignored", () => {
    const events = [
      { ...base, seq: 1, log: "EVENT_JSON:{}" }, // a Verifier event (no executor)
      {
        ...base,
        seq: 2,
        log: "EVENT_JSON:{}",
        executor_id: "usdc.sandbox.near",
        receipt_id: "R0",
        log_index: 0,
        block_hash: "bh",
        block_timestamp: "1",
      },
      {
        ...base,
        seq: 3,
        log: VAULT.events[0].log,
        executor_id: "vault.sandbox.near",
        receipt_id: "R1",
        log_index: 2,
        block_hash: "bh",
        block_timestamp: "1794268800000000000",
      },
      {
        ...base,
        seq: 4,
        log: VAULT.events[2].log,
        executor_id: "vault.sandbox.near",
        receipt_id: "R2",
        log_index: 0,
        block_hash: "bh",
        block_timestamp: "1",
        receipt_status: "failure" as const,
      },
      { ...base, seq: 5, log: VAULT.events[3].log, executor_id: "intents.near" },
    ];
    const out = sandboxVaultReceipts(r, events);
    expect(out.records.map((x) => [x.receipt_id, x.log_index, x.event.event, x.vault_contract])).toEqual([
      ["R1", 2, "mandate_created", "vault.sandbox.near"],
    ]);
    expect(out.rejected).toEqual(["failed_receipt"]);
  });
});
