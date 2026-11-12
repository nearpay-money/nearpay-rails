/**
 * Solana settlement parsing (lld/rails.md §21.2–§21.3, spec vectors `chains-solana-bitcoin.json` `evidence.solana`,
 * `solana-transfer.json`). Pure.
 *
 * - Addresses are base58 of 32 bytes; program-derived addresses (ATAs) are off the ed25519 curve.
 * - Amount of a transfer = the owner's balance delta for the asset in one finalized, successful transaction:
 *   SPL Σ post − Σ pre over the token balances whose `owner` is the recipient and `mint` the asset mint (a missing
 *   pre entry counts 0, so a payout that creates the ATA in the same transaction counts in full); SOL lamports
 *   `postBalances[i] − preBalances[i]` at the recipient's account index (static keys, then
 *   `loadedAddresses.writable`, `loadedAddresses.readonly`). Instruction parsing (TransferChecked / Transfer) is not
 *   needed: the runtime's balance bookkeeping covers every instruction shape, inner instructions included.
 * - A transaction with `meta.err` set proves nothing.
 */

import { parseAssetId, type SolanaEvidence } from "@nearpay-money/spec";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import bs58 from "bs58";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
/** The classic SPL Token program (the only one enabled in v1; Token-2022 mints are not in the asset table). */
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/** 32 raw bytes of a base58 address, or null when it is not one. */
export function decodeSolanaAddress(a: string): Uint8Array | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return null;
  try {
    const b = bs58.decode(a);
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

/** True when the 32 bytes decode to an ed25519 point (a wallet key); program-derived addresses are off-curve. */
export function isOnCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** `findProgramAddress(seeds, program)`: the first bump from 255 down whose hash is off-curve. */
export function findProgramAddress(seeds: readonly Uint8Array[], programId: string): { address: string; bump: number } {
  const program = decodeSolanaAddress(programId);
  if (!program) throw new RangeError(`not a Solana address: ${programId}`);
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(concat(...seeds, Uint8Array.of(bump), program, PDA_MARKER));
    if (!isOnCurve(h)) return { address: bs58.encode(h), bump };
  }
  throw new RangeError("no viable bump seed");
}

/** Associated token account of `owner` for `mint` (`[owner, token program, mint]` under the ATA program). */
export function associatedTokenAddress(
  owner: string,
  mint: string,
  tokenProgram = TOKEN_PROGRAM,
): { address: string; bump: number } {
  const o = decodeSolanaAddress(owner);
  const t = decodeSolanaAddress(tokenProgram);
  const m = decodeSolanaAddress(mint);
  if (!o || !t || !m) throw new RangeError("owner, token program and mint must be Solana addresses");
  return findProgramAddress([o, t, m], ASSOCIATED_TOKEN_PROGRAM);
}

/** omft asset id of an SPL mint: `nep141:sol-` + hex(keccak256(mint bytes)[12..32]) + `.omft.near` (§21.1). */
export function splAssetId(mint: string): string {
  return `nep141:sol-${splAssetHash(mint)}.omft.near`;
}

/** hex(keccak256(mint bytes)[12..32]): the hash20 an SPL bridge asset id names (omft `sol-<hex>`, omdep `sol-0x<hex>`). */
export function splAssetHash(mint: string): string {
  const m = decodeSolanaAddress(mint);
  if (!m) throw new RangeError(`not a Solana address: ${mint}`);
  return Buffer.from(keccak_256(m).subarray(12)).toString("hex");
}

/**
 * Whether `mint` is the SPL mint `assetId` names (spec `parseAssetId`, 0.5.2): a Solana bridge id (`omft` or `omdep`)
 * whose hash20 the mint reproduces, or `1cs_v1:sol:spl:<mint>` with that exact mint. False for anything else.
 */
