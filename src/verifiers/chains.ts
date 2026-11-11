/**
 * Stage 4 verifier adapters (lld/rails.md §21.3, §21.5): Solana and Bitcoin, live and sandbox.
 *
 * - Solana: `getTransaction(sig, confirmed)` per provider destination signature (ADR-0022 as amended: the slot is
 *   voted by a supermajority — Solana's one-block confirmation; evidence `finality: confirmed`, re-checked at
 *   `finalized` after success, §8.12); not found / not confirmed → retry; `meta.err` set → that signature proves
 *   nothing (another hash or the timeout → `held(evidence_timeout)`). Amount = the destination owner's balance delta
 *   for the asset (ATA created in the same tx counts in full).
 * - Bitcoin: Esplora `GET /tx/{txid}` + tip; Σ outputs re-derived to the destination; 1 confirmation for every amount
 *   by default (ADR-0022 as amended; a profile's `confirmation_tiers` may require more by USD value) → below it not
 *   final, retry; re-checked at 6 confirmations in the same block after success (§8.12). Bitcoin is never
 *   amount-tagged: this verifier, on the provider's txid, is its only evidence path.
 * - Agreement: at or above `NP_AGREEMENT_USD` a second pool endpoint must return the same amount and block (slot /
 *   block hash), as for EVM.
 * - Sandbox (§21.5): `SimTx` fills `Evidence.solana` / `Evidence.bitcoin` (`block_ref` → slot/height, transfers'
 *   `token_account` / `vout`, `confirmations`, `failed`; pre/post amounts null; block hash = sha256 hex of
 *   `<chain>|<block_ref>`).
 */
import { createHash } from "node:crypto";
import { SimTx } from "@nearpay-internal/spec";
import type { BitcoinEvidence, ConfirmationTier, SolanaEvidence } from "@nearpay-money/spec";
import type { Rails } from "../app/context.js";
import { tokenOf } from "../app/tokens.js";
import type { ExecutionRow } from "../app/views.js";
import {
  addressToScript,
  checkBitcoinTransfer,
  confirmationsRequired,
  normalizeBitcoinAddress,
  outputsTo,
  snapshotUsdMicros,
} from "../domain/chains/bitcoin.js";
import { checkSolanaTransfer, splAssetId, TOKEN_PROGRAM } from "../domain/chains/solana.js";
import { ONE_CONFIRMATION } from "../domain/token-registry/chain-profiles.js";
import { compareTransfers, type ObservedTransfer } from "../domain/verification/verification.js";
import type { Esplora } from "../infra/clients/esplora.js";
import type { SolanaRpc } from "../infra/clients/solana.js";
import type { VerifyOutcome } from "./verifier.js";

const pending = (details: Record<string, unknown>, result: "pending" | "not_found" = "pending"): VerifyOutcome => ({
  result,
  tier: "A",
  source: "verifier",
  finality: "finalized",
  txHash: null,
  blockRef: null,
  amount: 0n,
  details,
});

const recipientOf = (row: ExecutionRow) => row.destination_key.split("|")[1] as string;

/** SPL mint of the settlement asset (null for SOL), checked against the omft asset id (§21.1). */
async function solanaMint(r: Rails, row: ExecutionRow): Promise<{ mint: string | null } | { error: string }> {
  const t = await tokenOf(r, row.livemode, row.destination_asset_id);
  if (!t) return { error: "settlement asset unknown" };
  const mint = t.contract_address;
  if (!mint) return { mint: null };
  try {
    if (splAssetId(mint) !== row.destination_asset_id) return { error: "SPL mint does not reproduce the asset id" };
  } catch {
    return { error: "SPL mint is not a Solana address" };
  }
  return { mint };
}

