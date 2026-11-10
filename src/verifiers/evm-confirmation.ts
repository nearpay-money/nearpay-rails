/**
 * Whether an EVM receipt counts as evidence under the chain's confirmation policy (lld/rails.md §8.8, ADR-0022).
 *
 * - `finalized`: the receipt's block is at or below the `finalized` tag.
 * - `confirmations`: `latest − block + 1 ≥ blocks`; then the receipt is read again and must be in the same block
 *   (same number and hash) with status 1 — a receipt that moved or vanished meanwhile was reorganised and counts
 *   for nothing now (the next attempt starts again from the receipt the chain then shows).
 *
 * The receipt passed in has status 1 (the caller rejects reverted ones). Only the `EvmRpc` port is used.
 */
import { confirmationsOf, type EvmConfirmation } from "../domain/chains/evm.js";
import type { EvmReceipt, EvmRpc } from "../infra/clients/evm.js";

export type EvmConfirmationCheck =
  | {
      readonly kind: "counted";
      readonly finality: "finalized" | "confirmed";
      /** Confirmations at the check (null under the `finalized` rule). */
      readonly confirmations: number | null;
      readonly blockHash: string;
      readonly blockNumber: bigint;
    }
  | { readonly kind: "pending"; readonly details: Record<string, unknown> }
  | { readonly kind: "reorged"; readonly details: Record<string, unknown> };

export async function checkEvmConfirmation(
  rpc: EvmRpc,
  policy: EvmConfirmation,
  receipt: EvmReceipt,
): Promise<EvmConfirmationCheck> {
  const block = BigInt(receipt.blockNumber);
  if (policy.kind === "finalized") {
    const finalized = await rpc.finalizedBlock();
    if (block > finalized)
      return {
        kind: "pending",
        details: { reason: "not finalized", block: block.toString(), finalized: finalized.toString() },
      };
    return {
      kind: "counted",
      finality: "finalized",
      confirmations: null,
      blockHash: receipt.blockHash,
      blockNumber: block,
    };
  }
  const latest = await rpc.latestBlock();
  const confirmations = confirmationsOf(latest, block);
  if (confirmations < BigInt(policy.blocks))
    return {
      kind: "pending",
      details: {
        reason: "awaiting confirmations",
        block: block.toString(),
        confirmations: Number(confirmations),
        required_confirmations: policy.blocks,
      },
    };
  // reorg check: the receipt must still be in the block we counted from
  const again = await rpc.receipt(receipt.transactionHash);
  if (!again)
    return { kind: "reorged", details: { reason: "receipt vanished at confirmation", block_hash: receipt.blockHash } };
  if (again.blockHash.toLowerCase() !== receipt.blockHash.toLowerCase() || BigInt(again.blockNumber) !== block)
    return {
      kind: "reorged",
      details: {
        reason: "block hash changed at confirmation",
        block_hash: receipt.blockHash,
        new_block_hash: again.blockHash,
        new_block: BigInt(again.blockNumber).toString(),
      },
    };
  if (again.status !== "0x1")
    return { kind: "reorged", details: { reason: "receipt status changed at confirmation", status: again.status } };
  return {
    kind: "counted",
    finality: "confirmed",
    confirmations: Number(confirmations),
    blockHash: receipt.blockHash,
    blockNumber: block,
  };
}
