/**
 * Settlement amounts, fees, amount tags, deadlines and the Intents payment binding
 * (lld/rails.md §8.1, §8.3, domain-model §3). Pure.
 */
import { createHash } from "node:crypto";
import { afterBps, bpsOf, ceil, floor, maxOf, mul, type Rational, rational } from "@nearpay-internal/money";
import bs58 from "bs58";

/** Merchant-bearer settlement: the quoted output is net of the fee (rounded down). */
export function baseAfterBearer(settlement: bigint, bps: number, bearer: "payer" | "merchant"): bigint {
  return bearer === "merchant" ? afterBps(settlement, bps) : settlement;
}

/**
 * Tag space `T` (§8.3): the largest tag worth at most USD 0.01, capped at 9,999; below 100 slots the
 * asset is too coarse to tag (0 = untagged, attribution falls back to provider tx hashes).
 * `unitUsd` is the USD price of one whole token.
 */
export function tagSpace(unitUsd: Rational, decimals: number): number {
  if (unitUsd.num <= 0n) return 0;
  // T = floor(0.01 / (unitUsd / 10^decimals)) = floor(10^decimals / (100 × unitUsd))
  const t = floor({ num: 10n ** BigInt(decimals) * unitUsd.den, den: 100n * unitUsd.num });
  const capped = t > 9_999n ? 9_999 : Number(t);
  return capped < 100 ? 0 : capped;
}

/** Candidate tags in allocation order: up to 5 random draws, then every tag ascending (§8.3). */
export function tagCandidates(space: number, random: () => number): number[] {
  if (space <= 0) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < 5; i++) {
    const t = 1 + Math.floor(random() * space);
    const v = Math.min(Math.max(t, 1), space);
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/** Deadline (§8.1 step 7): min(cap, now + default); shorter than the chain minimum is refused. */
export function executionDeadline(
  nowMs: number,
  cap: Date | null,
  profile: { defaultDeadlineS: number; minDeadlineS: number },
): { ok: true; deadline: Date } | { ok: false } {
  const natural = nowMs + profile.defaultDeadlineS * 1000;
  const deadline = cap && cap.getTime() < natural ? cap.getTime() : natural;
  // whole seconds: 1Click deadlines are ISO strings and the spec timestamps are second-precise
  const d = new Date(Math.floor(deadline / 1000) * 1000);
  return d.getTime() - nowMs < profile.minDeadlineS * 1000 ? { ok: false } : { ok: true, deadline: d };
}

/** USD micros → base units of a par token, rounded up. */
export function parUnitsCeil(micros: bigint, decimals: number): bigint {
  return ceil(mul(rational(micros, 1_000_000n), rational(10n ** BigInt(decimals))));
}

/** `intents_transfer` fee (§8.1): max(ceil(amount × bps / 10 000), minimum fee). */
export function intentsFee(amount: bigint, bps: number, minFeeUnits: bigint): bigint {
  return maxOf(bpsOf(amount, bps), minFeeUnits);
}

/** RFC 8785 (JCS) of a flat object of ASCII strings: sorted keys, JSON string escaping. */
function jcsStrings(o: Readonly<Record<string, string>>): string {
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(o[k])}`)
    .join(",")}}`;
}

export interface BindingInput {
  readonly executionId: string;
  readonly payTo: string;
  readonly token: string;
  readonly amount: bigint;
  readonly feeTo: string;
  readonly feeAmount: bigint;
  readonly deadline: Date;
}

/**
 * Payment binding (§8.1 `intents_transfer`): `np1:` + base58(sha256(JCS({execution_id, pay_to,
 * token, amount, fee_to, fee, deadline}))). Both transfers carry it as their memo; the indexer
 * attributes the payment by it (single evidence path, agentpay §9).
 */
export function binding(b: BindingInput): string {
  const digest = createHash("sha256")
    .update(
      jcsStrings({
        execution_id: b.executionId,
        pay_to: b.payTo,
        token: b.token,
        amount: b.amount.toString(),
        fee_to: b.feeTo,
        fee: b.feeAmount.toString(),
        deadline: b.deadline.toISOString(),
      }),
    )
    .digest();
  return `np1:${bs58.encode(digest)}`;
}
