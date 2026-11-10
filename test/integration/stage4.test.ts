/**
 * Stage 4 (lld/rails.md §21, §8.6) against recorded-shape fakes — no live network: a Solana JSON-RPC fake and an Esplora
 * fake serving the spec vectors' transactions, the 1Click fake for provider statuses, and synthetic neardata blocks
 * for vault events. Covers the Solana/Bitcoin verifiers through the tracker, the watchers, tier pinning and the Tier-B
 * fallback, the sandbox evidence adapter (§21.5) and vault event forwarding.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { BitcoinEvidence, SolanaEvidence } from "@nearpay/spec";
import { fromUuid, toUuid } from "@nearpay-internal/ids";
import { EventEnvelope, Execution, VaultEventRecord } from "@nearpay-internal/spec";
import bs58 from "bs58";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tierAtCreate } from "../../src/app/chain-tier.js";
import { refreshTokens } from "../../src/app/tokens.js";
import type { ExecutionRow } from "../../src/app/views.js";
import type { EsploraTx } from "../../src/domain/chains/bitcoin.js";
import type { SolanaTx } from "../../src/domain/chains/solana.js";
import { esploraClient } from "../../src/infra/clients/esplora.js";
import { neardata } from "../../src/infra/clients/near.js";
import { solanaRpc } from "../../src/infra/clients/solana.js";
import { readCursor, writeCursor } from "../../src/trackers/cursors.js";
import { bitcoinWatchOnce } from "../../src/trackers/destination-watchers/bitcoin-watcher.js";
import { solanaWatchOnce } from "../../src/trackers/destination-watchers/solana-watcher.js";
import { indexOnce } from "../../src/trackers/near-indexer/indexer.js";
import { sandboxChainOutcome } from "../../src/verifiers/chains.js";
import { type FakeOneClick, type FakeServer, fakeOneClick, fakeServer } from "../support/fakes.js";
import { ACCOUNT, randomEvm, routeQuote } from "../support/requests.js";
import { type Stack, startStack, USDC_ARB } from "../support/stack.js";
import { specVector } from "../support/vectors.js";

// biome-ignore lint/suspicious/noExplicitAny: vector JSON
type Any = any;
const V = specVector<Any>("chains-solana-bitcoin.json");
const VAULT_V = specVector<Any>("vault.json");

const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BITCOIN = "bip122:000000000019d6689c085ae165831e93";
const USDC_SOL = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near";
const SOL = "nep141:sol.omft.near";
const BTC = "nep141:btc.omft.near";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const OWNER = "H314ws4NAZj5cXEzLVXyLZ3vrwWYuhDEz2cSa5EMs7DR";
const OWNER_ATA = "6Pae6bB84WciurjFB1rXDJtUUW2Haiv97KvRWAbuRx5h";
const SOLVER = "bHc9jeXo4NK4ma1W4aLwU5REmqhzTKnzXq79JEeb3Dq";
const SOLVER_ATA = "3QBfo77iYx9FCuRaDfveumpuSQYVEwmTQy1e25nRrdwL";
const BTC_ADDR = "bc1qgjvrfv789jcls63y95cgan53lq88jnuh32w0fq";
const VAULT = "v1.vault.nearpay.near";

const sig = () => bs58.encode(randomBytes(64));
const txid = () => randomBytes(32).toString("hex");

// ---------------------------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------------------------

/** Transactions the fake serves at `confirmed` (evidence, ADR-0022 as amended). */
const solTxs = new Map<string, SolanaTx | null>();
/**
 * `finalized` view (§8.12 re-check): a confirmed tx whose slot ≤ `solFinalizedSlot`, unless `solFinal` overrides it
 * (null = dropped with its fork, or another tx = moved).
 */
const solFinal = new Map<string, SolanaTx | null>();
let solFinalizedSlot = 0;
const commitments: string[] = [];
/** account → signatures, newest first. */
const solSigs = new Map<string, { signature: string; slot: number; err: unknown; blockTime: number }[]>();

