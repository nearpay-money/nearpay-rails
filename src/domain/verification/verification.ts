/**
 * Evidence rules (ADR-0012, lld/rails.md §5, §8.7, §8.8). Pure.
 *
 * Tier A = NearPay saw the transfer to the merchant on chain itself (final). Tier B = the provider
 * attests the settlement and NearPay accepts it only within limits (`NP_TIER_B_LIMITS`).
 */

export type VerificationResult = "pass" | "short" | "mismatch" | "not_found" | "pending";

export interface ObservedTransfer {
  readonly to: string;
  /** Sender, when the chain shows it (spec 0.3.0 `Evidence.sender`). */
  readonly from?: string | null;
  readonly assetId: string;
  readonly amount: bigint;
}

/**
 * Verifier comparison (§8.8): the sum of final transfers of the settlement asset to the recipient —
 * `≥ expected` pass, `0 < sum < expected` short, nothing to the recipient mismatch. `sender` (spec 0.3.0
 * `Evidence.sender`) is the sender of the largest counted transfer (the first on a tie); null when the chain
 * named none.
 */
export function compareTransfers(
  transfers: readonly ObservedTransfer[],
  expect: { recipient: string; assetId: string; expected: bigint },
): { result: "pass" | "short" | "mismatch"; amount: bigint; sender: string | null } {
  let sum = 0n;
  let largest: ObservedTransfer | null = null;
  for (const t of transfers) {
    if (t.to === expect.recipient && t.assetId === expect.assetId && t.amount > 0n) {
      sum += t.amount;
      if (largest === null || t.amount > largest.amount) largest = t;
    }
  }
  const sender = largest?.from ?? null;
  if (sum >= expect.expected) return { result: "pass", amount: sum, sender };
  if (sum > 0n) return { result: "short", amount: sum, sender };
  return { result: "mismatch", amount: 0n, sender: null };
}

/**
 * Amount attribution for watchers and the indexer (§8.6, §8.7): a transfer to a destination is
 * evidence for exactly one in-flight execution expecting that exact amount. Two or more candidates
 * is ambiguous — nothing is attributed (the verifier still has the provider's tx hash).
 */
export function attribute<T extends { readonly expected: bigint }>(candidates: readonly T[], amount: bigint): T | null {
  const hits = candidates.filter((c) => c.expected === amount);
  return hits.length === 1 ? (hits[0] as T) : null;
}

export interface TierBLimits {
  readonly perPaymentUsdMicros: bigint;
  readonly perDayUsdMicros: bigint;
}

/** Tier B acceptance (§5 "Success"): the payment and the account's Tier B day stay within limits. */
export function tierBAllowed(
  amountUsdMicros: bigint | null,
  settledTodayUsdMicros: bigint,
  limits: TierBLimits,
): { ok: true } | { ok: false; reason: string } {
  if (amountUsdMicros === null) return { ok: false, reason: "no reliable USD value for a Tier B settlement" };
  if (amountUsdMicros > limits.perPaymentUsdMicros) return { ok: false, reason: "above the Tier B per-payment limit" };
  if (settledTodayUsdMicros + amountUsdMicros > limits.perDayUsdMicros)
    return { ok: false, reason: "above the Tier B daily limit" };
  return { ok: true };
}

/** Minimum economic payment (§8.9): max(USD 1.00, 20 × withdraw fee); Intents accounts USD 0.01. */
export function minimumUsdMicros(kind: "intents" | "chain", withdrawFeeUsdMicros: bigint | null): bigint | null {
  if (kind === "intents") return 10_000n;
  if (withdrawFeeUsdMicros === null) return null;
  const twenty = 20n * withdrawFeeUsdMicros;
  return twenty > 1_000_000n ? twenty : 1_000_000n;
}
