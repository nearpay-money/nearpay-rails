/**
 * Stage 4 properties (lld/rails.md §21, §8.6):
 * - Solana: the evidence amount is exactly Σ post − Σ pre of the recipient's token accounts for the mint (a missing pre
 *   entry counts 0), never negative; other owners' and other mints' balances never count; a failed transaction never
 *   yields a transfer; the comparison is pass ⇔ amount ≥ expected, short ⇔ 0 < amount < expected.
 * - Bitcoin: the amount is Σ outputs paying the address, invariant under splitting an output and under foreign outputs;
 *   more confirmations never turn a final check non-final; required confirmations never decrease with USD value;
 *   the mempool never counts.
 * - Vault forwarding: a line is forwarded iff executor = vault ∧ success ∧ final ∧ schema-valid.
 */

import { BITCOIN_CONFIRMATION_TIERS } from "@nearpay-money/spec";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addressToScript,
  checkBitcoinTransfer,
  confirmationsRequired,
  type EsploraTx,
} from "../../src/domain/chains/bitcoin.js";
import { checkSolanaTransfer, type SolanaTx } from "../../src/domain/chains/solana.js";
import { destinationTagSpace, tagSpace } from "../../src/domain/execution/amounts.js";
import { vaultEventsOf } from "../../src/trackers/near-indexer/vault.js";
import { specVector } from "../support/vectors.js";

const OWNER = "H314ws4NAZj5cXEzLVXyLZ3vrwWYuhDEz2cSa5EMs7DR";
const OTHER = "bHc9jeXo4NK4ma1W4aLwU5REmqhzTKnzXq79JEeb3Dq";
const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MINT2 = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const KEYS = [
  OTHER,
  "3QBfo77iYx9FCuRaDfveumpuSQYVEwmTQy1e25nRrdwL",
  "6Pae6bB84WciurjFB1rXDJtUUW2Haiv97KvRWAbuRx5h",
  OWNER,
  "DN5C7q7RzxDXor5jNHDBxfHU5yp3M58XJXcWR4WvvyAp",
  "6kXo5suJm2RPRyJEnof9oz3FcEtXUYFoKAUhDK6CkpGQ",
];

const balanceArb = fc.record({
  accountIndex: fc.integer({ min: 0, max: KEYS.length - 1 }),
  owner: fc.constantFrom(OWNER, OTHER),
  mint: fc.constantFrom(MINT, MINT2),
  pre: fc.option(fc.bigInt({ min: 0n, max: 10n ** 15n }), { nil: null }),
  post: fc.option(fc.bigInt({ min: 0n, max: 10n ** 15n }), { nil: null }),
});

interface Entry {
  accountIndex: number;
  owner: string;
  mint: string;
  pre: bigint | null;
  post: bigint | null;
}

function solTx(entries: Entry[], err: unknown = null): SolanaTx {
  // one entry per account index (the runtime reports each token account once per side)
  const byIdx = new Map(entries.map((e) => [e.accountIndex, e]));
  const side = (k: "pre" | "post") =>
    [...byIdx.values()]
      .filter((e) => e[k] !== null)
      .map((e) => ({
        accountIndex: e.accountIndex,
        mint: e.mint,
        owner: e.owner,
        uiTokenAmount: { amount: (e[k] as bigint).toString() },
      }));
  return {
    slot: 1,
    blockTime: 1,
    meta: {
      err,
      preBalances: KEYS.map(() => 1),
      postBalances: KEYS.map(() => 1),
      preTokenBalances: side("pre"),
      postTokenBalances: side("post"),
    },
    transaction: { signatures: ["s"], message: { accountKeys: KEYS } },
  };
}

describe("Solana token-balance delta", () => {
  it("amount = Σ post − Σ pre over the owner's accounts of the mint (≥ 0), classification exact", () => {
    fc.assert(
      fc.property(fc.array(balanceArb, { maxLength: 6 }), fc.bigInt({ min: 1n, max: 10n ** 15n }), (es, expected) => {
        const tx = solTx(es);
        const byIdx = new Map(es.map((e) => [e.accountIndex, e]));
        let want = 0n;
        for (const e of byIdx.values())
          if (e.owner === OWNER && e.mint === MINT) want += (e.post ?? 0n) - (e.pre ?? 0n);
        const amount = want > 0n ? want : 0n;
        const r = checkSolanaTransfer(tx, "s", { owner: OWNER, mint: MINT, expected });
        expect(r.kind).toBe("transfer");
        if (r.kind !== "transfer") return;
        expect(r.amount).toBe(amount);
        expect(r.result).toBe(amount === 0n ? "mismatch" : amount >= expected ? "pass" : "short");
        expect(BigInt(r.detail.post_amount as string) - BigInt(r.detail.pre_amount as string)).toBe(want);
        if (amount === 0n) expect(r.sender).toBeNull();
      }),
    );
  });

  it("a failed transaction is never a transfer", () => {
    fc.assert(
      fc.property(
        fc.array(balanceArb, { maxLength: 6 }),
        fc.jsonValue().filter((v) => v !== null),
        (es, err) => {
          expect(checkSolanaTransfer(solTx(es, err), "s", { owner: OWNER, mint: MINT, expected: 1n }).kind).toBe(
            "failed",
          );
        },
      ),
    );
  });
});