async function fakeSolana(): Promise<FakeServer> {
  return fakeServer((req) => {
    const b = req.body as { method: string; params: [string, Record<string, unknown>] };
    const reply = (result: unknown) => ({ status: 200, body: { jsonrpc: "2.0", id: 1, result } });
    if (b.method === "getSlot") return reply(solFinalizedSlot);
    if (b.method === "getTransaction") {
      expect(b.params[1]).toMatchObject({ maxSupportedTransactionVersion: 0 });
      const c = b.params[1].commitment as string;
      commitments.push(`getTransaction@${c}`);
      expect(["confirmed", "finalized"]).toContain(c); // never `processed`
      if (c === "finalized") {
        if (solFinal.has(b.params[0])) return reply(solFinal.get(b.params[0]) ?? null);
        const t = solTxs.get(b.params[0]) ?? null;
        return reply(t && t.slot <= solFinalizedSlot ? t : null);
      }
      return reply(solTxs.get(b.params[0]) ?? null);
    }
    if (b.method === "getSignaturesForAddress") {
      expect(b.params[1]).toMatchObject({ commitment: "confirmed" });
      const all = solSigs.get(b.params[0]) ?? [];
      const until = b.params[1].until as string | undefined;
      const cut = until ? all.findIndex((x) => x.signature === until) : -1;
      const list = cut >= 0 ? all.slice(0, cut) : all;
      return reply(list.slice(0, b.params[1].limit as number));
    }
    return { status: 200, body: { jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no" } } };
  });
}

const btcTxs = new Map<string, EsploraTx>();
const btcAddr = new Map<string, EsploraTx[]>();
let tip = 900_000;
async function fakeEsplora(): Promise<FakeServer> {
  return fakeServer((req) => {
    if (req.path === "/blocks/tip/height") return { status: 200, body: tip };
    const t = /^\/tx\/([0-9a-f]{64})$/.exec(req.path);
    if (t) {
      const tx = btcTxs.get(t[1] as string);
      return tx ? { status: 200, body: tx } : { status: 404, body: "Transaction not found" };
    }
    const a = /^\/address\/([a-z0-9]+)\/txs$/.exec(req.path);
    if (a) return { status: 200, body: btcAddr.get(a[1] as string) ?? [] };
    return { status: 404, body: null };
  });
}

/** An SPL payout of `amount` to OWNER (ATA created in the tx when `created`), shaped like the vector cases. */
function splPayout(o: { signature: string; slot: number; amount: bigint; created?: boolean; err?: unknown }): SolanaTx {
  const tb = (accountIndex: number, owner: string, amount: bigint) => ({
    accountIndex,
    mint: MINT,
    owner,
    programId: TOKEN,
    uiTokenAmount: { amount: amount.toString(), decimals: 6 },
  });
  const ok = o.err === undefined || o.err === null;
  return {
    slot: o.slot,
    blockTime: 1_794_139_200,
    meta: {
      err: o.err ?? null,
      preBalances: [5_000_000_000, 2_039_280, o.created ? 0 : 2_039_280, 1_000_000_000, 1_461_600, 1],
      postBalances: [4_997_955_720, 2_039_280, 2_039_280, 1_000_000_000, 1_461_600, 1],
      preTokenBalances: [tb(1, SOLVER, 900_000_000n), ...(o.created ? [] : [tb(2, OWNER, 0n)])],
      postTokenBalances: [tb(1, SOLVER, ok ? 900_000_000n - o.amount : 900_000_000n), tb(2, OWNER, ok ? o.amount : 0n)],
    },
    transaction: {
      signatures: [o.signature],
      message: { accountKeys: [SOLVER, SOLVER_ATA, OWNER_ATA, OWNER, MINT, TOKEN] },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// stack
// ---------------------------------------------------------------------------------------------

let s: Stack;
let one: FakeOneClick;
let sol: FakeServer;
let esp: FakeServer;
let nd: FakeServer;
let final = 150_000_000;
const blocks = new Map<number, unknown>();

beforeAll(async () => {
  [one, sol, esp] = await Promise.all([fakeOneClick(), fakeSolana(), fakeEsplora()]);
  nd = await fakeServer((req) => {
    if (req.path === "/v0/last_block/final")
      return { status: 200, body: { block: { header: { height: final, hash: `h${final}` } }, shards: [] } };
    const m = /^\/v0\/block\/(\d+)$/.exec(req.path);
    return { status: 200, body: m ? (blocks.get(Number(m[1])) ?? null) : null };
  });
  s = await startStack({
    oneclick: one,
    config: {
      treasuryAccount: "treasury.nearpay.near",
      solanaRpcUrls: [sol.url],
      bitcoinEsploraUrls: [esp.url],
      vaultContract: VAULT,
    },
    tracker: {
      solana: solanaRpc({ urls: [sol.url] }),
      esplora: esploraClient({ urls: [esp.url] }),
    },
  });
  await refreshTokens(s.rails, true);
  await s.admin.db.updateTable("tokens").set({ price_updated_at: new Date() }).where("livemode", "=", true).execute();
});
afterAll(async () => {
  await s?.stop();
  await Promise.all([one?.stop(), sol?.stop(), esp?.stop(), nd?.stop()]);
});

const get = async (id: string) => Execution.parse((await s.call("GET", `/internal/executions/${id}`)).body);
async function until(id: string, pred: (x: Execution) => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const x = await get(id);
    if (pred(x)) return x;
    if (Date.now() > end) throw new Error(`stuck in ${x.state}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Inserts an in-flight live execution settling on Solana or Bitcoin (paths a quote cannot reach in a test). */
async function insertExecution(o: {
  state: "settling" | "verifying" | "awaiting_deposit";
  chain: string;
  recipient: string;
  asset: string;
  decimals: number;
  base: bigint;
  tag?: bigint;
  txHashes?: string[];
  snapshot?: { primary_usd: string | null; secondary_usd: string | null };
  tier?: "A" | "B" | null;
  depositAddress?: string;
  origin?: { asset: string; chain: string };
}): Promise<string> {
  const id = randomUUID();
  const tag = o.tag ?? 0n;
  await s.admin.db
    .insertInto("executions")
    .values({
      id,
      account_id: toUuid(ACCOUNT, "acct"),
      livemode: true,
      kind: "payment",
      method: "route_quote",
      provider: "oneclick",
      idempotency_key: `test:${id}`,
      state: o.state,
      provider_status: o.state === "verifying" ? "SUCCESS" : "PROCESSING",
      origin_asset_id: o.origin?.asset ?? USDC_ARB,
      origin_chain: o.origin?.chain ?? "eip155:42161",
      refund_to: "0x52908400098527886e0f7030069857d2e4169ee7",
      refund_type: "origin_chain",
      destination_asset_id: o.asset,
      recipient: o.recipient,
      recipient_type: "destination_chain",
      destination_chain: o.chain,
      destination_key: `${o.chain}|${o.recipient}|${o.asset}`,
      route_class: "stable_pair",
      applied_fee_bps: 20,
      amount_out_base: o.base.toString(),
      amount_tag: tag.toString(),
      amount_out_expected: (o.base + tag).toString(),
      destination_decimals: o.decimals,
      price_snapshot: JSON.stringify({
        ...(o.snapshot ?? { primary_usd: "1", secondary_usd: null }),
        fx: null,
        par: false,
        as_of: new Date().toISOString(),
      }),
      deposit_address: o.depositAddress ?? randomEvm(),
      deadline: new Date(Date.now() + 1_800_000),
      destination_tx_hashes: o.txHashes ?? [],
      verify_at: o.state === "verifying" ? new Date() : null,
      verifying_since: o.state === "verifying" ? new Date() : null,
      verification_tier: o.tier === undefined ? "A" : o.tier,
      version: 1,
    })
    .execute();
  return fromUuid("ex", id);
}

const verifications = (id: string) =>
  s.admin.db.selectFrom("verifications").selectAll().where("execution_id", "=", toUuid(id, "ex")).execute();

// ---------------------------------------------------------------------------------------------
// Solana verifier
// ---------------------------------------------------------------------------------------------

describe("Solana verifier (§21.3)", () => {
  it("a payout creating the ATA in the same tx settles with Evidence.solana and the solver as sender", async () => {
    const signature = sig();
    solTxs.set(signature, splPayout({ signature, slot: 380_000_010, amount: 25_000_000n, created: true }));
    const id = await insertExecution({
      state: "verifying",
      chain: SOLANA,
      recipient: OWNER,
      asset: USDC_SOL,
      decimals: 6,
      base: 25_000_000n,
      txHashes: [signature],
    });
    const done = await until(id, (e) => e.state === "succeeded");
    const ev = done.evidence as Any;
    expect(ev).toMatchObject({
      chain: SOLANA,
      tx_hash: signature,
      block_ref: "380000010",
      recipient: OWNER,
      asset_id: USDC_SOL,
      amount: "25000000",
      finality: "confirmed", // ADR-0022 as amended: `confirmed` commitment (Solana's one-block confirmation)
      tier: "A",
      source: "verifier",
      sender: SOLVER,
      bitcoin: null,
      explorer_url: `https://solscan.io/tx/${signature}`,
    });
    expect(SolanaEvidence.parse(ev.solana)).toEqual({
      signature,
      slot: 380_000_010,
      block_time: 1_794_139_200,
      mint: MINT,
      token_program: TOKEN,
      owner: OWNER,
      token_accounts: [OWNER_ATA],
      pre_amount: "0",
      post_amount: "25000000",
    });
    expect(commitments).toContain("getTransaction@confirmed");
    expect(commitments).not.toContain("getTransaction@finalized"); // evidence never waits for `finalized`
  });

  describe("post-success re-check at `finalized` commitment (§8.12)", () => {
    const recheck = (id: string) =>
      s.admin.db
        .selectFrom("executions")
        .select([
          "state",
          "version",
          "finality_recheck_status",
          "finality_recheck_detail",
          "finality_recheck_block_hash",
        ])
        .where("id", "=", toUuid(id, "ex"))
        .executeTakeFirstOrThrow();
    const due = (id: string) =>
      s.admin.db
        .updateTable("executions")
        .set({ finality_recheck_at: new Date() })
        .where("id", "=", toUuid(id, "ex"))
        .execute();
    async function settled(slot: number) {
      const signature = sig();
      solTxs.set(signature, splPayout({ signature, slot, amount: 4_000_000n }));
      const id = await insertExecution({
        state: "verifying",
        chain: SOLANA,
        recipient: OWNER,
        asset: USDC_SOL,
        decimals: 6,
        base: 4_000_000n,
        txHashes: [signature],
      });
      await until(id, (e) => e.state === "succeeded");
      return { id, signature };
    }
    async function outcome(id: string) {
      const end = Date.now() + 10_000;
      for (;;) {
        const r = await recheck(id);
        if (r.finality_recheck_status !== "pending" || Date.now() > end) return r;
        await new Promise((x) => setTimeout(x, 100));
      }
    }

    it("scheduled at settlement; pending until the slot is finalized, then `finalized`", async () => {
      solFinalizedSlot = 0;
      const { id } = await settled(380_100_000);
      expect(await recheck(id)).toMatchObject({
        finality_recheck_status: "pending",
        finality_recheck_block_hash: null,
      });
      expect((await recheck(id)).finality_recheck_detail).toMatchObject({ family: "solana", block_ref: "380100000" });
      await due(id);
      await new Promise((r) => setTimeout(r, 600));
      expect((await recheck(id)).finality_recheck_status).toBe("pending"); // slot not finalized yet
      solFinalizedSlot = 380_100_032;
      await due(id);
      expect(await outcome(id)).toMatchObject({ state: "succeeded", finality_recheck_status: "finalized" });
    });

    it("dropped with its fork by finality → ALERT, metric, evidence-trail observation; stays succeeded", async () => {
      const tr = s.tracker?.rails as NonNullable<typeof s.tracker>["rails"];
      const alert = vi.spyOn(tr.log, "error");
      const metric = vi.spyOn(tr.metrics, "finalityRecheck");
      solFinalizedSlot = 0;
      const { id, signature } = await settled(380_200_000);
      solTxs.set(signature, null); // gone at `confirmed` too: the fork was abandoned
      solFinal.set(signature, null);
      solFinalizedSlot = 380_200_040;
      await due(id);
      const row = await outcome(id);
      expect(row).toMatchObject({ state: "succeeded", version: 2, finality_recheck_status: "failed" });
      expect(row.finality_recheck_detail).toMatchObject({
        outcome: "failed",
        family: "solana",
        reason: "transaction not found at finality",
      });
      expect(metric).toHaveBeenCalledWith(SOLANA, "failed");
      expect(alert).toHaveBeenCalledWith(
        expect.objectContaining({ tx_hash: signature }),
        expect.stringMatching(/^ALERT finalized re-check failed: confirmed Solana evidence/),
      );
      const obs = await s.call("GET", `/internal/executions/${id}/observations`);
      expect((obs.body as { data: Any[] }).data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "verifier",
            applied: false,
            payload: expect.objectContaining({ finality_recheck: expect.objectContaining({ outcome: "failed" }) }),
          }),
        ]),
      );
      alert.mockRestore();
      metric.mockRestore();
    });
  });

  it("a failed transaction proves nothing; another provider signature that pays settles", async () => {
    const failed = sig();
    const good = sig();
    solTxs.set(failed, splPayout({ signature: failed, slot: 380_000_020, amount: 7_000_000n, err: { Custom: 1 } }));
    const id = await insertExecution({
      state: "verifying",
      chain: SOLANA,
      recipient: OWNER,
      asset: USDC_SOL,
      decimals: 6,
      base: 7_000_000n,
      txHashes: [failed],
    });
    await new Promise((r) => setTimeout(r, 1_500));
    expect((await get(id)).state).toBe("verifying"); // retried, never held for a failed tx before the timeout
    expect(await verifications(id)).toHaveLength(0);
    solTxs.set(good, splPayout({ signature: good, slot: 380_000_021, amount: 7_000_000n }));
    await s.admin.db
      .updateTable("executions")
      .set({ destination_tx_hashes: [failed, good], verify_at: new Date() })
      .where("id", "=", toUuid(id, "ex"))
      .execute();
    const done = await until(id, (e) => e.state === "succeeded");
    expect(done.evidence?.tx_hash).toBe(good);
  });

  it("not yet confirmed (null) keeps verifying; the verification timeout holds it (evidence_timeout)", async () => {
    const pendingSig = sig();
    const id = await insertExecution({
      state: "verifying",
      chain: SOLANA,
      recipient: OWNER,
      asset: USDC_SOL,
      decimals: 6,
      base: 1_000_000n,
      txHashes: [pendingSig],
    });
    await new Promise((r) => setTimeout(r, 800));
    expect((await get(id)).state).toBe("verifying");
    await s.admin.db
      .updateTable("executions")
      .set({ verifying_since: new Date(Date.now() - 1_900_000), verify_at: new Date() })
      .where("id", "=", toUuid(id, "ex"))
      .execute();
    const held = await until(id, (e) => e.state === "held");
    expect(held.held_reason).toBe("evidence_timeout");
  });

  it("a payout to someone else is a mismatch at the timeout (evidence_mismatch)", async () => {
    const other = sig();
    solTxs.set(other, splPayout({ signature: other, slot: 380_000_030, amount: 3_000_000n }));
    const id = await insertExecution({
      state: "verifying",
      chain: SOLANA,
      recipient: "EyjEeiTxb4rvkoN3ZA2zTimuc6VyF8V1QuH9TT66Gkn6",
      asset: USDC_SOL,
      decimals: 6,
      base: 3_000_000n,
      txHashes: [other],
    });
    await s.admin.db
      .updateTable("executions")
      .set({ verifying_since: new Date(Date.now() - 1_900_000) })
      .where("id", "=", toUuid(id, "ex"))
      .execute();
    const held = await until(id, (e) => e.state === "held");
    expect(held.held_reason).toBe("evidence_mismatch");
  });
});

