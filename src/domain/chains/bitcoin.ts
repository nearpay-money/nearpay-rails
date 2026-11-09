/**
 * Bitcoin settlement parsing (lld/rails.md §21.3, spec vectors `chains-solana-bitcoin.json` `evidence.bitcoin`). Pure.
 *
 * - Amount = Σ value of the outputs whose scriptPubKey encodes the destination. The address is re-derived from the
 *   script (never taken from the indexer's `scriptpubkey_address`) and compared lower-case.
 * - confirmations = tip − block_height + 1 (unconfirmed = 0: the mempool never counts). Below
 *   `requiredConfirmations(confirmation_tiers, settlement USD value)` the transfer is not final yet.
 * - Bitcoin is never amount-tagged (§21.1): evidence always comes from the verifier on the provider's txid.
 */

import { type BitcoinEvidence, type ConfirmationTier, requiredConfirmations } from "@nearpay/spec";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58check, bech32, bech32m } from "@scure/base";
import { convertUnits, parseExactDecimal } from "../pricing/ratio.js";

const b58c = base58check(sha256);
const hexBytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

/**
 * Mainnet address a scriptPubKey pays (lower-case for segwit), or null for scripts without an address (OP_RETURN,
 * bare multisig, malformed). P2WPKH/P2WSH bech32, witness v1+ bech32m, P2PKH/P2SH base58check.
 */
export function scriptToAddress(scriptHex: string, hrp = "bc"): string | null {
  const s = scriptHex.toLowerCase();
  if (!/^([0-9a-f]{2})+$/.test(s) || s.length > 200) return null;
  const b = hexBytes(s);
  // witness programs: OP_n <push len> <program>
  const op = b[0] as number;
  const version = op === 0x00 ? 0 : op >= 0x51 && op <= 0x60 ? op - 0x50 : -1;
  if (version >= 0 && b.length >= 4 && b[1] === b.length - 2) {
    const program = b.subarray(2);
    if (program.length < 2 || program.length > 40) return null;
    if (version === 0 && program.length !== 20 && program.length !== 32) return null;
    const words = [version, ...bech32.toWords(program)];
    return version === 0 ? bech32.encode(hrp, words, 90) : bech32m.encode(hrp, words, 90);
  }
  if (b.length === 25 && s.startsWith("76a914") && s.endsWith("88ac"))
    return b58c.encode(Uint8Array.of(0x00, ...b.subarray(3, 23)));
  if (b.length === 23 && s.startsWith("a914") && s.endsWith("87"))
    return b58c.encode(Uint8Array.of(0x05, ...b.subarray(2, 22)));
  return null;
}

/** scriptPubKey (hex) of a mainnet segwit address (P2WPKH, P2WSH, P2TR, …), or null when it is not one. */
export function addressToScript(address: string, hrp = "bc"): string | null {
  const a = address.toLowerCase();
  if (address !== a && address !== address.toUpperCase()) return null;
  for (const codec of [bech32, bech32m]) {
    try {
      const { prefix, words } = codec.decode(a as `${string}1${string}`, 90);
      if (prefix !== hrp || words.length === 0) continue;
      const version = words[0] as number;
      if ((version === 0) !== (codec === bech32) || version > 16) continue;
      const program = codec.fromWords(words.slice(1));
      if (program.length < 2 || program.length > 40) continue;
      if (version === 0 && program.length !== 20 && program.length !== 32) continue;
      const op = version === 0 ? 0 : 0x50 + version;
      return Buffer.from(Uint8Array.of(op, program.length, ...program)).toString("hex");
    } catch {}
  }
  return null;
}

/** Address as compared: bech32 lower-case, base58 as given. */
export const normalizeBitcoinAddress = (a: string): string => (/^bc1/i.test(a) ? a.toLowerCase() : a);

/** Esplora `GET /tx/{txid}` as rails reads it. */
export interface EsploraTx {
  readonly txid: string;
  readonly vout: readonly { readonly scriptpubkey: string; readonly value: number }[];
  readonly status: {
    readonly confirmed: boolean;
    readonly block_height?: number | null;
    readonly block_hash?: string | null;
  };
}

