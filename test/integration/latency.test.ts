/**
 * Time to "Paid" on the rails side (ADR-0022 as amended, owner 2026-11-10 17:10: one block confirms; target < 5 s
 * from the confirming block to checkout "Paid"). Anvil mines each payout into its own block (auto-mining — the
 * one-block rule needs no later block; Anvil's interval miners stalled under concurrent `eth_getLogs` here); the
 * tracker and feeds run
 * with their PRODUCTION cadences (no test tick overrides: poller 500 ms, verifier 500 ms, Base watcher 2 s, the
 * production poll schedule and verifier retry), and the clock runs from the moment the payout's block is mined
 * (its receipt first readable) to `evt.rails.execution.settled` arriving on NATS (outbox relay included) — the event
 * payments turns into `succeeded` and pushes to the checkout stream (Valkey notify → SSE, no polling on that path).
 *
 * Two paths:
 * - watcher: a tagged USDC payout seen by the Base destination watcher (evidence without the provider);
 * - provider: a USDC payout to a destination the watcher does not follow (no watched destination) — 1Click reports
 *   SUCCESS with the tx hash after the swap has been settling for a while, the hot poller reads it, the verifier
 *   proves it on chain.
 */
import { toUuid } from "@nearpay-internal/ids";
import { Execution } from "@nearpay-internal/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { refreshTokens } from "../../src/app/tokens.js";
import { evmRpc } from "../../src/infra/clients/evm.js";
import { type Anvil, startAnvil } from "../support/anvil.js";
import { type FakeOneClick, fakeOneClick } from "../support/fakes.js";
import { ACCOUNT, randomEvm, routeQuote } from "../support/requests.js";
import { type Stack, startStack, USDC_ARB, USDC_BASE } from "../support/stack.js";

const SAMPLES = Number(process.env.NP_LATENCY_SAMPLES ?? 3);
/** Rails' share of the < 5 s budget (payments + checkout are push-driven on top of it). */
const RAILS_BUDGET_MS = Number(process.env.NP_LATENCY_BUDGET_MS ?? 4_000);

let s: Stack;
let one: FakeOneClick;
let anvil: Anvil;
let token: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  [one, anvil] = await Promise.all([fakeOneClick(), startAnvil()]);
  token = await anvil.deployToken();
  const base = new Map([["eip155:8453", evmRpc({ urls: [anvil.url] })]]);
  s = await startStack({
    oneclick: one,
    config: { treasuryAccount: "treasury.nearpay.near" },
    // tickMs 0 → the loops' production cadences
    tracker: { evm: base, near: null, tickMs: 0 },
    feeds: { evm: base, tickMs: 0, intervals: { tokens: 600_000, sandbox: 1_000, indexer: 1_000, watcher: 0 } },
  });
  await refreshTokens(s.rails, true);
  await sleep(3_000); // let the feeds' own first token refresh finish (it rewrites prices and contracts)
  await pinTokens();
}, 240_000);
afterAll(async () => {
  await s?.stop();
  await anvil?.container.stop();
  await one?.stop();
});

/** Fresh prices, and Base USDC on the Anvil token (the feeds' token refresh re-reads the recorded list). */
async function pinTokens() {
  await s.admin.db.updateTable("tokens").set({ price_updated_at: new Date() }).where("livemode", "=", true).execute();
  await s.admin.db
    .updateTable("tokens")
    .set({ contract_address: token })
    .where("livemode", "=", true)
    .where("asset_id", "=", USDC_BASE)
    .execute();
}

const create = async () => {
  await pinTokens();
  const r = await s.call("POST", "/internal/executions", {
    body: routeQuote({
      livemode: true,
      origin: {
        asset_id: USDC_ARB,
        chain: "eip155:42161",
        refund_to: "0x52908400098527886e0f7030069857d2e4169ee7",
        refund_type: "origin_chain",
      },
      destination: { asset_id: USDC_BASE, type: "chain_address", chain: "eip155:8453", address: randomEvm() },
    }),
  });
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return Execution.parse(r.body);
};
const state = async (id: string) => Execution.parse((await s.call("GET", `/internal/executions/${id}`)).body).state;
const stats = (xs: number[]) => {
  const v = [...xs].sort((a, b) => a - b);
  return { samples: v, median: v[Math.floor(v.length / 2)] as number, max: v[v.length - 1] as number };
};

/** ms from the payout's block (receipt first readable) to `evt.rails.execution.settled` for `id`. */
async function settledAfter(id: string, payout: () => Promise<string>): Promise<number> {
  const probe = await s.probe("evt.rails.execution.settled");
  try {
    const uuid = toUuid(id, "ex");
    const arrived = probe
      .next(
        "evt.rails.execution.settled",
        (e) => JSON.stringify(e).includes(uuid) || JSON.stringify(e).includes(id),
        120_000,
      )
      .then(() => Date.now());
    await payout(); // returns as soon as the receipt is readable, i.e. the block is mined
    const t0 = Date.now();
    return (await arrived) - t0;
  } finally {
    await probe.close();
  }
}

describe("time from the confirming block to `settled` (production cadences)", () => {
  it(`watcher path (tagged USDC on Base), ${SAMPLES} samples`, async () => {
    const out: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const x = await create();
      await s.admin.db
        .insertInto("watched_destinations")
        .values({
          destination_id: crypto.randomUUID(),
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
      await sleep(3_000); // the watcher has picked up the demand
      out.push(
        await settledAfter(x.id, () => anvil.transfer(token, x.settlement.recipient, BigInt(x.settlement.expected))),
      );
      expect(await state(x.id)).toBe("succeeded");
    }
    const r = stats(out);
    console.log(`LATENCY watcher path ms: ${JSON.stringify(r)}`);
    expect(r.median).toBeLessThan(RAILS_BUDGET_MS);
  }, 300_000);

  it(`provider path (1Click SUCCESS after ~30 s settling → poller → verifier), ${SAMPLES} samples`, async () => {
    const out: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const x = await create(); // no watched destination: only the provider's SUCCESS + verifier can settle it
      const address = x.deposit?.address as string;
      let at = Date.now();
      const status = (status: string, extra: Record<string, unknown> = {}) => {
        at += 1000;
        one.statuses.set(address, { status, updatedAt: new Date(at).toISOString(), ...extra });
      };
      status("PROCESSING", {
        swapDetails: { originChainTxHashes: [{ hash: `0x${"a1".repeat(32)}`, explorerUrl: "" }] },
      });
      await s.call("POST", `/internal/executions/${x.id}/signals`, { body: { type: "payer_sent" } });
      await sleep(30_000); // the swap settles for a while: the poller has slowed down as it would in production
      out.push(
        await settledAfter(x.id, async () => {
          const hash = await anvil.transfer(token, x.settlement.recipient, BigInt(x.settlement.expected));
          // the provider reports SUCCESS as the destination block lands (best case for the provider leg)
          status("SUCCESS", {
            swapDetails: { amountOut: x.settlement.expected, destinationChainTxHashes: [{ hash, explorerUrl: "" }] },
          });
          return hash;
        }),
      );
      expect(await state(x.id)).toBe("succeeded");
    }
    const r = stats(out);
    console.log(`LATENCY provider path ms: ${JSON.stringify(r)}`);
    expect(r.median).toBeLessThan(RAILS_BUDGET_MS);
  }, 600_000);
});