// ---------------------------------------------------------------------------------------------
// Bitcoin verifier
// ---------------------------------------------------------------------------------------------

describe("Bitcoin verifier (§21.3, confirmation tiers)", () => {
  const vec = (i: number) => structuredClone(V.evidence.bitcoin.cases[i].esplora_tx) as EsploraTx;

  it("USD 500 split outputs: 1 confirmation required, outputs summed, Evidence.bitcoin; sender null", async () => {
    const tx = { ...vec(3), txid: txid() } as EsploraTx;
    btcTxs.set(tx.txid, tx);
    tip = 900_000;
    const id = await insertExecution({
      state: "verifying",
      chain: BITCOIN,
      recipient: BTC_ADDR,
      asset: BTC,
      decimals: 8,
      base: 625_000n,
      txHashes: [tx.txid.toUpperCase()],
      snapshot: { primary_usd: "80000", secondary_usd: "80000" },
    });
    const done = await until(id, (e) => e.state === "succeeded");
    const ev = done.evidence as Any;
    expect(ev).toMatchObject({
      chain: BITCOIN,
      tx_hash: tx.txid,
      block_ref: "900000",
      amount: "625000",
      finality: "confirmed",
      tier: "A",
      source: "verifier",
      sender: null,
      solana: null,
      explorer_url: `https://mempool.space/tx/${tx.txid}`,
    });
    expect(BitcoinEvidence.parse(ev.bitcoin)).toEqual({
      ...V.evidence.bitcoin.cases[3].evidence.bitcoin,
      txid: tx.txid,
      confirmations: 1,
      required_confirmations: 1,
    });
  });

  it("USD 1,000 (and any amount): one confirmation settles — no USD tiers by default; the mempool never counts", async () => {
    const tx = { ...vec(1), txid: txid(), status: { confirmed: false } } as EsploraTx;
    btcTxs.set(tx.txid, tx);
    tip = 900_000;
    const id = await insertExecution({
      state: "verifying",
      chain: BITCOIN,
      recipient: BTC_ADDR,
      asset: BTC,
      decimals: 8,
      base: 1_250_000n,
      txHashes: [tx.txid],
      snapshot: { primary_usd: "80000", secondary_usd: null },
    });
    await new Promise((r) => setTimeout(r, 700));
    expect((await get(id)).state).toBe("verifying"); // mempool
    btcTxs.set(tx.txid, { ...vec(1), txid: tx.txid });
    await s.admin.db
      .updateTable("executions")
      .set({ verify_at: new Date() })
      .where("id", "=", toUuid(id, "ex"))
      .execute();
    const done = await until(id, (e) => e.state === "succeeded");
    expect((done.evidence as Any).bitcoin).toMatchObject({ confirmations: 1, required_confirmations: 1 });
  });

  it("without a price in the snapshot: still 1 confirmation (no tiers to be strict about)", async () => {
    const tx = { ...vec(0), txid: txid() } as EsploraTx;
    btcTxs.set(tx.txid, tx);
    tip = 900_000;
    const id = await insertExecution({
      state: "verifying",
      chain: BITCOIN,
      recipient: BTC_ADDR,
      asset: BTC,
      decimals: 8,
      base: 625_000n,
      txHashes: [tx.txid],
      snapshot: { primary_usd: null, secondary_usd: null },
    });
    expect(((await until(id, (e) => e.state === "succeeded")).evidence as Any).bitcoin.required_confirmations).toBe(1);
  });

  describe("post-success re-check at 6 confirmations in the same block (§8.12)", () => {
    const recheck = (id: string) =>
      s.admin.db
        .selectFrom("executions")
        .select(["state", "finality_recheck_status", "finality_recheck_detail", "finality_recheck_block_hash"])
        .where("id", "=", toUuid(id, "ex"))
        .executeTakeFirstOrThrow();
    const due = (id: string) =>
      s.admin.db
        .updateTable("executions")
        .set({ finality_recheck_at: new Date() })
        .where("id", "=", toUuid(id, "ex"))
        .execute();
    async function outcome(id: string) {
      const end = Date.now() + 10_000;
      for (;;) {
        const r = await recheck(id);
        if (r.finality_recheck_status !== "pending" || Date.now() > end) return r;
        await new Promise((x) => setTimeout(x, 100));
      }
    }
    async function settled() {
      const tx = { ...vec(3), txid: txid() } as EsploraTx;
      btcTxs.set(tx.txid, tx);
      tip = 900_000;
      const id = await insertExecution({
        state: "verifying",
        chain: BITCOIN,
        recipient: BTC_ADDR,
        asset: BTC,
        decimals: 8,
        base: 625_000n,
        txHashes: [tx.txid],
        snapshot: { primary_usd: "80000", secondary_usd: null },
      });
      await until(id, (e) => e.state === "succeeded");
      return { id, tx };
    }

    it("pending below 6 confirmations; same block hash at 6 → finalized", async () => {
      const { id, tx } = await settled();
      expect(await recheck(id)).toMatchObject({
        finality_recheck_status: "pending",
        finality_recheck_block_hash: tx.status.block_hash,
      });
      tip = 900_004; // 5 confirmations
      await due(id);
      await new Promise((r) => setTimeout(r, 600));
      expect((await recheck(id)).finality_recheck_status).toBe("pending");
      tip = 900_005; // 6 confirmations
      await due(id);
      expect(await outcome(id)).toMatchObject({ state: "succeeded", finality_recheck_status: "finalized" });
    });

    it("orphaned (re-mined in another block) by 6 confirmations → failed alert; the payment stays succeeded", async () => {
      const tr = s.tracker?.rails as NonNullable<typeof s.tracker>["rails"];
      const metric = vi.spyOn(tr.metrics, "finalityRecheck");
      const { id, tx } = await settled();
      btcTxs.set(tx.txid, { ...tx, status: { confirmed: true, block_height: 900_001, block_hash: "cd".repeat(32) } });
      tip = 900_010;
      await due(id);
      const row = await outcome(id);
      expect(row).toMatchObject({ state: "succeeded", finality_recheck_status: "failed" });
      expect(row.finality_recheck_detail).toMatchObject({
        family: "bitcoin",
        reason: "block hash changed by 6 confirmations",
      });
      expect(metric).toHaveBeenCalledWith(BITCOIN, "failed");
      metric.mockRestore();
    });
  });
});

