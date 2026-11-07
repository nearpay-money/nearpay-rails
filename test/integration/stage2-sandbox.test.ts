/**
 * Stage 2 in test mode against the real nearpay-sandbox image (stage-2/2.2-sandbox): refund legs quoted with
 * `scenario_kind: refund` / `scenario_group: re_…`, EUR pricing through the fixed test FX table, and the Explorer
 * feed on the sandbox mirror (`GET /api/v0/transactions`, service token).
 */
import { newId, toUuid } from "@nearpay-internal/ids";
import { Execution, SettlementEstimate } from "@nearpay-internal/spec";
import { testServiceToken } from "@nearpay-internal/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refreshTokens } from "../../src/app/tokens.js";
import { sandboxExplorer } from "../../src/infra/clients/explorer.js";
import { explorerOnce } from "../../src/trackers/explorer-feed/feed.js";
import { ACCOUNT, randomEvm, routeQuote } from "../support/requests.js";
import { ETH_BASE, type Stack, startStack, USDC_ARB, USDC_BASE, USDC_NEAR } from "../support/stack.js";

let s: Stack;
beforeAll(async () => {
  s = await startStack({ sandbox: true });
  expect(await refreshTokens(s.rails, false)).toBeGreaterThan(10);
});
afterAll(async () => {
  await s?.stop();
});

const error = (r: { body: unknown }) => (r.body as { error: { code: string } }).error;

describe("refund legs on the sandbox", () => {
  it("EXACT_INPUT route leg is quoted by the sandbox, integrity-checked and signed", async () => {
    const re = newId("re");
    const r = await s.call("POST", "/internal/refund_executions", {
      body: {
        idempotency_key: `refund:${re}:leg:1`,
        account_id: ACCOUNT,
        livemode: false,
        method: "route_quote",
        reference: { payment_intent: newId("pi"), payment_attempt: newId("pa"), refund: re, refund_leg: 1 },
        source: { asset_id: USDC_BASE, type: "chain_address", chain: "eip155:8453", address: randomEvm() },
        recipient: {
          asset_id: USDC_ARB,
          chain: "eip155:42161",
          address: "0x52908400098527886e0f7030069857d2e4169ee7",
          type: "origin_chain",
        },
        amount: "7000000",
        swap_type: "EXACT_INPUT",
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const x = Execution.parse(r.body);
    expect(x).toMatchObject({ kind: "refund", provider: "sandbox", applied_fee_bps: 0 });
    expect(x.deposit?.amount_in).toBe("7000000");
    expect(BigInt(x.refund?.min_amount_out as string)).toBeLessThanOrEqual(
      BigInt(x.refund?.amount_out_expected as string),
    );
    expect(x.settlement.expected).toBe(x.refund?.min_amount_out);
  });

  it("EXACT_OUTPUT from a merchant Intents account → payer Base USDC: one bound transfer to the INTENTS deposit", async () => {
    const re = newId("re");
    const r = await s.call("POST", "/internal/refund_executions", {
      body: {
        idempotency_key: `refund:${re}:leg:1`,
        account_id: ACCOUNT,
        livemode: false,
        method: "route_quote",
        reference: { payment_intent: newId("pi"), payment_attempt: newId("pa"), refund: re, refund_leg: 1 },
        source: { asset_id: USDC_NEAR, type: "intents_account", chain: "near:mainnet", address: "merchant.near" },
        recipient: {
          asset_id: USDC_BASE,
          chain: "eip155:8453",
          address: "0x52908400098527886e0f7030069857d2e4169ee7",
          type: "origin_chain",
        },
        amount: "3000000",
        swap_type: "EXACT_OUTPUT",
      },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const x = Execution.parse(r.body);
    expect(x.settlement.expected).toBe("3000000");
    expect(x.refund?.transfer).toMatchObject({ signer_id: "merchant.near", receiver_id: x.deposit?.address });
  });
});

describe("non-USD pricing in test mode (fixed FX table)", () => {
  it("EUR prices settle in USDC through the fixed rate; the snapshot names the rate", async () => {
    const r = await s.call("POST", "/internal/executions", {
      body: routeQuote({ pricing: { currency: "eur", amount: 2000 } }),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const x = Execution.parse(r.body);
    expect(x.settlement.amount_base).toBe("21600000"); // 20.00 EUR × 1.08, payer bears the fee
    expect(x.price_snapshot?.rates?.[0]).toMatchObject({ base: "eur", source: "fixed", valid_until: null });
    const e = SettlementEstimate.parse(
      (
        await s.call(
          "GET",
          `/internal/settlement-estimate?amount=1000&currency=jpy&settlement_asset=${USDC_ARB}&livemode=false`,
        )
      ).body,
    );
    expect(e.usd_micros).toBe("6700000");
    expect(
      error(
        await s.call("POST", "/internal/executions", { body: routeQuote({ pricing: { currency: "sek", amount: 1 } }) }),
      ).code,
    ).toBe("currency_unsupported");
  });
});

describe("non-par settlement in test mode (sandbox price is primary and secondary)", () => {
  it("settles ETH on Base from USD pricing with both prices in the snapshot", async () => {
    const r = await s.call("POST", "/internal/executions", {
      body: routeQuote({ destination: { asset_id: ETH_BASE, chain: "eip155:8453" } }),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const x = Execution.parse(r.body);
    expect(x.price_snapshot).toMatchObject({ par: false, par_currency: null });
    expect(x.price_snapshot?.rates?.map((p) => `${p.role}:${p.source}`)).toEqual([
      "primary:sandbox",
      "secondary:sandbox",
    ]);
  });
});

describe("Explorer feed on the sandbox mirror (test mode)", () => {
  it("sees the sandbox quote as an Explorer row and records its status once", async () => {
    const x = Execution.parse((await s.call("POST", "/internal/executions", { body: routeQuote() })).body);
    const ex = sandboxExplorer({
      baseUrl: s.sandbox?.url as string,
      serviceToken: testServiceToken("rails"),
      referral: "nearpay",
    });
    expect(await explorerOnce(s.rails, ex, 0)).toBe(1_000);
    const row = await s.admin.db
      .selectFrom("executions")
      .select(["explorer_status", "explorer_seen_at"])
      .where("id", "=", toUuid(x.id, "ex"))
      .executeTakeFirstOrThrow();
    expect(row.explorer_status).toBe("PENDING_DEPOSIT");
    await explorerOnce(s.rails, ex, 0);
    const obs = await s.admin.db
      .selectFrom("provider_observations")
      .select("id")
      .where("execution_id", "=", toUuid(x.id, "ex"))
      .where("source", "=", "explorer")
      .execute();
    expect(obs).toHaveLength(1);
  });
});
