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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refreshTokens } from "../../src/app/tokens.js";
import { evmRpc } from "../../src/infra/clients/evm.js";
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
  it("attributes a finalized Transfer of exactly base + tag to the execution; other amounts are unattributed", async () => {
    const rpc = evmRpc({ urls: [anvil.url] });
    const x = await create(live());
    await s.admin.db
      .insertInto("watched_destinations")
      .values({
        destination_id: randomUUID(),
        account_id: toUuid(ACCOUNT, "acct"),
        livemode: true,
        chain: "eip155:8453",
        address_norm: x.settlement.recipient,
        asset_id: USDC_BASE,
        type: "chain_address",
        active: true,
        source_version: 1,
      })
      .execute();
    await watchOnce(s.rails, "eip155:8453", rpc); // starts the cursor at the finalized head
    const hash = await anvil.transfer(token, x.settlement.recipient, BigInt(x.settlement.expected));
    const stray = await anvil.transfer(token, x.settlement.recipient, 12_345n);
    await anvil.mine(70);
    let scanned = 0;
    for (let i = 0; i < 5 && (await get(x.id)).state !== "succeeded"; i++)
      scanned += await watchOnce(s.rails, "eip155:8453", rpc);
    expect(scanned).toBeGreaterThan(0);
    const done = await get(x.id);
    expect(done).toMatchObject({ state: "succeeded", settled_amount: x.settlement.expected });
    expect(done.evidence).toMatchObject({
      source: "watcher",
      tier: "A",
      finality: "finalized",
      tx_hash: hash,
      chain: "eip155:8453",
    });
    const un = await s.admin.db.selectFrom("unattributed_transfers").selectAll().where("tx_hash", "=", stray).execute();
    expect(un.map((u) => [u.amount, u.recipient])).toEqual([["12345", x.settlement.recipient]]);
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
    const head = await anvil.rpc<{ number: string }>("eth_getBlockByNumber", ["finalized", false]);
    expect((await readCursor<{ block: string }>(s.rails, "evm:eip155:8453"))?.block).toBe(
      BigInt(head.number).toString(),
    );
  });
});

describe("verifier (Tier A on Anvil, NEAR on recorded RPC, Tier B)", () => {
  it("EVM: provider SUCCESS → verifying → pending until finalized → succeeded on the receipt", async () => {
    const x = await create(live());
    const hash = await anvil.transfer(token, x.settlement.recipient, BigInt(x.settlement.expected));
    one.statuses.set(x.deposit?.address as string, {
      status: "SUCCESS",
      swapDetails: { amountOut: x.settlement.expected, destinationChainTxHashes: [{ hash, explorerUrl: "" }] },
    });
    await s.call("POST", `/internal/executions/${x.id}/signals`, { body: { type: "payer_sent" } });
    await until(x.id, (e) => e.state === "verifying");
    await new Promise((r) => setTimeout(r, 300));
    expect((await get(x.id)).state).toBe("verifying"); // not finalized yet
    await anvil.mine(70);
    const done = await until(x.id, (e) => e.state === "succeeded");
    expect(done.evidence).toMatchObject({ source: "verifier", tier: "A", tx_hash: hash, finality: "finalized" });
    const v = await s.admin.db
      .selectFrom("verifications")
      .selectAll()
      .where("execution_id", "=", toUuid(x.id, "ex"))
      .execute();
    expect(v.map((r) => r.result)).toEqual(["pass"]); // pending attempts are not recorded
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
    expect(done.evidence).toMatchObject({ tier: "A", amount: "1000000000000" });
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
            depositAddress: x.deposit?.address,
            depositMemo: null,
            status: "PROCESSING",
            createdAt: new Date().toISOString(),
            referral: "nearpay",
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