// ---------------------------------------------------------------------------------------------
// tiers
// ---------------------------------------------------------------------------------------------

describe("tiers (§21.4)", () => {
  it("a Solana execution is created Tier A; after > 5 min of pool failures new ones are Tier B (pinned)", async () => {
    const body = routeQuote({
      livemode: true,
      origin: {
        asset_id: USDC_ARB,
        chain: "eip155:42161",
        refund_to: "0x52908400098527886e0f7030069857d2e4169ee7",
        refund_type: "origin_chain",
      },
      destination: { asset_id: USDC_SOL, type: "chain_address", chain: SOLANA, address: OWNER },
    });
    const r1 = await s.call("POST", "/internal/executions", { body });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    const x1 = Execution.parse(r1.body);
    const tierOf = async (id: string) =>
      (
        await s.admin.db
          .selectFrom("executions")
          .select("verification_tier")
          .where("id", "=", toUuid(id, "ex"))
          .executeTakeFirstOrThrow()
      ).verification_tier;
    expect(await tierOf(x1.id)).toBe("A");
    await writeCursor(s.rails, `health:${SOLANA}`, { failing_since_ms: Date.now() - 6 * 60_000, last_ok_ms: null });
    expect(await tierAtCreate(s.rails, SOLANA)).toBe("B");
    const r2 = await s.call("POST", "/internal/executions", {
      body: { ...body, idempotency_key: `k-${randomUUID()}` },
    });
    expect(r2.status).toBe(201);
    expect(await tierOf(Execution.parse(r2.body).id)).toBe("B");
    // the profile view keeps the boot-time tier; recovery restores Tier A for new executions
    await writeCursor(s.rails, `health:${SOLANA}`, { failing_since_ms: null, last_ok_ms: Date.now() });
    expect(await tierAtCreate(s.rails, SOLANA)).toBe("A");
    expect(await tierAtCreate(s.rails, "eip155:8453")).toBe("A");
    expect(await tierAtCreate(s.rails, "eip155:10")).toBe("B");
    expect(await tierAtCreate(s.rails, "unknown:x")).toBe("B");
  });

  it("a Tier-B pinned Solana execution settles on the provider's word within the limits", async () => {
    const id = await insertExecution({
      state: "verifying",
      chain: SOLANA,
      recipient: OWNER,
      asset: USDC_SOL,
      decimals: 6,
      base: 2_000_000n,
      txHashes: [sig()],
      tier: "B",
    });
    await s.admin.db
      .updateTable("executions")
      .set({ provider_amount_out: "2000000" })
      .where("id", "=", toUuid(id, "ex"))
      .execute();
    const done = await until(id, (e) => e.state === "succeeded");
    expect(done.evidence).toMatchObject({ tier: "B", source: "provider" });
  });

  it("the chain profiles route carries the Stage 4 fields", async () => {
    const r = await s.call("GET", "/internal/chain-profiles");
    const p = (r.body as { profiles: Any[] }).profiles;
    // ADR-0022 as amended: one block of each chain's own consensus — the spec 0.4.2 vector profiles
    const want = (chain: string) => (V.chains as Any[]).find((x) => x.chain === chain);
    expect(p.find((x) => x.chain === BITCOIN)).toMatchObject({
      tier: "A",
      explorer_address_url: "https://mempool.space/address/{address}",
      finality: want(BITCOIN).finality,
      confirmation_tiers: want(BITCOIN).confirmation_tiers,
    });
    expect(want(BITCOIN).confirmation_tiers).toEqual([{ below_usd_micros: null, confirmations: 1 }]);
    expect(p.find((x) => x.chain === SOLANA)).toMatchObject({
      finality: want(SOLANA).finality,
      confirmation_tiers: want(SOLANA).confirmation_tiers,
    });
    for (const x of p.filter((y) => y.family === "evm")) expect(x.finality).toBe("1 confirmation");
  });
});