export async function verifySolana(
  r: Rails,
  rpc: SolanaRpc,
  row: ExecutionRow,
  hashes: readonly string[],
  needsAgreement: () => Promise<boolean>,
): Promise<VerifyOutcome> {
  const owner = recipientOf(row);
  const expected = BigInt(row.amount_out_expected);
  const m = await solanaMint(r, row);
  if ("error" in m) return { ...pending({ reason: m.error }), holdNow: "evidence_mismatch" };
  // `confirmed` (default) → evidence `confirmed`, re-checked at `finalized` after success (§8.12)
  const finality = rpc.commitment === "finalized" ? "finalized" : "confirmed";
  let best: VerifyOutcome | null = null;
  for (const sig of hashes) {
    const tx = await rpc.transaction(sig);
    if (!tx) {
      best ??= pending({ hash: sig, reason: `not found or not ${rpc.commitment} yet` }, "not_found");
      continue;
    }
    const c = checkSolanaTransfer(tx, sig, { owner, mint: m.mint, expected });
    if (c.kind !== "transfer") {
      // a failed (meta.err) or unreadable transaction proves nothing: another hash, or the timeout
      best ??= pending({
        hash: sig,
        reason: c.kind === "failed" ? "transaction failed (meta.err)" : "malformed result",
      });
      continue;
    }
    const out: VerifyOutcome = {
      result: c.result,
      tier: "A",
      source: "verifier",
      finality,
      txHash: sig,
      blockRef: String(c.detail.slot),
      amount: c.amount,
      sender: c.sender,
      details: { hash: sig, slot: c.detail.slot, commitment: rpc.commitment },
      chainDetail: { solana: c.detail, bitcoin: null },
    };
    if (c.result === "mismatch") {
      best = out;
      continue;
    }
    if (rpc.urls.length > 1 && (await needsAgreement())) {
      const other = await rpc.transaction(sig, 1).catch(() => null);
      const o = other ? checkSolanaTransfer(other, sig, { owner, mint: m.mint, expected }) : null;
      if (o?.kind !== "transfer" || o.amount !== c.amount || o.detail.slot !== c.detail.slot)
        return pending({ hash: sig, reason: "second RPC does not agree yet" });
    }
    return out;
  }
  return best ?? pending({ reason: "no destination transactions yet" });
}

export async function verifyBitcoin(
  r: Rails,
  esplora: Esplora,
  row: ExecutionRow,
  hashes: readonly string[],
  tiers: readonly ConfirmationTier[],
  needsAgreement: () => Promise<boolean>,
): Promise<VerifyOutcome> {
  const address = normalizeBitcoinAddress(recipientOf(row));
  const expected = BigInt(row.amount_out_expected);
  const required = await requiredFor(r, row, tiers);
  let best: VerifyOutcome | null = null;
  let tip: number | null = null;
  for (const raw of hashes) {
    const txid = raw.toLowerCase();
    const tx = await esplora.tx(txid);
    if (!tx) {
      best ??= pending({ hash: txid, reason: "unknown txid" }, "not_found");
      continue;
    }
    tip ??= await esplora.tipHeight();
    const c = checkBitcoinTransfer(tx, tip, { address, expected, required });
    if (c.kind === "mismatch") {
      best = {
        ...pending({ hash: txid, reason: "no output pays the destination" }),
        result: "mismatch",
        finality: "confirmed",
      };
      continue;
    }
    if (c.kind === "not_final") {
      best = pending({ hash: txid, reason: "not enough confirmations", confirmations: c.confirmations, required });
      continue;
    }
    if (esplora.urls.length > 1 && (await needsAgreement())) {
      // §21.3: the second endpoint must report the same amount to the destination and the same block
      const other = await esplora.tx(txid, 1).catch(() => null);
      const otherAmount = other ? outputsTo(other, address).reduce((a, o) => a + o.value, 0n) : null;
      if (
        !other?.status.confirmed ||
        other.status.block_hash?.toLowerCase() !== c.detail.block_hash ||
        otherAmount !== c.amount
      )
        return pending({ hash: txid, reason: "second Esplora does not agree yet" });
    }
    return {
      result: c.result,
      tier: "A",
      source: "verifier",
      finality: "confirmed",
      txHash: txid,
      blockRef: String(c.detail.block_height),
      amount: c.amount,
      // inputs are not attributed on Bitcoin (§21.3)
      sender: null,
      details: { hash: txid, block_hash: c.detail.block_hash, confirmations: c.detail.confirmations },
      chainDetail: { solana: null, bitcoin: c.detail },
    };
  }
  return best ?? pending({ reason: "no destination transactions yet" });
}

/**
 * Confirmations required for this execution's settlement (§21.1): the profile's tiers by USD value from its price
 * snapshot; without tiers 1 confirmation for every amount (ADR-0022 as amended 2026-11-10 17:10).
 */
export async function requiredFor(r: Rails, row: ExecutionRow, tiers: readonly ConfirmationTier[]): Promise<number> {
  const decimals =
    row.destination_decimals ?? (await tokenOf(r, row.livemode, row.destination_asset_id))?.decimals ?? null;
  const usd =
    decimals === null ? null : snapshotUsdMicros(BigInt(row.amount_out_expected), decimals, row.price_snapshot);
  return confirmationsRequired(tiers.length ? tiers : ONE_CONFIRMATION, usd);
}

