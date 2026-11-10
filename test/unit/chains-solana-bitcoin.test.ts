/** Solana and Bitcoin parsing against the spec vectors (lld/rails.md §21, spec 0.4.2 `chains-solana-bitcoin.json`). */

import {
  BITCOIN_CONFIRMATION_TIERS,
  BITCOIN_DEFAULT_CONFIRMATION_TIERS,
  BitcoinEvidence,
  parseOmftAssetId,
  requiredConfirmations,
  SolanaEvidence,
} from "@nearpay/spec";
import { describe, expect, it } from "vitest";
import {
  checkBitcoinTransfer,
  confirmationsAt,
  confirmationsRequired,
  type EsploraTx,
  maxConfirmations,
  normalizeBitcoinAddress,
  outputsTo,
  scriptToAddress,
  snapshotUsdMicros,
} from "../../src/domain/chains/bitcoin.js";
import {
  accountKeys,
  associatedTokenAddress,
  checkSolanaTransfer,
  decodeSolanaAddress,
  findProgramAddress,
  isOnCurve,
  type SolanaTx,
  solanaDelta,
  splAssetId,
  TOKEN_PROGRAM,
} from "../../src/domain/chains/solana.js";
import { ONE_CONFIRMATION } from "../../src/domain/token-registry/chain-profiles.js";
import { specVector } from "../support/vectors.js";

// biome-ignore lint/suspicious/noExplicitAny: vector JSON
type Any = any;
const V = specVector<Any>("chains-solana-bitcoin.json");
const T = specVector<Any>("solana-transfer.json");

describe("Solana addresses, ATAs and omft ids", () => {
  it("decodes only 32-byte base58 addresses (vector address rules)", () => {
    for (const a of V.addresses.solana) {
      expect(decodeSolanaAddress(a.address) !== null, a.address).toBe(a.valid);
      if (a.valid) expect(isOnCurve(decodeSolanaAddress(a.address) as Uint8Array), a.address).toBe(a.on_curve);
    }
  });

  it("derives the associated token accounts of the vectors (address and bump)", () => {
    expect(associatedTokenAddress(T.inputs.payer, T.spl.mint)).toEqual(T.spl.payer_ata);
    expect(associatedTokenAddress(T.inputs.deposit_address, T.spl.mint)).toEqual(T.spl.deposit_ata);
    // the merchant ATA of the evidence vectors
    const ataCase = V.evidence.solana.cases[0];
    expect(associatedTokenAddress(ataCase.evidence.recipient, ataCase.evidence.solana.mint).address).toBe(
      ataCase.evidence.solana.token_accounts[0],
    );
  });

  it("refuses non-addresses", () => {
    expect(() => associatedTokenAddress("nope", T.spl.mint)).toThrow(RangeError);
    expect(() => findProgramAddress([], "nope")).toThrow(RangeError);
    expect(() => splAssetId("0")).toThrow(RangeError);
  });

  it("reproduces the SPL omft asset ids and parses omft ids", () => {
    for (const m of V.omft.spl_mints) expect(splAssetId(m.mint)).toBe(m.asset_id);
    for (const c of V.omft.cases) expect(parseOmftAssetId(c.asset_id)).toEqual(c.parsed);
    for (const a of V.assets.filter((x: Any) => x.token.standard === "spl"))
      expect(splAssetId(a.token.address)).toBe(a.asset_id);
  });
});

