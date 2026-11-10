/** ADR-0022: EVM confirmation policy (profiles, env overrides), the confirmation check and the finalized re-check. */
import { ConfigError, loadConfig } from "@nearpay-internal/service";
import { describe, expect, it } from "vitest";
import { loadProfiles } from "../../src/app/services.js";
import { trackerShape } from "../../src/config.js";
import {
  blockCounts,
  ConfirmationPolicyError,
  confirmationsOf,
  countedHead,
  DEFAULT_EVM_CONFIRMATION,
  type EvmConfirmation,
  parseEvmConfirmation,
  policyLabel,
} from "../../src/domain/chains/evm.js";
import { chainProfiles, ProfileError } from "../../src/domain/token-registry/chain-profiles.js";
import type { EvmReceipt, EvmRpc } from "../../src/infra/clients/evm.js";
import { checkEvmConfirmation } from "../../src/verifiers/evm-confirmation.js";
import { recheckFinality } from "../../src/verifiers/finality-recheck.js";

const HASH = `0x${"ab".repeat(32)}`;
const BLOCK_HASH = `0x${"11".repeat(32)}`;
const OTHER_HASH = `0x${"22".repeat(32)}`;
const receipt = (over: Partial<EvmReceipt> = {}): EvmReceipt => ({
  status: "0x1",
  blockNumber: "0x64", // 100
  blockHash: BLOCK_HASH,
  transactionHash: HASH,
  logs: [],
  ...over,
});

/** Fake EVM pool: heads and a scripted sequence of receipt answers (the last one repeats). */
function fakeRpc(o: { latest?: bigint; finalized?: bigint; receipts?: (EvmReceipt | null)[] }) {
  const calls: string[] = [];
  const queue = [...(o.receipts ?? [])];
  const rpc: EvmRpc = {
    urls: ["http://rpc.test"],
    async finalizedBlock() {
      calls.push("finalized");
      if (o.finalized === undefined) throw new Error("finalized not scripted");
      return o.finalized;
    },
    async latestBlock() {
      calls.push("latest");
      if (o.latest === undefined) throw new Error("latest not scripted");
      return o.latest;
    },
    async logs() {
      return [];
    },
    async receipt() {
      calls.push("receipt");
      return (queue.length > 1 ? queue.shift() : queue[0]) ?? null;
    },
    async transaction() {
      return null;
    },
  };
  return { rpc, calls };
}

const TEN: EvmConfirmation = { kind: "confirmations", blocks: 10 };

describe("confirmation policy (domain)", () => {
  it("parses overrides: finalized or a block count; anything else is refused", () => {
    expect(parseEvmConfirmation("finalized")).toEqual({ kind: "finalized" });
    expect(parseEvmConfirmation(" FINALIZED ")).toEqual({ kind: "finalized" });
    expect(parseEvmConfirmation("25")).toEqual({ kind: "confirmations", blocks: 25 });
    for (const bad of ["0", "-1", "1.5", "abc", "", "100001", "10 blocks"])
      expect(() => parseEvmConfirmation(bad)).toThrow(ConfirmationPolicyError);
  });

  it("counts confirmations with the block itself as 1, and the counted head", () => {
    expect(confirmationsOf(109n, 100n)).toBe(10n);
    expect(confirmationsOf(100n, 100n)).toBe(1n);
    expect(confirmationsOf(99n, 100n)).toBe(0n);
    expect(countedHead(TEN, { latest: 109n })).toBe(100n);
    expect(countedHead(TEN, { latest: 5n })).toBe(0n);
    expect(countedHead({ kind: "finalized" }, { finalized: 77n })).toBe(77n);
    expect(blockCounts(TEN, 100n, { latest: 109n })).toBe(true);
    expect(blockCounts(TEN, 100n, { latest: 108n })).toBe(false);
    expect(() => countedHead(TEN, { finalized: 1n })).toThrow(ConfirmationPolicyError);
    expect(() => countedHead({ kind: "finalized" }, { latest: 1n })).toThrow(ConfirmationPolicyError);
    expect(policyLabel(TEN)).toBe("10 confirmations");
    expect(policyLabel({ kind: "finalized" })).toBe("finalized");
  });
});

