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
import { readKillSwitch, storeKillSwitch, syncKillSwitch } from "../../src/app/kill-switch.js";
import { refreshTokens } from "../../src/app/tokens.js";
import { type EvmRpc, evmRpc } from "../../src/infra/clients/evm.js";
import { explorer } from "../../src/infra/clients/explorer.js";
import { neardata, nearRpc } from "../../src/infra/clients/near.js";
import { runOps } from "../../src/ops/cli.js";
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
    routingHealth: { intervalMs: 200, graceMs: 0, minLogMs: 0 },
    tracker: {
      // Anvil stands in for Base and (one-block rule, ADR-0022 as amended) for Ethereum L1
      evm: new Map([
        ["eip155:8453", evmRpc({ urls: [anvil.url] })],
        ["eip155:1", evmRpc({ urls: [anvil.url] })],
      ]),
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

describe("routing health (stable reasons, gauges, ALERT lines)", () => {
  const optionsPath = `/internal/options?destination_asset=${USDC_BASE}&destination_type=chain_address&amount_out=1000000&livemode=true`;
  const reasons = async () => {
    const r = await s.call("GET", optionsPath);
    expect(r.status).toBe(200);
    const o = (r.body as { options: { available: boolean; reason: string | null }[] }).options;
    expect(o.length).toBeGreaterThan(0);
    return [...new Set(o.map((x) => (x.available ? "available" : x.reason)))];
  };
  const setFlag = (name: string, value: boolean) =>
    s.admin.db.updateTable("control_flags").set({ value }).where("name", "=", name).execute();
  const gauge = async (series: string) => {
    const text = await s.api.metrics.render();
    const line = text.split("\n").find((l) => l.startsWith(`${series} `));
    return line === undefined ? undefined : Number(line.slice(series.length + 1));
  };
  const until = async (series: string, want: number) => {
    const end = Date.now() + 5_000;
    for (;;) {
      const v = await gauge(series);
      if (v === want) return v;
      if (Date.now() > end) throw new Error(`${series} = ${v}, wanted ${want}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const captureLogs = () => {
    const lines: { level: string; fields: Record<string, unknown>; msg: string }[] = [];
    const real = s.rails.log;
    const at = (level: string) => (fields: Record<string, unknown>, msg: string) => {
      lines.push({ level, fields, msg });
    };
    s.rails.log = { ...real, warn: at("warn"), info: at("info"), error: at("error") } as typeof real;
    return { lines, restore: () => (s.rails.log = real) };
  };

  it("options report the blocking reason as a stable code, per cause", async () => {
    await s.admin.db.updateTable("tokens").set({ price_updated_at: new Date() }).where("livemode", "=", true).execute();
    expect(await reasons()).toEqual(["available"]);
    await setFlag("quoting_enabled", false);
    try {
      expect(await reasons()).toEqual(["kill_switch_engaged"]);
    } finally {
      await setFlag("quoting_enabled", true);
    }
    await setFlag("cross_chain_enabled", false);
    try {
      expect(await reasons()).toEqual(["cross_chain_paused"]);
    } finally {
      await setFlag("cross_chain_enabled", true);
    }
    // the settlement asset's 1Click price is older than 300 s by its provider timestamp
    await s.admin.db
      .updateTable("tokens")
      .set({ price_updated_at: new Date(Date.now() - 600_000) })
      .where("livemode", "=", true)
      .where("asset_id", "=", USDC_BASE)
      .execute();
    try {
      expect(await reasons()).toEqual(["settlement_price_stale"]);
    } finally {
      await s.admin.db
        .updateTable("tokens")
        .set({ price_updated_at: new Date() })
        .where("livemode", "=", true)
        .execute();
    }
    expect(await reasons()).toEqual(["available"]);
  });

  it("gauges, ALERT routing_blocked on the flip and INFO on recovery; ops routing-health explains the reasons", async () => {
    await s.admin.db
      .insertInto("watched_destinations")
      .values({
        destination_id: randomUUID(),
        account_id: toUuid(ACCOUNT, "acct"),
        livemode: true,
        chain: "eip155:8453",
        address_norm: randomEvm(),
        asset_id: USDC_BASE,
        type: "chain_address",
        active: true,
        source_version: 1,
      })
      .execute();
    await until('nearpay_rails_routing_available{livemode="true"}', 1);
    expect(await gauge('nearpay_rails_routing_blocked{livemode="true",reason="kill_switch_engaged"}')).toBe(0);
    expect(await gauge('nearpay_rails_token_registry_age_seconds{livemode="true"}')).toBeLessThan(3600);
    // the asset is in use from the monitor's next tick on
    const ageSeries = `nearpay_rails_settlement_price_age_seconds{livemode="true",asset="${USDC_BASE}"}`;
    const ageEnd = Date.now() + 5_000;
    while ((await gauge(ageSeries)) === undefined && Date.now() < ageEnd) await new Promise((r) => setTimeout(r, 100));
    expect(await gauge(ageSeries)).toBeLessThan(60);
    const logs = captureLogs();
    try {
      await setFlag("quoting_enabled", false);
      await until('nearpay_rails_routing_blocked{livemode="true",reason="kill_switch_engaged"}', 1);
      expect(await gauge('nearpay_rails_routing_available{livemode="true"}')).toBe(0);
      const alert = logs.lines.find((l) => l.msg.startsWith("ALERT routing_blocked"));
      expect(alert).toMatchObject({ level: "warn", fields: { livemode: true, reasons: ["kill_switch_engaged"] } });
      const out: string[] = [];
      expect(await runOps(["routing-health", "live"], s.rails, { actor: "test", out: (l) => out.push(l) })).toBe(0);
      expect(JSON.parse(out.join("\n"))).toMatchObject({
        mode: "live",
        available: false,
        reasons: [{ reason: "kill_switch_engaged", fix: expect.stringContaining("console") }],
      });
      await setFlag("quoting_enabled", true);
      await until('nearpay_rails_routing_available{livemode="true"}', 1);
      expect(await gauge('nearpay_rails_routing_blocked{livemode="true",reason="kill_switch_engaged"}')).toBe(0);
      const end = Date.now() + 2_000;
      while (!logs.lines.some((l) => l.msg === "live payments route again") && Date.now() < end)
        await new Promise((r) => setTimeout(r, 50));
      expect(logs.lines.some((l) => l.level === "info" && l.msg === "live payments route again")).toBe(true);
      // both modes when no mode is given; usage errors exit 2
      const both: string[] = [];
      await runOps(["routing-health"], s.rails, { actor: "test", out: (l) => both.push(l) });
      expect((JSON.parse(both.join("\n")) as { mode: string }[]).map((x) => x.mode)).toEqual(["live", "test"]);
      expect(await runOps(["routing-health", "x"], s.rails, { actor: "test", err: () => {} })).toBe(2);
    } finally {
      logs.restore();
      await setFlag("quoting_enabled", true);
    }
  });

  it("an unreadable kill switch: ALERT kill_switch_unknown with the cause, kill_switch_unknown on options", async () => {
    const setUnknown = () =>
      s.admin.db
        .updateTable("control_flags")
        .set({ known: false, value: true, source_version: 0 })
        .where("name", "=", "quoting_enabled")
        .execute();
    const logs = captureLogs();
    try {
      s.killSwitch.fail = true; // before the state turns unknown: the monitor may read too
      await setUnknown();
      expect(await readKillSwitch(s.rails, { force: true })).toBe("unknown");
      const alert = logs.lines.find((l) => l.msg.startsWith("ALERT kill_switch_unknown"));
      expect(alert?.level).toBe("warn");
      expect(alert?.fields.cause).toMatch(/^http_5\d\d$/);
      expect(await reasons()).toEqual(["kill_switch_unknown"]);
      s.killSwitch.fail = false;
      expect(await readKillSwitch(s.rails, { force: true })).toBe("released");
      expect(logs.lines.some((l) => l.level === "info" && /known again/.test(l.msg))).toBe(true);
      expect(await reasons()).toEqual(["available"]);
    } finally {
      logs.restore();
      s.killSwitch.fail = false;
      await readKillSwitch(s.rails, { force: true });
    }
  });

  it("RAILS-2: refreshes keep the last-good price; a stale 1Click price settles a USD stablecoin at par on a fresh CoinGecko price", async () => {
    const usdcRow = () =>
      s.admin.db
        .selectFrom("tokens")
        .select(["price_num", "price_den", "price_updated_at", "secondary_num", "secondary_updated_at"])
        .where("livemode", "=", true)
        .where("asset_id", "=", USDC_BASE)
        .executeTakeFirstOrThrow();
    const fresh = new Date();
    // a refresh resets the registry fields too: Base USDC lives on Anvil here (beforeAll)
    const { contract_address: anvilToken } = await s.admin.db
      .selectFrom("tokens")
      .select("contract_address")
      .where("livemode", "=", true)
      .where("asset_id", "=", USDC_BASE)
      .executeTakeFirstOrThrow();
    await s.admin.db
      .updateTable("tokens")
      .set({ price_updated_at: fresh })
      .where("livemode", "=", true)
      .where("asset_id", "=", USDC_BASE)
      .execute();
    // the recorded /v0/tokens list is hours old: a refresh never replaces a newer stored price with it
    await refreshTokens(s.rails, true);
    expect((await usdcRow()).price_updated_at?.getTime()).toBe(fresh.getTime());
    // an older stored price is replaced by the provider's
    await s.admin.db
      .updateTable("tokens")
      .set({ price_updated_at: new Date("2020-01-01T00:00:00Z") })
      .where("livemode", "=", true)
      .where("asset_id", "=", USDC_BASE)
      .execute();
    await refreshTokens(s.rails, true);
    const replaced = (await usdcRow()).price_updated_at as Date;
    expect(replaced.getTime()).toBeGreaterThan(Date.parse("2020-01-02T00:00:00Z"));
    await s.admin.db
      .updateTable("tokens")
      .set({ contract_address: anvilToken })
      .where("livemode", "=", true)
      .where("asset_id", "=", USDC_BASE)
      .execute();
    try {
      // 1Click price 10 min old: stale without a secondary …
      await s.admin.db
        .updateTable("tokens")
        .set({ price_updated_at: new Date(Date.now() - 600_000), secondary_num: null, secondary_updated_at: null })
        .where("livemode", "=", true)
        .execute();
      expect(await reasons()).toEqual(["settlement_price_stale"]);
      // … at par via a fresh CoinGecko price within ±1 % of 1 USD
      await s.admin.db
        .updateTable("tokens")
        .set({
          secondary_price_usd: "0.9998",
          secondary_num: "9998",
          secondary_den: "10000",
          secondary_updated_at: new Date(),
          secondary_fetched_at: new Date(),
          secondary_source: "coingecko",
        })
        .where("livemode", "=", true)
        .where("asset_id", "=", USDC_BASE)
        .execute();
      expect(await reasons()).toEqual(["available"]);
      // a secondary outside the single-source band is a depeg, never par
      await s.admin.db
        .updateTable("tokens")
        .set({ secondary_price_usd: "0.985", secondary_num: "985", secondary_den: "1000" })
        .where("livemode", "=", true)
        .where("asset_id", "=", USDC_BASE)
        .execute();
      expect(await reasons()).toEqual(["settlement_price_depeg"]);
    } finally {
      await s.admin.db
        .updateTable("tokens")
        .set({
          price_updated_at: new Date(),
          secondary_price_usd: null,
          secondary_num: null,
          secondary_den: null,
          secondary_updated_at: null,
          secondary_fetched_at: null,
          secondary_source: null,
        })
        .where("livemode", "=", true)
        .execute();
    }
    expect(await reasons()).toEqual(["available"]);
  });

  it("periodic read (RAILS-1): a missed release or engage self-heals, an older answer never wins, a failed re-read keeps the state", async () => {
    const copyRow = () =>
      s.admin.db
        .selectFrom("control_flags")
        .select(["value", "known", "source_version"])
        .where("name", "=", "quoting_enabled")
        .executeTakeFirstOrThrow();
    const logs = captureLogs();
    const longAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    try {
      // rails holds engaged v5; sentinel released v6 ten minutes ago and the event never arrived
      await s.admin.db
        .updateTable("control_flags")
        .set({ value: false, known: true, source_version: 5 })
        .where("name", "=", "quoting_enabled")
        .execute();
      Object.assign(s.killSwitch, { engaged: false, version: 6, updatedAt: longAgo });
      expect(await readKillSwitch(s.rails)).toBe("engaged"); // the quote path does not ask sentinel while known
      expect(await syncKillSwitch(s.rails, { force: true })).toBe("released");
      expect(await copyRow()).toMatchObject({ value: true, known: true, source_version: 6 });
      const healed = logs.lines.find((l) => l.msg.startsWith("ALERT kill_switch_copy_diverged"));
      expect(healed).toMatchObject({ level: "warn", fields: { cause: "copy_behind", resolved: true } });
      expect(await gauge("nearpay_rails_kill_switch_version")).toBe(6);
      expect(await gauge("nearpay_rails_kill_switch_source_version")).toBe(6);
      expect(await gauge("nearpay_rails_kill_switch_engaged")).toBe(0);
      expect(await gauge("nearpay_rails_kill_switch_diverged")).toBe(0);
      expect(await gauge("nearpay_rails_kill_switch_last_read_timestamp_seconds")).toBeGreaterThan(
        Date.now() / 1000 - 60,
      );
      expect(await reasons()).toEqual(["available"]);

      // within 60 s a non-forced sync does not ask sentinel again
      const reads = s.killSwitch.reads;
      expect(await syncKillSwitch(s.rails)).toBe("released");
      expect(s.killSwitch.reads).toBe(reads);

      // the reverse: a missed engage (v7) stops live quoting at the next read
      Object.assign(s.killSwitch, { engaged: true, version: 7 });
      expect(await syncKillSwitch(s.rails, { force: true })).toBe("engaged");
      expect(await reasons()).toEqual(["kill_switch_engaged"]);

      // sentinel answers an older version (restored database): no change, ALERT with the cause, diverged = 1
      logs.lines.length = 0;
      Object.assign(s.killSwitch, { engaged: false, version: 4 });
      expect(await syncKillSwitch(s.rails, { force: true })).toBe("engaged");
      expect(await copyRow()).toMatchObject({ value: false, source_version: 7 });
      expect(logs.lines.find((l) => l.msg.startsWith("ALERT kill_switch_copy_diverged"))).toMatchObject({
        fields: { cause: "sentinel_behind" },
      });
      expect(await gauge("nearpay_rails_kill_switch_diverged")).toBe(1);
      expect(await gauge("nearpay_rails_kill_switch_source_version")).toBe(4);

      // an event older than the copy never applies either
      expect(await storeKillSwitch(s.rails.db, { engaged: false, version: 6, reason: "late event" })).toBe(false);

      // sentinel unreachable while known: the state stays (never unknown), a warning, no ALERT kill_switch_unknown
      logs.lines.length = 0;
      s.killSwitch.fail = true;
      expect(await syncKillSwitch(s.rails, { force: true })).toBe("engaged");
      expect(logs.lines.some((l) => l.msg.startsWith("kill switch could not be re-read"))).toBe(true);
      expect(logs.lines.some((l) => l.msg.startsWith("ALERT kill_switch_unknown"))).toBe(false);
      s.killSwitch.fail = false;

      // operator override (flag-set) at the same version: kept, reported as value_overridden; sentinel's next
      // release replaces it and the copy agrees again
      Object.assign(s.killSwitch, { engaged: true, version: 7 });
      await setFlag("quoting_enabled", true);
      logs.lines.length = 0;
      expect(await syncKillSwitch(s.rails, { force: true })).toBe("released");
      expect(logs.lines.find((l) => l.msg.startsWith("ALERT kill_switch_copy_diverged"))).toMatchObject({
        fields: { cause: "value_overridden" },
      });
      Object.assign(s.killSwitch, { engaged: false, version: 8, updatedAt: null });
      logs.lines.length = 0;
      expect(await syncKillSwitch(s.rails, { force: true })).toBe("released");
      expect(await copyRow()).toMatchObject({ value: true, source_version: 8 });
      expect(await gauge("nearpay_rails_kill_switch_diverged")).toBe(0);
      // sentinel changed just now: its event is still in flight, so no ALERT; the divergence cleared
      expect(logs.lines.some((l) => l.msg.startsWith("ALERT"))).toBe(false);
      expect(logs.lines.some((l) => l.msg === "kill switch copy agrees with sentinel again")).toBe(true);
    } finally {
      logs.restore();
      Object.assign(s.killSwitch, { engaged: false, version: 0, fail: false, updatedAt: null });
      await s.admin.db
        .updateTable("control_flags")
        .set({ value: true, known: true, source_version: 0 })
        .where("name", "=", "quoting_enabled")
        .execute();
    }
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

  it("Base: attributes a Transfer of exactly base + tag in its own block (1 confirmation, `confirmed`), then the finalized re-check passes", async () => {
    const rpc = evmRpc({ urls: [anvil.url] });
    const x = await create(live());
    await watch(x.settlement.recipient);
    await watchOnce(s.rails, "eip155:8453", rpc); // starts the cursor 10 blocks below the counted head (latest)
    const hash = await anvil.transfer(token, x.settlement.recipient, BigInt(x.settlement.expected));
    const stray = await anvil.transfer(token, x.settlement.recipient, 12_345n);
    // ADR-0022 as amended: the payout's own block (latest − block + 1 = 1 … 2) is enough — no further blocks mined
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
    expect(v?.details).toMatchObject({ block_hash: receipt.blockHash, required_confirmations: 1 });
    expect((v?.details as { confirmations?: number } | undefined)?.confirmations ?? 0).toBeGreaterThanOrEqual(1);
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
    // Base counts one block (ADR-0022 as amended): the counted head is `latest` itself, and first sight starts
    // FIRST_SIGHT_MARGIN (10) blocks below it so a payout in the block the watcher first sees is not skipped
    const latest = await anvil.rpc<string>("eth_blockNumber");
    expect((await readCursor<{ block: string }>(s.rails, "evm:eip155:8453"))?.block).toBe(
      (BigInt(latest) - 10n).toString(),
    );
  });
});

describe("EVM watcher first sight (one-block rule)", () => {
  it("a payout mined in the very block the watcher first sees demand is still attributed", async () => {
    const rpc = evmRpc({ urls: [anvil.url] });
    await s.admin.db
      .updateTable("executions")
      .set({ terminal_at: new Date(), state: "failed" })
      .where("livemode", "=", true)
      .where("terminal_at", "is", null)
      .execute();
    expect(await watchOnce(s.rails, "eip155:8453", rpc)).toBe(0); // idle: cursor forgotten
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
    // the payout lands before the (just-elected) watcher's first step: it is the head block at first sight
    const hash = await anvil.transfer(token, x.settlement.recipient, BigInt(x.settlement.expected));
    await watchOnce(s.rails, "eip155:8453", rpc); // first sight
    for (let i = 0; i < 3 && (await get(x.id)).state !== "succeeded"; i++) await watchOnce(s.rails, "eip155:8453", rpc);
    expect(await get(x.id)).toMatchObject({ state: "succeeded", evidence: { tx_hash: hash, finality: "confirmed" } });
  });
});

describe("verifier (Tier A on Anvil, NEAR on recorded RPC, Tier B)", () => {
  it("EVM (Base): provider SUCCESS → verifying → succeeded `confirmed` on the receipt in its own block (1 confirmation)", async () => {
    const x = await create(live());
    const hash = await anvil.transfer(token, x.settlement.recipient, BigInt(x.settlement.expected));
    one.statuses.set(x.deposit?.address as string, {
      status: "SUCCESS",
      swapDetails: { amountOut: x.settlement.expected, destinationChainTxHashes: [{ hash, explorerUrl: "" }] },
    });
    await s.call("POST", `/internal/executions/${x.id}/signals`, { body: { type: "payer_sent" } });
    // ADR-0022 as amended: no further block is needed — the receipt's own block confirms it
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
    expect(v[0]?.details).toMatchObject({ block_hash: receipt.blockHash, required_confirmations: 1 });
    expect((v[0]?.details as { confirmations?: number } | undefined)?.confirmations ?? 0).toBeGreaterThanOrEqual(1);
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

  it("Ethereum L1 (ADR-0022 as amended): one block confirms — no wait for `finalized`; the re-check is scheduled", async () => {
    const to = randomEvm();
    const hash = await anvil.sendNative(to, 2_000_000_000_000n); // the head block: far from Anvil's finalized tag
    const id = await insertExecution({
      state: "verifying",
      destinationChain: "eip155:1",
      recipient: to,
      recipientType: "destination_chain",
      asset: "nep141:eth.omft.near",
      base: 2_000_000_000_000n,
      txHashes: [hash],
    });
    const done = await until(id, (e) => e.state === "succeeded", 5_000);
    expect(done.evidence).toMatchObject({ chain: "eip155:1", tier: "A", finality: "confirmed", tx_hash: hash });
    const receipt = await anvil.rpc<{ blockHash: string }>("eth_getTransactionReceipt", [hash]);
    const row = await s.admin.db
      .selectFrom("executions")
      .select(["finality_recheck_status", "finality_recheck_block_hash"])
      .where("id", "=", toUuid(id, "ex"))
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ finality_recheck_status: "pending", finality_recheck_block_hash: receipt.blockHash });
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

describe("NEAR indexer catch-up (RAILS-3)", () => {
  it("400 blocks behind: one step fetches them 8 at a time and applies them in height order", async () => {
    const final = 223_270_700 + 99;
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
      const start = 223_270_700 - 301; // 400 blocks behind the final head
      await writeCursor(s.rails, "near-indexer", { height: start });
      const client = neardata({ baseUrl: nd.url });
      expect(await indexOnce(s.rails, client)).toBe(400);
      const heights = nd.requests
        .filter((r) => r.path.startsWith("/v0/block/"))
        .map((r) => Number(r.path.split("/").pop()));
      expect(new Set(heights).size).toBe(400);
      expect(Math.min(...heights)).toBe(start + 1);
      expect(Math.max(...heights)).toBe(final);
      expect(await readCursor(s.rails, "near-indexer")).toEqual({ height: final });
      const done = await get(id);
      expect(done).toMatchObject({ state: "succeeded" });
      expect(done.evidence).toMatchObject({ source: "indexer", block_ref: "223270700", finality: "final" });
    } finally {
      await s.admin.db
        .updateTable("executions")
        .set({ state: "failed", terminal_at: new Date() })
        .where("livemode", "=", true)
        .where("destination_chain", "=", "near:mainnet")
        .where("terminal_at", "is", null)
        .execute();
      await nd.stop();
    }
  });

  it("more than 400 behind: a step stops at the window and the lag gauge reports the rest", async () => {
    let final = 0;
    const nd = await fakeNeardata(() => final);
    try {
      await insertExecution({
        state: "awaiting_deposit",
        destinationChain: "near:mainnet",
        recipient: "51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe",
        recipientType: "intents",
        asset: USDC_BASE,
        base: 123_450n,
        tag: 11n,
      });
      final = 300_001_000;
      await writeCursor(s.rails, "near-indexer", { height: 300_000_000 });
      const client = neardata({ baseUrl: nd.url });
      expect(await indexOnce(s.rails, client)).toBe(400);
      expect(await readCursor(s.rails, "near-indexer")).toEqual({ height: 300_000_400 });
      const text = await s.api.metrics.render();
      expect(text).toContain('nearpay_rails_tracker_lag_blocks{tracker="near-indexer"} 600');
    } finally {
      await s.admin.db
        .updateTable("executions")
        .set({ state: "failed", terminal_at: new Date() })
        .where("livemode", "=", true)
        .where("destination_chain", "=", "near:mainnet")
        .where("terminal_at", "is", null)
        .execute();
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
