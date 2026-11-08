/**
 * Stage 2 routes in live mode against the signed 1Click fake (never the real 1Click, ECB or CoinGecko): refund legs,
 * FX rates and staleness, settlement estimates, observations, the evidence summary, the console routes (ops tokens),
 * the observation archive and the Explorer feed with paging and change detection.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "@nearpay-internal/db";
import { newId, toUuid } from "@nearpay-internal/ids";
import { bpsOf } from "@nearpay-internal/money";
import {
  createScreening,
  EvidenceSummary,
  Execution,
  FxRates,
  getKillSwitch,
  ProviderObservationPage,
  SettlementEstimate,
} from "@nearpay-internal/spec";
import { mintOpsToken } from "@nearpay-internal/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { archiveObservations } from "../../src/app/archive.js";
import { refreshEcb, refreshSecondary } from "../../src/app/fx.js";
import { readKillSwitch } from "../../src/app/kill-switch.js";
import { settleWithEvidence } from "../../src/app/observations.js";
import { refreshTokens } from "../../src/app/tokens.js";
import { decodeObservations } from "../../src/archive/parquet.js";
import { fileStore } from "../../src/archive/store.js";
import { parseEcbDaily } from "../../src/domain/pricing/ecb.js";
import { isTargetClosingDay } from "../../src/domain/pricing/target-calendar.js";
import { explorer } from "../../src/infra/clients/explorer.js";
import { verifierNonces } from "../../src/infra/clients/nonces.js";
import { coingeckoProvider } from "../../src/providers/prices/coingecko.js";
import { readCursor } from "../../src/trackers/cursors.js";
import { explorerOnce } from "../../src/trackers/explorer-feed/feed.js";
import { type FakeOneClick, fakeOneClick, fakeServer } from "../support/fakes.js";
import { ACCOUNT, randomEvm, routeQuote } from "../support/requests.js";
import { type Stack, startStack, USDC_ARB, USDC_BASE, USDC_NEAR } from "../support/stack.js";

const TREASURY = "treasury.nearpay.near";
const LIVE_SALT = "c0ffee01";
const PAYER = "0x52908400098527886e0f7030069857d2e4169ee7";
let s: Stack;
let one: FakeOneClick;
const archiveDir = mkdtempSync(join(tmpdir(), "rails-archive-int-"));

/** The ECB fixture re-dated to the latest TARGET working day (the bound is calendar-relative). */
function ecbFixture(): string {
  let d = new Date();
  // before today's 16:00 CET publication the previous working day is the latest
  d = new Date(d.getTime() - 86_400_000);
  while (isTargetClosingDay(d.toISOString().slice(0, 10))) d = new Date(d.getTime() - 86_400_000);
  const xml = readFileSync(new URL("../fixtures/ecb/eurofxref-daily-2026-11-06.xml", import.meta.url), "utf8");
  return xml.replace("2026-11-06", d.toISOString().slice(0, 10));
}

beforeAll(async () => {
  one = await fakeOneClick();
  s = await startStack({
    oneclick: one,
    config: { treasuryAccount: TREASURY },
    tracker: true,
    nonces: verifierNonces({ rpcUrls: [], readSalt: async () => LIVE_SALT }),
  });
  await refreshTokens(s.rails, true);
  await s.admin.db.updateTable("tokens").set({ price_updated_at: new Date() }).where("livemode", "=", true).execute();
  await refreshEcb(s.rails, { daily: async () => parseEcbDaily(ecbFixture()) });
});
afterAll(async () => {
  await s?.stop();
  await one?.stop();
  rmSync(archiveDir, { recursive: true, force: true });
});

const error = (r: { body: unknown }) => (r.body as { error: { code: string } }).error;
const merchant = () => randomEvm();
const refundBody = (over: Record<string, unknown> = {}) => ({
  idempotency_key: `refund:${newId("re")}:leg:1`,
  account_id: ACCOUNT,
  livemode: true,
  method: "route_quote",
  reference: { payment_intent: newId("pi"), payment_attempt: newId("pa"), refund: newId("re"), refund_leg: 1 },
  source: { asset_id: USDC_BASE, type: "chain_address", chain: "eip155:8453", address: merchant() },
  recipient: { asset_id: USDC_ARB, chain: "eip155:42161", address: PAYER, type: "origin_chain" },
  amount: "5000000",
  swap_type: "EXACT_INPUT",
  ...over,
});
const refund = async (over: Record<string, unknown> = {}) => {
  const r = await s.call("POST", "/internal/refund_executions", { body: refundBody(over) });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return Execution.parse(r.body);
};
const quoteSent = () => one.requests.filter((x) => x.path === "/v0/quote").at(-1)?.body as Record<string, unknown>;