const simBlockHash = (chain: string, blockRef: string) =>
  createHash("sha256").update(`${chain}|${blockRef}`).digest("hex");

/**
 * Sandbox verification of a Solana / Bitcoin settlement (§21.5). `transfers` are already reduced to those the
 * comparison counts; returns null when the simulated transaction carries no Stage 4 detail it can use.
 */
export async function sandboxChainOutcome(
  r: Rails,
  row: ExecutionRow,
  family: "solana" | "bitcoin",
  hash: string,
  tx: unknown,
  transfers: readonly ObservedTransfer[],
  tiers: readonly ConfirmationTier[],
): Promise<VerifyOutcome> {
  const parsed = SimTx.safeParse(tx);
  // a simulated transaction that does not parse as the spec's SimTx proves nothing (fail closed)
  if (!parsed.success) return pending({ hash, reason: "simulated tx does not parse", simulated: true });
  const add = parsed.data;
  const recipient = recipientOf(row);
  const expected = BigInt(row.amount_out_expected);
  if (family === "solana" && add.failed === true)
    return pending({ hash, reason: "simulated transaction failed (meta.err)", simulated: true });
  const raw = add.transfers;
  const counted = (i: number) => {
    const t = raw[i];
    return t !== undefined && toKey(row.destination_chain, t.to) === recipient && t.token === row.destination_asset_id;
  };
  const c = compareTransfers(transfers, { recipient, assetId: row.destination_asset_id, expected });
  const blockRef = add.block_ref && /^\d{1,19}$/.test(add.block_ref) ? add.block_ref : null;
  if (family === "bitcoin") {
    const required = await requiredFor(r, row, tiers);
    const confirmations = add.confirmations ?? 0;
    if (c.result === "mismatch")
      return { ...pending({ hash, simulated: true }), result: "mismatch", finality: "confirmed" };
    if (confirmations < required || blockRef === null)
      return pending({ hash, reason: "not enough confirmations", confirmations, required, simulated: true });
    const script = addressToScript(recipient);
    const outputs = add.transfers.flatMap((t, i) =>
      counted(i) && typeof t.vout === "number" && script
        ? [{ vout: t.vout, value: t.amount, script_pubkey: script }]
        : [],
    );
    if (outputs.length === 0) return pending({ hash, reason: "simulated outputs carry no vout", simulated: true });
    const detail: BitcoinEvidence = {
      txid: hash.toLowerCase(),
      outputs,
      block_height: Number(blockRef),
      block_hash: simBlockHash(row.destination_chain, blockRef),
      confirmations,
      required_confirmations: required,
    };
    return {
      result: c.result,
      tier: "A",
      source: "verifier",
      finality: "confirmed",
      txHash: hash,
      blockRef,
      amount: c.amount,
      sender: null,
      details: { hash, simulated: true },
      chainDetail: { solana: null, bitcoin: detail },
    };
  }
  if (c.result === "mismatch")
    return { ...pending({ hash, simulated: true }), result: "mismatch", txHash: hash, blockRef };
  // Evidence.solana.slot = Evidence.block_ref: without the simulated slot there is nothing to record (fail closed)
  if (blockRef === null) return pending({ hash, reason: "simulated slot unknown", simulated: true });
  const m = await solanaMint(r, row);
  const mint = "mint" in m ? m.mint : null;
  const accounts = add.transfers.flatMap((t, i) =>
    counted(i) && typeof t.token_account === "string" && t.token_account ? [t.token_account] : [],
  );
  const detail: SolanaEvidence = {
    signature: hash,
    slot: Number(blockRef),
    block_time: null,
    mint,
    token_program: mint ? TOKEN_PROGRAM : null,
    owner: recipient,
    token_accounts: [...new Set(accounts)],
    pre_amount: null,
    post_amount: null,
  };
  return {
    result: c.result,
    tier: "A",
    source: "verifier",
    // as live (ADR-0022 as amended): Solana evidence is `confirmed`; test mode is never re-checked (§8.12)
    finality: "confirmed",
    txHash: hash,
    blockRef,
    amount: c.amount,
    sender: c.sender,
    details: { hash, simulated: true },
    chainDetail: { solana: detail, bitcoin: null },
  };
}

/** Address as destination keys store it: Solana base58 as given, Bitcoin bech32 lower-case, others lower-case. */
export function toKey(chain: string, address: string): string {
  if (chain.startsWith("solana:")) return address;
  if (chain.startsWith("bip122:")) return normalizeBitcoinAddress(address);
  return address.toLowerCase();
}
