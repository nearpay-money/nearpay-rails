/**
 * Live-mode paths without live funds: a 1Click-compatible fake (signed with a test key through the
 * SDK's quote hash), Anvil as a real EVM chain for the watcher and verifier, and recorded mainnet
 * NEAR data (neardata blocks, RPC tx statuses) for the indexer and NEAR verifier. Also the 1Click
 * adapter contract against recorded responses and the Explorer feed.
 */
import { randomUUID } from "node:crypto";
import { sql } from "@nearpay-internal/db";
import { fromUuid, toUuid } from "@nearpay-internal/ids";
import { Execution } from "@nearpay-internal/spec";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { refreshTokens } from "../../src/app/tokens.js";
import { type EvmRpc, evmRpc } from "../../src/infra/clients/evm.js";
import { explorer } from "../../src/infra/clients/explorer.js";
import { neardata, nearRpc } from "../../src/infra/clients/near.js";
import { oneClickProvider } from "../../src/providers/oneclick/client.js";
import { ModeViolation } from "../../src/providers/port.js";
import { sandboxProvider } from "../../src/providers/sandbox/client.js";
import { readCursor, writeCursor } from "../../src/trackers/cursors.js";
import { watchOnce } from "../../src/trackers/destination-watchers/evm-watcher.js";
import { explorerOnce } from "../../src/trackers/explorer-feed/feed.js";
import { indexOnce } from "../../src/trackers/near-indexer/indexer.js";
import { type Anvil, startAnvil } from "../support/anvil.js";
import {
  type FakeOneClick,
  type FakeServer,
  fakeNeardata,
  fakeNearRpc,
  fakeOneClick,
  fakeServer,
  fixture,
} from "../support/fakes.js";
import { ACCOUNT, randomEvm, routeQuote } from "../support/requests.js";
import { type Stack, startStack, USDC_ARB, USDC_BASE } from "../support/stack.js";

const TREASURY = "treasury.nearpay.near";
let s: Stack;
let one: FakeOneClick;
let anvil: Anvil;
let token: string;
let nearRpcServer: FakeServer;

beforeAll(async () => {
  [one, anvil, nearRpcServer] = await Promise.all([
    fakeOneClick(),
    startAnvil(),
    fakeNearRpc({
      AXvXuteK8UUNE3nhGx3Cdmxm1ax3CiqCx2MyFkbCwpYv: "tx-intents-transfer.json",
      AGK5b5iMegtbVeokGvUtWZ78XChEgTPbCWfcNUmGxR92: "tx-usdc-ft-transfer.json",
    }),
  ]);
  token = await anvil.deployToken();
  s = await startStack({
    oneclick: one,
    config: { treasuryAccount: TREASURY },
    tracker: {
      evm: new Map([["eip155:8453", evmRpc({ urls: [anvil.url] })]]),
      near: nearRpc({ urls: [nearRpcServer.url] }),
    },
  });
  expect(await refreshTokens(s.rails, true)).toBe(188);
  // the recorded list is hours old: freshen prices; Base USDC lives on Anvil here
  await s.admin.db.updateTable("tokens").set({ price_updated_at: new Date() }).where("livemode", "=", true).execute();
  await s.admin.db
    .updateTable("tokens")
    .set({ contract_address: token })
    .where("livemode", "=", true)
    .where("asset_id", "=", USDC_BASE)
    .execute();
});
afterAll(async () => {
  await s?.stop();
  await anvil?.container.stop();
  await one?.stop();
  await nearRpcServer?.stop();
});

const live = (over: Parameters<typeof routeQuote>[0] = {}) =>
  routeQuote({
    livemode: true,
    origin: {
      asset_id: USDC_ARB,
      chain: "eip155:42161",
      refund_to: "0x52908400098527886e0f7030069857d2e4169ee7",
      refund_type: "origin_chain",
    },
    destination: { asset_id: USDC_BASE, type: "chain_address", chain: "eip155:8453", address: randomEvm() },
    ...over,
  });
