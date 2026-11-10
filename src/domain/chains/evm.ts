/**
 * EVM confirmation policy (lld/rails.md §4 "Chain profiles", §8.7, §8.8, §8.12; ADR-0022). Pure.
 *
 * - `finalized`: evidence counts once the transfer's block is at or below the chain's `finalized` tag (Ethereum L1;
 *   on an L2 this follows L1 finality, ≈ 15–20 min).
 * - `confirmations`: evidence counts once `latest − block + 1 ≥ blocks` on the chain itself (L2 block confirmations,
 *   owner decision 2026-11-10 for Base and Arbitrum). The receipt is re-read at that moment and must still sit in
 *   the same block (reorg check); a post-success re-check against `finalized` follows (§8.12).
 */

export type EvmConfirmation =
  | { readonly kind: "finalized" }
  | { readonly kind: "confirmations"; readonly blocks: number };

export const FINALIZED: EvmConfirmation = { kind: "finalized" };
export const MAX_CONFIRMATIONS = 100_000;

/** Defaults when the profile file and the environment say nothing: L2s confirm on their own blocks, L1 finalizes. */
export const DEFAULT_EVM_CONFIRMATION: Readonly<Record<string, EvmConfirmation>> = {
  "eip155:8453": { kind: "confirmations", blocks: 10 }, // Base, 2 s blocks ≈ 20 s
  "eip155:42161": { kind: "confirmations", blocks: 40 }, // Arbitrum One, 0.25 s blocks ≈ 10 s
  "eip155:1": FINALIZED,
};

export class ConfirmationPolicyError extends Error {
  override readonly name = "ConfirmationPolicyError";
}

/**
 * Parses an override (`NP_EVM_CONFIRMATIONS_<CHAINID>`): `finalized`, or a block count 1…100000.
 * Anything else is refused (fail closed: a typo must not silently weaken or disable the rule).
 */
export function parseEvmConfirmation(raw: string): EvmConfirmation {
  const v = raw.trim().toLowerCase();
  if (v === "finalized") return FINALIZED;
  if (!/^\d+$/.test(v))
    throw new ConfirmationPolicyError(`EVM confirmations must be "finalized" or a block count, got "${raw}"`);
  const blocks = Number(v);
  if (!Number.isSafeInteger(blocks) || blocks < 1 || blocks > MAX_CONFIRMATIONS)
    throw new ConfirmationPolicyError(`EVM confirmations must be 1…${MAX_CONFIRMATIONS}, got ${raw}`);
  return { kind: "confirmations", blocks };
}

/** Confirmations of a block at `block` when the head is `latest` (the block itself counts as 1; never negative). */
export function confirmationsOf(latest: bigint, block: bigint): bigint {
  return latest >= block ? latest - block + 1n : 0n;
}

/**
 * The newest block whose transfers count under `policy` (watchers scan up to it): the `finalized` head, or
 * `latest − blocks + 1` (a block there has exactly `blocks` confirmations). Never below 0.
 */
export function countedHead(policy: EvmConfirmation, heads: { latest?: bigint; finalized?: bigint }): bigint {
  if (policy.kind === "finalized") {
    if (heads.finalized === undefined) throw new ConfirmationPolicyError("finalized head required");
    return heads.finalized;
  }
  if (heads.latest === undefined) throw new ConfirmationPolicyError("latest head required");
  const h = heads.latest - BigInt(policy.blocks) + 1n;
  return h > 0n ? h : 0n;
}

/** Whether a transfer in `block` counts under `policy` given the heads. */
export function blockCounts(policy: EvmConfirmation, block: bigint, heads: { latest?: bigint; finalized?: bigint }) {
  return block <= countedHead(policy, heads);
}

/** Human label of a policy (profile `finality` text, logs): `finalized` or `10 confirmations`. */
export function policyLabel(p: EvmConfirmation): string {
  return p.kind === "finalized" ? "finalized" : `${p.blocks} confirmations`;
}
