/**
 * Contract (foundations §16): every Stage 1–4 rails route is bound (and nothing else); every subject the
 * catalogue routes to rails is handled; every subject rails produces is emitted; the 1Click wire
 * schemas parse the recorded responses (schema parity with the sandbox, sandbox LLD §7).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Evidence, PUBLIC_ROUTES } from "@nearpay/spec";
import { unhandledSubjects } from "@nearpay-internal/bus";
import { unimplementedRoutes } from "@nearpay-internal/service";
import {
  ChainProfile,
  CreateExecution,
  EventEnvelope,
  Execution,
  INTERNAL_ROUTES,
  listEvidence,
  OneClickQuoteRequest,
  OneClickQuoteResponse,
  OneClickStatusResponse,
  SUBJECTS,
  type Subject,
  VaultEventRecord,
} from "@nearpay-internal/spec";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { railsRoutes } from "../../src/api/routes.js";
import { subjectFor } from "../../src/app/ledger.js";
import { evidenceRecord } from "../../src/app/observations.js";
import { executionView } from "../../src/app/views.js";
import { railsHandlers } from "../../src/consumers/handlers.js";
import { chainProfiles } from "../../src/domain/token-registry/chain-profiles.js";
import { vaultEnvelope, vaultEventsOf } from "../../src/trackers/near-indexer/vault.js";
import { fixture } from "../support/fakes.js";
import { specVector } from "../support/vectors.js";

const ALL = [...PUBLIC_ROUTES, ...INTERNAL_ROUTES];

describe("routes and events", () => {
  it("binds every Stage 1–4 rails route (internal, public and console ops), and nothing else", () => {
    const bindings = railsRoutes({ profiles: { all: () => [] } } as never);
    expect(unimplementedRoutes("rails", ALL, bindings).map((r) => r.id)).toEqual([]);
    expect(bindings.map((b) => b.route.id).sort()).toEqual(
      ALL.filter((r) => r.service === "rails" && r.stage <= 4)
        .map((r) => r.id)
        .sort(),
    );
  });

  it("handles every subject the catalogue routes to rails", () => {
    const handlers = railsHandlers({} as never);
    expect(unhandledSubjects("rails", handlers)).toEqual([]);
    for (const subject of Object.keys(handlers) as Subject[]) expect(SUBJECTS[subject].consumers).toContain("rails");
  });

  it("emits every subject rails produces", () => {
    const produced = (Object.keys(SUBJECTS) as Subject[]).filter(
      (k) => SUBJECTS[k].producer === "rails" && SUBJECTS[k].stage <= 4,
    );
    const emitted = new Set(
      (["awaiting_deposit", "succeeded", "refunded", "failed", "held", "settling"] as const).map((to) =>
        subjectFor("verifying", to),
      ),
    );
    emitted.add("evt.rails.ops_action.recorded"); // app/ops.ts reverify
    emitted.add("evt.rails.vault.event"); // trackers/near-indexer/vault.ts (§8.6)
    expect([...emitted].sort()).toEqual([...produced].sort());
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
    const src = files(new URL("../../src", import.meta.url).pathname)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    for (const s of produced) expect(src).toContain(s);
  });
});

describe("Stage 3 contract (spec 0.3.0, lld/rails.md §20)", () => {
  it("the execution view rails emits (API and evt.rails.execution.*) carries owner, binding and the evidence sender", () => {
    const row = {
      id: "0190f5d2-6c4e-7a00-8000-000000000001",
      account_id: "0190f5d2-6c4e-7a00-8000-000000000002",
      livemode: false,
      owner: "agentpay",
      x402_binding: "np1:4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
      kind: "payment",
      method: "route_quote",
      provider: "sandbox",
      state: "succeeded",
      provider_status: "SUCCESS",
      route_class: "same_asset",
      applied_fee_bps: 20,
      origin_asset_id: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      origin_chain: "eip155:8453",
      refund_to: "0x52908400098527886e0f7030069857d2e4169ee7",
      refund_type: "origin_chain",
      origin_decimals: 6,
      destination_asset_id: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      destination_decimals: 6,
      amount_out_base: "1000000",
      amount_tag: "17",
      amount_out_expected: "1000017",
      recipient: "merchant.near",
      recipient_type: "intents",
      destination_chain: "near:mainnet",
      price_snapshot: null,
      deposit_address: "0x0000000000000000000000000000000000000001",
      deposit_memo: null,
      amount_in: "1003000",
      min_amount_in: "1002000",
      fee_amount_in: "2006",
      deadline: new Date(),
      deposit_tx_hashes: [],
      settled_amount: "1000017",
      refunded_amount: null,
      refund_reason: null,
      evidence: {
        chain: "near:mainnet",
        tx_hash: "F4j6f6d1V1tRycSMuTfVjFX2LN2dfQwWBmg1yF6Wu7Hv",
        block_ref: "223270700",
        recipient: "merchant.near",
        asset_id: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
        amount: "1000017",
        finality: "final",
        tier: "A",
        source: "indexer",
        observed_at: new Date().toISOString(),
        explorer_url: null,
        sender: "solver.near",
      },
      failure_code: null,
      held_reason: null,
      terminal_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
      reference: null,
      refund: null,
      observed_fee_amount: null,
      observed_fee_asset: null,
      deposited_amount: null,
      abandoned_at: null,
      abandon_reason: null,
      version: 5,
    };
    const view = Execution.parse(executionView(row as never));
    expect(view).toMatchObject({
      owner: "agentpay",
      x402_binding: row.x402_binding,
      evidence: { sender: "solver.near" },
    });
    // a payments execution never shows a binding, even if one were stored
    expect(executionView({ ...row, owner: "payments" } as never)).toMatchObject({
      owner: "payments",
      x402_binding: null,
    });
  });

  it("CreateExecution and listEvidence accept the Stage 3 owner fields", () => {
    expect(CreateExecution.shape.owner).toBeDefined();
    expect(CreateExecution.shape.x402_binding).toBeDefined();
    expect(listEvidence.query?.shape.owner).toBeDefined();
  });
});

describe("Stage 4 contract (spec 0.4.0, lld/rails.md §21, §8.6)", () => {
  // biome-ignore lint/suspicious/noExplicitAny: vector JSON
  type Any = any;
  const V = specVector<Any>("chains-solana-bitcoin.json");
  const VAULT = specVector<Any>("vault.json");

  it("the Solana and Bitcoin profile views parse as ChainProfile with the Stage 4 fields", () => {
    const doc = parseYaml(readFileSync(new URL("../../config/chains.yaml", import.meta.url), "utf8"));
    const profiles = chainProfiles(doc);
    for (const want of V.chains as Any[]) {
      const view = ChainProfile.parse(profiles.view(profiles.get(want.chain) as never));
      expect(view).toMatchObject({
        chain: want.chain,
        explorer_address_url: want.explorer_address_url,
        // ADR-0022 as amended (owner 2026-11-10 17:10): Bitcoin needs 1 confirmation for every amount; the spec 0.4.0
        // vector still carries the Stage 4 USD tiers (spec follow-up). The schema accepts both.
        confirmation_tiers:
          view.family === "bitcoin" ? [{ below_usd_micros: null, confirmations: 1 }] : want.confirmation_tiers,
      });
    }
    for (const p of profiles.all()) expect(() => ChainProfile.parse(profiles.view(p))).not.toThrow();
  });

  it("the Evidence rails records equals the vector Evidence field for field (Solana and Bitcoin)", () => {
    const cases = [
      ...(V.evidence.solana.cases as Any[]).filter((c) => c.evidence),
      ...(V.evidence.bitcoin.cases as Any[]).filter((c) => c.evidence),
    ];
    expect(cases.length).toBeGreaterThanOrEqual(6);
    for (const c of cases) {
      const ev = c.evidence;
      const rec = evidenceRecord(
        {
          result: c.result,
          tier: ev.tier,
          source: ev.source,
          chain: ev.chain,
          txHash: ev.tx_hash,
          blockRef: ev.block_ref,
          recipient: ev.recipient,
          sender: ev.sender,
          assetId: ev.asset_id,
          amount: BigInt(ev.amount),
          finality: ev.finality,
          chainDetail: { solana: ev.solana, bitcoin: ev.bitcoin },
        },
        new Date(ev.observed_at),
      );
      expect(rec).toEqual(ev);
      expect(Evidence.parse(rec)).toEqual(ev);
    }
  });

  it("evt.rails.vault.event: the envelope rails writes parses with the catalogue entry", () => {
    const entry = SUBJECTS["evt.rails.vault.event"];
    expect(entry.producer).toBe("rails");
    const vault = "v1.vault.nearpay.near";
    const { records } = vaultEventsOf(
      {
        receiptId: "8RK6Dn9EaLwVb5nN3x9yrZfP6qz5mC8cQbqvYyYz2gHq",
        txHash: "4bWb9XzwJ2w3F7C2dWbNN1pYxQX7bGk8C5fDf3h1Jq8y",
        executor: vault,
        logs: (VAULT.events as Any[]).map((e) => e.log as string),
        success: true,
      },
      {
        vaultContract: vault,
        final: true,
        blockHeight: 140_000_000,
        blockHash: "4bWb9XzwJ2w3F7C2dWbNN1pYxQX7bGk8C5fDf3h1Jq8y",
        blockTimestamp: "1794268800000000000",
      },
    );
    expect(records).toHaveLength(VAULT.events.length);
    for (const [i, rec] of records.entries()) {
      const env = EventEnvelope.parse(
        vaultEnvelope(i % 2 === 0, rec, "0190f5d2-6c4e-7a00-8000-0000000000aa", new Date()),
      );
      expect(env).toMatchObject({
        subject: "evt.rails.vault.event",
        account_id: null,
        livemode: i % 2 === 0,
        aggregate: { type: entry.aggregate, id: `${vault}#${rec.event.data[0].mandate_id}`, version: 140_000_000 },
      });
      expect(VaultEventRecord.parse(env.data.object)).toEqual(rec);
      expect(entry.object.parse(env.data.object)).toEqual(rec);
    }
  });
});

describe("1Click and Explorer wire schemas", () => {
  it("parse the recorded live status unmodified (spec 0.2.0 nullish shape)", () => {
    expect(OneClickStatusResponse.safeParse(fixture("oneclick-status-pending-live.json")).success).toBe(true);
  });

  it("parse the recorded quote and request", () => {
    expect(OneClickQuoteResponse.safeParse(fixture("oneclick/dry-quote.json")).success).toBe(true);
    expect(OneClickQuoteRequest.safeParse(fixture("oneclick/dry-quote.request.json")).success).toBe(true);
  });
});
