/**
 * Test mode end to end against the real nearpay-sandbox image: the hot poller applies the sandbox's
 * 1Click timelines, the verifier checks the simulated destination chain, the sandbox feed attributes
 * Intents transfers by binding and tag, consumers keep the watch-list and kill switch, and the outbox
 * relay publishes `evt.rails.execution.*` (lld/rails.md §5, §7–§9).
 */

import type { IntentMessage } from "@nearpay/spec";
import { sql } from "@nearpay-internal/db";
import { toUuid } from "@nearpay-internal/ids";
import {
  buildPayload,
  buildTransferIntents,
  implicitAccountId,
  makeNonce,
  signNep413,
} from "@nearpay-internal/intents";
import { EventEnvelope, Execution } from "@nearpay-internal/spec";
import { domainEvent, internalSettlementDestination } from "@nearpay-internal/testing";
import { ed25519 } from "@noble/curves/ed25519.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { intentsTransfer, randomEvm, routeQuote, toIntents } from "../support/requests.js";
import { type Stack, startStack, USDC_ARB, USDC_NEAR } from "../support/stack.js";

let s: Stack;
beforeAll(async () => {
  s = await startStack({ sandbox: true, tracker: true, feeds: true });
  // the feeds' token refresh fills the test registry
  for (let i = 0; i < 100; i++) {
    const n = await s.admin.db.selectFrom("tokens").select("asset_id").where("livemode", "=", false).execute();
    if (n.length > 5) break;
    await new Promise((r) => setTimeout(r, 100));
  }
});
afterAll(async () => {
  await s?.stop();
});

