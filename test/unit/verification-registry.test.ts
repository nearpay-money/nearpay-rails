import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { chainProfiles, ProfileError } from "../../src/domain/token-registry/chain-profiles.js";
import { familyOf, registryRows, routeClass } from "../../src/domain/token-registry/registry.js";
import {
  attribute,
  compareTransfers,
  minimumUsdMicros,
  tierBAllowed,
} from "../../src/domain/verification/verification.js";
import { parseTokens } from "../../src/providers/oneclick/client.js";

const profiles = chainProfiles(parseYaml(readFileSync(new URL("../../config/chains.yaml", import.meta.url), "utf8")));
const tokensJson = JSON.parse(readFileSync(new URL("../fixtures/oneclick/tokens.json", import.meta.url), "utf8"));

describe("evidence comparison (§8.8)", () => {
  const expect_ = { recipient: "0xabc", assetId: "nep141:usdc", expected: 100n };
  it("sums transfers of the asset to the recipient", () => {
    expect(compareTransfers([{ to: "0xabc", assetId: "nep141:usdc", amount: 100n }], expect_)).toEqual({
      result: "pass",
      amount: 100n,
      sender: null,
    });
    expect(
      compareTransfers(
        [
          { to: "0xabc", assetId: "nep141:usdc", amount: 60n },
          { to: "0xabc", assetId: "nep141:usdc", amount: 50n },
        ],
        expect_,
      ),
    ).toEqual({ result: "pass", amount: 110n, sender: null });
    expect(compareTransfers([{ to: "0xabc", assetId: "nep141:usdc", amount: 99n }], expect_)).toEqual({
      result: "short",
      amount: 99n,
      sender: null,
    });
    expect(
      compareTransfers(
        [
          { to: "0xdef", assetId: "nep141:usdc", amount: 100n },
          { to: "0xabc", assetId: "nep141:usdt", amount: 100n },
          { to: "0xabc", assetId: "nep141:usdc", amount: 0n },
        ],
        expect_,
      ),
    ).toEqual({ result: "mismatch", amount: 0n, sender: null });
  });

  it("names the sender of the largest counted transfer (spec 0.3.0 Evidence.sender)", () => {
    expect(
      compareTransfers(
        [
          { to: "0xabc", from: "solver-a.near", assetId: "nep141:usdc", amount: 40n },
          { to: "0xabc", from: "solver-b.near", assetId: "nep141:usdc", amount: 70n },
          { to: "0xdef", from: "other.near", assetId: "nep141:usdc", amount: 500n },
          { to: "0xabc", from: "wrong-asset.near", assetId: "nep141:usdt", amount: 900n },
        ],
        expect_,
      ),
    ).toEqual({ result: "pass", amount: 110n, sender: "solver-b.near" });
    // a tie keeps the first; a short settlement still names its sender; a mismatch names none
    expect(
      compareTransfers(
        [
          { to: "0xabc", from: "first.near", assetId: "nep141:usdc", amount: 30n },
          { to: "0xabc", from: "second.near", assetId: "nep141:usdc", amount: 30n },
        ],
        expect_,
      ),
    ).toEqual({ result: "short", amount: 60n, sender: "first.near" });
    expect(
      compareTransfers([{ to: "0xdef", from: "x.near", assetId: "nep141:usdc", amount: 100n }], expect_).sender,
    ).toBeNull();
  });

  it("attributes by exact amount only when unambiguous", () => {
    const c = [
      { id: "a", expected: 100n },
      { id: "b", expected: 101n },
      { id: "c", expected: 101n },
    ];
    expect(attribute(c, 100n)?.id).toBe("a");
    expect(attribute(c, 101n)).toBeNull();
    expect(attribute(c, 102n)).toBeNull();
  });

  it("Tier B limits", () => {
    const limits = { perPaymentUsdMicros: 2_000_000_000n, perDayUsdMicros: 20_000_000_000n };
    expect(tierBAllowed(1_000_000n, 0n, limits)).toEqual({ ok: true });
    expect(tierBAllowed(2_000_000_001n, 0n, limits).ok).toBe(false);
    expect(tierBAllowed(1_000_000_000n, 19_500_000_000n, limits).ok).toBe(false);
    expect(tierBAllowed(null, 0n, limits).ok).toBe(false);
  });

  it("minimums: max(USD 1, 20 × withdraw fee); Intents USD 0.01", () => {
    expect(minimumUsdMicros("intents", null)).toBe(10_000n);
    expect(minimumUsdMicros("chain", 20_000n)).toBe(1_000_000n);
    expect(minimumUsdMicros("chain", 500_000n)).toBe(10_000_000n);
    expect(minimumUsdMicros("chain", null)).toBeNull();
  });
});

