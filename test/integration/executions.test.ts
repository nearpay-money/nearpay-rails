/**
 * Creating executions in test mode against the real nearpay-sandbox image (lld/rails.md §8.1), plus
 * the read APIs (§6).
 */
import { sql } from "@nearpay-internal/db";
import { toUuid } from "@nearpay-internal/ids";
import { createScreening, Execution } from "@nearpay-internal/spec";
import { mockError } from "@nearpay-internal/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refreshTokens } from "../../src/app/tokens.js";
import { ACCOUNT, intentsTransfer, randomEvm, routeQuote } from "../support/requests.js";
import {
  ETH_BASE,
  MERCHANT_EVM,
  type Stack,
  startStack,
  TREASURY,
  USDC_ARB,
  USDC_BASE,
  USDC_NEAR,
} from "../support/stack.js";

let s: Stack;
beforeAll(async () => {
  s = await startStack({ sandbox: true });
  expect(await refreshTokens(s.rails, false)).toBeGreaterThan(10);
});
afterAll(async () => {
  await s?.stop();
});

const create = (body: unknown) => s.call("POST", "/internal/executions", { body });
const error = (r: { body: unknown }) => (r.body as { error: { code: string; param?: string } }).error;

describe("route_quote (test mode, sandbox)", () => {
  it("quotes, tags, checks integrity and stores one execution with its outbox event", async () => {
    const b = routeQuote();
    const r = await create(b);
    expect(r.status).toBe(201);
    const x = Execution.parse(r.body);
    expect(x).toMatchObject({
      version: 1,
      livemode: false,
      kind: "payment",
      method: "route_quote",
      provider: "sandbox",
      state: "awaiting_deposit",
      provider_status: "PENDING_DEPOSIT",
      route_class: "same_asset",
      applied_fee_bps: 20,
      origin: { asset_id: USDC_BASE, chain: "eip155:8453", refund_type: "origin_chain" },
      settlement: { asset_id: USDC_ARB, amount_base: "20000000", recipient: MERCHANT_EVM, chain: "eip155:42161" },
      price_snapshot: { par: true, fx: null },
      intents_requirement: null,
    });
    const tag = BigInt(x.settlement.tag);
    expect(tag >= 1n && tag <= 9_999n).toBe(true);
    expect(x.settlement.expected).toBe((20_000_000n + tag).toString());
    expect(x.deposit?.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(x.deposit?.chain).toBe("eip155:8453");
    expect(Date.parse(x.deadline) - Date.now()).toBeGreaterThan(1_700_000);

    const id = toUuid(x.id, "ex");
    const row = await s.admin.db.selectFrom("executions").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
    // what the sandbox was asked: EXACT_OUTPUT of base + tag, appFees to the treasury, the scenario amount
    expect(row.quote_request).toMatchObject({
      swapType: "EXACT_OUTPUT",
      amount: x.settlement.expected,
      recipient: MERCHANT_EVM,
      recipientType: "DESTINATION_CHAIN",
      appFees: [{ recipient: TREASURY, fee: 20 }],
      referral: "nearpay",
    });
    // …and what it answered, stored verbatim: the split, with live 1Click's limitOrderId: null on each item
    const answered = row.quote_response as {
      quoteRequest: { appFees: unknown; deadline: string };
      quote: { deadline: string; timeWhenInactive: string };
    };
    expect(answered.quoteRequest.appFees).toEqual([
      { limitOrderId: null, recipient: TREASURY, fee: 10 },
      { limitOrderId: null, recipient: "sandbox-oneclick-fees.near", fee: 10 },
    ]);
    // two deadlines, as live: the payer's is the requested one; the address stays active 3 days longer
    expect(x.deadline).toBe(answered.quoteRequest.deadline);
    expect(Date.parse(answered.quote.deadline) - Date.parse(x.deadline)).toBe(3 * 86_400_000);
    expect(row.time_when_inactive?.toISOString()).toBe(answered.quote.timeWhenInactive);
    const tags = await s.admin.db.selectFrom("amount_tags").selectAll().where("execution_id", "=", id).execute();
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ tag: tag.toString(), released_at: null });
    const obs = await s.admin.db
      .selectFrom("provider_observations")
      .selectAll()
      .where("execution_id", "=", id)
      .execute();
    expect(obs.map((o) => [o.source, o.applied])).toEqual([["quote", true]]);
    const tr = await s.admin.db
      .selectFrom("execution_transitions")
      .selectAll()
      .where("execution_id", "=", id)
      .execute();
    expect(tr.map((t) => [t.from_state, t.to_state, t.actor])).toEqual([[null, "awaiting_deposit", "api"]]);
    const out = await s.admin.db.selectFrom("outbox").selectAll().where("aggregate_id", "=", id).execute();
    expect(out.map((e) => [e.subject, e.aggregate_version])).toEqual([["evt.rails.execution.updated", 1]]);
  });

  it("is idempotent on the idempotency key (same account and mode only)", async () => {
    const b = routeQuote();
    const a = Execution.parse((await create(b)).body);
    const again = await create(b);
    expect(again.status).toBe(201);
    expect(Execution.parse(again.body)).toEqual(a);
    const other = await create({ ...b, account_id: "acct_01jbz9k3m4n5p6q7r8s9t0v1w2" });
    expect([other.status, error(other).code]).toEqual([409, "idempotency_key_reused"]);
    const n = await s.admin.db
      .selectFrom("executions")
      .select(sql<string>`count(*)`.as("n"))
      .where("idempotency_key", "=", b.idempotency_key)
      .executeTakeFirstOrThrow();
    expect(Number(n.n)).toBe(1);
  });

  it("merchant-bearer settlement is net of the fee; stable pairs pay 50 bps", async () => {
    const x = Execution.parse(
      (
        await create(
          routeQuote({
            fee: { bearer: "merchant" },
            destination: {
              asset_id: "nep141:usdt.tether-token.near",
              type: "intents_account",
              chain: "near:mainnet",
              address: "merchant.near",
            },
          }),
        )
      ).body,
    );
    expect(x.route_class).toBe("stable_pair");
    expect(x.applied_fee_bps).toBe(50);
    expect(x.settlement.amount_base).toBe("19900000");
    expect(x.settlement.recipient_type).toBe("intents");
  });

  it("allocates distinct expected amounts to concurrent payments to one destination", async () => {
    const dest = randomEvm();
    const rs = await Promise.all(
      Array.from({ length: 12 }, () => create(routeQuote({ destination: { address: dest } }))),
    );
    expect(rs.every((r) => r.status === 201)).toBe(true);
    const expected = rs.map((r) => Execution.parse(r.body).settlement.expected);
    expect(new Set(expected).size).toBe(12);
  });

  it.each([
    [
      "an unknown origin asset",
      { origin: { asset_id: "nep141:nope.near" } },
      400,
      "asset_unsupported",
      "origin.asset_id",
    ],
    ["a chain that is not the asset's", { origin: { chain: "eip155:1" } }, 400, "invalid_request", "origin.chain"],
    ["an invalid refund address", { origin: { refund_to: "0x123" } }, 400, "invalid_request", "origin.refund_to"],
    ["an invalid destination", { destination: { address: "nope" } }, 400, "invalid_request", "destination.address"],
    // Stage 2: non-par settlement and EUR pricing work (stage2-sandbox.test.ts); unaccepted currencies are refused
    [
      "a currency outside NP_PRICING_CURRENCIES",
      { pricing: { currency: "sek", amount: 2000 } },
      400,
      "currency_unsupported",
      undefined,
    ],
    [
      "a session ending too soon",
      { deadline_cap: new Date(Date.now() + 120_000).toISOString() },
      422,
      "deadline_too_short",
      undefined,
    ],
  ])("refuses %s", async (_what, over, status, code, param) => {
    const r = await create(routeQuote(over as never));
    expect([r.status, error(r).code]).toEqual([status, code]);
    if (param) expect(error(r).param).toBe(param);
  });

  it("refuses a refund address compliance blocks, and fails closed above USD 1,000 when it is down", async () => {
    s.compliance.on(
      createScreening,
      async () =>
        ({
          screening_id: "scr_01jbz9k3m4n5p6q7r8s9t0v1w2",
          decision: "block",
          risk: "severe",
          reasons: ["sanctions"],
          cached: false,
          post_screen_required: false,
        }) as never,
    );
    const blocked = await create(routeQuote());
    expect([blocked.status, error(blocked).code, error(blocked).param]).toEqual([
      402,
      "screening_blocked",
      "origin.refund_to",
    ]);
    s.compliance.on(createScreening, () => mockError("screening_unavailable"));
    const big = await create(routeQuote({ pricing: { currency: "usd", amount: 100_000 } }));
    expect([big.status, error(big).code]).toEqual([503, "screening_unavailable"]);
    const small = await create(routeQuote({ pricing: { currency: "usd", amount: 99_900 } }));
    expect(small.status).toBe(201);
    s.compliance.on(createScreening, async (ctx) => ({
      screening_id: "scr_01jbz9k3m4n5p6q7r8s9t0v1w2" as const,
      decision: "allow" as const,
      risk: null,
      reasons: [],
      cached: false,
      post_screen_required: false,
      ...(ctx.body.subject ? {} : {}),
    }));
    const calls = s.compliance.callsTo(createScreening);
    expect(calls.at(-1)?.body).toMatchObject({
      subject_type: "address",
      chain: "eip155:8453",
      context: "payment",
      livemode: false,
      amount_usd_micros: 999_000_000,
    });
  });

  it("maps a provider rejection to quote_rejected and releases the tag", async () => {
    // a registry token the sandbox does not know: the sandbox answers 400
    await s.admin.db
      .insertInto("tokens")
      .values({
        livemode: false,
        asset_id: "nep141:fake-usdc.near",
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
        refreshed_at: new Date(Date.now() + 3_600_000),
        contract_address: "fake-usdc.near",
      })
      .execute();
    const r = await create(
      routeQuote({
        destination: {
          asset_id: "nep141:fake-usdc.near",
          type: "intents_account",
          chain: "near:mainnet",
          address: "m.near",
        },
      }),
    );
    expect([r.status, error(r).code]).toEqual([422, "quote_rejected"]);
    expect((r.body as { error: { message: string } }).error.message).toMatch(/not supported by the sandbox/);
    const live = await s.admin.db
      .selectFrom("amount_tags")
      .selectAll()
      .where("destination_key", "=", "near:mainnet|m.near|nep141:fake-usdc.near")
      .where("released_at", "is", null)
      .execute();
    expect(live).toEqual([]);
  });

  it("live mode is refused until the owner configures the treasury; the kill switch stops live quotes", async () => {
    const live = await create(routeQuote({ livemode: true }));
    expect([live.status, error(live).code]).toEqual([503, "rail_unavailable"]);
    expect((live.body as { error: { message: string } }).error.message).toMatch(/not configured/);
    await s.admin.db
      .updateTable("control_flags")
      .set({ value: false })
      .where("name", "=", "cross_chain_enabled")
      .execute();
    const paused = await create(routeQuote());
    expect([paused.status, error(paused).code]).toEqual([503, "rail_unavailable"]);
    // Intents transfers keep working while cross-chain routes are paused (RB-01)
    const it = await create(intentsTransfer("payer.near", "merchant.near"));
    expect(it.status).toBe(201);
    await s.admin.db
      .updateTable("control_flags")
      .set({ value: true })
      .where("name", "=", "cross_chain_enabled")
      .execute();
  });
});