describe("refund legs (POST /internal/refund_executions)", () => {
  it("EXACT_INPUT route leg: no app fee, no tag, verification floor = minAmountOut, refund + reference echoed", async () => {
    const body = refundBody();
    const r = await s.call("POST", "/internal/refund_executions", { body });
    expect(r.status).toBe(201);
    const x = Execution.parse(r.body);
    expect(x).toMatchObject({ kind: "refund", method: "route_quote", provider: "oneclick", applied_fee_bps: 0 });
    expect(x.settlement).toMatchObject({ tag: "0", recipient: PAYER, asset_id: USDC_ARB, chain: "eip155:42161" });
    expect(x.origin).toMatchObject({
      refund_to: (body.source as { address: string }).address,
      refund_type: "origin_chain",
    });
    expect(x.refund).toMatchObject({
      swap_type: "EXACT_INPUT",
      amount: "5000000",
      amount_out_expected: "4950000",
      min_amount_out: "4935150", // same_asset slippage 30 bps below amountOut
      transfer: null,
    });
    expect(x.refund?.token?.standard).toBe("erc20");
    expect(x.settlement.expected).toBe("4935150");
    expect(x.reference).toEqual(body.reference);
    expect(quoteSent()).toMatchObject({
      swapType: "EXACT_INPUT",
      amount: "5000000",
      appFees: [],
      refundType: "ORIGIN_CHAIN",
    });
    // idempotent replay
    const again = await s.call("POST", "/internal/refund_executions", { body });
    expect(Execution.parse(again.body).id).toBe(x.id);
    // a payment key cannot be replayed as a refund and vice versa
    const pay = await s.call("POST", "/internal/executions", {
      body: routeQuote({ livemode: true, idempotency_key: body.idempotency_key }),
    });
    expect(error(pay).code).toBe("idempotency_key_reused");
  });

  it("EXACT_OUTPUT converts with §8.2 pricing (USDC → USDC at par)", async () => {
    const x = await refund({ swap_type: "EXACT_OUTPUT" });
    expect(quoteSent()).toMatchObject({ swapType: "EXACT_OUTPUT", amount: "5000000" });
    expect(x.settlement.expected).toBe("5000000");
    expect(x.price_snapshot).toMatchObject({ par: true, currency: "asset" });
  });

  it("Intents-account source: INTENTS deposit and one bound transfer to the deposit address", async () => {
    const x = await refund({
      source: { asset_id: USDC_NEAR, type: "intents_account", chain: "near:mainnet", address: "Merchant.near" },
    });
    expect(quoteSent()).toMatchObject({ depositType: "INTENTS", refundType: "INTENTS", refundTo: "merchant.near" });
    expect(x.refund?.token).toBeNull();
    expect(x.refund?.transfer).toMatchObject({
      signer_id: "merchant.near",
      receiver_id: x.deposit?.address,
      token: USDC_NEAR,
      amount: x.deposit?.amount_in,
    });
    expect(x.refund?.transfer?.memo).toMatch(/^np1:/);
    expect(x.deposit?.chain).toBe("near:mainnet");
  });

  it("intents_transfer leg: merchant → payer Intents account, same asset, binding, no provider", async () => {
    const x = await refund({
      method: "intents_transfer",
      source: { asset_id: USDC_NEAR, type: "intents_account", chain: "near:mainnet", address: "merchant.near" },
      recipient: { asset_id: USDC_NEAR, chain: "near:mainnet", address: "payer.near", type: "intents" },
    });
    expect(x).toMatchObject({ method: "intents_transfer", provider: "direct_intents", intents_requirement: null });
    expect(x.refund).toMatchObject({ swap_type: null, amount: "5000000", min_amount_out: null });
    expect(x.refund?.transfer).toMatchObject({
      signer_id: "merchant.near",
      receiver_id: "payer.near",
      amount: "5000000",
    });
    // agentpay's refund relay matches the signed transfer against these (memo = the execution's binding)
    expect(x.reference?.refund).toMatch(/^re_/);
    const row = await s.admin.db
      .selectFrom("executions")
      .select("binding")
      .where("id", "=", toUuid(x.id, "ex"))
      .executeTakeFirstOrThrow();
    expect(x.refund?.transfer?.memo).toBe(row.binding);
    const bad = await s.call("POST", "/internal/refund_executions", {
      body: refundBody({ method: "intents_transfer" }),
    });
    expect(error(bad).code).toBe("route_unavailable");
  });

  it("screens the recipient (context refund) and refuses a blocked one", async () => {
    const r = await s.call("POST", "/internal/refund_executions", {
      body: refundBody({
        method: "intents_transfer",
        source: { asset_id: USDC_NEAR, type: "intents_account", chain: "near:mainnet", address: "merchant.near" },
        recipient: { asset_id: USDC_NEAR, chain: "near:mainnet", address: "sanctioned.near", type: "intents" },
      }),
    });
    expect(error(r).code).toBe("screening_blocked");
  });

  it("the kill switch blocks new live refund legs (rail_unavailable)", async () => {
    await s.admin.db.updateTable("control_flags").set({ value: false }).where("name", "=", "quoting_enabled").execute();
    try {
      const r = await s.call("POST", "/internal/refund_executions", { body: refundBody() });
      expect(r.status).toBe(503);
      expect(error(r).code).toBe("rail_unavailable");
    } finally {
      await s.admin.db
        .updateTable("control_flags")
        .set({ value: true })
        .where("name", "=", "quoting_enabled")
        .execute();
    }
  });

  describe("refund quote bounds against §8.2 pricing (audit finding 4)", () => {
    const refused = async (tamper: (q: Record<string, unknown>) => void, over: Record<string, unknown> = {}) => {
      const before = one.requests.filter((x) => x.path === "/v0/quote").length;
      one.tamper = (resp) => tamper(resp.quote as Record<string, unknown>);
      try {
        const r = await s.call("POST", "/internal/refund_executions", { body: refundBody(over) });
        expect(one.requests.filter((x) => x.path === "/v0/quote").length).toBe(before + 1);
        expect(r.status).toBe(502);
        expect(error(r).code).toBe("quote_integrity_failed");
      } finally {
        one.tamper = null;
      }
    };

    it("EXACT_INPUT: a signed quote with minAmountOut far below amountOut is refused (the payer's floor)", async () => {
      // passes the old 0 < minAmountOut ≤ amountOut check
      await refused((q) => {
        q.minAmountOut = "1";
      });
    });

    it("EXACT_INPUT: a signed quote whose amountOut is outside the price band is refused", async () => {
      await refused((q) => {
        q.amountOut = "4000000"; // 20 % below the priced 5 000 000
        q.minAmountOut = "3988000";
      });
    });

    it("EXACT_OUTPUT: a signed quote charging the merchant above band + slippage is refused", async () => {
      await refused(
        (q) => {
          q.amountIn = "5500000"; // +10 % for 5 USDC out
          q.minAmountIn = "5500000";
        },
        { swap_type: "EXACT_OUTPUT" },
      );
    });

    it("pricing unavailable refuses an EXACT_INPUT leg before any quote (fail closed)", async () => {
      const before = one.requests.filter((x) => x.path === "/v0/quote").length;
      const stale = new Date(Date.now() - 3_600_000);
      await s.admin.db
        .updateTable("tokens")
        .set({ price_updated_at: stale })
        .where("livemode", "=", true)
        .where("asset_id", "in", [USDC_BASE, USDC_ARB])
        .execute();
      try {
        const r = await s.call("POST", "/internal/refund_executions", { body: refundBody() });
        expect(r.status).toBe(503);
        expect(error(r).code).toBe("pricing_unavailable");
        expect(one.requests.filter((x) => x.path === "/v0/quote").length).toBe(before);
      } finally {
        await s.admin.db
          .updateTable("tokens")
          .set({ price_updated_at: new Date() })
          .where("livemode", "=", true)
          .execute();
      }
    });
  });

  it("a provider SUCCESS alone never settles a refund leg (INV-2): verifying, not succeeded", async () => {
    const x = await refund();
    one.statuses.set(x.deposit?.address as string, {
      status: "SUCCESS",
      swapDetails: {
        amountOut: "4950000",
        destinationChainTxHashes: [{ hash: `0x${"cd".repeat(32)}`, explorerUrl: "" }],
      },
    });
    await s.call("POST", `/internal/executions/${x.id}/signals`, { body: { type: "payer_sent" } });
    const end = Date.now() + 15_000;
    let cur = x;
    while (Date.now() < end && cur.state !== "verifying") {
      await new Promise((r) => setTimeout(r, 100));
      cur = Execution.parse((await s.call("GET", `/internal/executions/${x.id}`)).body);
    }
    expect(cur.state).toBe("verifying");
    expect(cur.settled_amount).toBeNull();
  });
});

