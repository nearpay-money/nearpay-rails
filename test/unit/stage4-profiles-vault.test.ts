/** Stage 4: chain profiles vs the spec vectors, boot-time tiers, SPL registry binding, vault event rules (§21, §8.6). */
import { readFileSync } from "node:fs";
import { parseVaultEventLog } from "@nearpay/spec";
import { VaultEventRecord, vaultEventDedupeKey } from "@nearpay-internal/spec";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { chainProfiles, ProfileError } from "../../src/domain/token-registry/chain-profiles.js";
import { contractBinding, registryRows } from "../../src/domain/token-registry/registry.js";
import { aggregateUuid, type VaultReceipt, vaultEventsOf } from "../../src/trackers/near-indexer/vault.js";
import { toKey } from "../../src/verifiers/chains.js";
import { simTransfers } from "../../src/verifiers/verifier.js";
import { specVector } from "../support/vectors.js";

// biome-ignore lint/suspicious/noExplicitAny: vector JSON
type Any = any;
const V = specVector<Any>("chains-solana-bitcoin.json");
const VAULT = specVector<Any>("vault.json");
const doc = parseYaml(readFileSync(new URL("../../config/chains.yaml", import.meta.url), "utf8"));
const profiles = chainProfiles(doc);

describe("Solana and Bitcoin chain profiles (spec vectors `chains`)", () => {
  for (const want of V.chains as Any[]) {
    it(`${want.blockchain}: the shipped profile view equals the vector`, () => {
      const p = profiles.get(want.chain);
      expect(p).toBeDefined();
      expect(profiles.view(p as never)).toEqual({
        chain: want.chain,
        blockchain: want.blockchain,
        family: want.family,
        tier: want.tier,
        min_deadline_s: want.min_deadline_s,
        default_deadline_s: want.default_deadline_s,
        finality: want.finality,
        verification_timeout_s: want.verification_timeout_s,
        memo_mode: want.memo_mode,
        explorer_tx_url: want.explorer_tx_url,
        explorer_address_url: want.explorer_address_url,
        confirmation_tiers: want.confirmation_tiers,
      });
    });
  }

  it("EVM and NEAR profiles carry no confirmation tiers", () => {
    expect(profiles.view(profiles.get("eip155:8453") as never).confirmation_tiers).toBeNull();
  });

  it("without a pool a pooled chain is Tier B at boot, watcher off (§21.4)", () => {
    const { profiles: eff, degraded } = profiles.withPools((c) => c.startsWith("solana:"));
    expect(degraded).toEqual(["bip122:000000000019d6689c085ae165831e93"]);
    expect(eff.get("bip122:000000000019d6689c085ae165831e93")).toMatchObject({ tier: "B", watcher: false });
    expect(eff.get("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toMatchObject({ tier: "A", watcher: true });
    // EVM / NEAR are not pooled here (their own pools are configured separately)
    expect(eff.get("eip155:1")?.tier).toBe("A");
    expect(eff.get("near:mainnet")?.tier).toBe("A");
  });

  const base = {
    chain: "bip122:000000000019d6689c085ae165831e93",
    blockchain: "btc",
    tier: "A",
    min_deadline_s: 60,
    default_deadline_s: 60,
    finality: "x",
    verification_timeout_s: 60,
    memo_mode: "none",
  };
  it.each([
    [{ ...base }, /needs confirmation_tiers/],
    [{ ...base, confirmation_tiers: [{ below_usd_micros: 5, confirmations: 1 }] }, /ascend/],
    [
      {
        ...base,
        confirmation_tiers: [
          { below_usd_micros: null, confirmations: 1 },
          { below_usd_micros: null, confirmations: 2 },
        ],
      },
      /ascend/,
    ],
    [
      {
        ...base,
        confirmation_tiers: [
          { below_usd_micros: 10, confirmations: 1 },
          { below_usd_micros: 5, confirmations: 2 },
          { below_usd_micros: null, confirmations: 3 },
        ],
      },
      /ascend/,
    ],
    [
      {
        ...base,
        confirmation_tiers: [
          { below_usd_micros: 10, confirmations: 3 },
          { below_usd_micros: null, confirmations: 2 },
        ],
      },
      /ascend/,
    ],
  ])("rejects bad confirmation tiers %#", (p, msg) => {
    expect(() => chainProfiles({ chains: [p] })).toThrow(ProfileError);
    expect(() => chainProfiles({ chains: [p] })).toThrow(msg);
  });

  it("a Tier-B Bitcoin profile without tiers is accepted", () => {
    expect(chainProfiles({ chains: [{ ...base, tier: "B" }] }).get(base.chain)?.confirmationTiers).toBeNull();
  });
});

describe("token registry: SPL asset ids bound to their mint (§21.1)", () => {
  const tok = (assetId: string, contractAddress: string | null) => ({
    assetId,
    decimals: 6,
    blockchain: "sol",
    symbol: "USDC",
    priceUsd: "1",
    priceUpdatedAt: new Date(),
    contractAddress,
  });
  it("keeps every vector asset and drops a mismatched / missing / invalid mint", () => {
    for (const a of V.assets as Any[])
      expect(
        contractBinding({ assetId: a.asset_id, blockchain: a.blockchain, contractAddress: a.token.address }),
      ).toBeNull();
    const usdc = V.assets[1];
    const drops: string[] = [];
    const rows = registryRows(
      true,
      [
        tok(usdc.asset_id, usdc.token.address),
        tok(usdc.asset_id.replace("5ce3", "5ce4"), usdc.token.address),
        tok(V.assets[2].asset_id, null),
        tok("nep141:sol-0000000000000000000000000000000000000000.omft.near", "0OIl"),
      ],
      profiles,
      { onDrop: (_id, reason) => drops.push(reason) },
    );
    expect(rows.map((r) => r.asset_id)).toEqual([usdc.asset_id]);
    expect(drops).toEqual([
      "SPL mint does not reproduce the asset id",
      "SPL asset without a mint",
      "SPL mint is not a Solana address",
    ]);
    expect(rows[0]).toMatchObject({ chain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", enabled: true });
    // `1cs_v1:` ids are not NEAR Intents asset ids: ignored
    expect(registryRows(true, [tok("1cs_v1:sol:spl:EPjF", "x")], profiles)).toEqual([]);
  });
});

describe("sandbox transfers keep Solana addresses case-sensitive", () => {
  it("lower-cases EVM/NEAR/Bitcoin only", () => {
    const t = [{ token: "a", from: "Sender1", to: "H314ws4NAZj5cXEzLVXyLZ3vrwWYuhDEz2cSa5EMs7DR", amount: "1" }];
    expect(simTransfers(t, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")[0]).toMatchObject({
      to: "H314ws4NAZj5cXEzLVXyLZ3vrwWYuhDEz2cSa5EMs7DR",
      from: "Sender1",
    });
    expect(simTransfers(t)[0]?.to).toBe("h314ws4nazj5cxezlvxylz3vrwwyuhdez2csa5ems7dr");
    expect(toKey("bip122:000000000019d6689c085ae165831e93", "BC1QABC")).toBe("bc1qabc");
    expect(simTransfers([{ ...t[0], from: "" } as Any], "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")[0]?.from).toBeNull();
  });
});

describe("vault event forwarding rules (§8.6, spec vault.json)", () => {
  const VAULT_ID = "v1.vault.nearpay.near";
  const ctx = {
    vaultContract: VAULT_ID,
    final: true,
    blockHeight: 140_000_000,
    blockHash: "9mVQ7kT1i3t5aZ7wbhZVxw3Q7xD6hgf1tGJ2bA7uR3rC",
    blockTimestamp: "1794268800000000000",
  };
  const receipt = (logs: string[], o: Partial<VaultReceipt> = {}): VaultReceipt => ({
    receiptId: "8RK6Dn9EaLwVb5nN3x9yrZfP6qz5mC8cQbqvYyYz2gHq",
    txHash: "4bWb9XzwJ2w3F7C2dWbNN1pYxQX7bGk8C5fDf3h1Jq8y",
    executor: VAULT_ID,
    logs,
    success: true,
    ...o,
  });

  it("every vector line parses and forwards with its log index", () => {
    const lines = (VAULT.events as Any[]).map((e) => e.log as string);
    for (const e of VAULT.events as Any[]) expect(parseVaultEventLog(e.log)).toEqual(e.event);
    const out = vaultEventsOf(receipt(["Transfer 10 from a to b", ...lines]), ctx);
    expect(out.rejected).toEqual([]);
    expect(out.records).toHaveLength(lines.length);
    out.records.forEach((r, i) => {
      expect(VaultEventRecord.parse(r)).toEqual(r);
      expect(r.log_index).toBe(i + 1);
      expect(r.event).toEqual(VAULT.events[i].event);
      expect(vaultEventDedupeKey(r)).toBe(`${receipt([]).receiptId}:${i + 1}`);
    });
  });

  const line = VAULT.events[0].log as string;
  it.each([
    ["wrong_executor", receipt([line], { executor: "evil.near" }), ctx],
    ["failed_receipt", receipt([line], { success: false }), ctx],
    ["not_final", receipt([line]), { ...ctx, final: false }],
    ["bad_version", receipt([line.replace('"1.0.0"', '"1.0.1"')]), ctx],
    ["bad_schema", receipt([line.replace('"mandate_id":7', '"mandate_id":"7"')]), ctx],
    [
      "bad_schema",
      receipt(['EVENT_JSON:{"standard":"nearpay_vault","version":"1.0.0","event":"rugged","data":[{}]}']),
      ctx,
    ],
    ["bad_schema", receipt([line]), { ...ctx, blockTimestamp: null }],
  ])("drops %s", (reason, r, c) => {
    const out = vaultEventsOf(r, c);
    expect(out.records).toEqual([]);
    expect(out.rejected).toEqual([reason]);
  });

  it("ignores lines of other standards and malformed JSON; explicit log indexes win", () => {
    const out = vaultEventsOf(
      receipt(
        [
          'EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[]}',
          "EVENT_JSON:{nearpay_vault",
          line,
        ],
        { logIndexes: [4, 5, 9] },
      ),
      ctx,
    );
    expect(out.rejected).toEqual([]);
    expect(out.records.map((r) => r.log_index)).toEqual([9]);
    // a receipt without a tx hash falls back to its receipt id
    expect(vaultEventsOf(receipt([line], { txHash: null }), ctx).records[0]?.tx_hash).toBe(receipt([]).receiptId);
  });

  it("aggregate uuid is deterministic and well-formed", () => {
    const a = aggregateUuid(`${VAULT_ID}#7`);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(aggregateUuid(`${VAULT_ID}#7`)).toBe(a);
    expect(aggregateUuid(`${VAULT_ID}#8`)).not.toBe(a);
  });
});
