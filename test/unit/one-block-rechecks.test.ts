/**
 * ADR-0022 as amended (owner 2026-11-10 17:10): one block of each chain's own consensus confirms a payment, and the
 * post-success re-check (§8.12) follows Solana to `finalized` commitment and Bitcoin to 6 confirmations in the same
 * block. Pure checks with fake readers; the loop itself is covered in test/integration (live.test.ts, stage4.test.ts).
 */

import { describe, expect, it } from "vitest";
import type { Rails } from "../../src/app/context.js";
import { recheckFamily, recheckPlan } from "../../src/app/finality.js";
import type { EvidenceInput } from "../../src/app/observations.js";
import { loadProfiles } from "../../src/app/services.js";
import type { ExecutionRow } from "../../src/app/views.js";
import type { EsploraTx } from "../../src/domain/chains/bitcoin.js";
import type { SolanaTx } from "../../src/domain/chains/solana.js";
import type { Esplora } from "../../src/infra/clients/esplora.js";
import type { SolanaCommitment, SolanaRpc } from "../../src/infra/clients/solana.js";
import { requiredFor } from "../../src/verifiers/chains.js";
import { recheckBitcoin, recheckSolana } from "../../src/verifiers/finality-recheck.js";
import { BITCOIN_RETRY_MS, RETRY_MS, retryMsFor, VERIFIER_TICK_MS } from "../../src/verifiers/verifier.js";

const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BTC = "bip122:000000000019d6689c085ae165831e93";
const SIG = "5".repeat(88);
const TXID = "ab".repeat(32);
const HASH = "00".repeat(4) + "11".repeat(28);
const OTHER = "00".repeat(4) + "22".repeat(28);

const solTx = (slot: number, err: unknown = null): SolanaTx =>
  ({
    slot,
    meta: { err, preBalances: [], postBalances: [] },
    transaction: { signatures: [SIG], message: { accountKeys: [] } },
  }) as unknown as SolanaTx;

function fakeSolana(o: {
  finalizedSlot: number;
  at: Partial<Record<SolanaCommitment, SolanaTx | null>>;
}): SolanaRpc & { calls: string[] } {
  const calls: string[] = [];
  return {
    urls: ["http://sol"],
    commitment: "confirmed",
    calls,
    async signatures() {
      return [];
    },
    async transaction() {
      return o.at.confirmed ?? null;
    },
    async transactionAt(_sig, c) {
      calls.push(`tx@${c}`);
      return o.at[c] ?? null;
    },
    async slot(c) {
      calls.push(`slot@${c}`);
      return o.finalizedSlot;
    },
    health: () => ({ failingSinceMs: null, lastOkMs: null }) as never,
  };
}

describe("Solana re-check at `finalized` commitment", () => {
  const t = { signature: SIG, slot: 1000 };
  it("finalized in the same slot without meta.err → finalized", async () => {
    const rpc = fakeSolana({ finalizedSlot: 1032, at: { finalized: solTx(1000) } });
    expect(await recheckSolana(rpc, t)).toMatchObject({ kind: "finalized", detail: { tx_slot: 1000 } });
    expect(rpc.calls).toEqual(["slot@finalized", "tx@finalized"]);
  });

  it("not finalized yet (finalized slot below the evidence slot) → pending", async () => {
    const rpc = fakeSolana({ finalizedSlot: 990, at: { confirmed: solTx(1000) } });
    expect(await recheckSolana(rpc, t)).toMatchObject({
      kind: "pending",
      detail: { reason: "slot not finalized yet" },
    });
  });

  it("a lagging endpoint (finality passed, still `confirmed` in the same slot) → pending, not an alert", async () => {
    const rpc = fakeSolana({ finalizedSlot: 1040, at: { confirmed: solTx(1000) } });
    expect((await recheckSolana(rpc, t)).kind).toBe("pending");
  });

  it("dropped with its fork, moved to another slot or failed at finality → failed", async () => {
    expect(await recheckSolana(fakeSolana({ finalizedSlot: 1040, at: {} }), t)).toMatchObject({
      kind: "failed",
      detail: { reason: "transaction not found at finality" },
    });
    expect(await recheckSolana(fakeSolana({ finalizedSlot: 1040, at: { finalized: solTx(1007) } }), t)).toMatchObject({
      kind: "failed",
      detail: { reason: "slot changed at finality", tx_slot: 1007 },
    });
    expect(await recheckSolana(fakeSolana({ finalizedSlot: 1040, at: { confirmed: solTx(1009) } }), t)).toMatchObject({
      kind: "failed",
      detail: { reason: "slot changed at finality" },
    });
    expect(
      await recheckSolana(
        fakeSolana({ finalizedSlot: 1040, at: { finalized: solTx(1000, { InstructionError: 1 }) } }),
        t,
      ),
    ).toMatchObject({ kind: "failed", detail: { reason: "transaction failed at finality" } });
  });
});

