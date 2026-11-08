/** Row ↔ spec view mapping (`Execution`, domain-model §4.3). */

import type { Selectable } from "@nearpay-internal/db";
import { fromUuid } from "@nearpay-internal/ids";
import type { Execution } from "@nearpay-internal/spec";
import type { ExecutionsTable, TokensTable } from "../infra/db/schema.js";

export type ExecutionRow = Selectable<ExecutionsTable>;
export type TokenRowDb = Selectable<TokensTable>;

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);
/** numeric columns may come back as "1.000…" for scaled types; amounts are integers. */
const int = (s: string) => BigInt(s.split(".")[0] as string).toString();
const intOrNull = (s: string | null) => (s === null ? null : int(s));

export function executionView(r: ExecutionRow): Execution {
  const deposit =
    r.method === "route_quote" && r.deposit_address
      ? {
          address: r.deposit_address,
          memo: r.deposit_memo,
          amount_in: intOrNull(r.amount_in) ?? "0",
          min_amount_in: intOrNull(r.min_amount_in) ?? "0",
          chain: r.refund_type === "intents" ? "near:mainnet" : r.origin_chain,
          deadline: iso(r.deadline),
          // spec 0.2.1: NearPay's fee share of amount_in (display only); null when not apportioned
          fee_amount_in: intOrNull(r.fee_amount_in),
        }
      : null;
  const intents =
    // payment requirement only; a refund leg's instruction is `refund.transfer`
    r.method === "intents_transfer" && r.binding && r.kind === "payment"
      ? {
          pay_to: r.recipient,
          token: r.destination_asset_id,
          amount: int(r.amount_out_expected),
          fee_to: r.fee_recipient ?? "",
          fee_amount: intOrNull(r.fee_amount) ?? "0",
          binding: r.binding,
          deadline: iso(r.deadline),
        }
      : null;
  return {
    id: fromUuid("ex", r.id),
    version: Math.max(1, r.version),
    account_id: fromUuid("acct", r.account_id),
    livemode: r.livemode,
    kind: r.kind,
    method: r.method,
    provider: r.provider,
    state: r.state as Execution["state"],
    provider_status: r.provider_status,
    route_class: r.route_class,
    applied_fee_bps: r.applied_fee_bps,
    origin: {
      asset_id: r.origin_asset_id,
      chain: r.origin_chain,
      refund_to: r.refund_to,
      refund_type: r.refund_type,
      ...(r.origin_decimals !== null ? { decimals: r.origin_decimals } : {}),
    },
    settlement: {
      asset_id: r.destination_asset_id,
      amount_base: int(r.amount_out_base),
      tag: int(r.amount_tag),
      expected: int(r.amount_out_expected),
      recipient: r.recipient,
      recipient_type: r.recipient_type,
      chain: r.destination_chain,
      ...(r.destination_decimals !== null ? { decimals: r.destination_decimals } : {}),
    },
    price_snapshot: r.price_snapshot,
    deposit,
    intents_requirement: intents,
    deposit_tx_hashes: r.deposit_tx_hashes,
    settled_amount: intOrNull(r.settled_amount),
    refunded_amount: intOrNull(r.refunded_amount),
    refund_reason: r.refund_reason,
    evidence: r.evidence,
    failure_code: r.failure_code,
    held_reason: r.held_reason as Execution["held_reason"],
    deadline: iso(r.deadline),
    terminal_at: isoOrNull(r.terminal_at),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    reference: r.reference ?? null,
    refund: r.kind === "refund" ? (r.refund ?? null) : null,
    // spec 0.2.1
    observed_fee:
      r.kind === "payment" && r.observed_fee_amount !== null && r.observed_fee_asset !== null
        ? { amount: int(r.observed_fee_amount), asset_id: r.observed_fee_asset }
        : null,
    deposited_amount: intOrNull(r.deposited_amount),
    abandoned_at: isoOrNull(r.abandoned_at),
    abandon_reason: r.abandon_reason,
    // spec 0.3.0 (§20): consumers ignore executions they do not own; events carry the same view
    owner: r.owner,
    x402_binding: r.owner === "agentpay" ? r.x402_binding : null,
  } as Execution;
}

export { pricedToken } from "./pricing.js";
