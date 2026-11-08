/**
 * Vault event forwarding (lld/rails.md §8.6 v1.8/v1.10, contracts-vault §4.1, AI audit A2-M-4).
 *
 * NEAR keeps the logs of failed receipts, and any contract can log a `nearpay_vault` line, so rails forwards a
 * `nearpay_vault` NEP-297 event to `evt.rails.vault.event` only if ALL hold: (1) the receipt's executor is exactly the
 * configured vault (`NP_VAULT_CONTRACT`; the sandbox stand-in in test mode); (2) the receipt outcome is
 * `SuccessValue` / `SuccessReceiptId`; (3) the block is final; (4) the envelope parses with version `1.0.0` and the
 * event's schema. Anything else is counted (`vault_event_rejected_total{reason}`) and dropped. Dedupe key
 * `receipt_id:log_index` (at-least-once indexing, INV-4): a `vault_events` row and the outbox row are written in one
 * transaction, so re-indexing a block forwards nothing twice.
 *
 * Envelope (§8.6 v1.10): `account_id` null (billing resolves the merchant from `ext_ref` / its mirror), `livemode`
 * true for the mainnet vault and false for the stand-in, aggregate `{type: "vault_mandate", id:
 * "<vault_contract>#<mandate_id>", version: block_height}`.
 */
import { createHash } from "node:crypto";
import { sql } from "@nearpay-internal/db";
import { uuidv7 } from "@nearpay-internal/ids";
import { EventEnvelope } from "@nearpay-internal/spec";
import type { Rails, Tx } from "../../app/context.js";
import {
  EVENT_JSON_PREFIX,
  parseVaultEventLog,
  type VAULT_EVENT_REJECT_REASONS,
  VAULT_EVENT_STANDARD,
  VAULT_EVENT_SUBJECT,
  VAULT_EVENT_VERSION,
  VaultEventRecord,
} from "../../spec-0.4.0.js";

export type VaultRejectReason = (typeof VAULT_EVENT_REJECT_REASONS)[number];

export interface VaultReceipt {
  readonly receiptId: string;
  readonly txHash: string | null;
  readonly executor: string;
  readonly logs: readonly string[];
  readonly success: boolean;
  /** Index of each line in the receipt's outcome logs when `logs` is a subset (sandbox feed); default: position. */
  readonly logIndexes?: readonly number[];
}

export interface VaultBlockContext {
  readonly vaultContract: string;
  readonly final: boolean;
  readonly blockHeight: number;
  readonly blockHash: string;
  /** Block time, ns decimal string; null when the source did not carry it. */
  readonly blockTimestamp: string | null;
}

/** NEP-297 envelope of a log line when it claims the `nearpay_vault` standard (whoever logged it), else null. */
function claimsVaultStandard(line: string): { version: unknown } | null {
  if (!line.startsWith(EVENT_JSON_PREFIX) || !line.includes(VAULT_EVENT_STANDARD)) return null;
  try {
    const j = JSON.parse(line.slice(EVENT_JSON_PREFIX.length)) as unknown;
    if (typeof j === "object" && j !== null && (j as { standard?: unknown }).standard === VAULT_EVENT_STANDARD)
      return { version: (j as { version?: unknown }).version };
  } catch {}
  return null;
}

/** Rules (1)–(3) and the version half of (4), in the §8.6 order; null = the line may be forwarded if it parses. */
function rejectionOf(o: VaultReceipt, ctx: VaultBlockContext, version: unknown): VaultRejectReason | null {
  if (o.executor !== ctx.vaultContract) return "wrong_executor";
  if (!o.success) return "failed_receipt";
  if (!ctx.final) return "not_final";
  if (version !== VAULT_EVENT_VERSION) return "bad_version";
  return null;
}

/**
 * The forwardable vault events of one receipt outcome, and the rejection reason of every other `nearpay_vault` line.
 * Pure. Rules are checked in the §8.6 order: executor, outcome, finality, version, schema.
 */
