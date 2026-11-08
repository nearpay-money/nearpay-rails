/**
 * Applying what rails observes (lld/rails.md §5): provider statuses (hot poller, deposit submit,
 * Explorer nudges) and evidence (watchers, indexer, verifier). Every observation is recorded; only
 * those that are not older than the stored provider timestamp are applied (§5 "Monotonic").
 */
import { createHash } from "node:crypto";
import { explorerTxUrl, getChain } from "@nearpay-internal/chains";
import { uuidv7 } from "@nearpay-internal/ids";
import type { OneClickStatusResponse } from "@nearpay-internal/spec";
import { observedRouteFee } from "../domain/execution/amounts.js";
import { isExpired, LATE_REFUND_WINDOW_MS, nextPollAt } from "../domain/execution/schedule.js";
import { decideEvidence, decideProviderStatus, type HeldReason, type State } from "../domain/execution/state.js";
import type { VerificationResult } from "../domain/verification/verification.js";
import type { EvidenceRow, ObservationSource } from "../infra/db/schema.js";
import type { Rails, Tx } from "./context.js";
import { applyChange, type Change, type ChangeMeta, lockExecution } from "./ledger.js";
import type { ExecutionRow } from "./views.js";

export function observationValues(
  executionId: string,
  source: ObservationSource,
  status: string | null,
  payload: unknown,
  providerUpdatedAt: Date | null,
  applied: boolean,
) {
  return {
    id: uuidv7(),
    execution_id: executionId,
    source,
    provider_status: status,
    payload: JSON.stringify(payload ?? null),
    payload_sha256: createHash("sha256")
      .update(JSON.stringify(payload ?? null))
      .digest(),
    provider_updated_at: providerUpdatedAt,
    applied,
  };
}

const hashes = (xs: readonly { hash: string }[] | null | undefined) => (xs ?? []).map((x) => x.hash).filter(Boolean);
const merge = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])].slice(-20);
const amount = (s: string | null | undefined) => (s && /^\d+$/.test(s) ? BigInt(s) : null);

export function depositSeen(cur: ExecutionRow, s?: OneClickStatusResponse): boolean {
  if (cur.deposit_tx_hashes.length > 0) return true;
  if (cur.state !== "awaiting_deposit") return true;
  if (!s) return false;
  return hashes(s.swapDetails.originChainTxHashes).length > 0 || (amount(s.swapDetails.depositedAmount) ?? 0n) > 0n;
}

export function scheduleFor(r: Rails, row: ExecutionRow, state: State, pollCount: number): Date | null {
  const at = nextPollAt({
    state,
    hasSignal: row.has_signal,
    pollCount,
    createdAtMs: row.created_at.getTime(),
    deadlineMs: row.deadline.getTime(),
    nowMs: r.now(),
    explorerEnabled: r.explorerEnabled,
    awaitingSweepS: r.awaitingSweepS,
  });
  return at === null ? null : new Date(at);
}

/**
 * Applies a provider status to the locked row. `polled` updates the hot-poller schedule as well.
 * Returns the updated row.
 */
export async function applyStatus(
  r: Rails,
  tx: Tx,
  cur: ExecutionRow,
  s: OneClickStatusResponse,
  raw: unknown,
  source: Extract<ObservationSource, "hot_poll" | "submit" | "explorer">,
  polled: boolean,
): Promise<ExecutionRow> {
  const at = Date.parse(s.updatedAt);
  const updatedAt = Number.isFinite(at) ? new Date(at) : null;
  const stale = updatedAt !== null && cur.provider_updated_at !== null && updatedAt < cur.provider_updated_at;
  const obs = observationValues(cur.id, source, s.status, raw, updatedAt, !stale);
  await tx.insertInto("provider_observations").values(obs).execute();
  const pollCount = polled ? cur.poll_count + 1 : cur.poll_count;
  const meta: ChangeMeta = {
    cause: `provider ${s.status}`,
    actor: source === "submit" ? "api" : (source as ChangeMeta["actor"]),
    observationId: obs.id,
  };
  if (stale) {
    return applyChange(
      r,
      tx,
      cur,
      polled ? { pollCount, notFoundCount: 0, nextPollAt: scheduleFor(r, cur, cur.state as State, pollCount) } : {},
      meta,
    );
  }

  const d = s.swapDetails;
  const change: Change = {
    providerStatus: s.status,
    providerUpdatedAt: updatedAt,
    depositTxHashes: merge(cur.deposit_tx_hashes, hashes(d.originChainTxHashes)),
    destinationTxHashes: merge(cur.destination_tx_hashes, hashes(d.destinationChainTxHashes)),
  };
  if (s.status === "SUCCESS") change.providerAmountOut = amount(d.amountOut);
  // spec 0.2.1: what the payer deposited (provider `depositedAmount`) and, for a settled payment route, the app
  // fee the provider reports (its echoed `appFees` on the settled `amountIn`); unknown stays unknown
  const deposited = amount(d.depositedAmount);
  if (deposited !== null && deposited > 0n) change.depositedAmount = deposited;
  if (s.status === "SUCCESS" && cur.kind === "payment" && cur.observed_fee_amount === null) {
    const fee = observedRouteFee(d.amountIn, s.quoteResponse?.quoteRequest?.appFees);
    if (fee !== null) change.observedFee = { amount: fee, assetId: cur.origin_asset_id };
  }
  if (s.status === "REFUNDED" || (d.refundedAmount && amount(d.refundedAmount) !== 0n)) {
    const ref = amount(d.refundedAmount);
    if (ref !== null) change.refundedAmount = ref;
    if (d.refundReason) change.refundReason = d.refundReason;
  }
  // A repeated status carries no new information: only a changed provider status moves the state
  // (otherwise a hold for a contradiction would resolve itself on the next identical poll).
  const decision =
    s.status === cur.provider_status
      ? ({ kind: "none" } as const)
      : decideProviderStatus({ state: cur.state as State, depositSeen: depositSeen(cur, s) }, s.status);
  let next = cur.state as State;
  if (decision.kind === "move") {
    next = decision.to;
    change.state = decision.to;
    if (decision.heldReason) change.heldReason = decision.heldReason;
    if (decision.to === "failed") change.failureCode = "provider_failed";
    if (decision.alert)
      r.log.error({ execution: cur.id, status: s.status, alert: decision.alert }, "ALERT execution held");
  } else if (cur.state === "held" && s.status === "SUCCESS" && cur.verify_at === null) {
    // held with a provider success: let the verifier look for evidence again (held → succeeded)
    change.verifyAt = new Date(r.now());
  }
  // expiry (§5): no deposit and still PENDING_DEPOSIT past deadline + 10 min
  if (
    next === "awaiting_deposit" &&
    isExpired({
      state: next,
      depositSeen: depositSeen(cur, s),
      providerStatus: s.status,
      deadlineMs: cur.deadline.getTime(),
      nowMs: r.now(),
    })
  ) {
    next = "expired_unpaid";
    change.state = "expired_unpaid";
    change.trackingUntil = new Date(cur.deadline.getTime() + LATE_REFUND_WINDOW_MS);
  }
  if (polled) {
    change.pollCount = pollCount;
    change.notFoundCount = 0;
    change.nextPollAt = scheduleFor(r, cur, next, pollCount);
  }
  return applyChange(r, tx, cur, change, meta);
}

