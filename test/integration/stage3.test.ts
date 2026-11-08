/**
 * Stage 3 (lld/rails.md §20, spec 0.3.0) against the real nearpay-sandbox image: executions owned by agentpay
 * (cross-chain x402 `near-intents`), ownership enforced by caller identity, `Evidence.sender` for Intents
 * recipients, `listEvidence?owner`, events carrying the owner.
 */
import { randomBytes } from "node:crypto";
import { sql } from "@nearpay-internal/db";
import { newId, toUuid } from "@nearpay-internal/ids";
import { EventEnvelope, Execution } from "@nearpay-internal/spec";
import bs58 from "bs58";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACCOUNT, FEE_SCHEDULE, intentsTransfer, randomEvm, routeQuote } from "../support/requests.js";
import { PAYER, type Stack, startStack, USDC_ARB, USDC_BASE, USDC_NEAR } from "../support/stack.js";

let s: Stack;
beforeAll(async () => {
  s = await startStack({ sandbox: true, tracker: true, feeds: true });
  for (let i = 0; i < 100; i++) {
    const n = await s.admin.db.selectFrom("tokens").select("asset_id").where("livemode", "=", false).execute();
    if (n.length > 5) break;
    await new Promise((r) => setTimeout(r, 100));
  }
});
afterAll(async () => {
  await s?.stop();
});

type Who = "payments" | "agentpay" | "sentinel";
const newBinding = () => `np1:${bs58.encode(randomBytes(32))}`;

/** What agentpay sends for a quoted near-intents requirement (agentpay §3.1 step 2). */
function x402(merchant: string, over: Record<string, unknown> = {}) {
  const binding = newBinding();
  return {
    idempotency_key: `x402:${binding}`,
    owner: "agentpay",
    x402_binding: binding,
    kind: "payment",
    method: "route_quote",
    account_id: ACCOUNT,
    livemode: false,
    origin: { asset_id: USDC_BASE, chain: "eip155:8453", refund_to: PAYER, refund_type: "origin_chain" },
    destination: { asset_id: USDC_NEAR, type: "intents_account", chain: "near:mainnet", address: merchant },
    pricing: { currency: "asset", asset_id: USDC_NEAR, amount: "1000000" },
    fee: { schedule: FEE_SCHEDULE, bearer: "payer" },
    deadline_cap: new Date(Date.now() + 1_800_000).toISOString(),
    slippage_bps: 50,
    ...over,
  };
}

