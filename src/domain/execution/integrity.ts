/**
 * Quote integrity (lld/rails.md §8.1 step 10, threat T-03 layer 1). Pure.
 *
 * Every quote is checked against the request NearPay sent before any deposit address is shown:
 * the echoed request must carry the same recipient, assets, amount, refund address and types; an
 * `EXACT_OUTPUT` quote must deliver exactly the requested amount; the deposit address must be valid
 * for the origin; and the deadline must leave the chain minimum. An `EXACT_INPUT` quote (refund legs) must take
 * exactly the requested amount in and promise a positive `minAmountOut` ≤ `amountOut`.
 *
 * `appFees` are not covered by the provider signature (the 1Click SDK's signed request sets
 * `appFees: undefined`), so they are checked here. 1Click echoes them **split** with its own fee
 * account (recorded quote 2026-11-05: `[{treasury, 50}]` → `[{treasury, 25}, {<1Click>, 25}]`, the
 * documented 50/50 split, provider half ≥ its floor). Accepted: the entries sum to exactly the fee
 * NearPay asked for (the payer is never charged more), exactly one entry pays the treasury, and the
 * treasury keeps at least `fee − max(ceil(fee × share), floor)`.
 */
import type { OneClickQuoteRequest, OneClickQuoteResponse } from "@nearpay-internal/spec";

export interface ProviderSplit {
  /** Provider share of appFees, bps of the fee (5000 = 50 %). */
  readonly shareBps: number;
  readonly floorBps: number;
  /** Floor on stable/same-asset routes. */
  readonly stableFloorBps: number;
}

export interface IntegrityInput {
  readonly sent: OneClickQuoteRequest;
  readonly response: OneClickQuoteResponse;
  readonly treasury: string | null;
  readonly feeBps: number;
  readonly split: ProviderSplit;
  readonly stableRoute: boolean;
  readonly nowMs: number;
  readonly minDeadlineS: number;
  /** Validates the deposit address for the origin (chain address or Intents account). */
  readonly validDeposit: (address: string) => boolean;
}

export type IntegrityResult = { ok: true } | { ok: false; failures: string[] };

/** Smallest treasury share NearPay accepts for a fee of `fee` bps. */
export function minTreasuryShare(fee: number, split: ProviderSplit, stableRoute: boolean): number {
  const floorBps = stableRoute ? split.stableFloorBps : split.floorBps;
  const providerTake = Math.max(Math.ceil((fee * split.shareBps) / 10_000), floorBps);
  return Math.max(0, fee - providerTake);
}

export function checkAppFees(
  echoed: readonly { recipient: string; fee: number }[] | null | undefined,
  treasury: string | null,
  feeBps: number,
  split: ProviderSplit,
  stableRoute: boolean,
): string[] {
  const fees = echoed ?? [];
  if (feeBps === 0) return fees.length === 0 ? [] : ["appFees present on a fee-free quote"];
  const failures: string[] = [];
  const total = fees.reduce((s, f) => s + f.fee, 0);
  if (total !== feeBps) failures.push(`appFees total ${total} bps != requested ${feeBps} bps`);
  const ours = fees.filter((f) => f.recipient === treasury);
  if (ours.length !== 1) failures.push(`appFees pay the treasury ${ours.length} times`);
  else if ((ours[0]?.fee ?? 0) < minTreasuryShare(feeBps, split, stableRoute))
    failures.push(`treasury appFee ${ours[0]?.fee} bps < ${minTreasuryShare(feeBps, split, stableRoute)} bps`);
  if (fees.length > 2) failures.push(`appFees has ${fees.length} entries (expected the treasury and the provider)`);
  return failures;
}

const SAME_FIELDS = [
  "recipient",
  "recipientType",
  "destinationAsset",
  "originAsset",
  "amount",
  "refundTo",
  "refundType",
  "depositType",
  "swapType",
] as const satisfies readonly (keyof OneClickQuoteRequest)[];

export function checkQuote(i: IntegrityInput): IntegrityResult {
  const failures: string[] = [];
  const echoed = i.response.quoteRequest;
  for (const f of SAME_FIELDS) {
    if (echoed[f] !== i.sent[f]) failures.push(`quoteRequest.${f} ${String(echoed[f])} != ${String(i.sent[f])}`);
  }
  if (echoed.dry !== false) failures.push("quote is a dry run");
  failures.push(...checkAppFees(echoed.appFees, i.treasury, i.feeBps, i.split, i.stableRoute));
  const q = i.response.quote;
  if (i.sent.swapType === "EXACT_OUTPUT" && q.amountOut !== i.sent.amount)
    failures.push(`amountOut ${q.amountOut} != requested ${i.sent.amount}`);
  // EXACT_INPUT (refund legs, Stage 2): the sender deposits exactly the requested amount; the recipient's floor is
  // minAmountOut, which must be positive and not above the quoted amountOut
  if (i.sent.swapType === "EXACT_INPUT") {
    if (q.amountIn !== i.sent.amount) failures.push(`amountIn ${q.amountIn} != requested ${i.sent.amount}`);
    if (!/^\d+$/.test(q.minAmountOut) || BigInt(q.minAmountOut) <= 0n) failures.push("minAmountOut is zero");
    else if (BigInt(q.minAmountOut) > BigInt(q.amountOut)) failures.push("minAmountOut exceeds amountOut");
  }
  if (BigInt(q.minAmountIn) > BigInt(q.amountIn)) failures.push("minAmountIn exceeds amountIn");
  if (BigInt(q.amountIn) <= 0n) failures.push("amountIn is zero");
  if (!q.depositAddress) failures.push("no deposit address");
  else if (!i.validDeposit(q.depositAddress))
    failures.push(`deposit address ${q.depositAddress} is invalid for the origin`);
  const deadline = q.deadline ? Date.parse(q.deadline) : Number.NaN;
  if (!Number.isFinite(deadline)) failures.push("quote has no deadline");
  else if (deadline < i.nowMs + i.minDeadlineS * 1000)
    failures.push("quote deadline is shorter than the chain minimum");
  return failures.length ? { ok: false, failures } : { ok: true };
}