function fakeEsplora(o: { tip: number; tx: EsploraTx | null }): Esplora {
  return {
    urls: ["http://esplora"],
    tx: async () => o.tx,
    tipHeight: async () => o.tip,
    addressTxs: async () => [],
    health: () => ({ failingSinceMs: null, lastOkMs: null }) as never,
  };
}
const btcTx = (status: EsploraTx["status"]): EsploraTx => ({ txid: TXID, vout: [], status });

describe("Bitcoin re-check at 6 confirmations in the same block", () => {
  const t = { txid: TXID, blockHash: HASH, height: 900_000 };
  it("pending until the tip is 6 deep over the evidence block; then the same block hash → finalized", async () => {
    const same = btcTx({ confirmed: true, block_height: 900_000, block_hash: HASH });
    expect(await recheckBitcoin(fakeEsplora({ tip: 900_004, tx: same }), t, 6)).toMatchObject({
      kind: "pending",
      detail: { confirmations: 5, required: 6 },
    });
    expect(await recheckBitcoin(fakeEsplora({ tip: 900_005, tx: same }), t, 6)).toMatchObject({
      kind: "finalized",
      detail: { confirmations: 6, tx_block_hash: HASH },
    });
  });

  it("orphaned (another block / back in the mempool) or unknown at 6 confirmations → failed (1-conf risk surfaced)", async () => {
    const moved = btcTx({ confirmed: true, block_height: 900_001, block_hash: OTHER });
    expect(await recheckBitcoin(fakeEsplora({ tip: 900_010, tx: moved }), t, 6)).toMatchObject({
      kind: "failed",
      detail: { reason: "block hash changed by 6 confirmations", tx_block_height: 900_001 },
    });
    expect(await recheckBitcoin(fakeEsplora({ tip: 900_010, tx: btcTx({ confirmed: false }) }), t, 6)).toMatchObject({
      kind: "failed",
      detail: { reason: "transaction left the best chain (back in the mempool)" },
    });
    expect(await recheckBitcoin(fakeEsplora({ tip: 900_010, tx: null }), t, 6)).toMatchObject({
      kind: "failed",
      detail: { reason: "transaction not found at 6 confirmations" },
    });
  });
});