const ADDR = "bc1qgjvrfv789jcls63y95cgan53lq88jnuh32w0fq";
const FOREIGN = "bc1ppg5met9kvkkqutjpjcyq2ru7v2gwym6ydrjyg2p6vkwcv58l662s8pkhzh";
const S_ADDR = addressToScript(ADDR) as string;
const S_FOREIGN = addressToScript(FOREIGN) as string;
const HASH = "8a06a53077b90166ab0ea15831f07aa1bc8b8858b168b309dfdfa0fc2f046282";

const outArb = fc.record({ mine: fc.boolean(), value: fc.integer({ min: 0, max: 2_100_000_000 }) });
const btcTx = (outs: { mine: boolean; value: number }[], confirmed = true): EsploraTx => ({
  txid: "a".repeat(64),
  vout: outs.map((o) => ({ scriptpubkey: o.mine ? S_ADDR : S_FOREIGN, value: o.value })),
  status: confirmed ? { confirmed: true, block_height: 900_000, block_hash: HASH } : { confirmed: false },
});

describe("Bitcoin outputs and confirmations", () => {
  it("amount = Σ outputs to the address; splitting an output or adding foreign outputs changes nothing", () => {
    fc.assert(
      fc.property(
        fc.array(outArb, { minLength: 1, maxLength: 8 }),
        fc.nat(7),
        fc.integer({ min: 0, max: 1_000_000 }),
        (outs, at, foreign) => {
          const want = outs.filter((o) => o.mine).reduce((a, o) => a + BigInt(o.value), 0n);
          const r = checkBitcoinTransfer(btcTx(outs), 900_010, { address: ADDR, expected: 1n, required: 1 });
          if (want === 0n) {
            expect(r.kind).toBe("mismatch");
            return;
          }
          expect(r.kind === "transfer" && r.amount).toBe(want);
          const i = at % outs.length;
          const o = outs[i] as { mine: boolean; value: number };
          const half = Math.floor(o.value / 2);
          const split = [
            ...outs.slice(0, i),
            { ...o, value: half },
            { ...o, value: o.value - half },
            { mine: false, value: foreign },
            ...outs.slice(i + 1),
          ];
          const s = checkBitcoinTransfer(btcTx(split), 900_010, { address: ADDR, expected: 1n, required: 1 });
          expect(s.kind === "transfer" && s.amount).toBe(want);
        },
      ),
    );
  });

  it("finality is monotonic in confirmations and the mempool never counts", () => {
    fc.assert(
      fc.property(
        fc.array(outArb, { minLength: 1, maxLength: 4 }),
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 1, max: 6 }),
        (outs, a, b, required) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const at = (tip: number) =>
            checkBitcoinTransfer(btcTx(outs), tip, { address: ADDR, expected: 1n, required }).kind;
          if (at(900_000 + lo - 1) === "transfer") expect(at(900_000 + hi - 1)).toBe("transfer");
          const mem = checkBitcoinTransfer(btcTx(outs, false), 900_000 + hi, { address: ADDR, expected: 1n, required });
          expect(mem.kind).not.toBe("transfer");
        },
      ),
    );
  });

  it("required confirmations never decrease with the USD value; unknown value = strictest", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 13n }), fc.bigInt({ min: 0n, max: 10n ** 13n }), (x, y) => {
        const [lo, hi] = x < y ? [x, y] : [y, x];
        expect(confirmationsRequired(BITCOIN_CONFIRMATION_TIERS, lo)).toBeLessThanOrEqual(
          confirmationsRequired(BITCOIN_CONFIRMATION_TIERS, hi),
        );
        expect(confirmationsRequired(BITCOIN_CONFIRMATION_TIERS, null)).toBeGreaterThanOrEqual(
          confirmationsRequired(BITCOIN_CONFIRMATION_TIERS, hi),
        );
      }),
    );
  });
});

describe("vault forwarding rule", () => {
  // biome-ignore lint/suspicious/noExplicitAny: vector JSON
  const lines = (specVector<any>("vault.json").events as { log: string }[]).map((e) => e.log);
  it("forwarded ⇔ executor = vault ∧ success ∧ final (valid lines)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("v1.vault.nearpay.near", "evil.near", "intents.near"),
        fc.boolean(),
        fc.boolean(),
        fc.subarray(lines, { minLength: 1 }),
        (executor, success, final, logs) => {
          const out = vaultEventsOf(
            { receiptId: "8RK6Dn9EaLwVb5nN3x9yrZfP6qz5mC8cQbqvYyYz2gHq", txHash: null, executor, logs, success },
            {
              vaultContract: "v1.vault.nearpay.near",
              final,
              blockHeight: 1,
              blockHash: "h",
              blockTimestamp: "1",
            },
          );
          const ok = executor === "v1.vault.nearpay.near" && success && final;
          expect(out.records.length).toBe(ok ? logs.length : 0);
          expect(out.rejected.length).toBe(ok ? 0 : logs.length);
          expect(new Set(out.records.map((r) => `${r.receipt_id}:${r.log_index}`)).size).toBe(out.records.length);
        },
      ),
    );
  });
});

describe("Bitcoin is never amount-tagged (§21.1, owner decision)", () => {
  it("any BTC price, any decimals → tag space 0; other families follow tagSpace", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 12n }),
        fc.bigInt({ min: 1n, max: 10n ** 6n }),
        fc.integer({ min: 0, max: 24 }),
        fc.constantFrom("evm", "near", "solana"),
        (num, den, decimals, other) => {
          const usd = { num, den };
          expect(destinationTagSpace("bitcoin", usd, decimals)).toBe(0);
          expect(destinationTagSpace(other, usd, decimals)).toBe(tagSpace(usd, decimals));
        },
      ),
    );
  });
});