const create = async (body: unknown) => {
  const r = await s.call("POST", "/internal/executions", { body });
  expect(r.status).toBe(201);
  return Execution.parse(r.body);
};
const get = async (id: string) => Execution.parse((await s.call("GET", `/internal/executions/${id}`)).body);
async function until(id: string, pred: (x: Execution) => boolean, ms = 30_000): Promise<Execution> {
  const end = Date.now() + ms;
  for (;;) {
    const x = await get(id);
    if (pred(x)) return x;
    if (Date.now() > end) throw new Error(`execution ${id} stuck in ${x.state} (${x.provider_status})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const deposit = async (x: Execution, amount?: string) => {
  const r = await s.sandbox?.call("POST", "/sim/deposits", {
    deposit_address: x.deposit?.address,
    ...(amount ? { amount_in: amount } : {}),
  });
  expect(r?.status).toBe(202);
  expect((await s.call("POST", `/internal/executions/${x.id}/signals`, { body: { type: "payer_sent" } })).status).toBe(
    202,
  );
};
const transitions = async (id: string) =>
  (
    await s.admin.db
      .selectFrom("execution_transitions")
      .selectAll()
      .where("execution_id", "=", toUuid(id, "ex"))
      .orderBy("created_at")
      .execute()
  ).map((t) => `${t.to_state}:${t.actor}`);

describe("route_quote lifecycle (sandbox scenarios)", () => {
  it("00 to a chain address: deposit → settling → verifying → succeeded on simulated-chain evidence; events published", async () => {
    const probe = await s.probe();
    const x = await create(routeQuote({ destination: { address: randomEvm() } }));
    await deposit(x);
    const done = await until(x.id, (e) => e.state === "succeeded");
    expect(done.evidence).toMatchObject({
      chain: "eip155:42161",
      recipient: x.settlement.recipient,
      asset_id: USDC_ARB,
      amount: x.settlement.expected,
      tier: "A",
      source: "verifier",
      finality: "finalized",
    });
    expect(done.evidence?.explorer_url).toMatch(/^https:\/\/arbiscan\.io\/tx\//);
    expect(done.settled_amount).toBe(x.settlement.expected);
    expect(done.terminal_at).not.toBeNull();
    const t = await transitions(x.id);
    expect(t[0]).toBe("awaiting_deposit:api");
    expect(t).toContain("verifying:hot_poll");
    expect(t.at(-1)).toBe("succeeded:verifier");
    // the tag is released at the terminal state
    const tags = await s.admin.db
      .selectFrom("amount_tags")
      .select("released_at")
      .where("execution_id", "=", toUuid(x.id, "ex"))
      .execute();
    expect(tags.every((r) => r.released_at !== null)).toBe(true);
    // the relay published every version in order, the last one as `settled`
    await probe.next("evt.rails.execution.settled", (e) => e.aggregate.id === x.id, 15_000);
    const mine = probe.received.filter((e) => e.aggregate.id === x.id);
    for (const e of mine) EventEnvelope.parse(e);
    const versions = mine.map((e) => e.aggregate.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(mine.at(-1)?.subject).toBe("evt.rails.execution.settled");
    await probe.close();
  });

  it("00 to an Intents account: settles from the sandbox feed's tag match or the verifier", async () => {
    const merchant = `m${Date.now()}.near`;
    const x = await create(toIntents(merchant));
    await deposit(x);
    const done = await until(x.id, (e) => e.state === "succeeded");
    expect(["indexer", "verifier"]).toContain(done.evidence?.source);
    expect(done.evidence).toMatchObject({
      chain: "near:mainnet",
      recipient: merchant,
      asset_id: USDC_NEAR,
      amount: x.settlement.expected,
    });
  });

  it("05: the destination receives one unit less — succeeded short (payments decides the review)", async () => {
    const x = await create(
      routeQuote({ pricing: { currency: "usd", amount: 2005 }, destination: { address: randomEvm() } }),
    );
    await deposit(x);
    const done = await until(x.id, (e) => e.state === "succeeded");
    expect(BigInt(done.settled_amount ?? "0")).toBe(BigInt(x.settlement.expected) - 1n);
  });

  it("04: FAILED after PROCESSING — held (failed_after_deposit), held event", async () => {
    const probe = await s.probe("evt.rails.execution.held");
    const x = await create(
      routeQuote({ pricing: { currency: "usd", amount: 2004 }, destination: { address: randomEvm() } }),
    );
    await deposit(x);
    const done = await until(x.id, (e) => e.state === "held");
    expect(done).toMatchObject({ held_reason: "failed_after_deposit", provider_status: "FAILED", terminal_at: null });
    await probe.next("evt.rails.execution.held", (e) => e.aggregate.id === x.id, 15_000);
    await probe.close();
  });

  it("a provider refund ends refunded with the refunded amount (manual step)", async () => {
    const x = await create(routeQuote({ destination: { address: randomEvm() } }));
    const r = await s.sandbox?.call("POST", "/sim/advance", { deposit_address: x.deposit?.address, to: "refund" });
    expect(r?.status).toBe(202);
    await s.call("POST", `/internal/executions/${x.id}/signals`, { body: { type: "payer_sent" } });
    const done = await until(x.id, (e) => e.state === "refunded");
    expect(done.provider_status).toBe("REFUNDED");
  });

  it("expires an unpaid execution after deadline + 10 min, and keeps sweeping it for late refunds", async () => {
    const x = await create(routeQuote({ destination: { address: randomEvm() } }));
    await s.admin.db
      .updateTable("executions")
      .set({ deadline: new Date(Date.now() - 11 * 60_000), next_poll_at: new Date() })
      .where("id", "=", toUuid(x.id, "ex"))
      .execute();
    const done = await until(x.id, (e) => e.state === "expired_unpaid");
    expect(done.terminal_at).toBeNull();
    const row = await s.admin.db
      .selectFrom("executions")
      .selectAll()
      .where("id", "=", toUuid(x.id, "ex"))
      .executeTakeFirstOrThrow();
    expect(row.tracking_until).not.toBeNull();
    expect(row.next_poll_at?.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
  });
});

describe("intents_transfer (sandbox Verifier + sandbox feed)", () => {
  it("settles from the DIP-4 transfer carrying the binding memo", async () => {
    const sk = ed25519.utils.randomSecretKey();
    const payer = implicitAccountId(ed25519.getPublicKey(sk));
    const merchant = `shop${Date.now()}.near`;
    const x = await create(intentsTransfer(payer, merchant, { pricing: { currency: "usd", amount: 500 } }));
    const req = x.intents_requirement;
    if (!req) throw new Error("no requirement");
    const total = (BigInt(req.amount) + BigInt(req.fee_amount)).toString();
    expect(
      (await s.sandbox?.call("POST", "/sim/intents/fund", { account_id: payer, token: USDC_NEAR, amount: total }))
        ?.status,
    ).toBe(200);
    const salt =
      (
        (
          await s.sandbox?.call("POST", "/sim/intents/simulate", {
            signed: [
              signNep413(
                buildPayload({
                  signerId: payer,
                  deadline: req.deadline,
                  nonce: makeNonce("00000000"),
                  intents: [],
                } as never) as IntentMessage,
                sk,
              ),
            ],
          })
        )?.body as { state?: { current_salt?: string } }
      )?.state?.current_salt ?? "5a0dbe11";
    const msg = buildPayload({
      signerId: payer,
      deadline: req.deadline,
      nonce: makeNonce(salt),
      intents: buildTransferIntents(req as never),
    } as never) as IntentMessage;
    const sandbox = s.sandbox;
    if (!sandbox) throw new Error("no sandbox");
    const ex = await sandbox.call("POST", "/sim/intents/execute", { signed: [signNep413(msg, sk)] });
    expect((ex.body as { status: string }).status).toBe("success");
    const done = await until(x.id, (e) => e.state === "succeeded");
    expect(done.evidence).toMatchObject({
      source: "indexer",
      tier: "A",
      recipient: merchant,
      amount: req.amount,
      finality: "final",
    });
    expect(done.evidence?.tx_hash).toBe((ex.body as { tx_hash: string }).tx_hash);
    // spec 0.2.1: the executed payload's fee transfer is the observed fee; the payer moved amount + fee
    expect(done.observed_fee).toEqual({ amount: req.fee_amount, asset_id: USDC_NEAR });
    expect(done.deposited_amount).toBe(total);
    expect(done.settlement.decimals).toBe(6);
  });

  it("an unpaid Intents requirement expires after its deadline", async () => {
    const x = await create(intentsTransfer("payer.near", `late${Date.now()}.near`));
    await s.admin.db
      .updateTable("executions")
      .set({ deadline: new Date(Date.now() - 11 * 60_000), next_poll_at: new Date() })
      .where("id", "=", toUuid(x.id, "ex"))
      .execute();
    const done = await until(x.id, (e) => e.state === "expired_unpaid");
    const row = await s.admin.db
      .selectFrom("executions")
      .select("next_poll_at")
      .where("id", "=", toUuid(x.id, "ex"))
      .executeTakeFirstOrThrow();
    expect(row.next_poll_at).toBeNull();
    expect(done.version).toBe(2);
  });
});

describe("consumers", () => {
  const waitFor = async (pred: () => Promise<boolean>, ms = 15_000) => {
    const end = Date.now() + ms;
    while (!(await pred())) {
      if (Date.now() > end) throw new Error("condition not met");
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  it("keeps the destination watch-list (stale versions ignored) and refreshes the new minimum", async () => {
    const d = internalSettlementDestination({
      livemode: false,
      type: "chain_address",
      chain: "eip155:42161",
      address: randomEvm(),
      asset_id: USDC_ARB,
    });
    const id = toUuid(d.id, "sd");
    await s.publishEvent(
      domainEvent("evt.identity.settlement_destination.activated", { ...d, status: "active" }, { version: 3 }),
    );
    await waitFor(async () =>
      Boolean(
        await s.admin.db
          .selectFrom("watched_destinations")
          .select("active")
          .where("destination_id", "=", id)
          .executeTakeFirst(),
      ),
    );
    await s.publishEvent(
      domainEvent("evt.identity.settlement_destination.disabled", { ...d, status: "disabled" }, { version: 2 }),
    );
    await s.publishEvent(
      domainEvent("evt.identity.settlement_destination.disabled", { ...d, status: "disabled" }, { version: 4 }),
    );
    await waitFor(
      async () =>
        (
          await s.admin.db
            .selectFrom("watched_destinations")
            .select("active")
            .where("destination_id", "=", id)
            .executeTakeFirst()
        )?.active === false,
    );
    const row = await s.admin.db
      .selectFrom("watched_destinations")
      .selectAll()
      .where("destination_id", "=", id)
      .executeTakeFirstOrThrow();
    expect([row.source_version, row.address_norm]).toEqual([4, d.address_norm]);
    await waitFor(async () =>
      Boolean(
        await s.admin.db
          .selectFrom("jobs")
          .select("id")
          .where("dedupe_key", "=", `minimums.refresh:${id}:3`)
          .executeTakeFirst(),
      ),
    );
  });

  it("the sentinel kill switch stops live quoting; release restores it; stale events are ignored", async () => {
    const flag = async () =>
      (
        await s.admin.db
          .selectFrom("control_flags")
          .selectAll()
          .where("name", "=", "quoting_enabled")
          .executeTakeFirstOrThrow()
      ).value;
    const ks = (engaged: boolean, version: number) =>
      domainEvent(
        engaged ? "evt.sentinel.kill_switch.engaged" : "evt.sentinel.kill_switch.released",
        { engaged, reason: "audit mismatch", actor: "sentinel" },
        { version, accountUuid: null, livemode: null },
      );
    await s.publishEvent(ks(true, 10));
    await waitFor(async () => (await flag()) === false);
    await s.publishEvent(ks(false, 9));
    await new Promise((r) => setTimeout(r, 500));
    expect(await flag()).toBe(false);
    await s.publishEvent(ks(false, 11));
    await waitFor(async () => (await flag()) === true);
    const n = await sql<{ n: string }>`select count(*)::text as n from inbox`.execute(s.admin.db);
    expect(Number(n.rows[0]?.n)).toBeGreaterThanOrEqual(3);
  });
});