describe("Solana evidence (vector cases)", () => {
  const expectedOf = (c: Any) => BigInt(c.expected_amount ?? V.evidence.solana.expected_amount);
  for (const c of V.evidence.solana.cases as Any[]) {
    it(c.name, () => {
      const owner = "H314ws4NAZj5cXEzLVXyLZ3vrwWYuhDEz2cSa5EMs7DR";
      const mint =
        c.evidence?.solana?.mint ?? (c.name.startsWith("SOL") ? null : "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
      const sig = c.rpc_result.transaction.signatures[0];
      const r = checkSolanaTransfer(c.rpc_result as SolanaTx, sig, { owner, mint, expected: expectedOf(c) });
      if (c.evidence === null) {
        expect(r.kind).toBe("failed");
        return;
      }
      expect(r.kind).toBe("transfer");
      if (r.kind !== "transfer") return;
      expect(r.result).toBe(c.result);
      expect(r.amount.toString()).toBe(c.evidence.amount);
      expect(r.detail).toEqual(c.evidence.solana);
      expect(SolanaEvidence.parse(r.detail)).toEqual(c.evidence.solana);
      // §21.3 sender: the wallet whose balance fell (the vectors leave Evidence.sender null; rails fills it)
      expect(r.sender).toBe("bHc9jeXo4NK4ma1W4aLwU5REmqhzTKnzXq79JEeb3Dq");
    });
  }

  it("short and mismatch against the expectation", () => {
    const c = V.evidence.solana.cases[0];
    const sig = c.rpc_result.transaction.signatures[0];
    const owner = c.evidence.recipient;
    const mint = c.evidence.solana.mint;
    const short = checkSolanaTransfer(c.rpc_result, sig, { owner, mint, expected: 25_000_001n });
    expect(short).toMatchObject({ kind: "transfer", result: "short", amount: 25_000_000n });
    const other = checkSolanaTransfer(c.rpc_result, sig, { owner: T.inputs.payer, mint, expected: 1n });
    expect(other).toMatchObject({ kind: "transfer", result: "mismatch", amount: 0n, sender: null });
    // the solver itself paid: its delta is negative → mismatch
    const solver = checkSolanaTransfer(c.rpc_result, sig, {
      owner: "bHc9jeXo4NK4ma1W4aLwU5REmqhzTKnzXq79JEeb3Dq",
      mint,
      expected: 1n,
    });
    expect(solver).toMatchObject({ result: "mismatch", amount: 0n });
    // SOL to an account not in the transaction
    const sol = V.evidence.solana.cases[2];
    expect(checkSolanaTransfer(sol.rpc_result, "x", { owner: T.inputs.payer, mint: null, expected: 1n })).toMatchObject(
      {
        result: "mismatch",
      },
    );
  });

  it("malformed results prove nothing", () => {
    const c = structuredClone(V.evidence.solana.cases[0].rpc_result);
    expect(checkSolanaTransfer({ ...c, meta: null }, "s", { owner: "a", mint: null, expected: 1n }).kind).toBe(
      "malformed",
    );
    expect(checkSolanaTransfer({ ...c, slot: -1 }, "s", { owner: "a", mint: null, expected: 1n }).kind).toBe(
      "malformed",
    );
    const bad = structuredClone(c);
    bad.meta.postTokenBalances[1].uiTokenAmount.amount = "1.5";
    expect(
      checkSolanaTransfer(bad, "s", { owner: c.transaction.message.accountKeys[3], mint: T.spl.mint, expected: 1n })
        .kind,
    ).toBe("malformed");
    const badSol = structuredClone(V.evidence.solana.cases[2].rpc_result);
    badSol.meta.postBalances[1] = -5;
    expect(solanaDelta(badSol, "H314ws4NAZj5cXEzLVXyLZ3vrwWYuhDEz2cSa5EMs7DR", null)).toBeNull();
    // a null block time is kept null
    const noTime = { ...structuredClone(V.evidence.solana.cases[2].rpc_result), blockTime: null };
    const r = checkSolanaTransfer(noTime, "s", {
      owner: "H314ws4NAZj5cXEzLVXyLZ3vrwWYuhDEz2cSa5EMs7DR",
      mint: null,
      expected: 1n,
    });
    expect(r.kind === "transfer" && r.detail.block_time).toBeNull();
  });

  it("account keys: jsonParsed objects, json + loaded addresses", () => {
    const base = V.evidence.solana.cases[2].rpc_result as SolanaTx;
    const parsed = {
      ...base,
      transaction: {
        ...base.transaction,
        message: {
          accountKeys: [
            { pubkey: "A1", source: "transaction" },
            { pubkey: "A2", source: "lookupTable" },
          ],
        },
      },
      meta: { ...(base.meta as object), loadedAddresses: { writable: ["A2"], readonly: [] } },
    } as unknown as SolanaTx;
    expect(accountKeys(parsed)).toEqual(["A1", "A2"]);
    const json = {
      ...base,
      meta: { ...(base.meta as object), loadedAddresses: { writable: ["W"], readonly: ["R"] } },
    } as unknown as SolanaTx;
    expect(accountKeys(json).slice(-2)).toEqual(["W", "R"]);
    expect(accountKeys({ ...base, meta: null })).toHaveLength(3);
  });

  it("two wallets whose balance fell enough: no sender", () => {
    const c = structuredClone(V.evidence.solana.cases[2].rpc_result);
    c.transaction.message.accountKeys.push("EyjEeiTxb4rvkoN3ZA2zTimuc6VyF8V1QuH9TT66Gkn6");
    c.meta.preBalances.push(3_000_000_000);
    c.meta.postBalances.push(1_000_000_000);
    const d = solanaDelta(c, "H314ws4NAZj5cXEzLVXyLZ3vrwWYuhDEz2cSa5EMs7DR", null);
    expect(d?.sender).toBeNull();
    expect(d?.amount).toBe(1_500_000_000n);
  });

  it("SPL without a programId on the balances defaults to the Token program", () => {
    const c = structuredClone(V.evidence.solana.cases[0].rpc_result);
    for (const b of [...c.meta.preTokenBalances, ...c.meta.postTokenBalances]) delete b.programId;
    const d = solanaDelta(c, "H314ws4NAZj5cXEzLVXyLZ3vrwWYuhDEz2cSa5EMs7DR", T.spl.mint);
    expect(d?.tokenProgram).toBe(TOKEN_PROGRAM);
    const none = solanaDelta(c, T.inputs.payer, T.spl.mint);
    expect(none?.tokenProgram).toBeNull();
  });
});

describe("Bitcoin scripts and addresses", () => {
  it("re-derives the vector addresses from their scripts", () => {
    for (const c of V.evidence.bitcoin.cases as Any[])
      for (const o of c.esplora_tx.vout) expect(scriptToAddress(o.scriptpubkey)).toBe(o.scriptpubkey_address);
  });

  it("encodes P2PKH, P2SH, P2WSH and refuses non-address scripts", () => {
    expect(scriptToAddress("76a91412ab8dc588ca9d5787dde7eb29569da63c3a238c88ac")).toMatch(/^1/);
    expect(scriptToAddress("a91489abcdefabbaabbaabbaabbaabbaabbaabbaabba87")).toMatch(/^3/);
    expect(scriptToAddress(`0020${"11".repeat(32)}`)).toMatch(/^bc1q.{58}$/);
    expect(scriptToAddress("6a0b68656c6c6f")).toBeNull(); // OP_RETURN
    expect(scriptToAddress(`0015${"11".repeat(21)}`)).toBeNull(); // v0 program of 21 bytes
    expect(scriptToAddress("5101ff")).toBeNull(); // 1-byte program
    expect(scriptToAddress("zz")).toBeNull();
    expect(scriptToAddress("")).toBeNull();
    expect(normalizeBitcoinAddress("BC1QGJVRFV789JCLS63Y95CGAN53LQ88JNUH32W0FQ")).toBe(
      "bc1qgjvrfv789jcls63y95cgan53lq88jnuh32w0fq",
    );
    expect(normalizeBitcoinAddress("12HWMKcfvshJ1dJo1kBX3jaguexKF5UeXY")).toBe("12HWMKcfvshJ1dJo1kBX3jaguexKF5UeXY");
  });
});

describe("Bitcoin evidence (vector cases)", () => {
  it("confirmation tiers: 1 for every amount by default; the Stage 4 USD tiers as an opt-in override", () => {
    const tiers = V.evidence.bitcoin.tiers;
    expect(tiers).toEqual(BITCOIN_DEFAULT_CONFIRMATION_TIERS);
    expect(tiers).toEqual(ONE_CONFIRMATION);
    for (const c of V.evidence.bitcoin.required_confirmations)
      expect(requiredConfirmations(tiers, BigInt(c.usd_micros))).toBe(c.confirmations);
    expect(maxConfirmations(tiers)).toBe(1);
    expect(confirmationsRequired(tiers, null)).toBe(1);
    expect(V.evidence.bitcoin.override_tiers).toEqual(BITCOIN_CONFIRMATION_TIERS);
    for (const c of V.evidence.bitcoin.override_required_confirmations)
      expect(requiredConfirmations(BITCOIN_CONFIRMATION_TIERS, BigInt(c.usd_micros))).toBe(c.confirmations);
    expect(maxConfirmations(BITCOIN_CONFIRMATION_TIERS)).toBe(2);
    expect(confirmationsRequired(BITCOIN_CONFIRMATION_TIERS, null)).toBe(2);
    expect(() => requiredConfirmations([{ below_usd_micros: 5, confirmations: 1 }], 10n)).toThrow(RangeError);
  });

  for (const c of V.evidence.bitcoin.cases as Any[]) {
    it(c.name, () => {
      const required = confirmationsRequired(V.evidence.bitcoin.tiers, BigInt(c.settlement_usd_micros));
      const r = checkBitcoinTransfer(c.esplora_tx as EsploraTx, c.tip_height, {
        address: "bc1qgjvrfv789jcls63y95cgan53lq88jnuh32w0fq",
        expected: BigInt(c.expected_amount),
        required,
      });
      if (c.result === "not_final") {
        expect(r.kind).toBe("not_final");
        return;
      }
      expect(r.kind).toBe("transfer");
      if (r.kind !== "transfer") return;
      expect(r.result).toBe(c.result);
      expect(r.amount.toString()).toBe(c.evidence.amount);
      expect(r.detail).toEqual(c.evidence.bitcoin);
      expect(BitcoinEvidence.parse(r.detail)).toEqual(c.evidence.bitcoin);
    });
  }

  it("short, mismatch and odd node states", () => {
    const c = V.evidence.bitcoin.cases[0];
    const at = (tx: EsploraTx, tip: number, expected: bigint, address = "bc1qgjvrfv789jcls63y95cgan53lq88jnuh32w0fq") =>
      checkBitcoinTransfer(tx, tip, { address, expected, required: 1 });
    expect(at(c.esplora_tx, 900000, 625_001n)).toMatchObject({ kind: "transfer", result: "short" });
    expect(at(c.esplora_tx, 900000, 1n, "bc1qpct5sxzppv204tth290uen85nqkhzw9sq5m0ku")).toEqual({ kind: "mismatch" });
    // a node whose tip is behind the block: not final
    expect(at(c.esplora_tx, 899999, 1n).kind).toBe("not_final");
    // confirmed without a block hash: not final (cannot record the block)
    const noHash = { ...c.esplora_tx, status: { confirmed: true, block_height: 900000 } };
    expect(at(noHash, 900005, 1n).kind).toBe("not_final");
    expect(confirmationsAt({ ...c.esplora_tx, status: { confirmed: true, block_height: -1 } }, 5)).toBe(0);
    // negative / unsafe output values are ignored
    const bad = { ...c.esplora_tx, vout: [{ ...c.esplora_tx.vout[0], value: -1 }] };
    expect(outputsTo(bad, "bc1qgjvrfv789jcls63y95cgan53lq88jnuh32w0fq")).toEqual([]);
  });

  it("USD value from the price snapshot (higher of the two prices, unknown → null)", () => {
    expect(snapshotUsdMicros(100_000_000n, 8, { primary_usd: "80000", secondary_usd: "80100.5" })).toBe(
      80_100_500_000n,
    );
    expect(snapshotUsdMicros(625_000n, 8, { primary_usd: "80000", secondary_usd: null })).toBe(500_000_000n);
    expect(snapshotUsdMicros(1n, 8, { primary_usd: "junk", secondary_usd: null })).toBeNull();
    expect(snapshotUsdMicros(1n, 8, null)).toBeNull();
  });
});

describe("Bitcoin address → script", () => {
  it("round-trips the vector addresses and refuses others", async () => {
    const { addressToScript } = await import("../../src/domain/chains/bitcoin.js");
    for (const c of V.evidence.bitcoin.cases as Any[])
      for (const o of c.esplora_tx.vout) expect(addressToScript(o.scriptpubkey_address)).toBe(o.scriptpubkey);
    for (const a of V.addresses.bitcoin as Any[]) {
      const script = addressToScript(a.address);
      if (a.valid && a.normalized.startsWith("bc1")) expect(scriptToAddress(script as string)).toBe(a.normalized);
      else expect(script).toBeNull();
    }
  });
});
