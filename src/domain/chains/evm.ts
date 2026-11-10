/**
 * EVM confirmation policy (lld/rails.md §4 "Chain profiles", §8.7, §8.8, §8.12; ADR-0022). Pure.
 *
 * - `finalized`: evidence counts once the transfer's block is at or below the chain's `finalized` tag (Ethereum L1;
 *   on an L2 this follows L1 finality, ≈ 15–20 min).
 * - `confirmations`: evidence counts once `latest − block + 1 ≥ blocks` on the chain itself. Owner decision
 *   2026-11-10 17:10 (ADR-0022 as amended): every EVM chain — Ethereum L1, Base, Arbitrum and the Tier B chains —
 *   confirms on ONE block of its own chain (the receipt in a block on `latest`). The receipt is re-read right before
 *   the evidence is applied and must still sit in the same block (reorg check); a post-success re-check against
 *   `finalized` follows (§8.12).
 */

export type EvmConfirmation =
  | { readonly kind: "finalized" }
  | { readonly kind: "confirmations"; readonly blocks: number };

export const FINALIZED: EvmConfirmation = { kind: "finalized" };
export const MAX_CONFIRMATIONS = 100_000;

/** One block of the chain's own `latest` head (owner decision 2026-11-10 17:10, ADR-0022 as amended). */
export const ONE_BLOCK: EvmConfirmation = { kind: "confirmations", blocks: 1 };

/**
 * Default for an EVM chain when neither the profile file nor the environment says otherwise: one block on the chain
 * itself, for every EVM chain (Ethereum ≈ 12 s, Base ≈ 2 s, Arbitrum ≈ 0.25 s after the transfer is mined).
 */
export function defaultEvmConfirmation(_chain: string): EvmConfirmation {
  return ONE_BLOCK;
}

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

/** Human label of a policy (profile `finality` text, logs): `finalized`, `1 confirmation` or `10 confirmations`. */
export function policyLabel(p: EvmConfirmation): string {
  if (p.kind === "finalized") return "finalized";
  return p.blocks === 1 ? "1 confirmation" : `${p.blocks} confirmations`;
}