export function vaultEventsOf(
  o: VaultReceipt,
  ctx: VaultBlockContext,
): { records: VaultEventRecord[]; rejected: VaultRejectReason[] } {
  const records: VaultEventRecord[] = [];
  const rejected: VaultRejectReason[] = [];
  o.logs.forEach((line, position) => {
    const logIndex = o.logIndexes?.[position] ?? position;
    const claim = claimsVaultStandard(line);
    if (!claim) return;
    const reason = rejectionOf(o, ctx, claim.version);
    if (reason) {
      rejected.push(reason);
      return;
    }
    const event = parseVaultEventLog(line);
    const record = event
      ? VaultEventRecord.safeParse({
          vault_contract: ctx.vaultContract,
          tx_hash: o.txHash ?? o.receiptId,
          receipt_id: o.receiptId,
          log_index: logIndex,
          block_height: ctx.blockHeight,
          block_hash: ctx.blockHash,
          block_timestamp: ctx.blockTimestamp,
          event,
        })
      : null;
    if (record?.success) records.push(record.data);
    else rejected.push("bad_schema");
  });
  return { records, rejected };
}

/** Deterministic UUID (v8 layout) of a non-prefixed aggregate id, for the outbox's `aggregate_id uuid` column. */
export function aggregateUuid(id: string): string {
  const h = createHash("sha256").update(`vault_mandate:${id}`).digest();
  h[6] = ((h[6] as number) & 0x0f) | 0x80;
  h[8] = ((h[8] as number) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/**
 * Writes the outbox row of one forwarded event inside `tx`. Kit `emit` (0.3.1) maps `aggregate.id` through `toUuid`,
 * which only accepts NearPay prefixed ids; the vault aggregate id `<vault>#<mandate_id>` is not one (kit change
 * request), so this writes the same row `emit` would, with the envelope validated against the spec.
 */
async function emitVaultEvent(tx: Tx, livemode: boolean, rec: VaultEventRecord, id: string): Promise<void> {
  const aggregateId = `${rec.vault_contract}#${rec.event.data[0].mandate_id}`;
  const envelope = EventEnvelope.parse({
    id,
    subject: VAULT_EVENT_SUBJECT,
    occurred_at: new Date().toISOString(),
    account_id: null,
    livemode,
    aggregate: { type: "vault_mandate", id: aggregateId, version: rec.block_height },
    data: { object: VaultEventRecord.parse(rec) },
  });
  await tx
    .insertInto("outbox")
    .values({
      id: envelope.id,
      subject: envelope.subject,
      aggregate_type: envelope.aggregate.type,
      aggregate_id: aggregateUuid(aggregateId),
      aggregate_version: envelope.aggregate.version,
      account_id: null,
      livemode,
      payload: JSON.stringify(envelope),
      trace: null,
      created_at: envelope.occurred_at,
    })
    .execute();
  await sql`select pg_notify('nearpay_outbox', '')`.execute(tx);
}

/** Forwards records (dedupe `receipt_id:log_index` per mode); returns how many were new. */
export async function forwardVaultEvents(
  r: Rails,
  livemode: boolean,
  records: readonly VaultEventRecord[],
  rejected: readonly VaultRejectReason[] = [],
): Promise<number> {
  for (const reason of rejected) r.metrics.vaultEvent(reason);
  if (rejected.length) r.log.warn({ rejected, livemode }, "nearpay_vault logs dropped (rails §8.6 rules)");
  let forwarded = 0;
  for (const rec of records) {
    const eventId = uuidv7();
    const isNew = await r.db.transaction().execute(async (tx) => {
      const ins = await tx
        .insertInto("vault_events")
        .values({
          livemode,
          receipt_id: rec.receipt_id,
          log_index: rec.log_index,
          vault_contract: rec.vault_contract,
          tx_hash: rec.tx_hash,
          block_height: rec.block_height,
          block_hash: rec.block_hash,
          event: rec.event.event,
          mandate_id: rec.event.data[0].mandate_id,
          outbox_event_id: eventId,
        })
        .onConflict((oc) => oc.columns(["livemode", "receipt_id", "log_index"]).doNothing())
        .returning("receipt_id")
        .executeTakeFirst();
      if (!ins) return false;
      await emitVaultEvent(tx, livemode, rec, eventId);
      return true;
    });
    r.metrics.vaultEvent(isNew ? "forwarded" : "duplicate");
    if (isNew) forwarded++;
  }
  return forwarded;
}