export interface EvidenceInput {
  readonly result: VerificationResult;
  readonly tier: "A" | "B";
  readonly source: "watcher" | "indexer" | "verifier" | "provider" | "operator";
  readonly chain: string;
  readonly txHash: string | null;
  readonly blockRef: string | null;
  readonly recipient: string;
  readonly assetId: string;
  readonly amount: bigint;
  readonly finality: "final" | "finalized" | "confirmed";
  readonly details?: Record<string, unknown>;
  /** spec 0.2.1 — `intents_transfer`: the executed payload's fee transfer and the payer's total (incl. fee). */
  readonly observedFee?: { readonly amount: bigint; readonly assetId: string } | null;
  readonly depositedAmount?: bigint | null;
}

function explorerUrl(chain: string, tx: string): string | null {
  try {
    return getChain(chain) ? explorerTxUrl(chain, tx) : null;
  } catch {
    return null;
  }
}

/** Records a verification and, for pass/short, settles the locked execution (INV-2). */
export async function applyEvidence(r: Rails, tx: Tx, cur: ExecutionRow, e: EvidenceInput): Promise<ExecutionRow> {
  const verificationId = uuidv7();
  await tx
    .insertInto("verifications")
    .values({
      id: verificationId,
      execution_id: cur.id,
      tier: e.tier,
      chain: e.chain,
      source: e.source,
      tx_hash: e.txHash,
      block_ref: e.blockRef,
      recipient: e.recipient,
      asset_id: e.assetId,
      amount: e.amount.toString(),
      finality: e.finality,
      result: e.result,
      details: JSON.stringify(e.details ?? {}),
    })
    .execute();
  r.metrics.verification(e.tier, e.result);
  if (e.result !== "pass" && e.result !== "short") return cur;
  if (!e.txHash) return cur;
  const decision = decideEvidence({ state: cur.state as State, depositSeen: true });
  if (decision.kind === "none") return cur;
  const evidence: EvidenceRow = {
    chain: e.chain,
    tx_hash: e.txHash,
    block_ref: e.blockRef,
    recipient: e.recipient,
    asset_id: e.assetId,
    amount: e.amount.toString(),
    finality: e.finality,
    tier: e.tier,
    source: e.source,
    observed_at: new Date(r.now()).toISOString(),
    explorer_url: explorerUrl(e.chain, e.txHash),
  };
  if (decision.to === "held") {
    r.log.error({ execution: cur.id, alert: decision.alert }, "ALERT execution held");
    return applyChange(
      r,
      tx,
      cur,
      { state: "held", heldReason: decision.heldReason as HeldReason },
      {
        cause: decision.alert ?? "evidence",
        actor: e.source === "provider" ? "verifier" : (e.source as ChangeMeta["actor"]),
        evidence,
      },
    );
  }
  return applyChange(
    r,
    tx,
    cur,
    {
      state: "succeeded",
      settledAmount: e.amount,
      evidence,
      ...(e.observedFee !== undefined && cur.kind === "payment" ? { observedFee: e.observedFee } : {}),
      ...(e.depositedAmount !== undefined ? { depositedAmount: e.depositedAmount } : {}),
    },
    {
      cause: e.result === "short" ? "evidence: short settlement" : `evidence: ${e.source}`,
      actor: e.source === "provider" ? "verifier" : (e.source as ChangeMeta["actor"]),
      evidence: { ...evidence, verification_id: verificationId },
    },
  );
}

/** Locks, then applies evidence (watchers and indexer work outside a row lock). */
export async function settleWithEvidence(
  r: Rails,
  executionId: string,
  e: EvidenceInput,
): Promise<ExecutionRow | null> {
  return r.db.transaction().execute(async (tx) => {
    const cur = await lockExecution(tx, executionId);
    if (!cur) return null;
    return applyEvidence(r, tx, cur, e);
  });
}