describe("intents_transfer (§8.1)", () => {
  it("issues a requirement with the binding, the fee (minimum applied) and no tag", async () => {
    const r = await create(
      intentsTransfer("payer.near", "Merchant.near".toLowerCase(), { pricing: { currency: "usd", amount: 1 } }),
    );
    expect(r.status).toBe(201);
    const x = Execution.parse(r.body);
    expect(x).toMatchObject({
      method: "intents_transfer",
      provider: "direct_intents",
      route_class: "intents_transfer",
      applied_fee_bps: 30,
      deposit: null,
      settlement: {
        amount_base: "10000",
        tag: "0",
        expected: "10000",
        recipient: "merchant.near",
        recipient_type: "intents",
      },
    });
    expect(x.intents_requirement).toMatchObject({
      pay_to: "merchant.near",
      token: USDC_NEAR,
      amount: "10000",
      fee_to: TREASURY,
      fee_amount: "1000",
    });
    expect(x.intents_requirement?.binding).toMatch(/^np1:/);
    expect(x.intents_requirement?.deadline).toBe(x.deadline);
  });

  it("needs an Intents destination in the paying asset", async () => {
    const r = await create(
      intentsTransfer("payer.near", "merchant.near", { destination: { asset_id: USDT_FOR_TEST } }),
    );
    expect([r.status, error(r).code]).toEqual([422, "route_unavailable"]);
  });
});
const USDT_FOR_TEST = "nep141:usdt.tether-token.near";