/** Outputs of `tx` paying `address` (split outputs are all counted). */
export function outputsTo(tx: EsploraTx, address: string): { vout: number; value: bigint; script_pubkey: string }[] {
  const want = normalizeBitcoinAddress(address);
  const out: { vout: number; value: bigint; script_pubkey: string }[] = [];
  tx.vout.forEach((o, i) => {
    if (!Number.isSafeInteger(o.value) || o.value < 0) return;
    const a = scriptToAddress(o.scriptpubkey);
    if (a !== null && a === want)
      out.push({ vout: i, value: BigInt(o.value), script_pubkey: o.scriptpubkey.toLowerCase() });
  });
  return out;
}

/** Confirmations of a transaction at `tip` (0 = unconfirmed or ahead of the node's tip). */
export function confirmationsAt(tx: EsploraTx, tip: number): number {
  const h = tx.status.block_height;
  if (!tx.status.confirmed || typeof h !== "number" || !Number.isSafeInteger(h) || h < 0) return 0;
  return tip >= h ? tip - h + 1 : 0;
}

/** Most confirmations any tier requires (used when the settlement's USD value is unknown: fail closed). */
export const maxConfirmations = (tiers: readonly ConfirmationTier[]): number =>
  tiers.reduce((m, t) => Math.max(m, t.confirmations), 1);

/**
 * USD micros of a settlement from the execution's price snapshot (§21.1): the higher of the primary and secondary
 * USD prices recorded at creation (a higher value can only require more confirmations). Null without a price.
 */
export function snapshotUsdMicros(
  amount: bigint,
  decimals: number,
  snapshot: { readonly primary_usd: string | null; readonly secondary_usd: string | null } | null,
): bigint | null {
  if (!snapshot) return null;
  let best: bigint | null = null;
  for (const p of [snapshot.primary_usd, snapshot.secondary_usd]) {
    if (!p) continue;
    try {
      const v = convertUnits(amount, decimals, parseExactDecimal(p), 6, "ceil");
      if (best === null || v > best) best = v;
    } catch {}
  }
  return best;
}

/** Confirmations required for a settlement (unknown USD value → the strictest tier). */
export function confirmationsRequired(tiers: readonly ConfirmationTier[], usdMicros: bigint | null): number {
  return usdMicros === null ? maxConfirmations(tiers) : requiredConfirmations(tiers, usdMicros);
}

export type BitcoinCheck =
  | { readonly kind: "not_final"; readonly confirmations: number; readonly required: number; readonly amount: bigint }
  | { readonly kind: "mismatch" }
  | {
      readonly kind: "transfer";
      readonly result: "pass" | "short";
      readonly amount: bigint;
      readonly detail: BitcoinEvidence;
    };

/** Verifier view of one Esplora transaction for `{address, expected, required}` at `tip` (§21.3). */
export function checkBitcoinTransfer(
  tx: EsploraTx,
  tip: number,
  expect: { address: string; expected: bigint; required: number },
): BitcoinCheck {
  const outputs = outputsTo(tx, expect.address);
  const amount = outputs.reduce((a, o) => a + o.value, 0n);
  if (amount === 0n) return { kind: "mismatch" };
  const confirmations = confirmationsAt(tx, tip);
  const hash = tx.status.block_hash?.toLowerCase() ?? "";
  if (confirmations < expect.required || !/^[0-9a-f]{64}$/.test(hash))
    return { kind: "not_final", confirmations, required: expect.required, amount };
  return {
    kind: "transfer",
    result: amount >= expect.expected ? "pass" : "short",
    amount,
    detail: {
      txid: tx.txid.toLowerCase(),
      outputs: outputs.map((o) => ({ vout: o.vout, value: o.value.toString(), script_pubkey: o.script_pubkey })),
      block_height: tx.status.block_height as number,
      block_hash: hash,
      confirmations,
      required_confirmations: expect.required,
    },
  };
}