// ---------------------------------------------------------------------------------------------
// watchers
// ---------------------------------------------------------------------------------------------

describe("Solana watcher (§21.2)", () => {
  it("attributes a confirmed payout to the tagged execution by exact amount (failed txs skipped); nudges deposits", async () => {
    const owner = "EyjEeiTxb4rvkoN3ZA2zTimuc6VyF8V1QuH9TT66Gkn6";
    const { associatedTokenAddress } = await import("../../src/domain/chains/solana.js");
    const ata = associatedTokenAddress(owner, MINT).address;
    const id = await insertExecution({
      state: "settling",
      chain: SOLANA,
      recipient: owner,
      asset: USDC_SOL,
      decimals: 6,
      base: 10_000_000n,
      tag: 4_321n,
    });
    // a deposit still awaited on Solana (SOL origin → the deposit address itself is watched)
    const depositAddr = "F4d933S5Xkj1LZ7jQZHv2oVxc1YTiWswgBxeQYLcQ71x";
    const dep = await insertExecution({
      state: "awaiting_deposit",
      chain: "eip155:8453",
      recipient: randomEvm(),
      asset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      decimals: 6,
      base: 1_000_000n,
      depositAddress: depositAddr,
      origin: { asset: SOL, chain: SOLANA },
    });
    const rpc = solanaRpc({ urls: [sol.url] });
    // first sight: the cursor starts at the newest signature (an older one exists)
    solSigs.set(ata, [{ signature: sig(), slot: 1, err: null, blockTime: 1 }]);
    await solanaWatchOnce(s.rails, rpc);
    const cur = await readCursor<{ accounts: Record<string, string | null> }>(s.rails, "solana");
    expect(Object.keys(cur?.accounts ?? {})).toEqual(expect.arrayContaining([ata, depositAddr]));
    // then: a failed payout, an unrelated amount and the tagged payout
    const failed = sig();
    const wrong = sig();
    const paid = sig();
    const mk = (signature: string, slot: number, amount: bigint, err?: unknown) => {
      const t = splPayout({ signature, slot, amount, err });
      const keys = [...(t.transaction.message.accountKeys as string[])];
      keys[2] = ata;
      keys[3] = owner;
      const swap = (b: Any) => ({ ...b, owner: b.owner === OWNER ? owner : b.owner });
      return {
        ...t,
        meta: {
          ...(t.meta as Any),
          preTokenBalances: (t.meta?.preTokenBalances ?? []).map(swap),
          postTokenBalances: (t.meta?.postTokenBalances ?? []).map(swap),
        },
        transaction: { ...t.transaction, message: { accountKeys: keys } },
      } as SolanaTx;
    };
    solTxs.set(failed, mk(failed, 10, 10_004_321n, { Custom: 1 }));
    solTxs.set(wrong, mk(wrong, 11, 5n));
    solTxs.set(paid, mk(paid, 12, 10_004_321n));
    const old = solSigs.get(ata) ?? [];
    solSigs.set(ata, [
      { signature: paid, slot: 12, err: null, blockTime: 1 },
      { signature: wrong, slot: 11, err: null, blockTime: 1 },
      { signature: failed, slot: 10, err: { Custom: 1 }, blockTime: 1 },
      ...old,
    ]);
    solSigs.set(depositAddr, [{ signature: sig(), slot: 13, err: null, blockTime: 1 }]);
    const res = await solanaWatchOnce(s.rails, rpc);
    expect(res.settled).toBe(1);
    const done = await get(id);
    expect(done.state).toBe("succeeded");
    expect(done.evidence).toMatchObject({
      source: "watcher",
      tx_hash: paid,
      amount: "10004321",
      sender: SOLVER,
      finality: "confirmed",
    });
    expect(
      (
        await s.admin.db
          .selectFrom("executions")
          .select("finality_recheck_status")
          .where("id", "=", toUuid(id, "ex"))
          .executeTakeFirstOrThrow()
      ).finality_recheck_status,
    ).toBe("pending"); // watcher evidence is re-checked at `finalized` too
    expect((done.evidence as Any).solana).toMatchObject({ owner, mint: MINT, token_accounts: [ata], slot: 12 });
    // the failed tx was never fetched for attribution
    expect(sol.requests.some((r) => (r.body as Any)?.params?.[0] === failed)).toBe(false);
    // the deposit address had no signature at first sight (cursor null) → its new one nudges the poller
    expect(res.nudged).toBe(1);
    const d = await s.admin.db
      .selectFrom("executions")
      .select(["has_signal", "priority"])
      .where("id", "=", toUuid(dep, "ex"))
      .executeTakeFirstOrThrow();
    expect(d).toEqual({ has_signal: true, priority: 2 });
    // idle → no RPC call, cursor forgotten
    await s.admin.db
      .updateTable("executions")
      .set({ state: "failed", terminal_at: new Date() })
      .where("id", "=", toUuid(dep, "ex"))
      .execute();
    await s.admin.db
      .updateTable("executions")
      .set({ state: "failed", terminal_at: new Date() })
      .where("destination_chain", "=", SOLANA)
      .where("terminal_at", "is", null)
      .execute();
    const before = sol.requests.length;
    expect((await solanaWatchOnce(s.rails, rpc)).accounts).toBe(0);
    expect(sol.requests.length).toBe(before);
    expect(await readCursor(s.rails, "solana")).toBeNull();
  });
});