describe("payer inputs", () => {
  it("a deposit tx moves the execution to deposit_detected, is idempotent, and forwards to the provider", async () => {
    const x = Execution.parse((await create(routeQuote())).body);
    const tx = { tx_hash: `0x${"ab".repeat(32)}` };
    const r = await s.call("POST", `/internal/executions/${x.id}/deposit_tx`, { body: tx });
    expect(r.status).toBe(202);
    expect((await s.call("POST", `/internal/executions/${x.id}/deposit_tx`, { body: tx })).status).toBe(202);
    const after = Execution.parse((await s.call("GET", `/internal/executions/${x.id}`)).body);
    expect(after).toMatchObject({ state: "deposit_detected", version: 2, deposit_tx_hashes: [tx.tx_hash] });
    const row = await s.admin.db
      .selectFrom("executions")
      .selectAll()
      .where("id", "=", toUuid(x.id, "ex"))
      .executeTakeFirstOrThrow();
    expect([row.has_signal, row.priority]).toEqual([true, 1]);
  });

  it("a signal raises priority without a version change; terminal executions refuse deposits", async () => {
    const x = Execution.parse((await create(routeQuote())).body);
    expect(
      (await s.call("POST", `/internal/executions/${x.id}/signals`, { body: { type: "payer_sent" } })).status,
    ).toBe(202);
    const row = await s.admin.db
      .selectFrom("executions")
      .selectAll()
      .where("id", "=", toUuid(x.id, "ex"))
      .executeTakeFirstOrThrow();
    expect([row.has_signal, row.priority, row.version]).toEqual([true, 2, 1]);
    await s.admin.db
      .updateTable("executions")
      .set({ state: "failed", terminal_at: new Date() })
      .where("id", "=", row.id)
      .execute();
    const r = await s.call("POST", `/internal/executions/${x.id}/deposit_tx`, {
      body: { tx_hash: `0x${"cd".repeat(32)}` },
    });
    expect([r.status, error(r).code]).toEqual([409, "state_conflict"]);
    expect((await s.call("GET", "/internal/executions/ex_01jbz9k3m4n5p6q7r8s9t0v1w2")).status).toBe(404);
  });
});