describe("pricing and FX routes", () => {
  it("GET /internal/fx-rates: usd first, ECB rates with reference date; a stale rate is reported, never used", async () => {
    const r = FxRates.parse((await s.call("GET", "/internal/fx-rates?livemode=true")).body);
    expect(r.currencies.map((c) => c.currency)).toEqual(["usd", "aud", "cad", "chf", "eur", "gbp", "jpy"]);
    const eur = r.currencies.find((c) => c.currency === "eur");
    expect(eur).toMatchObject({ available: true, stale: false, exponent: 2 });
    expect(eur?.rate).toMatchObject({
      source: "ecb",
      kind: "fx",
      role: "reference",
      value: { num: "10823", den: "10000" },
    });
    expect(r.currencies.find((c) => c.currency === "jpy")?.exponent).toBe(0);

    await s.admin.db
      .updateTable("fx_rates")
      .set({ valid_until: new Date(Date.now() - 1000) })
      .where("livemode", "=", true)
      .where("currency", "=", "chf")
      .execute();
    const st = FxRates.parse((await s.call("GET", "/internal/fx-rates?livemode=true&currencies=chf,eur")).body);
    expect(st.currencies.map((c) => [c.currency, c.available, c.stale])).toEqual([
      ["chf", false, true],
      ["eur", true, false],
    ]);
    const test = FxRates.parse((await s.call("GET", "/internal/fx-rates?livemode=false&currencies=eur")).body);
    expect(test.currencies[0]?.rate).toMatchObject({ source: "fixed", valid_until: null });
  });

  it("settlement-estimate values EUR in USD micros and settles USDC at par via the EUR rate", async () => {
    const r = await s.call(
      "GET",
      `/internal/settlement-estimate?amount=1000&currency=eur&settlement_asset=${USDC_NEAR}&livemode=true`,
    );
    expect(r.status).toBe(200);
    const e = SettlementEstimate.parse(r.body);
    expect(e.usd_micros).toBe("10823000");
    expect(e.settlement).toEqual({ asset_id: USDC_NEAR, amount_base: "10823000", par: true });
    expect(e.price_snapshot).toMatchObject({ currency: "eur", par_currency: "usd", fx: "1.0823" });
    expect(
      error(await s.call("GET", "/internal/settlement-estimate?amount=1000&currency=chf&livemode=true")).code,
    ).toBe("fx_rate_unavailable");
    expect(
      error(await s.call("GET", "/internal/settlement-estimate?amount=1000&currency=sek&livemode=true")).code,
    ).toBe("currency_unsupported");
  });

  it("an execution priced in a stale currency fails with fx_rate_unavailable; EUR pricing works", async () => {
    const stale = await s.call("POST", "/internal/executions", {
      body: routeQuote({ livemode: true, pricing: { currency: "chf", amount: 2000 } }),
    });
    expect(error(stale).code).toBe("fx_rate_unavailable");
    const ok = await s.call("POST", "/internal/executions", {
      body: routeQuote({ livemode: true, pricing: { currency: "eur", amount: 2000 } }),
    });
    expect(ok.status).toBe(201);
    const x = Execution.parse(ok.body);
    expect(x.price_snapshot?.rates?.[0]).toMatchObject({ base: "eur", source: "ecb" });
  });

  it("assets carry peg, par_ok, prices and token; the secondary feed fills secondary prices", async () => {
    const cg = await fakeServer((req) => ({
      status: 200,
      body: Object.fromEntries(
        (req.query.get("ids") ?? "")
          .split(",")
          .map((id) => [id, { usd: 1.0001, last_updated_at: Math.floor(Date.now() / 1000) }]),
      ),
    }));
    try {
      expect(await refreshSecondary(s.rails, coingeckoProvider({ baseUrl: cg.url }))).toBeGreaterThan(0);
    } finally {
      await cg.stop();
    }
    const a = (await s.call("GET", `/internal/assets/${USDC_BASE}?livemode=true`)).body as Record<string, unknown>;
    expect(a).toMatchObject({ peg_currency: "usd", par_ok: true, token: { standard: "erc20" } });
    expect((a.prices as { role: string; source: string }[]).map((p) => `${p.role}:${p.source}`)).toEqual([
      "primary:oneclick",
      "secondary:coingecko",
    ]);
    const o = (
      await s.call(
        "GET",
        `/internal/options?destination_asset=${USDC_ARB}&destination_type=chain_address&amount_out=1000000&livemode=true`,
      )
    ).body as { options: { token?: unknown }[] };
    expect(o.options.length).toBeGreaterThan(0);
    expect(o.options.every((x) => x.token !== undefined)).toBe(true);
  });
});