describe("Bitcoin watcher (§21.2, signal only)", () => {
  it("a newly confirmed tx paying the destination nudges the poller; mempool and history do not", async () => {
    const addr = "bc1qpct5sxzppv204tth290uen85nqkhzw9sq5m0ku";
    const id = await insertExecution({
      state: "settling",
      chain: BITCOIN,
      recipient: addr,
      asset: BTC,
      decimals: 8,
      base: 100_000n,
    });
    const { addressToScript, scriptToAddress } = await import("../../src/domain/chains/bitcoin.js");
    const script = addressToScript(addr) as string;
    const pay = (confirmed: boolean): EsploraTx => ({
      txid: txid(),
      vout: [{ scriptpubkey: script, value: 100_000 }],
      status: confirmed
        ? { confirmed: true, block_height: 900_100, block_hash: "ab".repeat(32) }
        : { confirmed: false },
    });
    expect(scriptToAddress(script)).toBe(addr);
    btcAddr.set(addr, [pay(true)]);
    const esplora = esploraClient({ urls: [esp.url] });
    expect((await bitcoinWatchOnce(s.rails, esplora)).nudged).toBe(0); // history recorded
    btcAddr.set(addr, [pay(false), ...(btcAddr.get(addr) ?? [])]);
    expect((await bitcoinWatchOnce(s.rails, esplora)).nudged).toBe(0); // mempool
    btcAddr.set(addr, [pay(true), ...(btcAddr.get(addr) ?? [])]);
    expect((await bitcoinWatchOnce(s.rails, esplora)).nudged).toBe(1);
    const row = await s.admin.db
      .selectFrom("executions")
      .select(["has_signal", "state"])
      .where("id", "=", toUuid(id, "ex"))
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ has_signal: true, state: "settling" }); // never evidence by itself
    expect(await readCursor(s.rails, "bitcoin")).not.toBeNull();
  });

  it("a verifying execution: a newly confirmed tx to its destination makes its verification due now", async () => {
    const addr = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
    const id = await insertExecution({
      state: "verifying",
      chain: BITCOIN,
      recipient: addr,
      asset: BTC,
      decimals: 8,
      base: 100_000n,
      txHashes: ["ee".repeat(32)], // unknown to the fake: the verifier keeps retrying
    });
    const later = new Date(Date.now() + 60_000);
    const park = () =>
      s.admin.db.updateTable("executions").set({ verify_at: later }).where("id", "=", toUuid(id, "ex")).execute();
    const { addressToScript } = await import("../../src/domain/chains/bitcoin.js");
    const script = addressToScript(addr) as string;
    const pay = (): EsploraTx => ({
      txid: txid(),
      vout: [{ scriptpubkey: script, value: 100_000 }],
      status: { confirmed: true, block_height: 900_200, block_hash: "ef".repeat(32) },
    });
    const esplora = esploraClient({ urls: [esp.url] });
    btcAddr.set(addr, []);
    await park();
    expect((await bitcoinWatchOnce(s.rails, esplora)).verified).toBe(0); // first sight records history
    btcAddr.set(addr, [pay()]);
    await park();
    const res = await bitcoinWatchOnce(s.rails, esplora);
    expect(res).toMatchObject({ nudged: 0, verified: 1 });
    const row = await s.admin.db
      .selectFrom("executions")
      .select(["verify_at", "state"])
      .where("id", "=", toUuid(id, "ex"))
      .executeTakeFirstOrThrow();
    expect(row.state).toBe("verifying"); // scheduling only
    expect((row.verify_at as Date).getTime()).toBeLessThan(later.getTime());
    await s.admin.db
      .updateTable("executions")
      .set({ state: "failed", terminal_at: new Date(), verify_at: null })
      .where("id", "=", toUuid(id, "ex"))
      .execute();
  });
});

