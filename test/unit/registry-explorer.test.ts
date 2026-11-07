import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadProfiles } from "../../src/app/services.js";
import { registryRows, tokenContract } from "../../src/domain/token-registry/registry.js";
import { explorerRows } from "../../src/infra/clients/explorer.js";
import { parseTokens } from "../../src/providers/oneclick/client.js";

const text = (p: string) => readFileSync(new URL(`../fixtures/${p}`, import.meta.url), "utf8");

describe("token registry Stage 2 fields", () => {
  const tokens = parseTokens(text("oneclick/tokens.json"));
  const rows = registryRows(true, tokens, loadProfiles(), {
    pegs: { "nep141:eure.near": "eur" },
    coingeckoIds: { "nep141:wrap.near": "near" },
  });
  const by = (id: string) => rows.find((r) => r.asset_id === id);

  it("prices keep their source digits as exact ratios; coingeckoId carried (overrides win)", () => {
    const usdc = by("nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
    expect(usdc?.price_usd).toBe("0.999442");
    expect(usdc).toMatchObject({
      price_num: "499721",
      price_den: "500000",
      peg_currency: "usd",
      coingecko_id: "usd-coin",
    });
    expect(by("nep141:wrap.near")).toMatchObject({ coingecko_id: "near", peg_currency: null });
  });

  it("parseTokens accepts an already-parsed body (shortest decimal of the number)", () => {
    const t = parseTokens([
      {
        assetId: "nep141:x.near",
        decimals: 6,
        blockchain: "near",
        symbol: "X",
        price: 0.5,
        priceUpdatedAt: "2026-11-06T00:00:00Z",
      },
    ]);
    expect(t[0]).toMatchObject({ priceUsd: "0.5", coingeckoId: null, contractAddress: null });
    const peg = registryRows(true, [{ ...(t[0] as (typeof t)[number]), assetId: "nep141:eure.near" }], loadProfiles(), {
      pegs: { "nep141:eure.near": "eur" },
    });
    expect(peg[0]?.peg_currency).toBe("eur");
  });

  it("tokenContract maps chain families (CR-15-06)", () => {
    expect(tokenContract("evm", "0xabc")).toEqual({ standard: "erc20", address: "0xabc" });
    expect(tokenContract("evm", null)).toEqual({ standard: "native", address: null });
    expect(tokenContract("near", "wrap.near")).toEqual({ standard: "nep141", address: "wrap.near" });
    expect(tokenContract("near", "")).toEqual({ standard: "native", address: null });
    expect(tokenContract("solana", "So1")).toEqual({ standard: "spl", address: "So1" });
    expect(tokenContract("solana", null)).toEqual({ standard: "native", address: null });
    expect(tokenContract("bitcoin", "x")).toEqual({ standard: "native", address: null });
    expect(tokenContract(undefined, "x")).toEqual({ standard: "other", address: "x" });
  });
});

describe("Explorer rows (spec ExplorerTransaction)", () => {
  it("keeps valid rows with live nulls, drops and counts malformed ones", () => {
    let dropped = 0;
    const rows = explorerRows(JSON.parse(text("explorer/transactions.json")), (n) => {
      dropped = n;
    });
    expect(rows.map((r) => r.status)).toEqual(["PROCESSING", "SUCCESS"]);
    expect(rows[0]?.depositMemo).toBeNull();
    expect(dropped).toBe(1);
    expect(() => explorerRows({})).toThrow();
  });
});