describe("chain profiles", () => {
  it("defaults: Base 10 and Arbitrum 40 L2 confirmations; Ethereum stays finalized; non-EVM chains have none", () => {
    const p = loadProfiles();
    expect(p.get("eip155:8453")?.evmConfirmation).toEqual({ kind: "confirmations", blocks: 10 });
    expect(p.get("eip155:42161")?.evmConfirmation).toEqual({ kind: "confirmations", blocks: 40 });
    expect(p.get("eip155:1")?.evmConfirmation).toEqual({ kind: "finalized" });
    expect(p.get("near:mainnet")?.evmConfirmation).toBeNull();
    const view = (c: string) => p.view(p.get(c) as NonNullable<ReturnType<typeof p.get>>);
    expect(view("eip155:8453").finality).toBe("10 confirmations");
    expect(view("eip155:1").finality).toBe("finalized");
    expect(view("near:mainnet").finality).toBe("final");
    expect(DEFAULT_EVM_CONFIRMATION["eip155:1"]).toEqual({ kind: "finalized" });
  });

  it("a profile without evm_confirmation takes the chain default; non-EVM chains refuse the field", () => {
    const base = {
      chain: "eip155:8453",
      blockchain: "base",
      tier: "A",
      min_deadline_s: 300,
      default_deadline_s: 1800,
      finality: "x",
      verification_timeout_s: 3600,
      memo_mode: "none",
    };
    const eth = { ...base, chain: "eip155:1", blockchain: "eth" };
    const p = chainProfiles({ chains: [base, eth] });
    expect(p.get("eip155:8453")?.evmConfirmation).toEqual({ kind: "confirmations", blocks: 10 });
    expect(p.get("eip155:1")?.evmConfirmation).toEqual({ kind: "finalized" });
    expect(
      chainProfiles({ chains: [{ ...base, evm_confirmation: { kind: "finalized" } }] }).get("eip155:8453")
        ?.evmConfirmation,
    ).toEqual({ kind: "finalized" });
    expect(() =>
      chainProfiles({
        chains: [
          {
            ...base,
            chain: "near:mainnet",
            blockchain: "near",
            evm_confirmation: { kind: "confirmations", blocks: 3 },
          },
        ],
      }),
    ).toThrow(ProfileError);
    expect(() =>
      chainProfiles({ chains: [{ ...base, evm_confirmation: { kind: "confirmations", blocks: 0 } }] }),
    ).toThrow(ProfileError);
  });

  it("env overrides replace the rule per chain; unknown or non-EVM chains are refused", () => {
    const p = loadProfiles().withEvmConfirmations({
      "eip155:8453": { kind: "finalized" },
      "eip155:42161": { kind: "confirmations", blocks: 120 },
      "eip155:1": undefined,
    });
    expect(p.get("eip155:8453")?.evmConfirmation).toEqual({ kind: "finalized" });
    expect(p.get("eip155:42161")?.evmConfirmation).toEqual({ kind: "confirmations", blocks: 120 });
    expect(p.get("eip155:1")?.evmConfirmation).toEqual({ kind: "finalized" });
    expect(() => loadProfiles().withEvmConfirmations({ "eip155:999999": TEN })).toThrow(ProfileError);
    expect(() => loadProfiles().withEvmConfirmations({ "near:mainnet": TEN })).toThrow(ProfileError);
  });

  it("NP_EVM_CONFIRMATIONS_<CHAINID> parses at boot; an invalid value fails the boot", () => {
    const shape = {
      evmConfirmations_1: trackerShape.evmConfirmations_1,
      evmConfirmations_8453: trackerShape.evmConfirmations_8453,
      evmConfirmations_42161: trackerShape.evmConfirmations_42161,
    };
    const c = loadConfig(shape, {
      env: { NP_EVM_CONFIRMATIONS_8453: "25", NP_EVM_CONFIRMATIONS_42161: "finalized" },
    });
    expect(c).toEqual({
      evmConfirmations_1: undefined,
      evmConfirmations_8453: { kind: "confirmations", blocks: 25 },
      evmConfirmations_42161: { kind: "finalized" },
    });
    expect(() => loadConfig(shape, { env: { NP_EVM_CONFIRMATIONS_8453: "soon" } })).toThrow(ConfigError);
  });
});

