/**
 * Asset id shapes (spec 0.5.2 parseAssetId; incident 2026-11-11: `omdep` ids appeared in the live 1Click list):
 * SPL binding for omft, omdep (`sol-0x<hash20>`) and `1cs_v1:sol:spl:<mint>`, the settlement-mint check the Solana
 * verifier uses, and the drift check (ALERT unknown_asset_id_shape / asset_id_chain_disagrees).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadProfiles } from "../../src/app/services.js";
import { splAssetHash, splMintMatchesAssetId } from "../../src/domain/chains/solana.js";
import { assetIdDrift, contractBinding, registryRows } from "../../src/domain/token-registry/registry.js";
import { parseTokens } from "../../src/providers/oneclick/client.js";

const tokens = parseTokens(readFileSync(new URL("../fixtures/oneclick/tokens.json", import.meta.url), "utf8"));
const PENGU = "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv";
const PENGU_ID = "nep141:sol-0xaad74c68eecfc9f8c5bdcea614f6167048c795ef.omdep.near";

describe("SPL binding (omft, omdep, 1cs_v1)", () => {
  it("every entry of the live list is consistent (none dropped); omdep ids enter the registry, 1cs_v1 ids stay outside the AssetId contract", () => {
    const dropped: string[] = [];
    const rows = registryRows(true, tokens, loadProfiles(), { onDrop: (id) => dropped.push(id) });
    expect(dropped).toEqual([]);
    expect(rows.some((r) => r.asset_id === PENGU_ID)).toBe(true);
    expect(rows.some((r) => r.asset_id.startsWith("1cs_v1:"))).toBe(false);
  });

  it("an omdep Solana id binds to the mint whose keccak hash it names", () => {
    expect(splAssetHash(PENGU)).toBe("aad74c68eecfc9f8c5bdcea614f6167048c795ef");
    expect(contractBinding({ assetId: PENGU_ID, blockchain: "sol", contractAddress: PENGU })).toBeNull();
    expect(
      contractBinding({
        assetId: PENGU_ID,
        blockchain: "sol",
        contractAddress: "USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB",
      }),
    ).toBe("SPL mint does not reproduce the asset id");
    expect(contractBinding({ assetId: PENGU_ID, blockchain: "sol", contractAddress: null })).toBe(
      "SPL asset without a mint",
    );
    expect(contractBinding({ assetId: PENGU_ID, blockchain: "sol", contractAddress: "0xnope" })).toBe(
      "SPL mint is not a Solana address",
    );
  });

  it("1cs_v1:sol:spl binds to exactly its mint; non-SPL ids are not bound", () => {
    const id = "1cs_v1:sol:spl:A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";
    expect(
      contractBinding({
        assetId: id,
        blockchain: "sol",
        contractAddress: "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS",
      }),
    ).toBeNull();
    expect(contractBinding({ assetId: id, blockchain: "sol", contractAddress: PENGU })).toBe(
      "SPL mint does not reproduce the asset id",
    );
    expect(
      contractBinding({
        assetId: "nep141:bnb-0x55d398326f99059ff775485246999027b3197955.omdep.near",
        blockchain: "bsc",
        contractAddress: "0x55d398326f99059ff775485246999027b3197955",
      }),
    ).toBeNull();
  });

  it("the verifier's settlement-mint check accepts omft, omdep and 1cs_v1 Solana ids", () => {
    expect(splMintMatchesAssetId(PENGU, PENGU_ID)).toBe(true);
    expect(splMintMatchesAssetId(PENGU, "nep141:sol-aad74c68eecfc9f8c5bdcea614f6167048c795ef.omft.near")).toBe(true);
    expect(splMintMatchesAssetId(PENGU, `1cs_v1:sol:spl:${PENGU}`)).toBe(true);
    expect(splMintMatchesAssetId(PENGU, "nep141:sol.omft.near")).toBe(false);
    expect(splMintMatchesAssetId("not-a-mint", PENGU_ID)).toBe(false);
  });
});

describe("drift check", () => {
  it("the live list: every id is recognised; only strk-….omdep.near (listed on NEAR) disagrees", () => {
    const drift = tokens.map((t) => [t.assetId, assetIdDrift(t)] as const).filter(([, d]) => d !== null);
    expect(drift).toEqual([
      [
        "nep141:strk-0xe646ef2a705bf5147ceffc8dfbcc7bee4946b8f7.omdep.near",
        { kind: "chain_disagrees", id_blockchain: "strk", blockchain: "near" },
      ],
    ]);
  });

  it.each([
    [{ assetId: "nep141:bnb-0x55d398326f99059ff775485246999027b3197955.omdep.near", blockchain: "bsc" }, null],
    [{ assetId: "nep245:v2_1.omni.hot.tg:56_11111111111111111111", blockchain: "bsc" }, null],
    [{ assetId: "nep141:eth.bridge.near", blockchain: "near" }, null],
    [
      { assetId: "nep141:bnb-0x55d398326f99059ff775485246999027b3197955.omzzz.near", blockchain: "bsc" },
      "unknown_shape",
    ],
    [{ assetId: "2cs_v2:bsc:bep20:0x55d398326f99059ff775485246999027b3197955", blockchain: "bsc" }, "unknown_shape"],
    [
      { assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", blockchain: "base" },
      "chain_disagrees",
    ],
  ])("%o → %s", (t, kind) => expect(assetIdDrift(t)?.kind ?? null).toBe(kind));

  it("registryRows reports drift and keeps the entry (the chain comes from blockchain)", () => {
    const seen: [string, string][] = [];
    const rows = registryRows(
      true,
      [
        {
          ...tokens[0],
          assetId: "nep141:bnb-0x55d398326f99059ff775485246999027b3197955.omzzz.near",
          blockchain: "bsc",
        } as never,
      ],
      loadProfiles(),
      { onDrift: (id, d) => seen.push([id, d.kind]) },
    );
    expect(seen).toEqual([["nep141:bnb-0x55d398326f99059ff775485246999027b3197955.omzzz.near", "unknown_shape"]]);
    expect(rows).toHaveLength(1);
  });
});
