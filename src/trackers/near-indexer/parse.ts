/**
 * NEAR receipt parsing for the indexer and the sandbox feed (lld/rails.md §8.6). Pure.
 *
 * Mainnet shapes (SP-14, fixtures recorded 2026-11-06 from neardata blocks 223270688–223270709):
 * - DIP-4 `transfer` (intents.near): `{intent_hash, account_id, receiver_id, tokens: {asset: amount},
 *   memo?}` — the **only** event that carries a transfer intent's memo (the payment binding).
 * - NEP-245 `mt_transfer` (intents.near): `{old_owner_id, new_owner_id, token_ids, amounts}` — every
 *   balance movement (transfers, solver deliveries); no memo for transfer intents.
 * - NEP-141 `ft_transfer` (token contract): `{old_owner_id, new_owner_id, amount, memo?}`.
 * Only successful receipt outcomes count.
 */
import { parseEventLogs } from "@nearpay-internal/intents";
import type { EvidenceChainDetail } from "../../spec-0.4.0.js";

export interface Credit {
  readonly chain: string;
  /** `binding`: a DIP-4 transfer with a memo (matched by binding); `amount`: matched by amount. */
  readonly kind: "binding" | "amount";
  readonly to: string;
  /** Sender as the event names it (spec 0.3.0 `Evidence.sender`): DIP-4 `account_id`, NEP-245/NEP-141 `old_owner_id`, ERC-20 `from`. */
  readonly from: string | null;
  readonly assetId: string;
  readonly amount: bigint;
  readonly memo: string | null;
  readonly txHash: string;
  readonly blockRef: string;
  /** Unique within the transaction (receipt id + event index). */
  readonly logRef: string;
  /** spec 0.4.0: chain detail for the evidence (Solana watcher). */
  readonly detail?: EvidenceChainDetail;
}

export interface ReceiptOutcome {
  readonly receiptId: string;
  readonly txHash: string | null;
  readonly executor: string;
  readonly logs: readonly string[];
  readonly success: boolean;
}

const UINT = /^\d{1,78}$/;

/** A NEAR account named by an event as the sender, lower-cased; anything else is unknown (null). */
export function senderOf(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= 64 ? v.toLowerCase() : null;
}

/** Success: `SuccessValue` or `SuccessReceiptId` (failures emit no balance changes). */
export function outcomeSucceeded(status: Record<string, unknown>): boolean {
  return "SuccessValue" in status || "SuccessReceiptId" in status;
}

/** Credits in one receipt outcome. `tokenContracts`: NEP-141 contracts whose transfers are watched. */
export function creditsOf(
  o: ReceiptOutcome,
  ctx: { chain: string; intentsContract: string; tokenContracts: ReadonlySet<string>; blockRef: string },
): Credit[] {
  if (!o.success) return [];
  const txHash = o.txHash ?? o.receiptId;
  const out: Credit[] = [];
  const events = parseEventLogs(o.logs);
  events.forEach((e, i) => {
    if (!Array.isArray(e.data)) return;
    const ref = (j: number, k = 0) => `${o.receiptId}:${i}:${j}:${k}`;
    if (o.executor === ctx.intentsContract && e.standard === "dip4" && e.event === "transfer") {
      (e.data as Record<string, unknown>[]).forEach((d, j) => {
        const memo = typeof d?.memo === "string" ? d.memo : null;
        if (!memo || typeof d.receiver_id !== "string" || typeof d.tokens !== "object" || d.tokens === null) return;
        Object.entries(d.tokens as Record<string, unknown>).forEach(([asset, amt], k) => {
          if (typeof amt !== "string" || !UINT.test(amt)) return;
          out.push({
            chain: ctx.chain,
            kind: "binding",
            to: (d.receiver_id as string).toLowerCase(),
            from: senderOf(d.account_id),
            assetId: asset,
            amount: BigInt(amt),
            memo,
            txHash,
            blockRef: ctx.blockRef,
            logRef: ref(j, k),
          });
        });
      });
    } else if (o.executor === ctx.intentsContract && e.standard === "nep245" && e.event === "mt_transfer") {
      (e.data as Record<string, unknown>[]).forEach((d, j) => {
        const ids = d?.token_ids;
        const amounts = d?.amounts;
        if (typeof d?.new_owner_id !== "string" || !Array.isArray(ids) || !Array.isArray(amounts)) return;
        if (ids.length !== amounts.length) return;
        ids.forEach((asset, k) => {
          const amt = amounts[k];
          if (typeof asset !== "string" || typeof amt !== "string" || !UINT.test(amt)) return;
          out.push({
            chain: ctx.chain,
            kind: "amount",
            to: (d.new_owner_id as string).toLowerCase(),
            from: senderOf(d.old_owner_id),
            assetId: asset,
            amount: BigInt(amt),
            memo: null,
            txHash,
            blockRef: ctx.blockRef,
            logRef: ref(j, k),
          });
        });
      });
    } else if (ctx.tokenContracts.has(o.executor) && e.standard === "nep141" && e.event === "ft_transfer") {
      (e.data as Record<string, unknown>[]).forEach((d, j) => {
        if (typeof d?.new_owner_id !== "string" || typeof d.amount !== "string" || !UINT.test(d.amount)) return;
        out.push({
          chain: ctx.chain,
          kind: "amount",
          to: d.new_owner_id.toLowerCase(),
          from: senderOf(d.old_owner_id),
          assetId: `nep141:${o.executor}`,
          amount: BigInt(d.amount),
          memo: typeof d.memo === "string" ? d.memo : null,
          txHash,
          blockRef: ctx.blockRef,
          logRef: ref(j),
        });
      });
    }
  });
  return out;
}

/** Receipt outcomes of a neardata block. */
export function outcomesOfBlock(b: {
  shards: readonly {
    receipt_execution_outcomes: readonly {
      execution_outcome: {
        id: string;
        outcome: { executor_id: string; logs: readonly string[]; status: Record<string, unknown> };
      };
      tx_hash?: string | null | undefined;
    }[];
  }[];
}): ReceiptOutcome[] {
  const out: ReceiptOutcome[] = [];
  for (const s of b.shards) {
    for (const r of s.receipt_execution_outcomes) {
      const o = r.execution_outcome.outcome;
      out.push({
        receiptId: r.execution_outcome.id,
        txHash: r.tx_hash ?? null,
        executor: o.executor_id,
        logs: o.logs,
        success: outcomeSucceeded(o.status),
      });
    }
  }
  return out;
}