describe("which evidence is re-checked, and how often (§8.12)", () => {
  const profiles = loadProfiles();
  const r = {
    profiles,
    finalityRecheck: {
      windowS: 7200,
      intervalS: 60,
      solana: { windowS: 1800, intervalS: 15 },
      bitcoin: { windowS: 21_600, intervalS: 60, confirmations: 6 },
    },
  } as unknown as Rails;
  const row = { livemode: true } as unknown as ExecutionRow;
  const ev = (o: Partial<EvidenceInput>): EvidenceInput =>
    ({
      result: "pass",
      tier: "A",
      source: "verifier",
      chain: "eip155:8453",
      txHash: "0xabc",
      blockRef: "100",
      finality: "confirmed",
      details: { block_hash: "0x11" },
      ...o,
    }) as EvidenceInput;

  it("EVM, Solana and Bitcoin one-block evidence; never NEAR `final`, Tier B, `finalized` or test mode", () => {
    expect(recheckFamily(r, row, ev({}))).toBe("evm");
    expect(recheckFamily(r, row, ev({ chain: "eip155:1" }))).toBe("evm");
    expect(recheckFamily(r, row, ev({ chain: SOL, blockRef: "380000001", details: {} }))).toBe("solana");
    expect(recheckFamily(r, row, ev({ chain: BTC, blockRef: "900000", details: { block_hash: HASH } }))).toBe(
      "bitcoin",
    );
    expect(
      recheckFamily(
        r,
        row,
        ev({
          chain: BTC,
          blockRef: "900000",
          details: {},
          chainDetail: { solana: null, bitcoin: { block_hash: HASH } as never },
        }),
      ),
    ).toBe("bitcoin");
    expect(recheckFamily(r, row, ev({ chain: "near:mainnet", finality: "final" }))).toBeNull();
    expect(recheckFamily(r, row, ev({ tier: "B" }))).toBeNull();
    expect(recheckFamily(r, row, ev({ finality: "finalized" }))).toBeNull();
    expect(recheckFamily(r, row, ev({ txHash: null }))).toBeNull();
    expect(recheckFamily(r, row, ev({ chain: SOL, blockRef: null }))).toBeNull();
    expect(recheckFamily(r, row, ev({ chain: BTC, details: {} }))).toBeNull();
    expect(recheckFamily(r, { livemode: false } as never, ev({}))).toBeNull();
  });

  it("cadence/window per family: EVM 60 s / 2 h, Solana 15 s / 30 min, Bitcoin 60 s / 6 h", () => {
    expect(recheckPlan(r, "evm")).toEqual({ intervalS: 60, windowS: 7200 });
    expect(recheckPlan(r, "solana")).toEqual({ intervalS: 15, windowS: 1800 });
    expect(recheckPlan(r, "bitcoin")).toMatchObject({ intervalS: 60, windowS: 21_600 });
  });

  it("verifier retries every 2 s (Bitcoin 5 s) and looks for due work every 500 ms", () => {
    expect([RETRY_MS, BITCOIN_RETRY_MS, VERIFIER_TICK_MS]).toEqual([2_000, 5_000, 500]);
    expect(retryMsFor(r, "eip155:8453")).toBe(2_000);
    expect(retryMsFor(r, "eip155:1")).toBe(2_000);
    expect(retryMsFor(r, SOL)).toBe(2_000);
    expect(retryMsFor(r, "near:mainnet")).toBe(2_000);
    expect(retryMsFor(r, BTC)).toBe(5_000);
  });
});

describe("Bitcoin: 1 confirmation for every amount by default (tiers are an override)", () => {
  const row = (usd: string) =>
    ({
      livemode: true,
      destination_asset_id: "nep141:btc.omft.near",
      destination_decimals: 8,
      amount_out_expected: "100000000", // 1 BTC
      price_snapshot: { primary_usd: usd, secondary_usd: null },
    }) as unknown as Parameters<typeof requiredFor>[1];
  it("USD 50, USD 100,000 and an unknown price all need 1; profile tiers still apply when set", async () => {
    const r = {} as Rails;
    expect(await requiredFor(r, row("0.00000005"), [])).toBe(1);
    expect(await requiredFor(r, row("100000"), [])).toBe(1);
    expect(await requiredFor(r, { ...row("1"), price_snapshot: null } as never, [])).toBe(1);
    const tiers = [
      { below_usd_micros: 1_000_000_000, confirmations: 1 },
      { below_usd_micros: null, confirmations: 3 },
    ];
    expect(await requiredFor(r, row("100000"), tiers)).toBe(3);
    expect(await requiredFor(r, row("1"), tiers)).toBe(1);
  });
});
