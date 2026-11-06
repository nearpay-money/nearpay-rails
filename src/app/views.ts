/** Row ↔ spec view mapping (`Execution`, domain-model §4.3). */

import type { Selectable } from "@nearpay-internal/db";
import { fromUuid } from "@nearpay-internal/ids";
import type { Execution } from "@nearpay-internal/spec";
import type { PricedToken } from "../domain/pricing/pricing.js";
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
        }
      : null;
  const intents =
    r.method === "intents_transfer" && r.binding
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
    },
    settlement: {
      asset_id: r.destination_asset_id,
      amount_base: int(r.amount_out_base),
      tag: int(r.amount_tag),
      expected: int(r.amount_out_expected),
      recipient: r.recipient,
      recipient_type: r.recipient_type,
      chain: r.destination_chain,
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
  } as Execution;
}

export function pricedToken(t: TokenRowDb): PricedToken {
  return {
    asset_id: t.asset_id,
    decimals: t.decimals,
    is_usd_stable: t.is_usd_stable,
    price_usd: t.price_usd,
    price_updated_at: t.price_updated_at,
    secondary_price_usd: t.secondary_price_usd,
    secondary_updated_at: t.secondary_updated_at,
  };
}