describe("reads", () => {
  it("assets: internal view with price state; public list", async () => {
    const a = await s.call("GET", `/internal/assets/${USDC_BASE}?livemode=false`);
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({
      asset_id: USDC_BASE,
      chain: "eip155:8453",
      blockchain: "base",
      decimals: 6,
      family: "USDC",
      is_usd_stable: true,
      price_usd: "1",
      price_ok: true,
    });
    expect((await s.call("GET", `/internal/assets/${USDC_BASE}`)).status).toBe(200); // falls back to test
    const missing = await s.call("GET", "/internal/assets/nep141:nope.near");
    expect([missing.status, error(missing).code]).toEqual([400, "asset_unsupported"]);
    const pub = await s.call("GET", "/v1/assets", { token: null });
    expect(pub.status).toBe(200);
    const list = pub.body as { object: string; data: { asset_id: string; object: string }[]; url: string };
    expect(list.object).toBe("list");
    expect(list.data.map((d) => d.asset_id)).toContain(USDC_NEAR);
    expect(list.data.every((d) => d.object === "asset")).toBe(true);
  });

  it("chain profiles", async () => {
    const r = await s.call("GET", "/internal/chain-profiles", { service: "identity" });
    expect(r.status).toBe(200);
    const p = (r.body as { profiles: { chain: string; tier: string }[] }).profiles;
    expect(p.find((x) => x.chain === "near:mainnet")).toMatchObject({ tier: "A", min_deadline_s: 120 });
  });

  it("options: indicative route quotes plus the Intents transfer for Intents destinations", async () => {
    const r = await s.call(
      "GET",
      `/internal/options?destination_asset=${USDC_NEAR}&destination_type=intents_account&amount_out=20000000&livemode=false`,
    );
    expect(r.status).toBe(200);
    const opts = (
      r.body as {
        options: {
          method: string;
          origin_asset_id: string;
          route_class: string;
          available: boolean;
          estimated_amount_in: string | null;
        }[];
      }
    ).options;
    expect(opts[0]).toMatchObject({
      method: "intents_transfer",
      origin_asset_id: USDC_NEAR,
      available: true,
      estimated_amount_in: "20060000",
    });
    expect(opts.find((o) => o.origin_asset_id === USDC_BASE)).toMatchObject({
      route_class: "same_asset",
      available: true,
    });
    const eth = opts.find((o) => o.origin_asset_id === ETH_BASE);
    expect(eth?.route_class).toBe("volatile");
    expect(BigInt(eth?.estimated_amount_in ?? "0")).toBeGreaterThan(8_000_000_000_000_000n); // ≈ USD 20 at 2,500
    const evmOnly = await s.call(
      "GET",
      `/internal/options?destination_asset=${USDC_NEAR}&destination_type=chain_address&amount_out=1&wallet=${MERCHANT_EVM}&livemode=false`,
    );
    const chains = new Set((evmOnly.body as { options: { chain: string }[] }).options.map((o) => o.chain));
    // an EVM wallet pays on EVM chains, and on NEAR through its eth-implicit account (NEP-518)
    expect([...chains].every((c) => c.startsWith("eip155:") || c === "near:mainnet")).toBe(true);
    expect(chains.has("eip155:8453")).toBe(true);
  });

  it("deposit lookup tells genuine from unknown deposit addresses", async () => {
    const x = Execution.parse((await create(routeQuote())).body);
    const r = await s.call("GET", `/internal/executions?deposit_address=${x.deposit?.address}`, {
      service: "sentinel",
    });
    expect(r.body).toEqual({ exists: true, execution_id: x.id, account_id: ACCOUNT, livemode: false });
    const none = await s.call("GET", `/internal/executions?deposit_address=${randomEvm()}`, { service: "sentinel" });
    expect(none.body).toEqual({ exists: false, execution_id: null, account_id: null, livemode: null });
  });

  it("minimums from the sandbox's dry quote: max(USD 1, 20 × withdraw fee); Intents USD 0.01", async () => {
    const arbKey = `eip155:42161|${MERCHANT_EVM}|${USDC_ARB}`;
    const intentsKey = `near:mainnet|merchant.near|${USDC_NEAR}`;
    for (const [chain, address, asset, type] of [
      ["eip155:42161", MERCHANT_EVM, USDC_ARB, "chain_address"],
      ["near:mainnet", "merchant.near", USDC_NEAR, "intents_account"],
    ] as const)
      await s.admin.db
        .insertInto("watched_destinations")
        .values({
          destination_id: crypto.randomUUID(),
          account_id: toUuid(ACCOUNT, "acct"),
          livemode: false,
          chain,
          address_norm: address,
          asset_id: asset,
          type,
          active: true,
          source_version: 1,
        })
        .execute();
    const { refreshMinimums } = await import("../../src/app/minimums.js");
    expect(await refreshMinimums(s.rails)).toBe(2);
    const r = await s.call(
      "GET",
      `/internal/destination-minimums?keys=${encodeURIComponent(`${arbKey},${intentsKey},near:mainnet|x.near|${USDC_NEAR},junk`)}`,
      { service: "identity" },
    );
    expect(r.status).toBe(200);
    const m = r.body as Record<
      string,
      { min_amount_base: string | null; min_usd_micros: number | null; computed_at: string | null }
    >;
    // sandbox withdraw fee on Arbitrum is USD 0.02 → 20 × 0.02 = USD 0.40 < USD 1.00
    expect(m[arbKey]).toMatchObject({ min_amount_base: "1000000", min_usd_micros: 1_000_000 });
    expect(m[intentsKey]).toMatchObject({ min_amount_base: "10000", min_usd_micros: 10_000 });
    expect(m[`near:mainnet|x.near|${USDC_NEAR}`]).toEqual({
      min_amount_base: null,
      min_usd_micros: null,
      computed_at: null,
    });
    expect(m.junk?.computed_at).toBeNull();
  });

  it("evidence lists settled executions of a UTC day, paginated", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const x = Execution.parse((await create(routeQuote())).body);
      ids.push(x.id);
      await s.admin.db
        .updateTable("executions")
        .set({ state: "succeeded", terminal_at: new Date("2026-11-04T12:00:00Z") })
        .where("id", "=", toUuid(x.id, "ex"))
        .execute();
    }
    const q = `account_id=${ACCOUNT}&livemode=false&day=2026-11-04&limit=2`;
    const p1 = (await s.call("GET", `/internal/evidence?${q}`)).body as { data: { id: string }[]; has_more: boolean };
    expect([p1.data.length, p1.has_more]).toEqual([2, true]);
    const p2 = (await s.call("GET", `/internal/evidence?${q}&starting_after=${p1.data[1]?.id}`)).body as {
      data: { id: string }[];
      has_more: boolean;
    };
    expect([p2.data.length, p2.has_more]).toEqual([1, false]);
    expect([...p1.data, ...p2.data].map((d) => d.id).sort()).toEqual(ids.sort());
  });

  it("scopes are enforced from the spec", async () => {
    const r = await s.call("POST", "/internal/executions", { body: routeQuote(), service: "sentinel" });
    expect(r.status).toBe(403);
    expect((await s.call("GET", "/internal/chain-profiles", { token: null })).status).toBe(401);
  });
});