const create = async (body: unknown) => {
  const r = await s.call("POST", "/internal/executions", { body });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return Execution.parse(r.body);
};
const get = async (id: string) => Execution.parse((await s.call("GET", `/internal/executions/${id}`)).body);
const error = (r: { body: unknown }) => (r.body as { error: { code: string; message: string } }).error;
async function until(id: string, pred: (x: Execution) => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const x = await get(id);
    if (pred(x)) return x;
    if (Date.now() > end) throw new Error(`stuck in ${x.state}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Inserts an in-flight live execution directly (paths a 1Click quote cannot reach in a test). */
async function insertExecution(o: {
  state: "awaiting_deposit" | "verifying";
  destinationChain: string;
  recipient: string;
  recipientType: "destination_chain" | "intents";
  asset: string;
  base: bigint;
  tag?: bigint;
  txHashes?: string[];
  providerAmountOut?: bigint;
  verifyingSince?: Date;
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
      provider_status: o.state === "verifying" ? "SUCCESS" : "PENDING_DEPOSIT",
      origin_asset_id: USDC_ARB,
      origin_chain: "eip155:42161",
      refund_to: "0x52908400098527886e0f7030069857d2e4169ee7",
      refund_type: "origin_chain",
      destination_asset_id: o.asset,
      recipient: o.recipient,
      recipient_type: o.recipientType,
      destination_chain: o.destinationChain,
      destination_key: `${o.destinationChain}|${o.recipient}|${o.asset}`,
      route_class: "same_asset",
      applied_fee_bps: 20,
      amount_out_base: o.base.toString(),
      amount_tag: tag.toString(),
      amount_out_expected: (o.base + tag).toString(),
      deposit_address: randomEvm(),
      deadline: new Date(Date.now() + 1_800_000),
      destination_tx_hashes: o.txHashes ?? [],
      provider_amount_out: o.providerAmountOut?.toString() ?? null,
      verify_at: o.state === "verifying" ? new Date() : null,
      verifying_since: o.state === "verifying" ? (o.verifyingSince ?? new Date()) : null,
      version: 1,
    })
    .execute();
  return fromUuid("ex", id);
}

describe("live quotes through the 1Click adapter", () => {
  it("creates a live execution: appFees to the treasury, split echo accepted, signature verified", async () => {
    const x = await create(live());
    expect(x).toMatchObject({
      livemode: true,
      provider: "oneclick",
      route_class: "same_asset",
      applied_fee_bps: 20,
      state: "awaiting_deposit",
    });
    const sent = one.requests.filter((r) => r.path === "/v0/quote").at(-1)?.body as Record<string, unknown>;
    expect(sent).toMatchObject({
      dry: false,
      appFees: [{ recipient: TREASURY, fee: 20 }],
      referral: "nearpay",
      swapType: "EXACT_OUTPUT",
    });
    expect(sent).not.toHaveProperty("scenario_amount");
    expect(one.requests.at(-1)?.headers["x-api-key"]).toBeUndefined();
  });

  it("maps the recorded 400 to quote_rejected with the provider's message", async () => {
    one.reject = { status: 400, body: fixture("oneclick/quote-400.json") };
    const r = await s.call("POST", "/internal/executions", { body: live() });
    expect([r.status, error(r).code]).toEqual([422, "quote_rejected"]);
    expect(error(r).message).toBe("The route provider rejected the quote: tokenIn is not valid");
  });

  it("maps provider outages to rail_unavailable", async () => {
    one.reject = { status: 503, body: { message: "down" } };
    const r = await s.call("POST", "/internal/executions", { body: live() });
    expect([r.status, error(r).code]).toEqual([503, "rail_unavailable"]);
  });

  it.each([
    [
      "a lower treasury share",
      (q: Record<string, unknown>) =>
        ((q.quoteRequest as { appFees: { fee: number }[] }).appFees = [
          { recipient: TREASURY, fee: 5 } as never,
          { recipient: "x", fee: 15 } as never,
        ]),
    ],
    [
      "an inflated fee",
      (q: Record<string, unknown>) =>
        ((q.quoteRequest as { appFees: { fee: number }[] }).appFees = [
          { recipient: TREASURY, fee: 10 } as never,
          { recipient: "x", fee: 100 } as never,
        ]),
    ],
    [
      "another recipient",
      (q: Record<string, unknown>) =>
        ((q.quoteRequest as Record<string, unknown>).recipient = "0x000000000000000000000000000000000000dead"),
    ],
    ["a short output", (q: Record<string, unknown>) => ((q.quote as Record<string, unknown>).amountOut = "1")],
  ])("refuses a quote with %s (quote_integrity_failed), releasing the tag", async (_what, tamper) => {
    one.tamper = tamper;
    const body = live();
    const r = await s.call("POST", "/internal/executions", { body });
    one.tamper = null;
    expect([r.status, error(r).code]).toEqual([502, "quote_integrity_failed"]);
    const key = `eip155:8453|${body.destination.address}|${USDC_BASE}`;
    const tags = await s.admin.db
      .selectFrom("amount_tags")
      .selectAll()
      .where("destination_key", "=", key)
      .where("released_at", "is", null)
      .execute();
    expect(tags).toEqual([]);
  });

  it("refuses a quote whose signature does not verify", async () => {
    one.afterSign = (q) => {
      (q.quote as Record<string, unknown>).minAmountIn = "1";
    };
    const r = await s.call("POST", "/internal/executions", { body: live() });
    one.afterSign = null;
    expect([r.status, error(r).code]).toEqual([502, "quote_integrity_failed"]);
  });

  it("the kill switch refuses live quotes", async () => {
    await s.admin.db.updateTable("control_flags").set({ value: false }).where("name", "=", "quoting_enabled").execute();
    const r = await s.call("POST", "/internal/executions", { body: live() });
    expect([r.status, error(r).code]).toEqual([503, "rail_unavailable"]);
    expect(error(r).message).toMatch(/kill switch/);
    await s.admin.db.updateTable("control_flags").set({ value: true }).where("name", "=", "quoting_enabled").execute();
  });

  it("spec 0.3.0: an agentpay x402 quote runs §8.1 unchanged (appFees, integrity, signature, kill switch)", async () => {
    const binding = "np1:4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
    const merchant = "x402merchant.near";
    const body = {
      ...live({
        destination: { asset_id: USDC_BASE, type: "intents_account", chain: "near:mainnet", address: merchant },
        pricing: { currency: "asset", asset_id: USDC_BASE, amount: "2500000" },
        fee: { bearer: "payer" },
      }),
      idempotency_key: `x402:${binding}`,
      owner: "agentpay",
      x402_binding: binding,
    };
    const asAgentpay = (b: unknown) => s.call("POST", "/internal/executions", { body: b, service: "agentpay" });
    // tampered recipient: refused like any quote
    one.tamper = (q) => {
      (q.quoteRequest as Record<string, unknown>).recipient = "thief.near";
    };
    const bad = await asAgentpay(body);
    one.tamper = null;
    expect([bad.status, error(bad).code]).toEqual([502, "quote_integrity_failed"]);
    // kill switch: refused
    await s.admin.db.updateTable("control_flags").set({ value: false }).where("name", "=", "quoting_enabled").execute();
    const killed = await asAgentpay(body);
    await s.admin.db.updateTable("control_flags").set({ value: true }).where("name", "=", "quoting_enabled").execute();
    expect([killed.status, error(killed).code]).toEqual([503, "rail_unavailable"]);
    // a clean quote
    const r = await asAgentpay(body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const x = Execution.parse(r.body);
    expect(x).toMatchObject({
      livemode: true,
      provider: "oneclick",
      owner: "agentpay",
      x402_binding: binding,
      settlement: { amount_base: "2500000", recipient: merchant, recipient_type: "intents" },
    });
    const sent = one.requests.filter((q) => q.path === "/v0/quote").at(-1)?.body as Record<string, unknown>;
    expect(sent).toMatchObject({
      swapType: "EXACT_OUTPUT",
      recipient: merchant,
      recipientType: "INTENTS",
      appFees: [{ recipient: TREASURY, fee: 20 }],
      amount: x.settlement.expected,
    });
  });

  it("adapters assert their mode (INV-8) and send the partner key when configured", async () => {
    const p = oneClickProvider({ baseUrl: one.url, apiKey: "partner-key" });
    await expect(p.status(false, "0xabc", null)).rejects.toBeInstanceOf(ModeViolation);
    await p.tokens();
    expect(one.requests.at(-1)?.headers["x-api-key"]).toBe("partner-key");
    const sb = sandboxProvider({
      baseUrl: one.url,
      signingPubkey: "ed25519:11111111111111111111111111111111",
      serviceToken: async () => "t",
    });
    await expect(sb.quote(true, live() as never)).rejects.toBeInstanceOf(ModeViolation);
  });
});

describe("hot poller on 1Click statuses", () => {
  it("KNOWN_DEPOSIT_TX → deposit_detected, INCOMPLETE_DEPOSIT → incomplete_deposit, an unknown status → held", async () => {
    const x = await create(live());
    const address = x.deposit?.address as string;
    one.statuses.set(address, {
      status: "KNOWN_DEPOSIT_TX",
      swapDetails: { originChainTxHashes: [{ hash: `0x${"aa".repeat(32)}`, explorerUrl: "" }] },
    });
    await s.call("POST", `/internal/executions/${x.id}/signals`, { body: { type: "payer_sent" } });
    const a = await until(x.id, (e) => e.state === "deposit_detected");
    expect(a.deposit_tx_hashes).toEqual([`0x${"aa".repeat(32)}`]);
    one.statuses.set(address, { status: "INCOMPLETE_DEPOSIT" });
    await until(x.id, (e) => e.state === "incomplete_deposit");
    one.statuses.set(address, { status: "SOMETHING_NEW" });
    const h = await until(x.id, (e) => e.state === "held");
    expect(h.held_reason).toBe("unknown_status");
  });

  it("an address 1Click does not know is held after 3 tries (404 recorded)", async () => {
    const x = await create(live());
    one.quotes.delete(x.deposit?.address as string);
    await s.call("POST", `/internal/executions/${x.id}/signals`, { body: { type: "payer_sent" } });
    for (let i = 0; i < 3; i++) {
      await s.admin.db
        .updateTable("executions")
        .set({ next_poll_at: new Date() })
        .where("id", "=", toUuid(x.id, "ex"))
        .execute();
      await new Promise((r) => setTimeout(r, 400));
    }
    const h = await until(x.id, (e) => e.state === "held");
    expect(h.held_reason).toBe("unknown_status");
  });

  it("observations older than the stored provider time are recorded but not applied", async () => {
    const x = await create(live());
    const address = x.deposit?.address as string;
    one.statuses.set(address, { status: "PROCESSING", updatedAt: new Date(Date.now() + 60_000).toISOString() });
    await s.call("POST", `/internal/executions/${x.id}/signals`, { body: { type: "payer_sent" } });
    await until(x.id, (e) => e.state === "settling");
    one.statuses.set(address, { status: "REFUNDED", updatedAt: new Date(Date.now() - 60_000).toISOString() });
    await s.admin.db
      .updateTable("executions")
      .set({ next_poll_at: new Date() })
      .where("id", "=", toUuid(x.id, "ex"))
      .execute();
    const end = Date.now() + 1_500;
    let unapplied = 0;
    while (Date.now() < end && unapplied === 0) {
      const rows = await s.admin.db
        .selectFrom("provider_observations")
        .selectAll()
        .where("execution_id", "=", toUuid(x.id, "ex"))
        .where("applied", "=", false)
        .execute();
      unapplied = rows.length;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(unapplied).toBeGreaterThan(0);
    expect((await get(x.id)).state).toBe("settling");
  });
});

describe("EVM destination watcher (Anvil)", () => {
  const watch = async (recipient: string) =>
    s.admin.db
      .insertInto("watched_destinations")
      .values({
        destination_id: randomUUID(),
        account_id: toUuid(ACCOUNT, "acct"),
        livemode: true,
        chain: "eip155:8453",
        address_norm: recipient,
        asset_id: USDC_BASE,
        type: "chain_address",
        active: true,
        source_version: 1,
      })
      .execute();
  const recheckOf = (id: string) =>
    s.admin.db
      .selectFrom("executions")
      .select(["state", "finality_recheck_status", "finality_recheck_block_hash", "finality_recheck_at"])
      .where("id", "=", toUuid(id, "ex"))
      .executeTakeFirstOrThrow();

  it("Base: attributes a Transfer of exactly base + tag once it has 10 L2 confirmations (confirmed), then the finalized re-check passes", async () => {
    const rpc = evmRpc({ urls: [anvil.url] });
    const x = await create(live());
    await watch(x.settlement.recipient);
    await watchOnce(s.rails, "eip155:8453", rpc); // starts the cursor at the counted head (latest − 9)
    const hash = await anvil.transfer(token, x.settlement.recipient, BigInt(x.settlement.expected));
    const stray = await anvil.transfer(token, x.settlement.recipient, 12_345n);
    await anvil.mine(5); // the payout has 7 confirmations
    for (let i = 0; i < 3; i++) await watchOnce(s.rails, "eip155:8453", rpc);
    expect((await get(x.id)).state).toBe("awaiting_deposit"); // not deep enough: not counted yet
    await anvil.mine(5); // 12 confirmations
    let scanned = 0;
    for (let i = 0; i < 5 && (await get(x.id)).state !== "succeeded"; i++)
      scanned += await watchOnce(s.rails, "eip155:8453", rpc);
    expect(scanned).toBeGreaterThan(0);
    const done = await get(x.id);
    expect(done).toMatchObject({ state: "succeeded", settled_amount: x.settlement.expected });
    expect(done.evidence).toMatchObject({
      source: "watcher",
      tier: "A",
      finality: "confirmed",
      tx_hash: hash,
      chain: "eip155:8453",
      sender: expect.stringMatching(/^0x[0-9a-f]{40}$/), // spec 0.3.0: the Transfer log's `from`
    });
    const receipt = await anvil.rpc<{ blockHash: string }>("eth_getTransactionReceipt", [hash]);
    const [v] = await s.admin.db
      .selectFrom("verifications")
      .selectAll()
      .where("execution_id", "=", toUuid(x.id, "ex"))
      .execute();
    expect(v).toMatchObject({ result: "pass", finality: "confirmed", source: "watcher" });
    expect(v?.details).toMatchObject({ block_hash: receipt.blockHash, required_confirmations: 10 });
    expect((v?.details as { confirmations?: number } | undefined)?.confirmations ?? 0).toBeGreaterThanOrEqual(10);
    const un = await s.admin.db.selectFrom("unattributed_transfers").selectAll().where("tx_hash", "=", stray).execute();
    expect(un.map((u) => [u.amount, u.recipient])).toEqual([["12345", x.settlement.recipient]]);

    // §8.12: the re-check was scheduled; once Anvil's `finalized` (head − 64) covers the block it ends `finalized`
    expect(await recheckOf(x.id)).toMatchObject({
      finality_recheck_status: "pending",
      finality_recheck_block_hash: receipt.blockHash,
    });
    await anvil.mine(70);
    await s.admin.db
      .updateTable("executions")
      .set({ finality_recheck_at: new Date() })
      .where("id", "=", toUuid(x.id, "ex"))
      .execute();
    const end = Date.now() + 10_000;
    while ((await recheckOf(x.id)).finality_recheck_status === "pending" && Date.now() < end)
      await new Promise((r) => setTimeout(r, 100));
    expect(await recheckOf(x.id)).toMatchObject({
      state: "succeeded",
      finality_recheck_status: "finalized",
      finality_recheck_at: null,
    });
  });

  it("reorg check: a log whose receipt moved to another block settles nothing and is rescanned", async () => {
    const honest = evmRpc({ urls: [anvil.url] });
    // a pool whose receipt read disagrees with the log's block hash (the block was reorganised meanwhile)
    const reorged: EvmRpc = {
      ...honest,
      receipt: async (h, i) => {
        const r = await honest.receipt(h, i);
        return r ? { ...r, blockHash: `0x${"ee".repeat(32)}` } : r;
      },
    };
    const x = await create(live());
    await watch(x.settlement.recipient);
    await watchOnce(s.rails, "eip155:8453", honest);
    const hash = await anvil.transfer(token, x.settlement.recipient, BigInt(x.settlement.expected));
    const { blockNumber } = await anvil.rpc<{ blockNumber: string }>("eth_getTransactionReceipt", [hash]);
    await anvil.mine(12);
    for (let i = 0; i < 3; i++) await watchOnce(s.rails, "eip155:8453", reorged);
    expect((await get(x.id)).state).toBe("awaiting_deposit");
    // the cursor stops just before the reorganised block, so the next scan sees the log again
    expect((await readCursor<{ block: string }>(s.rails, "evm:eip155:8453"))?.block).toBe(
      (BigInt(blockNumber) - 1n).toString(),
    );
    for (let i = 0; i < 3 && (await get(x.id)).state !== "succeeded"; i++)
      await watchOnce(s.rails, "eip155:8453", honest);
    expect(await get(x.id)).toMatchObject({ state: "succeeded", evidence: { tx_hash: hash, finality: "confirmed" } });
  });

  it("makes no RPC call while nothing is in flight, and restarts at the head when demand returns", async () => {
    await s.admin.db
      .updateTable("executions")
      .set({ terminal_at: new Date(), state: "failed" })
      .where("livemode", "=", true)
      .where("terminal_at", "is", null)
      .execute();
    let calls = 0;
    const counting = (async (...a: Parameters<typeof fetch>) => {
      calls++;
      return fetch(...a);
    }) as typeof fetch;
    const rpc = evmRpc({ urls: [anvil.url], fetch: counting });
    expect(await watchOnce(s.rails, "eip155:8453", rpc)).toBe(0);
    expect(calls).toBe(0);
    expect(await readCursor(s.rails, "evm:eip155:8453")).toBeNull();
    await create(live());
    await anvil.mine(3);
    expect(await watchOnce(s.rails, "eip155:8453", rpc)).toBe(0);
    // Base counts 10 L2 confirmations (ADR-0022): the counted head is latest − 9
    const latest = await anvil.rpc<string>("eth_blockNumber");
    expect((await readCursor<{ block: string }>(s.rails, "evm:eip155:8453"))?.block).toBe(
      (BigInt(latest) - 9n).toString(),
    );
  });
});

describe("verifier (Tier A on Anvil, NEAR on recorded RPC, Tier B)", () => {
  it("EVM (Base): provider SUCCESS → verifying → pending below 10 confirmations → succeeded `confirmed` on the receipt", async () => {
    const x = await create(live());
    const hash = await anvil.transfer(token, x.settlement.recipient, BigInt(x.settlement.expected));
    one.statuses.set(x.deposit?.address as string, {
      status: "SUCCESS",
      swapDetails: { amountOut: x.settlement.expected, destinationChainTxHashes: [{ hash, explorerUrl: "" }] },
    });
    await s.call("POST", `/internal/executions/${x.id}/signals`, { body: { type: "payer_sent" } });
    await until(x.id, (e) => e.state === "verifying");
    await anvil.mine(7); // 8 confirmations
    await new Promise((r) => setTimeout(r, 400));
    expect((await get(x.id)).state).toBe("verifying"); // below the threshold
    await anvil.mine(2); // 10 confirmations: counts (no wait for Ethereum finality)
    const done = await until(x.id, (e) => e.state === "succeeded");
    expect(done.evidence).toMatchObject({
      source: "verifier",
      tier: "A",
      tx_hash: hash,
      finality: "confirmed",
      sender: expect.stringMatching(/^0x[0-9a-f]{40}$/),
    });
    const receipt = await anvil.rpc<{ blockHash: string }>("eth_getTransactionReceipt", [hash]);
    const v = await s.admin.db
      .selectFrom("verifications")
      .selectAll()
      .where("execution_id", "=", toUuid(x.id, "ex"))
      .execute();
    expect(v.map((r) => r.result)).toEqual(["pass"]); // pending attempts are not recorded
    expect(v[0]?.finality).toBe("confirmed");
    expect(v[0]?.details).toMatchObject({ block_hash: receipt.blockHash, required_confirmations: 10 });
    expect((v[0]?.details as { confirmations?: number } | undefined)?.confirmations ?? 0).toBeGreaterThanOrEqual(10);
    const row = await s.admin.db
      .selectFrom("executions")
      .select(["finality_recheck_status", "finality_recheck_block_hash"])
      .where("id", "=", toUuid(x.id, "ex"))
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ finality_recheck_status: "pending", finality_recheck_block_hash: receipt.blockHash });
  });

  describe("post-success finalized re-check (§8.12)", () => {
    /** A succeeded live execution whose confirmed evidence counted from `blockHash` (the re-check is due now). */
    async function succeededOn(hash: string, blockHash: string, until = new Date(Date.now() + 7_200_000)) {
      const r = await anvil.rpc<{ blockNumber: string }>("eth_getTransactionReceipt", [hash]);
      const recipient = randomEvm();
      const id = await insertExecution({
        state: "awaiting_deposit",
        destinationChain: "eip155:8453",
        recipient,
        recipientType: "destination_chain",
        asset: USDC_BASE,
        base: 5n,
      });
      await s.admin.db
        .updateTable("executions")
        .set({
          state: "succeeded",
          terminal_at: new Date(),
          settled_amount: "5",
          evidence: JSON.stringify({
            chain: "eip155:8453",
            tx_hash: hash,
            block_ref: BigInt(r.blockNumber).toString(),
            recipient,
            asset_id: USDC_BASE,
            amount: "5",
            finality: "confirmed",
            tier: "A",
            source: "verifier",
            observed_at: new Date().toISOString(),
            explorer_url: null,
          }),
          finality_recheck_status: "pending",
          finality_recheck_at: new Date(),
          finality_recheck_until: until,
          finality_recheck_block_hash: blockHash,
        })
        .where("id", "=", toUuid(id, "ex"))
        .execute();
      return id;
    }
    async function settledRecheck(id: string) {
      const end = Date.now() + 10_000;
      for (;;) {
        const row = await s.admin.db
          .selectFrom("executions")
          .select(["state", "version", "finality_recheck_status", "finality_recheck_detail"])
          .where("id", "=", toUuid(id, "ex"))
          .executeTakeFirstOrThrow();
        if (row.finality_recheck_status !== "pending" || Date.now() > end) return row;
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    it("a block hash that changed by finality alerts (log, metric, ops-visible) and leaves the payment succeeded", async () => {
      const tr = s.tracker?.rails as NonNullable<typeof s.tracker>["rails"];
      const alert = vi.spyOn(tr.log, "error");
      const metric = vi.spyOn(tr.metrics, "finalityRecheck");
      const hash = await anvil.transfer(token, randomEvm(), 5n);
      await anvil.mine(70); // finalized now covers the block
      const id = await succeededOn(hash, `0x${"cd".repeat(32)}`);
      const row = await settledRecheck(id);
      expect(row).toMatchObject({ state: "succeeded", version: 1, finality_recheck_status: "failed" });
      expect(row.finality_recheck_detail).toMatchObject({
        outcome: "failed",
        reason: "block hash changed at finality",
      });
      expect(metric).toHaveBeenCalledWith("eip155:8453", "failed");
      expect(alert).toHaveBeenCalledWith(
        expect.objectContaining({ execution: toUuid(id, "ex"), tx_hash: hash }),
        expect.stringMatching(/^ALERT finalized re-check failed/),
      );
      // evidence trail (console): a verifier observation, never applied
      const obs = await s.call("GET", `/internal/executions/${id}/observations`);
      expect((obs.body as { data: unknown[] }).data).toEqual([
        expect.objectContaining({
          source: "verifier",
          applied: false,
          payload: expect.objectContaining({
            finality_recheck: expect.objectContaining({ outcome: "failed", tx_hash: hash }),
          }),
        }),
      ]);
      alert.mockRestore();
      metric.mockRestore();
    });

    it("not finalized when the window ends → timeout alert; the payment stays succeeded", async () => {
      const tr = s.tracker?.rails as NonNullable<typeof s.tracker>["rails"];
      const alert = vi.spyOn(tr.log, "error");
      const hash = await anvil.transfer(token, randomEvm(), 5n); // the head block: far from Anvil's finalized tag
      const r = await anvil.rpc<{ blockHash: string }>("eth_getTransactionReceipt", [hash]);
      const id = await succeededOn(hash, r.blockHash, new Date(Date.now() - 1000));
      const row = await settledRecheck(id);
      expect(row).toMatchObject({ state: "succeeded", finality_recheck_status: "timeout" });
      expect(alert).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringMatching(/^ALERT finalized re-check timed out/),
      );
      alert.mockRestore();
    });
  });

  it("EVM: a transfer to someone else holds the execution at the timeout (evidence_mismatch)", async () => {
    const elsewhere = await anvil.transfer(token, randomEvm(), 5n);
    await anvil.mine(70);
    const id = await insertExecution({
      state: "verifying",
      destinationChain: "eip155:8453",
      recipient: randomEvm(),
      recipientType: "destination_chain",
      asset: USDC_BASE,
      base: 5n,
      txHashes: [elsewhere],
      verifyingSince: new Date(Date.now() - 3_700_000),
    });
    const done = await until(id, (e) => e.state === "held");
    expect(done.held_reason).toBe("evidence_mismatch");
  });

  it("EVM: a native transfer is verified from the transaction itself", async () => {
    const to = randomEvm();
    const hash = await anvil.sendNative(to, 1_000_000_000_000n);
    await anvil.mine(70);
    const id = await insertExecution({
      state: "verifying",
      destinationChain: "eip155:8453",
      recipient: to,
      recipientType: "destination_chain",
      asset: "nep141:base.omft.near",
      base: 1_000_000_000_000n,
      txHashes: [hash],
    });
    const done = await until(id, (e) => e.state === "succeeded");
    expect(done.evidence).toMatchObject({
      tier: "A",
      amount: "1000000000000",
      sender: expect.stringMatching(/^0x[0-9a-f]{40}$/), // the transaction's `from`
    });
  });

  it("NEAR: the recorded mt_transfer to an Intents account passes; an unknown tx is held at the timeout", async () => {
    const asset = "nep245:v2_1.omni.hot.tg:137_qiStmoQJDQPTebaPjgx5VBxZv6L";
    await s.admin.db
      .insertInto("tokens")
      .values({
        livemode: true,
        asset_id: asset,
        blockchain: "near",
        chain: "near:mainnet",
        symbol: "USDC",
        decimals: 6,
        family: "USDC",
        is_usd_stable: true,
        enabled: true,
        price_usd: "1",
        price_updated_at: new Date(),
        memo_required: false,
        refreshed_at: new Date(),
        contract_address: null,
      })
      .onConflict((oc) => oc.columns(["livemode", "asset_id"]).doNothing())
      .execute();
    const ok = await insertExecution({
      state: "verifying",
      destinationChain: "near:mainnet",
      recipient: "e7e163850ad161d83d50814ab1e1fbee45cb7c033de1a5585f6feaa7fff4bd58",
      recipientType: "intents",
      asset,
      base: 1_503_822n,
      txHashes: ["AXvXuteK8UUNE3nhGx3Cdmxm1ax3CiqCx2MyFkbCwpYv"],
    });
    const done = await until(ok, (e) => e.state === "succeeded");
    expect(done.evidence).toMatchObject({
      tier: "A",
      source: "verifier",
      finality: "final",
      amount: "1503822",
      chain: "near:mainnet",
      // spec 0.3.0: the recorded mt_transfer's old_owner_id (Intents recipients MUST name the sender)
      sender: "51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe",
    });
    expect(done.evidence?.block_ref).toBe("8XfH8iHtBgcjbEAFrcQKQjTGusvYh8VVprzRoiCoRUSt");
    const lost = await insertExecution({
      state: "verifying",
      destinationChain: "near:mainnet",
      recipient: "m.near",
      recipientType: "intents",
      asset,
      base: 1n,
      txHashes: ["4zHgrDmAZRiX7pTmZnwh4nKvGFstEdeCFtUuMBqsazq1"],
      verifyingSince: new Date(Date.now() - 700_000),
    });
    expect((await until(lost, (e) => e.state === "held")).held_reason).toBe("evidence_timeout");
  });

  it("NEAR: the recorded NEP-141 ft_transfer pays a NEAR account", async () => {
    const id = await insertExecution({
      state: "verifying",
      destinationChain: "near:mainnet",
      recipient: "v2.ref-finance.near",
      recipientType: "destination_chain",
      asset: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      base: 232_035_480n,
      txHashes: ["AGK5b5iMegtbVeokGvUtWZ78XChEgTPbCWfcNUmGxR92"],
    });
    expect((await until(id, (e) => e.state === "succeeded")).evidence?.source).toBe("verifier");
  });

  it("Tier B: the provider's word within limits; above the per-payment limit it is held", async () => {
    const usdcOp = "nep141:op-0x0b2c639c533813f4aa9d7837caf62653d097ff85.omft.near";
    await s.admin.db
      .insertInto("tokens")
      .values({
        livemode: true,
        asset_id: usdcOp,
        blockchain: "op",
        chain: "eip155:10",
        symbol: "USDC",
        decimals: 6,
        family: "USDC",
        is_usd_stable: true,
        enabled: true,
        price_usd: "1",
        price_updated_at: new Date(),
        memo_required: false,
        refreshed_at: new Date(),
        contract_address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85",
      })
      .onConflict((oc) => oc.columns(["livemode", "asset_id"]).doUpdateSet({ price_updated_at: new Date() }))
      .execute();
    const small = await insertExecution({
      state: "verifying",
      destinationChain: "eip155:10",
      recipient: randomEvm(),
      recipientType: "destination_chain",
      asset: usdcOp,
      base: 5_000_000n,
      txHashes: [`0x${"ee".repeat(32)}`],
      providerAmountOut: 5_000_000n,
    });
    expect((await until(small, (e) => e.state === "succeeded")).evidence).toMatchObject({
      tier: "B",
      source: "provider",
      finality: "confirmed",
      sender: null, // provider-attested: no chain view of the sender (never guessed)
    });
    const big = await insertExecution({
      state: "verifying",
      destinationChain: "eip155:10",
      recipient: randomEvm(),
      recipientType: "destination_chain",
      asset: usdcOp,
      base: 2_500_000_000n,
      txHashes: [`0x${"ef".repeat(32)}`],
      providerAmountOut: 2_500_000_000n,
    });
    expect((await until(big, (e) => e.state === "held")).held_reason).toBe("evidence_timeout");
  });
});

describe("NEAR indexer on recorded neardata blocks", () => {
  it("attributes the recorded mt_transfer to the tagged in-flight execution; idle, it only follows the head", async () => {
    let final = 223_270_700;
    const nd = await fakeNeardata(() => final);
    try {
      const id = await insertExecution({
        state: "awaiting_deposit",
        destinationChain: "near:mainnet",
        recipient: "51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe",
        recipientType: "intents",
        asset: USDC_BASE,
        base: 999_990n,
        tag: 10n,
      });
      await writeCursor(s.rails, "near-indexer", { height: 223_270_699 });
      expect(await indexOnce(s.rails, neardata({ baseUrl: nd.url }))).toBe(1);
      const done = await get(id);
      expect(done).toMatchObject({ state: "succeeded", settled_amount: "1000000" });
      expect(done.evidence).toMatchObject({
        source: "indexer",
        tier: "A",
        tx_hash: "F4j6f6d1V1tRycSMuTfVjFX2LN2dfQwWBmg1yF6Wu7Hv",
        block_ref: "223270700",
        finality: "final",
      });
      // nothing in flight to NEAR: no neardata call at all, the cursor is forgotten
      await s.admin.db
        .updateTable("executions")
        .set({ state: "failed", terminal_at: new Date() })
        .where("livemode", "=", true)
        .where("destination_chain", "=", "near:mainnet")
        .where("terminal_at", "is", null)
        .execute();
      final = 223_271_000;
      const fetched = nd.requests.length;
      expect(await indexOnce(s.rails, neardata({ baseUrl: nd.url }))).toBe(0);
      expect(nd.requests.length).toBe(fetched);
      expect(await readCursor(s.rails, "near-indexer")).toBeNull();
    } finally {
      await nd.stop();
    }
  });
});

describe("Explorer feed", () => {
  it("nudges an execution whose Explorer status differs; backs off on 429", async () => {
    const x = await create(live());
    let rateLimited = false;
    const ex = await fakeServer((req) => {
      if (rateLimited)
        return { status: 429, body: { status: 429, error: { code: "RATE_LIMITED", message: "slow down" } } };
      expect(req.headers.authorization).toBe("Bearer jwt");
      expect(req.query.get("referral")).toBe("nearpay");
      return {
        status: 200,
        body: [
          {
            originAsset: USDC_ARB,
            destinationAsset: USDC_BASE,
            depositAddress: x.deposit?.address,
            depositMemo: null,
            recipient: "0x1111111111111111111111111111111111111111",
            status: "PROCESSING",
            createdAt: new Date().toISOString(),
            createdAtTimestamp: Math.floor(Date.now() / 1000),
            referral: "nearpay",
            amountIn: "0",
            amountInFormatted: "0",
            amountInUsd: "0",
            amountOut: "0",
            amountOutFormatted: "0",
            amountOutUsd: "0",
          },
        ],
      };
    });
    try {
      const client = explorer({ baseUrl: ex.url, token: "jwt", referral: "nearpay" });
      await s.admin.db
        .updateTable("executions")
        .set({ next_poll_at: new Date(Date.now() + 3_600_000), has_signal: false, priority: 3 })
        .where("id", "=", toUuid(x.id, "ex"))
        .execute();
      expect(await explorerOnce(s.rails, client, 0)).toBe(5_000);
      const row = await s.admin.db
        .selectFrom("executions")
        .selectAll()
        .where("id", "=", toUuid(x.id, "ex"))
        .executeTakeFirstOrThrow();
      expect([row.has_signal, row.priority]).toEqual([true, 2]);
      const obs = await s.admin.db
        .selectFrom("provider_observations")
        .select(["source", "applied"])
        .where("execution_id", "=", row.id)
        .where("source", "=", "explorer")
        .execute();
      expect(obs).toEqual([{ source: "explorer", applied: false }]);
      expect(await explorerOnce(s.rails, client, 2)).toBe(5_000);
      expect((await readCursor<{ at: string }>(s.rails, "explorer"))?.at).toBeTruthy();
      rateLimited = true;
      expect(await explorerOnce(s.rails, client, 1)).toBe(10_000);
    } finally {
      await ex.stop();
    }
  });
});

describe("the database guards the invariants", () => {
  it("transitions and verifications are append-only; expected = base + tag", async () => {
    await expect(sql`update execution_transitions set cause = 'x'`.execute(s.admin.db)).rejects.toThrow(/append-only/);
    await expect(sql`delete from verifications`.execute(s.admin.db)).rejects.toThrow(/append-only/);
    await expect(
      sql`update executions set amount_out_expected = amount_out_expected + 1`.execute(s.admin.db),
    ).rejects.toThrow(/check/);
  });
});