const post = (path: string, body: unknown, service: Who = "payments") => s.call("POST", path, { body, service });
const get = (path: string, service: Who = "payments") => s.call("GET", path, { service });
const code = (r: { body: unknown }) => (r.body as { error?: { code: string; param?: string } }).error;
const created = (r: { status: number; body: unknown }) => {
  expect(r.status).toBe(201);
  return Execution.parse(r.body);
};
async function until(id: string, pred: (x: Execution) => boolean, ms = 30_000): Promise<Execution> {
  const end = Date.now() + ms;
  for (;;) {
    const x = Execution.parse((await get(`/internal/executions/${id}`)).body);
    if (pred(x)) return x;
    if (Date.now() > end) throw new Error(`execution ${id} stuck in ${x.state} (${x.provider_status})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("createExecution owner agentpay", () => {
  it("quotes an x402 near-intents execution owned by agentpay; replays return it", async () => {
    const merchant = `x402m${Date.now()}.near`;
    const b = x402(merchant);
    const x = created(await post("/internal/executions", b, "agentpay"));
    expect(x).toMatchObject({
      owner: "agentpay",
      x402_binding: b.x402_binding,
      reference: null,
      kind: "payment",
      method: "route_quote",
      provider: "sandbox",
      state: "awaiting_deposit",
      settlement: { asset_id: USDC_NEAR, amount_base: "1000000", recipient: merchant, recipient_type: "intents" },
    });
    // the merchant may receive amount + tag (§20); the payer bears the fee
    expect(BigInt(x.settlement.expected)).toBeGreaterThanOrEqual(1_000_000n);
    expect(x.deposit?.address).toMatch(/^0x[0-9a-f]{40}$/);
    const row = await s.admin.db
      .selectFrom("executions")
      .select(["owner", "x402_binding", "quote_request"])
      .where("id", "=", toUuid(x.id, "ex"))
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ owner: "agentpay", x402_binding: b.x402_binding });
    expect(row.quote_request).toMatchObject({
      swapType: "EXACT_OUTPUT",
      recipientType: "INTENTS",
      slippageTolerance: 50,
    });
    // replay: same execution
    const again = created(await post("/internal/executions", b, "agentpay"));
    expect(again.id).toBe(x.id);
    // the binding's key cannot be replayed by payments
    const stolen = await post("/internal/executions", { ...routeQuote(), idempotency_key: b.idempotency_key });
    expect(stolen.status).toBe(400);
    expect(code(stolen)?.param).toBe("idempotency_key");
  });

  it("the owner is the calling service: agentpay cannot create payments executions, nor payments agentpay ones", async () => {
    const asAgentpay = await post("/internal/executions", routeQuote(), "agentpay");
    expect(asAgentpay.status).toBe(403);
    expect(code(asAgentpay)?.code).toBe("permission_denied");
    const { owner: _o, ...noOwner } = x402("nobody.near");
    expect((await post("/internal/executions", noOwner, "agentpay")).status).toBe(403);
    expect((await post("/internal/executions", x402("nobody.near"), "payments")).status).toBe(403);
    expect((await post("/internal/executions", routeQuote({}), "sentinel")).status).toBe(403);
    const n = await s.admin.db
      .selectFrom("executions")
      .select(sql<string>`count(*)`.as("n"))
      .where("destination_key", "like", "%nobody.near%")
      .executeTakeFirstOrThrow();
    expect(Number(n.n)).toBe(0);
  });

  it("refuses an agentpay execution of another shape (400, param named)", async () => {
    const shape = async (over: Record<string, unknown>, param: string) => {
      const r = await post("/internal/executions", x402("shape.near", over), "agentpay");
      expect(r.status).toBe(400);
      expect(code(r)?.param).toBe(param);
    };
    await shape({ fee: { schedule: FEE_SCHEDULE, bearer: "merchant" } }, "fee.bearer");
    await shape({ pricing: { currency: "usd", amount: 100 } }, "pricing");
    await shape(
      { destination: { asset_id: USDC_NEAR, type: "chain_address", chain: "near:mainnet", address: "m.near" } },
      "destination.type",
    );
    await shape({ idempotency_key: "attempt:pa_x" }, "idempotency_key");
    await shape({ reference: { payment_intent: newId("pi"), payment_attempt: newId("pa") } }, "reference");
    // payments may not set the x402 fields
    const r = await post("/internal/executions", { ...routeQuote(), x402_binding: newBinding() });
    expect(r.status).toBe(400);
    expect(code(r)?.param).toBe("x402_binding");
  });

  it("refund legs and abandoning them stay payments'", async () => {
    const re = newId("re");
    const leg = {
      idempotency_key: `refund:${re}:leg:1`,
      account_id: ACCOUNT,
      livemode: false,
      method: "route_quote",
      reference: { payment_intent: newId("pi"), payment_attempt: newId("pa"), refund: re, refund_leg: 1 },
      source: { asset_id: USDC_BASE, type: "chain_address", chain: "eip155:8453", address: randomEvm() },
      recipient: { asset_id: USDC_ARB, chain: "eip155:42161", address: randomEvm(), type: "origin_chain" },
      amount: "7000000",
      swap_type: "EXACT_INPUT",
    };
    const refused = await post("/internal/refund_executions", leg, "agentpay");
    expect(refused.status).toBe(403);
    expect(code(refused)?.code).toBe("permission_denied");
    const r = created(await post("/internal/refund_executions", leg));
    const abandon = await post(`/internal/executions/${r.id}/abandon`, { reason: "superseded" }, "agentpay");
    expect(abandon.status).toBe(403);
    expect(Execution.parse((await get(`/internal/executions/${r.id}`)).body).abandoned_at).toBeNull();
  });
});

describe("reads and writes by owner", () => {
  it("agentpay reads its own and the payments executions it relays; payments' route executions are invisible", async () => {
    const mine = created(await post("/internal/executions", x402(`own${Date.now()}.near`), "agentpay"));
    const theirs = created(await post("/internal/executions", routeQuote({ destination: { address: randomEvm() } })));
    const relay = created(await post("/internal/executions", intentsTransfer("payer.near", `relay${Date.now()}.near`)));

    expect((await get(`/internal/executions/${mine.id}`, "agentpay")).status).toBe(200);
    expect((await get(`/internal/executions/${relay.id}`, "agentpay")).status).toBe(200);
    const hidden = await get(`/internal/executions/${theirs.id}`, "agentpay");
    expect(hidden.status).toBe(404);
    expect(code(hidden)?.code).toBe("resource_missing");
    expect((await get(`/internal/executions/${theirs.id}/observations`, "agentpay")).status).toBe(404);
    // other services read everything
    expect((await get(`/internal/executions/${mine.id}`, "payments")).status).toBe(200);
    expect((await get(`/internal/executions/${mine.id}`, "sentinel")).status).toBe(200);

    // deposit lookup: agentpay sees only its own deposit addresses
    const look = (x: Execution, who: Who) =>
      get(`/internal/executions?deposit_address=${encodeURIComponent(x.deposit?.address ?? "")}`, who);
    expect(((await look(theirs, "agentpay")).body as { exists: boolean }).exists).toBe(false);
    expect(((await look(mine, "agentpay")).body as { exists: boolean }).exists).toBe(true);
    expect(((await look(theirs, "sentinel")).body as { exists: boolean }).exists).toBe(true);
  });

  it("only the owner submits deposit txs and signals", async () => {
    const mine = created(await post("/internal/executions", x402(`dep${Date.now()}.near`), "agentpay"));
    const theirs = created(await post("/internal/executions", routeQuote({ destination: { address: randomEvm() } })));
    const tx = `0x${randomBytes(32).toString("hex")}`;
    expect((await post(`/internal/executions/${theirs.id}/deposit_tx`, { tx_hash: tx }, "agentpay")).status).toBe(404);
    expect((await post(`/internal/executions/${mine.id}/deposit_tx`, { tx_hash: tx }, "payments")).status).toBe(404);
    expect((await post(`/internal/executions/${theirs.id}/signals`, { type: "payer_sent" }, "agentpay")).status).toBe(
      404,
    );
    expect((await post(`/internal/executions/${mine.id}/deposit_tx`, { tx_hash: tx }, "agentpay")).status).toBe(202);
    // idempotent repeat
    expect((await post(`/internal/executions/${mine.id}/deposit_tx`, { tx_hash: tx }, "agentpay")).status).toBe(202);
    const after = Execution.parse((await get(`/internal/executions/${mine.id}`, "agentpay")).body);
    expect(after.deposit_tx_hashes).toEqual([tx]);
    const untouched = Execution.parse((await get(`/internal/executions/${theirs.id}`)).body);
    expect(untouched.deposit_tx_hashes).toEqual([]);
  });
});

describe("settlement of an agentpay execution", () => {
  it("settles on Intents evidence naming the sender; events carry owner and binding; listEvidence filters by owner", async () => {
    const probe = await s.probe();
    const merchant = `paid${Date.now()}.near`;
    const b = x402(merchant);
    const x = created(await post("/internal/executions", b, "agentpay"));
    const paid = created(await post("/internal/executions", routeQuote({ destination: { address: randomEvm() } })));
    for (const e of [x, paid]) {
      expect((await s.sandbox?.call("POST", "/sim/deposits", { deposit_address: e.deposit?.address }))?.status).toBe(
        202,
      );
    }
    expect((await post(`/internal/executions/${x.id}/signals`, { type: "payer_sent" }, "agentpay")).status).toBe(202);
    expect((await post(`/internal/executions/${paid.id}/signals`, { type: "payer_sent" })).status).toBe(202);
    const done = await until(x.id, (e) => e.state === "succeeded");
    await until(paid.id, (e) => e.state === "succeeded");
    expect(done.evidence).toMatchObject({ chain: "near:mainnet", recipient: merchant, asset_id: USDC_NEAR });
    // agentpay records evidence.sender as the payer: rails MUST set it for Intents recipients (§20)
    expect(done.evidence?.sender).toEqual(expect.any(String));
    expect(done.settled_amount).toBe(x.settlement.expected);

    const settled = await probe.next("evt.rails.execution.settled", (e) => e.aggregate.id === x.id, 15_000);
    EventEnvelope.parse(settled);
    const obj = Execution.parse(settled.data.object);
    expect(obj).toMatchObject({ owner: "agentpay", x402_binding: b.x402_binding });
    expect(obj.evidence?.sender).toBe(done.evidence?.sender);
    const other = await probe.next("evt.rails.execution.settled", (e) => e.aggregate.id === paid.id, 15_000);
    expect(Execution.parse(other.data.object).owner).toBe("payments");
    await probe.close();

    const day = new Date().toISOString().slice(0, 10);
    const ids = async (q: string, who: Who = "payments") => {
      const r = await get(`/internal/evidence?account_id=${ACCOUNT}&livemode=false&day=${day}&limit=1000${q}`, who);
      expect(r.status).toBe(200);
      return (r.body as { data: Execution[] }).data.map((e) => e.id);
    };
    expect(await ids("")).toEqual(expect.arrayContaining([x.id, paid.id]));
    const payments = await ids("&owner=payments");
    expect(payments).toContain(paid.id);
    expect(payments).not.toContain(x.id);
    const agentpay = await ids("&owner=agentpay");
    expect(agentpay).toContain(x.id);
    expect(agentpay).not.toContain(paid.id);
    // agentpay is narrowed to its own executions and may not read payments' evidence
    expect(await ids("", "agentpay")).not.toContain(paid.id);
    expect(
      (await get(`/internal/evidence?account_id=${ACCOUNT}&livemode=false&day=${day}&owner=payments`, "agentpay"))
        .status,
    ).toBe(403);
  });
});

describe("evidence summary ?owner= (spec 0.3.1)", () => {
  it("filters totals, tier_b, digest, in_flight and held_open by owner; complete stays account-wide; agentpay is narrowed", async () => {
    const merchant = `sum${Date.now()}.near`;
    const x = created(await post("/internal/executions", x402(merchant), "agentpay"));
    const paid = created(await post("/internal/executions", routeQuote({ destination: { address: randomEvm() } })));
    // open executions of both owners (counted by in_flight until they end)
    created(await post("/internal/executions", x402(`open${Date.now()}.near`), "agentpay"));
    created(await post("/internal/executions", routeQuote({ destination: { address: randomEvm() } })));
    for (const e of [x, paid]) {
      expect((await s.sandbox?.call("POST", "/sim/deposits", { deposit_address: e.deposit?.address }))?.status).toBe(
        202,
      );
    }
    expect((await post(`/internal/executions/${x.id}/signals`, { type: "payer_sent" }, "agentpay")).status).toBe(202);
    expect((await post(`/internal/executions/${paid.id}/signals`, { type: "payer_sent" })).status).toBe(202);
    await until(x.id, (e) => e.state === "succeeded");
    const chainPaid = await until(paid.id, (e) => e.state === "succeeded");
    // sandbox verifier evidence names the simulated sender (SimTx.transfers[].from, spec 0.3.1)
    expect(chainPaid.evidence).toMatchObject({ tier: "A", sender: expect.any(String) });

    const day = new Date().toISOString().slice(0, 10);
    type Summary = {
      complete: boolean;
      in_flight: number;
      held_open: number;
      totals: { kind: string; state: string; asset_id: string; count: number; settled_amount: string }[];
      tier_b: { count: number };
      digest: string;
    };
    const summary = async (q: string, who: Who = "payments") => {
      const r = await get(`/internal/evidence/summary?account_id=${ACCOUNT}&livemode=false&day=${day}${q}`, who);
      expect(r.status).toBe(200);
      return r.body as Summary;
    };
    const count = (s: Summary) => s.totals.reduce((n, t) => n + t.count, 0);
    const listed = async (q: string) => {
      const r = await get(`/internal/evidence?account_id=${ACCOUNT}&livemode=false&day=${day}&limit=1000${q}`);
      return (r.body as { data: Execution[] }).data.length;
    };
    const [all, pay, agent, agentDefault] = await Promise.all([
      summary(""),
      summary("&owner=payments"),
      summary("&owner=agentpay"),
      summary("", "agentpay"),
    ]);
    expect(count(pay)).toBe(await listed("&owner=payments"));
    expect(count(agent)).toBe(await listed("&owner=agentpay"));
    expect(count(all)).toBe(count(pay) + count(agent));
    expect(count(agent)).toBeGreaterThanOrEqual(1);
    expect(count(pay)).toBeGreaterThanOrEqual(1);
    expect(all.in_flight).toBe(pay.in_flight + agent.in_flight);
    expect(all.held_open).toBe(pay.held_open + agent.held_open);
    expect(agent.in_flight).toBeGreaterThanOrEqual(1);
    expect(pay.in_flight).toBeGreaterThanOrEqual(1);
    expect(all.tier_b.count).toBe(pay.tier_b.count + agent.tier_b.count);
    expect(new Set([all.digest, pay.digest, agent.digest]).size).toBe(3);
    expect(pay.complete).toBe(all.complete);
    expect(agent.complete).toBe(all.complete);
    // agentpay without owner is narrowed to its own executions; owner=payments is refused
    expect({ ...agentDefault, generated_at: null }).toEqual({ ...agent, generated_at: null });
    expect(
      (
        await get(
          `/internal/evidence/summary?account_id=${ACCOUNT}&livemode=false&day=${day}&owner=payments`,
          "agentpay",
        )
      ).status,
    ).toBe(403);
    expect(
      (await get(`/internal/evidence/summary?account_id=${ACCOUNT}&livemode=false&day=${day}&owner=nobody`)).status,
    ).toBe(400);
  });
});

describe("migration 0004", () => {
  it("an agentpay execution always has its binding, a payments one never; one quote per binding", async () => {
    const x = created(await post("/internal/executions", routeQuote({ destination: { address: randomEvm() } })));
    const id = toUuid(x.id, "ex");
    await expect(
      s.admin.db.updateTable("executions").set({ owner: "agentpay" }).where("id", "=", id).execute(),
    ).rejects.toThrow(/ex_x402_binding_owner/);
    await expect(
      s.admin.db.updateTable("executions").set({ x402_binding: newBinding() }).where("id", "=", id).execute(),
    ).rejects.toThrow(/ex_x402_binding_owner/);
    const legacy = await s.admin.db
      .selectFrom("executions")
      .select(sql<string>`count(*)`.as("n"))
      .where("owner", "is", null)
      .executeTakeFirstOrThrow();
    expect(Number(legacy.n)).toBe(0);
  });
});