describe("checkEvmConfirmation", () => {
  it("below the threshold is pending (9 of 10); at the threshold it counts as confirmed after the re-read", async () => {
    const short = fakeRpc({ latest: 108n, receipts: [receipt()] });
    expect(await checkEvmConfirmation(short.rpc, TEN, receipt())).toEqual({
      kind: "pending",
      details: { reason: "awaiting confirmations", block: "100", confirmations: 9, required_confirmations: 10 },
    });
    expect(short.calls).toEqual(["latest"]); // no re-read before the threshold

    const deep = fakeRpc({ latest: 109n, receipts: [receipt()] });
    expect(await checkEvmConfirmation(deep.rpc, TEN, receipt())).toEqual({
      kind: "counted",
      finality: "confirmed",
      confirmations: 10,
      blockHash: BLOCK_HASH,
      blockNumber: 100n,
    });
    expect(deep.calls).toEqual(["latest", "receipt"]);
  });

  it("reorg: a changed block hash, a vanished receipt or a changed status at confirmation counts for nothing", async () => {
    const moved = fakeRpc({ latest: 200n, receipts: [receipt({ blockHash: OTHER_HASH, blockNumber: "0x65" })] });
    expect(await checkEvmConfirmation(moved.rpc, TEN, receipt())).toMatchObject({
      kind: "reorged",
      details: { reason: "block hash changed at confirmation", block_hash: BLOCK_HASH, new_block_hash: OTHER_HASH },
    });
    const sameNumber = fakeRpc({ latest: 200n, receipts: [receipt({ blockHash: OTHER_HASH })] });
    expect((await checkEvmConfirmation(sameNumber.rpc, TEN, receipt())).kind).toBe("reorged");
    const gone = fakeRpc({ latest: 200n, receipts: [null] });
    expect(await checkEvmConfirmation(gone.rpc, TEN, receipt())).toMatchObject({
      kind: "reorged",
      details: { reason: "receipt vanished at confirmation" },
    });
    const reverted = fakeRpc({ latest: 200n, receipts: [receipt({ status: "0x0" })] });
    expect(await checkEvmConfirmation(reverted.rpc, TEN, receipt())).toMatchObject({
      kind: "reorged",
      details: { reason: "receipt status changed at confirmation" },
    });
  });

  it("Ethereum (finalized rule) waits for the finalized tag and never counts on confirmations", async () => {
    const early = fakeRpc({ finalized: 99n, latest: 10_000n });
    expect(await checkEvmConfirmation(early.rpc, { kind: "finalized" }, receipt())).toEqual({
      kind: "pending",
      details: { reason: "not finalized", block: "100", finalized: "99" },
    });
    expect(early.calls).toEqual(["finalized"]); // `latest` is never read under the finalized rule
    const done = fakeRpc({ finalized: 100n });
    expect(await checkEvmConfirmation(done.rpc, { kind: "finalized" }, receipt())).toEqual({
      kind: "counted",
      finality: "finalized",
      confirmations: null,
      blockHash: BLOCK_HASH,
      blockNumber: 100n,
    });
  });
});

describe("recheckFinality (post-success finalized re-check)", () => {
  const t = { txHash: HASH, blockHash: BLOCK_HASH, blockRef: "100" };
  it("pending until finalized covers the block, then finalized for the same block hash and status 1", async () => {
    expect((await recheckFinality(fakeRpc({ finalized: 99n, receipts: [receipt()] }).rpc, t)).kind).toBe("pending");
    expect(await recheckFinality(fakeRpc({ finalized: 150n, receipts: [receipt()] }).rpc, t)).toMatchObject({
      kind: "finalized",
      detail: { finalized: "150", receipt_block_hash: BLOCK_HASH, status: "0x1" },
    });
  });

  it("fails when the block hash changed, the receipt is gone or its status is not 1 at finality", async () => {
    expect(
      await recheckFinality(fakeRpc({ finalized: 150n, receipts: [receipt({ blockHash: OTHER_HASH })] }).rpc, t),
    ).toMatchObject({ kind: "failed", detail: { reason: "block hash changed at finality" } });
    expect(
      await recheckFinality(
        fakeRpc({ finalized: 150n, receipts: [receipt({ blockHash: OTHER_HASH, blockNumber: "0x66" })] }).rpc,
        t,
      ),
    ).toMatchObject({ kind: "failed", detail: { reason: "block hash changed at finality" } });
    expect(await recheckFinality(fakeRpc({ finalized: 150n, receipts: [null] }).rpc, t)).toMatchObject({
      kind: "failed",
      detail: { reason: "transaction not found at finality" },
    });
    expect(
      await recheckFinality(fakeRpc({ finalized: 150n, receipts: [receipt({ status: "0x0" })] }).rpc, t),
    ).toMatchObject({ kind: "failed", detail: { reason: "receipt status at finality is not 1" } });
  });

  it("a receipt missing or moved to a later block before finality is still pending (decided at finality)", async () => {
    expect((await recheckFinality(fakeRpc({ finalized: 90n, receipts: [null] }).rpc, t)).kind).toBe("pending");
    const later = receipt({ blockHash: OTHER_HASH, blockNumber: "0xc8" }); // block 200 > finalized 150
    expect((await recheckFinality(fakeRpc({ finalized: 150n, receipts: [later] }).rpc, t)).kind).toBe("pending");
  });
});