export function splMintMatchesAssetId(mint: string, assetId: string): boolean {
  const a = parseAssetId(assetId);
  if ((a.scheme === "omft" || a.scheme === "omdep") && a.blockchain === "sol" && a.kind === "hash20") {
    try {
      return splAssetHash(mint) === a.token;
    } catch {
      return false;
    }
  }
  return a.scheme === "1cs_v1" && a.blockchain === "sol" && a.standard === "spl" && a.address === mint;
}

// ---------------------------------------------------------------------------------------------
// getTransaction (encoding jsonParsed or json) as rails reads it
// ---------------------------------------------------------------------------------------------

export interface SolanaTokenBalance {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner?: string | null;
  readonly programId?: string | null;
  readonly uiTokenAmount: { readonly amount: string; readonly decimals?: number };
}

export type SolanaAccountKey = string | { readonly pubkey: string; readonly source?: string };

export interface SolanaTx {
  readonly slot: number;
  readonly blockTime?: number | null;
  readonly meta: {
    readonly err: unknown;
    readonly preBalances: readonly number[] | readonly string[];
    readonly postBalances: readonly number[] | readonly string[];
    readonly preTokenBalances?: readonly SolanaTokenBalance[] | null;
    readonly postTokenBalances?: readonly SolanaTokenBalance[] | null;
    readonly loadedAddresses?: { readonly writable?: readonly string[]; readonly readonly?: readonly string[] } | null;
  } | null;
  readonly transaction: {
    readonly signatures: readonly string[];
    readonly message: { readonly accountKeys: readonly SolanaAccountKey[] };
  };
}

/**
 * Account keys in index order. `jsonParsed` already lists lookup-table keys (`source: "lookupTable"`); `json` lists
 * static keys only, and the loaded ones follow (`loadedAddresses.writable`, then `.readonly`).
 */
export function accountKeys(tx: SolanaTx): string[] {
  const keys = tx.transaction.message.accountKeys;
  const out = keys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const parsedLookups = keys.some((k) => typeof k !== "string" && k.source === "lookupTable");
  if (!parsedLookups) {
    out.push(...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? []));
  }
  return out;
}

const UINT = /^\d{1,30}$/;
const big = (v: number | string | undefined): bigint | null => {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v === "string" && UINT.test(v)) return BigInt(v);
  return null;
};

export interface SolanaDelta {
  /** post − pre (negative when the owner's balance fell). */
  readonly amount: bigint;
  readonly pre: bigint;
  readonly post: bigint;
  /** Token accounts of the owner for the mint whose balance changed (empty for SOL). */
  readonly tokenAccounts: string[];
  /** The other wallet whose balance of the asset fell by at least `amount` — when exactly one did (§21.3 sender). */
  readonly sender: string | null;
  readonly tokenProgram: string | null;
}