describe("chain profiles", () => {
  it("loads the shipped profiles: Tier A NEAR, Ethereum, Base, Arbitrum with watchers on EVM", () => {
    const a = profiles.all().filter((p) => p.tier === "A");
    expect(a.map((p) => p.chain).sort()).toEqual(["eip155:1", "eip155:42161", "eip155:8453", "near:mainnet"]);
    expect(
      profiles
        .all()
        .filter((p) => p.watcher)
        .map((p) => p.chain)
        .sort(),
    ).toEqual(["eip155:1", "eip155:42161", "eip155:8453"]);
    expect(profiles.byBlockchain("base")?.chain).toBe("eip155:8453");
    expect(profiles.view(profiles.get("eip155:8453") as never)).toMatchObject({
      blockchain: "base",
      family: "evm",
      tier: "A",
      memo_mode: "none",
      explorer_tx_url: "https://basescan.org/tx/{tx}",
    });
  });

  it.each([
    [{ chains: [] }, /invalid chain profiles/],
    [
      {
        chains: [
          {
            chain: "eip155:999999",
            blockchain: "zzz",
            tier: "A",
            min_deadline_s: 60,
            default_deadline_s: 60,
            finality: "x",
            verification_timeout_s: 60,
            memo_mode: "none",
          },
        ],
      },
      /unknown chain/,
    ],
    [
      {
        chains: [
          {
            chain: "eip155:8453",
            blockchain: "eth",
            tier: "A",
            min_deadline_s: 60,
            default_deadline_s: 60,
            finality: "x",
            verification_timeout_s: 60,
            memo_mode: "none",
          },
        ],
      },
      /blockchain eth/,
    ],
    [
      {
        chains: [
          {
            chain: "eip155:8453",
            blockchain: "base",
            tier: "A",
            min_deadline_s: 600,
            default_deadline_s: 60,
            finality: "x",
            verification_timeout_s: 60,
            memo_mode: "none",
          },
        ],
      },
      /min_deadline_s exceeds/,
    ],
    [
      {
        chains: [
          {
            chain: "near:mainnet",
            blockchain: "near",
            tier: "A",
            watcher: true,
            min_deadline_s: 60,
            default_deadline_s: 60,
            finality: "x",
            verification_timeout_s: 60,
            memo_mode: "none",
          },
        ],
      },
      /EVM chains only/,
    ],
    [
      {
        chains: [
          {
            chain: "eip155:10",
            blockchain: "op",
            tier: "B",
            watcher: true,
            min_deadline_s: 60,
            default_deadline_s: 60,
            finality: "x",
            verification_timeout_s: 60,
            memo_mode: "none",
          },
        ],
      },
      /Tier A/,
    ],
  ])("rejects an invalid profile document %#", (doc, msg) => {
    expect(() => chainProfiles(doc)).toThrow(ProfileError);
    expect(() => chainProfiles(doc)).toThrow(msg);
  });

  it("rejects a chain listed twice", () => {
    const one = {
      chain: "eip155:8453",
      blockchain: "base",
      tier: "A",
      min_deadline_s: 60,
      default_deadline_s: 60,
      finality: "x",
      verification_timeout_s: 60,
      memo_mode: "none",
    };
    expect(() => chainProfiles({ chains: [one, one] })).toThrow(/listed twice/);
  });
});

describe("token registry on the recorded 1Click list", () => {
  const tokens = parseTokens(tokensJson);
  const rows = registryRows(true, tokens, profiles);

  it("keeps every NEAR Intents token and enables those on profiled chains", () => {
    expect(tokens.length).toBe(215);
    // 27 entries are 1Click's own `1cs_v1:` asset ids (not NEAR Intents assets): not routable by NearPay
    expect(tokens.filter((t) => t.assetId.startsWith("1cs_v1:"))).toHaveLength(27);
    expect(rows.length).toBe(188);
    const enabled = rows.filter((r) => r.enabled);
    expect(new Set(enabled.map((r) => r.blockchain))).toEqual(
      new Set(["near", "eth", "base", "arb", "op", "pol", "bsc", "avax", "gnosis", "sol", "btc", "ltc", "doge"]),
    );
    expect(rows.find((r) => r.blockchain === "ton")?.enabled).toBe(false);
  });

  it("classifies the USD stablecoins and families", () => {
    const usdcBase = rows.find(
      (r) => r.asset_id === "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    );
    expect(usdcBase).toMatchObject({
      chain: "eip155:8453",
      family: "USDC",
      is_usd_stable: true,
      decimals: 6,
      enabled: true,
    });
    expect(usdcBase?.price_usd).toMatch(/^0\.99/);
    const usdtNear = rows.find((r) => r.asset_id === "nep141:usdt.tether-token.near");
    expect(usdtNear).toMatchObject({ family: "USDT", is_usd_stable: true, chain: "near:mainnet" });
    const usdcNear = rows.find(
      (r) => r.asset_id === "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    );
    expect(routeClass(usdcBase as never, usdcNear as never)).toBe("same_asset");
    expect(routeClass(usdcBase as never, usdtNear as never)).toBe("stable_pair");
    const eth = rows.find((r) => r.asset_id === "nep141:base.omft.near");
    expect(routeClass(eth as never, usdcNear as never)).toBe("volatile");
    expect(routeClass(usdcBase as never, usdcBase as never)).toBe("same_asset");
  });

  it("folds wrapped families and drops malformed entries", () => {
    expect(familyOf("wNEAR")).toBe("NEAR");
    expect(familyOf(" weth ")).toBe("ETH");
    expect(familyOf("USDC")).toBe("USDC");
    const bad = registryRows(
      false,
      [
        {
          assetId: "not-an-asset",
          decimals: 6,
          blockchain: "near",
          symbol: "X",
          priceUsd: null,
          priceUpdatedAt: null,
          contractAddress: null,
        },
        {
          assetId: "nep141:a.near",
          decimals: 300,
          blockchain: "near",
          symbol: "X",
          priceUsd: null,
          priceUpdatedAt: null,
          contractAddress: null,
        },
        {
          assetId: "nep141:b.near",
          decimals: 6,
          blockchain: "near",
          symbol: "B",
          priceUsd: "1",
          priceUpdatedAt: null,
          contractAddress: null,
        },
        {
          assetId: "nep141:b.near",
          decimals: 6,
          blockchain: "near",
          symbol: "B",
          priceUsd: "1",
          priceUpdatedAt: null,
          contractAddress: null,
        },
      ],
      profiles,
    );
    expect(bad.map((r) => r.asset_id)).toEqual(["nep141:b.near"]);
    expect(parseTokens([{ nope: true }, ...tokensJson.slice(0, 1)])).toHaveLength(1);
  });
});
