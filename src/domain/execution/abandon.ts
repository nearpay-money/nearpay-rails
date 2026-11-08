/**
 * Abandoning a refund leg payments no longer uses (spec 0.2.1 `abandonExecution`, lld/rails.md §"Spec 0.2.1
 * contract changes"). Pure.
 *
 * Only a `kind: refund` execution before any deposit may be abandoned: state `quoting`, `awaiting_deposit` or
 * `expired_unpaid`, no deposit transaction known, no deposited amount and no provider status past
 * `PENDING_DEPOSIT`. Anything where money may have moved — or a payment execution, or a terminal one — is a
 * conflict: truth wins (INV-3). An abandoned leg is moved to `expired_unpaid` at once (deadline = now) and stays
 * tracked for the usual 24 h, so a late deposit still settles. A repeat returns the execution unchanged.
 */
import type { State } from "./state.js";

export const ABANDONABLE: ReadonlySet<State> = new Set(["quoting", "awaiting_deposit", "expired_unpaid"]);

export interface AbandonFacts {
  readonly kind: "payment" | "refund";
  readonly state: State;
  readonly abandoned: boolean;
  readonly depositTxHashes: number;
  readonly depositedAmount: bigint | null;
  readonly providerStatus: string | null;
}

export type AbandonDecision =
  | { readonly kind: "replay" }
  | { readonly kind: "abandon"; readonly to: "expired_unpaid" }
  | { readonly kind: "conflict"; readonly reason: string };

export function decideAbandon(x: AbandonFacts): AbandonDecision {
  if (x.abandoned) return { kind: "replay" };
  if (x.kind !== "refund") return { kind: "conflict", reason: "only refund legs can be abandoned" };
  if (!ABANDONABLE.has(x.state)) return { kind: "conflict", reason: `the leg is ${x.state}` };
  if (x.depositTxHashes > 0 || (x.depositedAmount !== null && x.depositedAmount > 0n))
    return { kind: "conflict", reason: "a deposit was seen for the leg" };
  if (x.providerStatus !== null && x.providerStatus !== "PENDING_DEPOSIT")
    return { kind: "conflict", reason: `the provider reports ${x.providerStatus}` };
  return { kind: "abandon", to: "expired_unpaid" };
}