describe("evidence: observations, summary, listEvidence filters", () => {
  it("observations page oldest first with payload hash; cursor paging", async () => {
    const x = await refund();
    const p = ProviderObservationPage.parse(
      (await s.call("GET", `/internal/executions/${x.id}/observations?limit=1`)).body,
    );
    expect(p.data[0]).toMatchObject({ source: "quote", provider_status: "PENDING_DEPOSIT", archive: null });
    expect(p.data[0]?.payload_sha256).toMatch(/^[0-9a-f]{64}$/);
    const next = ProviderObservationPage.parse(
      (await s.call("GET", `/internal/executions/${x.id}/observations?starting_after=${p.data[0]?.id}`)).body,
    );
    expect(next.data.every((o) => o.id > (p.data[0]?.id as string))).toBe(true);
  });

  it("summary: totals per kind/state/asset, digest, Tier-B cross-check; listEvidence states/kind", async () => {
    const account = newId("acct");
    const x = await refund({ account_id: account });
    await settleWithEvidence(s.rails, toUuid(x.id, "ex"), {
      result: "pass",
      tier: "B",
      source: "provider",
      chain: "eip155:42161",
      txHash: `0x${"ef".repeat(32)}`,
      blockRef: null,
      recipient: PAYER,
      assetId: USDC_ARB,
      amount: 4950000n,
      finality: "confirmed",
    });
    const day = new Date().toISOString().slice(0, 10);
    const sum = EvidenceSummary.parse(
      (await s.call("GET", `/internal/evidence/summary?account_id=${account}&livemode=true&day=${day}`)).body,
    );
    expect(sum.complete).toBe(false);
    expect(sum.totals).toEqual([
      {
        kind: "refund",
        state: "succeeded",
        asset_id: USDC_ARB,
        count: 1,
        settled_amount: "4950000",
        refunded_amount: "0",
      },
    ]);
    expect(sum.tier_b).toEqual({ count: 1, explorer_confirmed: 0, unconfirmed: [] }); // Explorer feed off
    const again = EvidenceSummary.parse(
      (await s.call("GET", `/internal/evidence/summary?account_id=${account}&livemode=true&day=${day}`)).body,
    );
    expect(again.digest).toBe(sum.digest);
    const list = (
      await s.call(
        "GET",
        `/internal/evidence?account_id=${account}&livemode=true&day=${day}&states=succeeded,failed&kind=refund`,
      )
    ).body as { data: Execution[] };
    expect(list.data.map((e) => e.id)).toEqual([x.id]);
    const payments = (
      await s.call("GET", `/internal/evidence?account_id=${account}&livemode=true&day=${day}&kind=payment`)
    ).body as { data: Execution[] };
    expect(payments.data).toEqual([]);
    const old = EvidenceSummary.parse(
      (await s.call("GET", `/internal/evidence/summary?account_id=${account}&livemode=true&day=2026-01-02`)).body,
    );
    expect(old).toMatchObject({ complete: true, totals: [], in_flight: 0 });
    expect(old.digest).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("console routes (/ops/executions…)", () => {
  const ops = async (o: Parameters<typeof mintOpsToken>[0] = {}) => mintOpsToken(o);

  it("list (livemode required), get, observations; merchant/service principals refused", async () => {
    const x = await refund();
    const list = await s.call("GET", `/ops/executions?livemode=true&kind=refund&limit=5`, { token: await ops() });
    expect(list.status).toBe(200);
    const page = list.body as { object: string; data: Execution[]; has_more: boolean };
    expect(page.object).toBe("list");
    expect(page.data[0]?.id).toBe(x.id);
    expect((await s.call("GET", "/ops/executions", { token: await ops() })).status).toBe(400);
    expect((await s.call("GET", `/ops/executions/${x.id}`, { token: await ops() })).status).toBe(200);
    const obs = await s.call("GET", `/ops/executions/${x.id}/observations`, { token: await ops() });
    expect(ProviderObservationPage.parse(obs.body).data.length).toBeGreaterThan(0);
    const svc = await s.call("GET", "/ops/executions?livemode=true");
    expect([401, 403]).toContain(svc.status);
    const older = await s.call("GET", `/ops/executions?livemode=true&starting_after=${x.id}&limit=1`, {
      token: await ops(),
    });
    expect((older.body as { data: Execution[] }).data.every((e) => e.id < x.id)).toBe(true);
  });

  it("reverify: step-up required; 409 outside held/verifying; held → verify_at now, operator observation, ops_action event", async () => {
    const x = await refund();
    const noStepUp = await s.call("POST", `/ops/executions/${x.id}/reverify`, {
      body: { note: "n" },
      token: await ops(),
    });
    expect([401, 403]).toContain(noStepUp.status);
    const conflict = await s.call("POST", `/ops/executions/${x.id}/reverify`, {
      body: { note: "check" },
      token: await ops({ stepUp: true }),
    });
    expect(error(conflict).code).toBe("state_conflict");
    await s.admin.db
      .updateTable("executions")
      .set({ state: "held", held_reason: "evidence_timeout", verify_at: null, next_poll_at: null })
      .where("id", "=", toUuid(x.id, "ex"))
      .execute();
    const sub = newId("usr");
    const r = await s.call("POST", `/ops/executions/${x.id}/reverify`, {
      body: { note: "provider says SUCCESS" },
      token: await ops({ stepUp: true, role: "ops_admin", sub }),
    });
    expect(r.status).toBe(202);
    expect(Execution.parse(r.body).state).toBe("held"); // never forces a state
    const row = await s.admin.db
      .selectFrom("provider_observations")
      .select(["source", "payload"])
      .where("execution_id", "=", toUuid(x.id, "ex"))
      .where("source", "=", "operator")
      .executeTakeFirstOrThrow();
    expect(row.payload).toMatchObject({ operator: sub, ops_role: "ops_admin", note: "provider says SUCCESS" });
    const ev = await sql<{ payload: { data: { object: Record<string, unknown> } } }>`
      select payload from outbox where subject = 'evt.rails.ops_action.recorded' order by created_at desc limit 1`.execute(
      s.admin.db,
    );
    expect(ev.rows[0]?.payload.data.object).toMatchObject({
      actor: { sub, ops_role: "ops_admin" },
      action: "execution.reverify_requested",
      target: { type: "execution", id: x.id },
      account_id: ACCOUNT,
    });
    expect(JSON.stringify(ev.rows[0]?.payload)).not.toContain("provider says SUCCESS"); // ids only
  });
});

describe("observation archive job", () => {
  it("archives terminal executions older than 90 days to Parquet, read back, then nulls payloads (hash kept)", async () => {
    const x = await refund();
    const id = toUuid(x.id, "ex");
    await s.admin.db
      .updateTable("executions")
      .set({ state: "failed", terminal_at: new Date(Date.now() - 91 * 86_400_000) })
      .where("id", "=", id)
      .execute();
    const before = await s.admin.db
      .selectFrom("provider_observations")
      .select(["id", "payload_sha256"])
      .where("execution_id", "=", id)
      .execute();
    const store = fileStore(archiveDir);
    expect(await archiveObservations(s.rails, store)).toBe(before.length);
    expect(await archiveObservations(s.rails, store)).toBe(0); // idempotent
    expect(await archiveObservations(s.rails, null)).toBe(0);
    const page = ProviderObservationPage.parse((await s.call("GET", `/internal/executions/${x.id}/observations`)).body);
    expect(page.data[0]?.payload).toBeNull();
    expect(page.data[0]?.archive?.object_key).toMatch(/^rails\/observations\/live\/\d{4}\/\d{2}\/\d{2}\/.+\.parquet$/);
    const file = await decodeObservations(await store.get(page.data[0]?.archive?.object_key as string));
    expect(file[page.data[0]?.archive?.row ?? 0]?.payload_sha256).toBe(page.data[0]?.payload_sha256);
    const after = await s.admin.db
      .selectFrom("provider_observations")
      .select(["payload_sha256"])
      .where("execution_id", "=", id)
      .execute();
    expect(after.map((a) => Buffer.from(a.payload_sha256).toString("hex")).sort()).toEqual(
      before.map((b) => Buffer.from(b.payload_sha256).toString("hex")).sort(),
    );
  });
});

describe("Explorer feed (owner token)", () => {
  it("records only status changes, nudges open executions, pages full windows with lastDepositAddress", async () => {
    const x = await refund();
    const address = x.deposit?.address as string;
    let status = "PROCESSING";
    let full = false;
    const queries: URLSearchParams[] = [];
    const row = (depositAddress: string, st: string) => ({
      originAsset: USDC_BASE,
      destinationAsset: USDC_ARB,
      depositAddress,
      depositMemo: null,
      recipient: PAYER,
      status: st,
      createdAt: new Date().toISOString(),
      createdAtTimestamp: Math.floor(Date.now() / 1000),
      referral: "nearpay",
      amountIn: "0",
      amountInFormatted: "0",
      amountInUsd: "0",
      amountOut: "0",
      amountOutFormatted: "0",
      amountOutUsd: "0",
    });
    const ex = await fakeServer((req) => {
      queries.push(req.query);
      return {
        status: 200,
        body: full
          ? Array.from({ length: 1000 }, (_, i) => row(i === 999 ? "last-row" : `other-${i}`, "PROCESSING"))
          : [row(address, status), row("unknown", "SUCCESS")],
      };
    });
    try {
      const client = explorer({ baseUrl: ex.url, token: "jwt", referral: "nearpay" });
      expect(await explorerOnce(s.rails, client, 0)).toBe(5_000);
      expect(ex.requests.at(-1)?.headers.authorization).toBe("Bearer jwt");
      expect(queries.at(-1)?.get("statuses")).toBe("PENDING_DEPOSIT,INCOMPLETE_DEPOSIT,PROCESSING");
      expect(queries.at(-1)?.get("numberOfTransactions")).toBe("1000");
      const count = async () =>
        (
          await s.admin.db
            .selectFrom("provider_observations")
            .select("id")
            .where("execution_id", "=", toUuid(x.id, "ex"))
            .where("source", "=", "explorer")
            .execute()
        ).length;
      expect(await count()).toBe(1);
      const r1 = await s.admin.db
        .selectFrom("executions")
        .select(["explorer_status", "has_signal"])
        .where("id", "=", toUuid(x.id, "ex"))
        .executeTakeFirstOrThrow();
      expect(r1).toEqual({ explorer_status: "PROCESSING", has_signal: true });
      await explorerOnce(s.rails, client, 3);
      expect(await count()).toBe(1); // unchanged status: not recorded again
      status = "SUCCESS";
      await explorerOnce(s.rails, client, 0);
      expect(await count()).toBe(2);
      full = true;
      await explorerOnce(s.rails, client, 0);
      const cur = await readCursor<{ pages?: Record<string, { depositAddress: string }> }>(s.rails, "explorer");
      expect(cur?.pages?.inflight?.depositAddress).toBe("last-row");
      full = false;
      await explorerOnce(s.rails, client, 0);
      expect(queries.at(-1)?.get("lastDepositAddress")).toBe("last-row");
      expect(queries.at(-1)?.get("direction")).toBe("next");
      const cur2 = await readCursor<{ pages?: Record<string, unknown> }>(s.rails, "explorer");
      expect(cur2?.pages?.inflight).toBeUndefined();
    } finally {
      await ex.stop();
    }
  });
});

describe("spec 0.2.1", () => {
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
  const payment = async () => {
    const r = await s.call("POST", "/internal/executions", {
      body: routeQuote({
        livemode: true,
        origin: { asset_id: USDC_ARB, chain: "eip155:42161", refund_to: PAYER, refund_type: "origin_chain" },
      }),
    });
    if (r.status !== 201) throw new Error(JSON.stringify(r.body));
    return Execution.parse(r.body);
  };
  const outboxOf = async (id: string) =>
    (
      await s.admin.db
        .selectFrom("outbox")
        .select(["subject", "payload"])
        .where(sql<boolean>`payload->'aggregate'->>'id' = ${id}`)
        .orderBy("created_at")
        .execute()
    ).map((r) => r.subject);

  it("decimals, fee share of amount_in, deposited amount and the observed route fee (provider appFees)", async () => {
    const x = await payment();
    expect(x.origin.decimals).toBe(6);
    expect(x.settlement.decimals).toBe(6);
    const amountIn = BigInt(x.deposit?.amount_in as string);
    // the payer bears the fee (FEE_SCHEDULE default): NearPay's share of amount_in at the applied bps
    expect(x.deposit?.fee_amount_in).toBe(bpsOf(amountIn, x.applied_fee_bps).toString());
    expect(x.observed_fee).toBeNull();
    expect(x.deposited_amount).toBeNull();
    const address = x.deposit?.address as string;
    one.statuses.set(address, {
      status: "KNOWN_DEPOSIT_TX",
      swapDetails: {
        depositedAmount: amountIn.toString(),
        originChainTxHashes: [{ hash: `0x${"ab".repeat(32)}`, explorerUrl: "" }],
      },
    });
    await s.call("POST", `/internal/executions/${x.id}/signals`, { body: { type: "payer_sent" } });
    const d = await until(x.id, (e) => e.state === "deposit_detected");
    expect(d.deposited_amount).toBe(amountIn.toString());
    expect(d.observed_fee).toBeNull(); // not settled yet
    one.statuses.set(address, {
      status: "SUCCESS",
      swapDetails: {
        amountIn: amountIn.toString(),
        depositedAmount: amountIn.toString(),
        amountOut: x.settlement.expected,
      },
    });
    await s.admin.db
      .updateTable("executions")
      .set({ next_poll_at: new Date() })
      .where("id", "=", toUuid(x.id, "ex"))
      .execute();
    const v = await until(x.id, (e) => e.state === "verifying");
    // the fake echoes the requested fee split (treasury + 1Click): together the applied bps
    expect(v.observed_fee).toEqual({ amount: bpsOf(amountIn, x.applied_fee_bps).toString(), asset_id: USDC_ARB });
    expect(Execution.safeParse(v).success).toBe(true);
  });

  it("refund legs carry no app fee: fee_amount_in 0, observed_fee null", async () => {
    const x = await refund();
    expect(x.deposit?.fee_amount_in).toBe("0");
    expect(x.observed_fee).toBeNull();
    expect(x.origin.decimals).toBe(6);
  });

  it("abandonExecution: a pre-deposit refund leg → expired_unpaid, tracked 24 h, one event; repeats unchanged", async () => {
    const x = await refund();
    const t0 = Date.now();
    const r = await s.call("POST", `/internal/executions/${x.id}/abandon`, {
      body: { reason: "execution_mismatch", note: "amount differs" },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const a = Execution.parse(r.body);
    expect(a).toMatchObject({ state: "expired_unpaid", abandon_reason: "execution_mismatch", version: x.version + 1 });
    expect(Date.parse(a.abandoned_at as string)).toBeGreaterThanOrEqual(t0 - 1000);
    expect(Date.parse(a.deadline)).toBeLessThanOrEqual(Date.now());
    const row = await s.admin.db
      .selectFrom("executions")
      .select(["tracking_until", "abandon_note", "terminal_at"])
      .where("id", "=", toUuid(x.id, "ex"))
      .executeTakeFirstOrThrow();
    expect((row.tracking_until as Date).getTime() - Date.parse(a.abandoned_at as string)).toBe(24 * 3_600_000);
    expect(row).toMatchObject({ abandon_note: "amount differs", terminal_at: null });
    const t = await s.admin.db
      .selectFrom("execution_transitions")
      .select(["from_state", "to_state", "cause"])
      .where("execution_id", "=", toUuid(x.id, "ex"))
      .orderBy("created_at")
      .execute();
    expect(t.at(-1)).toMatchObject({ from_state: "awaiting_deposit", to_state: "expired_unpaid" });
    const again = await s.call("POST", `/internal/executions/${x.id}/abandon`, { body: { reason: "superseded" } });
    expect(again.status).toBe(200);
    expect(Execution.parse(again.body)).toMatchObject({ version: a.version, abandon_reason: "execution_mismatch" });
    expect((await outboxOf(x.id)).filter((sub) => sub === "evt.rails.execution.updated").length).toBe(2); // created + abandoned
  });

  it("abandonExecution refuses a payment execution, a leg with a deposit, and needs rails.executions.write", async () => {
    const p = await payment();
    const r1 = await s.call("POST", `/internal/executions/${p.id}/abandon`, { body: { reason: "leg_failed" } });
    expect([r1.status, error(r1).code]).toEqual([409, "state_conflict"]);
    const x = await refund();
    await s.admin.db
      .updateTable("executions")
      .set({ deposit_tx_hashes: [`0x${"cd".repeat(32)}`] })
      .where("id", "=", toUuid(x.id, "ex"))
      .execute();
    const r2 = await s.call("POST", `/internal/executions/${x.id}/abandon`, { body: { reason: "leg_failed" } });
    expect([r2.status, error(r2).code]).toEqual([409, "state_conflict"]);
    expect((await get(x.id)).abandoned_at).toBeNull();
    const r3 = await s.call("POST", `/internal/executions/${x.id}/abandon`, {
      body: { reason: "leg_failed" },
      service: "sentinel",
    });
    expect(r3.status).toBe(403);
  });

  it("RefundTransfer.nonce: the Verifier salt ‖ 28 random bytes on Intents-source legs", async () => {
    const x = await refund({
      source: { asset_id: USDC_NEAR, type: "intents_account", chain: "near:mainnet", address: "merchant.near" },
    });
    const nonce = x.refund?.transfer?.nonce as string;
    const bytes = Buffer.from(nonce, "base64");
    expect(bytes).toHaveLength(32);
    expect(bytes.subarray(0, 4).toString("hex")).toBe(LIVE_SALT);
    const y = await refund({
      source: { asset_id: USDC_NEAR, type: "intents_account", chain: "near:mainnet", address: "merchant.near" },
    });
    expect(y.refund?.transfer?.nonce).not.toBe(nonce);
  });

  it("an owner-overridden recipient (screen: true) is screened fresh; others use the cache", async () => {
    await refund({ screen: true });
    expect(s.compliance.callsTo(createScreening).at(-1)?.body).toMatchObject({ context: "refund", fresh: true });
    await refund();
    expect(s.compliance.callsTo(createScreening).at(-1)?.body).not.toHaveProperty("fresh");
  });

  it("kill switch: unknown refuses live quoting; sentinel's state is read and stored with its version", async () => {
    const setUnknown = () =>
      s.admin.db
        .updateTable("control_flags")
        .set({ known: false, value: true, source_version: 0 })
        .where("name", "=", "quoting_enabled")
        .execute();
    try {
      await setUnknown();
      s.killSwitch.fail = true;
      expect(await readKillSwitch(s.rails, { force: true })).toBe("unknown");
      const r1 = await s.call("POST", "/internal/refund_executions", { body: refundBody() });
      expect([r1.status, error(r1).code]).toEqual([503, "rail_unavailable"]);
      expect((r1.body as { error: { message: string } }).error.message).toMatch(/unknown/);
      // sentinel answers: engaged at version 7 → stored, live quoting refused as engaged
      s.killSwitch.fail = false;
      Object.assign(s.killSwitch, { engaged: true, version: 7 });
      expect(await readKillSwitch(s.rails, { force: true })).toBe("engaged");
      const r2 = await s.call("POST", "/internal/executions", {
        body: routeQuote({
          livemode: true,
          origin: { asset_id: USDC_ARB, chain: "eip155:42161", refund_to: PAYER, refund_type: "origin_chain" },
        }),
      });
      expect([r2.status, error(r2).code]).toEqual([503, "rail_unavailable"]);
      const flag = await s.admin.db
        .selectFrom("control_flags")
        .selectAll()
        .where("name", "=", "quoting_enabled")
        .executeTakeFirstOrThrow();
      expect(flag).toMatchObject({ known: true, value: false, source_version: 7 });
      // once known, a read never overrides the stored state (only newer events do)
      Object.assign(s.killSwitch, { engaged: false, version: 8 });
      expect(await readKillSwitch(s.rails, { force: true })).toBe("engaged");
      expect(s.sentinel.callsTo(getKillSwitch).length).toBeGreaterThan(0);
    } finally {
      Object.assign(s.killSwitch, { engaged: false, version: 0, fail: false });
      await setUnknown();
      expect(await readKillSwitch(s.rails, { force: true })).toBe("released");
    }
  });
});