// ---------------------------------------------------------------------------------------------
// sandbox adapter (§21.5)
// ---------------------------------------------------------------------------------------------

describe("sandbox evidence adapter (§21.5)", () => {
  const rowOf = async (id: string) =>
    (await s.admin.db
      .selectFrom("executions")
      .selectAll()
      .where("id", "=", toUuid(id, "ex"))
      .executeTakeFirstOrThrow()) as ExecutionRow;

  it("Bitcoin: confirmations against the tiers, outputs from vout, simulated block hash", async () => {
    const id = await insertExecution({
      state: "verifying",
      chain: BITCOIN,
      recipient: BTC_ADDR,
      asset: BTC,
      decimals: 8,
      base: 625_000n,
      snapshot: { primary_usd: "80000", secondary_usd: null },
      tier: null,
    });
    await s.admin.db.updateTable("executions").set({ verify_at: null }).where("id", "=", toUuid(id, "ex")).execute();
    const row = await rowOf(id);
    const hash = txid();
    const tx = (confirmations: number) => ({
      finalized: confirmations > 0,
      transfers: [{ token: BTC, to: BTC_ADDR, amount: "625000", vout: 1 }],
      block_ref: "900000",
      confirmations,
    });
    const tr = [{ to: BTC_ADDR, assetId: BTC, amount: 625_000n, from: null }];
    const tiers = V.chains[1].confirmation_tiers;
    expect((await sandboxChainOutcome(s.rails, row, "bitcoin", hash, tx(0), tr, tiers)).result).toBe("pending");
    const ok = await sandboxChainOutcome(s.rails, row, "bitcoin", hash, tx(1), tr, tiers);
    expect(ok.result).toBe("pass");
    expect(ok.chainDetail?.bitcoin).toEqual({
      txid: hash,
      outputs: [{ vout: 1, value: "625000", script_pubkey: "0014449834b3c72cb1f86a242d308ece91f80e794f97" }],
      block_height: 900000,
      block_hash: (await import("node:crypto")).createHash("sha256").update(`${BITCOIN}|900000`).digest("hex"),
      confirmations: 1,
      required_confirmations: 1,
    });
    const none = await sandboxChainOutcome(s.rails, row, "bitcoin", hash, tx(1), [], tiers);
    expect(none.result).toBe("mismatch");
  });

  it("Solana: token accounts from transfers, failed flag proves nothing, pre/post null", async () => {
    const id = await insertExecution({
      state: "verifying",
      chain: SOLANA,
      recipient: OWNER,
      asset: USDC_SOL,
      decimals: 6,
      base: 25_000_000n,
      tier: null,
    });
    await s.admin.db.updateTable("executions").set({ verify_at: null }).where("id", "=", toUuid(id, "ex")).execute();
    const row = await rowOf(id);
    const hash = sig();
    const tx = {
      finalized: true,
      transfers: [{ token: USDC_SOL, from: SOLVER, to: OWNER, amount: "25000000", token_account: OWNER_ATA }],
      block_ref: "1234",
    };
    const tr = [{ to: OWNER, assetId: USDC_SOL, amount: 25_000_000n, from: SOLVER }];
    const ok = await sandboxChainOutcome(s.rails, row, "solana", hash, tx, tr, []);
    expect(ok).toMatchObject({ result: "pass", sender: SOLVER, blockRef: "1234", finality: "confirmed" });
    expect(ok.chainDetail?.solana).toEqual({
      signature: hash,
      slot: 1234,
      block_time: null,
      mint: MINT,
      token_program: TOKEN,
      owner: OWNER,
      token_accounts: [OWNER_ATA],
      pre_amount: null,
      post_amount: null,
    });
    expect((await sandboxChainOutcome(s.rails, row, "solana", hash, { ...tx, failed: true }, tr, [])).result).toBe(
      "pending",
    );
    // no simulated slot → nothing to record as Evidence.solana.slot: not final (fail closed)
    expect((await sandboxChainOutcome(s.rails, row, "solana", hash, { ...tx, block_ref: null }, tr, [])).result).toBe(
      "pending",
    );
  });
});