/** The owner's balance delta for `mint` (null = SOL lamports) in a transaction; null when the data is malformed. */
export function solanaDelta(tx: SolanaTx, owner: string, mint: string | null): SolanaDelta | null {
  const meta = tx.meta;
  if (!meta) return null;
  const keys = accountKeys(tx);
  if (mint === null) {
    const i = keys.indexOf(owner);
    if (i < 0) return { amount: 0n, pre: 0n, post: 0n, tokenAccounts: [], sender: null, tokenProgram: null };
    const pre = big(meta.preBalances[i]);
    const post = big(meta.postBalances[i]);
    if (pre === null || post === null) return null;
    const amount = post - pre;
    const senders: string[] = [];
    if (amount > 0n) {
      keys.forEach((k, j) => {
        if (j === i) return;
        const a = big(meta.preBalances[j]);
        const b = big(meta.postBalances[j]);
        if (a !== null && b !== null && a - b >= amount) senders.push(k);
      });
    }
    return {
      amount,
      pre,
      post,
      tokenAccounts: [],
      sender: senders.length === 1 ? (senders[0] as string) : null,
      tokenProgram: null,
    };
  }
  // SPL: per token account (accountIndex) pre/post for this mint
  const byAccount = new Map<number, { owner: string | null; pre: bigint; post: bigint; program: string | null }>();
  const add = (list: readonly SolanaTokenBalance[] | null | undefined, side: "pre" | "post"): boolean => {
    for (const b of list ?? []) {
      if (b.mint !== mint) continue;
      const v = big(b.uiTokenAmount?.amount);
      if (v === null || !Number.isInteger(b.accountIndex)) return false;
      const e = byAccount.get(b.accountIndex) ?? {
        owner: b.owner ?? null,
        pre: 0n,
        post: 0n,
        program: b.programId ?? null,
      };
      e[side] = v;
      byAccount.set(b.accountIndex, e);
    }
    return true;
  };
  if (!add(meta.preTokenBalances, "pre") || !add(meta.postTokenBalances, "post")) return null;
  let pre = 0n;
  let post = 0n;
  const tokenAccounts: string[] = [];
  const fell = new Map<string, bigint>();
  let tokenProgram: string | null = null;
  for (const [idx, e] of byAccount) {
    if (e.owner === owner) {
      pre += e.pre;
      post += e.post;
      if (e.pre !== e.post) {
        const k = keys[idx];
        if (k) tokenAccounts.push(k);
      }
      tokenProgram ??= e.program;
    } else if (e.owner && e.post < e.pre) {
      fell.set(e.owner, (fell.get(e.owner) ?? 0n) + (e.pre - e.post));
    }
  }
  const amount = post - pre;
  const senders = amount > 0n ? [...fell.entries()].filter(([, d]) => d >= amount).map(([o]) => o) : [];
  return {
    amount,
    pre,
    post,
    tokenAccounts,
    sender: senders.length === 1 ? (senders[0] as string) : null,
    tokenProgram: tokenProgram ?? (tokenAccounts.length ? TOKEN_PROGRAM : null),
  };
}

export type SolanaCheck =
  | { readonly kind: "failed" }
  | { readonly kind: "malformed" }
  | {
      readonly kind: "transfer";
      /** pass / short / mismatch against the expectation (§8.8). */
      readonly result: "pass" | "short" | "mismatch";
      readonly amount: bigint;
      readonly sender: string | null;
      readonly detail: SolanaEvidence;
    };

/**
 * Verifier view of one finalized transaction for `{owner, mint, expected}` (§21.3). `failed` (meta.err) and
 * `malformed` prove nothing; otherwise `pass` when the owner received ≥ expected, `short` when 0 < delta < expected,
 * `mismatch` when it received nothing.
 */
export function checkSolanaTransfer(
  tx: SolanaTx,
  signature: string,
  expect: { owner: string; mint: string | null; expected: bigint },
): SolanaCheck {
  if (!tx.meta) return { kind: "malformed" };
  if (tx.meta.err !== null && tx.meta.err !== undefined) return { kind: "failed" };
  if (!Number.isSafeInteger(tx.slot) || tx.slot < 0) return { kind: "malformed" };
  const d = solanaDelta(tx, expect.owner, expect.mint);
  if (!d) return { kind: "malformed" };
  const amount = d.amount > 0n ? d.amount : 0n;
  const result = amount === 0n ? "mismatch" : amount >= expect.expected ? "pass" : "short";
  const blockTime = typeof tx.blockTime === "number" && Number.isSafeInteger(tx.blockTime) ? tx.blockTime : null;
  return {
    kind: "transfer",
    result,
    amount,
    sender: amount > 0n ? d.sender : null,
    detail: {
      signature,
      slot: tx.slot,
      block_time: blockTime !== null && blockTime >= 0 ? blockTime : null,
      mint: expect.mint,
      token_program: expect.mint ? (d.tokenProgram ?? TOKEN_PROGRAM) : null,
      owner: expect.owner,
      token_accounts: d.tokenAccounts,
      pre_amount: d.pre.toString(),
      post_amount: d.post.toString(),
    },
  };
}