// ---------------------------------------------------------------------------------------------
// vault event forwarding (§8.6)
// ---------------------------------------------------------------------------------------------

describe("vault event forwarding (§8.6)", () => {
  const outcome = (id: string, executor: string, logs: string[], success = true) => ({
    execution_outcome: {
      id,
      block_hash: `h${final}`,
      outcome: { executor_id: executor, logs, status: success ? { SuccessValue: "" } : { Failure: {} } },
    },
    receipt: { receipt_id: id, receiver_id: executor, predecessor_id: "alice.near" },
    tx_hash: "4bWb9XzwJ2w3F7C2dWbNN1pYxQX7bGk8C5fDf3h1Jq8y",
  });

  it("forwards only successful, final vault receipts' schema-valid events, once per receipt_id:log_index", async () => {
    const lines = (VAULT_V.events as Any[]).map((e) => e.log as string);
    const nd1 = neardata({ baseUrl: nd.url });
    await writeCursor(s.rails, "near-indexer", { height: final });
    final += 1;
    const ok = "8RK6Dn9EaLwVb5nN3x9yrZfP6qz5mC8cQbqvYyYz2gHq";
    blocks.set(final, {
      block: { header: { height: final, hash: `h${final}`, timestamp_nanosec: "1794268800000000000" } },
      shards: [
        {
          shard_id: 0,
          receipt_execution_outcomes: [
            outcome(ok, VAULT, ["unrelated log", lines[0] as string, lines[3] as string]),
            outcome("FAiLeD1111111111111111111111111111111111111", VAULT, [lines[2] as string], false),
            outcome("EviL111111111111111111111111111111111111111", "evil.near", [lines[1] as string]),
            outcome("BaDV111111111111111111111111111111111111111", VAULT, [
              (lines[2] as string).replace('"1.0.0"', '"2.0.0"'),
            ]),
          ],
        },
      ],
    });
    expect(await indexOnce(s.rails, nd1)).toBe(1);
    const rows = await s.admin.db.selectFrom("vault_events").selectAll().orderBy("log_index").execute();
    expect(rows.map((r) => `${r.receipt_id}:${r.log_index}:${r.event}`)).toEqual([
      `${ok}:1:mandate_created`,
      `${ok}:2:collected`, // position in the receipt's logs: ["unrelated log", mandate_created, collected]
    ]);
    const out = await s.admin.db
      .selectFrom("outbox")
      .selectAll()
      .where("subject", "=", "evt.rails.vault.event")
      .orderBy("created_at")
      .orderBy("id")
      .execute();
    expect(out).toHaveLength(2);
    for (const [i, o] of out.entries()) {
      const env = EventEnvelope.parse(o.payload);
      expect(env).toMatchObject({
        account_id: null,
        livemode: true,
        aggregate: { type: "vault_mandate", id: `${VAULT}#7`, version: final },
      });
      const rec = VaultEventRecord.parse(env.data.object);
      expect(rec).toMatchObject({
        vault_contract: VAULT,
        receipt_id: ok,
        tx_hash: "4bWb9XzwJ2w3F7C2dWbNN1pYxQX7bGk8C5fDf3h1Jq8y",
        block_height: final,
        block_hash: `h${final}`,
        block_timestamp: "1794268800000000000",
      });
      expect(rec.event).toEqual(VAULT_V.events[i === 0 ? 0 : 3].event);
      expect(o.id).toBe(rows[i]?.outbox_event_id);
    }
    // re-indexing the same block (at-least-once) forwards nothing again
    await writeCursor(s.rails, "near-indexer", { height: final - 1 });
    expect(await indexOnce(s.rails, nd1)).toBe(1);
    expect(await s.admin.db.selectFrom("vault_events").selectAll().execute()).toHaveLength(2);
    expect(
      await s.admin.db.selectFrom("outbox").selectAll().where("subject", "=", "evt.rails.vault.event").execute(),
    ).toHaveLength(2);
  });
});
