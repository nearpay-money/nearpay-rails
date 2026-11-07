/**
 * Observation archive job `observations.archive` (lld/rails.md §8.11; daily 03:00 UTC on rails-feeds, after
 * payments' reconciliation). Observations of executions terminal for longer than `NP_OBS_ARCHIVE_AFTER_DAYS` (90)
 * are written per (mode, UTC day of `observed_at`) to Parquet under
 * `<prefix>/rails/observations/<live|test>/<yyyy>/<mm>/<dd>/<batch>.parquet`. The object is read back and every
 * row is checked (id, order, payload bytes, payload hash) before — in one transaction per batch — the payloads are
 * set to null and `archive_key`/`archive_row`/`archived_at` are set. The hash stays forever. Any failure leaves the
 * rows untouched (the next run retries); the store unset → the job does nothing.
 */
import { createHash } from "node:crypto";
import { sql } from "@nearpay-internal/db";
import { uuidv7 } from "@nearpay-internal/ids";
import { type ArchivedObservation, decodeObservations, encodeObservations } from "../archive/parquet.js";
import type { ArchiveStore } from "../archive/store.js";
import type { Rails } from "./context.js";

const BATCH = 2_000;
const DAY_MS = 86_400_000;

interface Candidate {
  id: string;
  execution_id: string;
  source: string;
  provider_status: string | null;
  provider_updated_at: Date | null;
  applied: boolean;
  observed_at: Date;
  payload_json: string;
  payload_sha256: Buffer;
  livemode: boolean;
  day: string;
}

export class ArchiveVerificationError extends Error {
  override readonly name = "ArchiveVerificationError";
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** The read-back check: same rows, same order, same payload bytes and hashes as the database rows. */
export function verifyReadBack(expected: readonly ArchivedObservation[], actual: readonly ArchivedObservation[]): void {
  if (expected.length !== actual.length)
    throw new ArchiveVerificationError(`row count ${actual.length} != ${expected.length}`);
  expected.forEach((e, i) => {
    const a = actual[i] as ArchivedObservation;
    if (a.id !== e.id || a.execution_id !== e.execution_id) throw new ArchiveVerificationError(`row ${i}: id mismatch`);
    if (a.payload_sha256 !== e.payload_sha256) throw new ArchiveVerificationError(`row ${i}: hash mismatch`);
    if (sha(a.payload_json) !== sha(e.payload_json)) throw new ArchiveVerificationError(`row ${i}: payload mismatch`);
    if (a.observed_at.getTime() !== e.observed_at.getTime())
      throw new ArchiveVerificationError(`row ${i}: observed_at mismatch`);
  });
}

export function archiveKey(prefix: string, livemode: boolean, day: string, batch: string): string {
  const [y, m, d] = day.split("-");
  const path = `rails/observations/${livemode ? "live" : "test"}/${y}/${m}/${d}/${batch}.parquet`;
  return prefix ? `${prefix}/${path}` : path;
}

async function candidates(r: Rails, cutoff: Date): Promise<Candidate[]> {
  const res = await sql<Candidate>`
    select o.id, o.execution_id, o.source, o.provider_status, o.provider_updated_at, o.applied, o.observed_at,
           o.payload::text as payload_json, o.payload_sha256, e.livemode,
           to_char(o.observed_at at time zone 'UTC', 'YYYY-MM-DD') as day
    from provider_observations o join executions e on e.id = o.execution_id
    where o.payload is not null and e.terminal_at is not null and e.terminal_at < ${cutoff}
    order by e.livemode, day, o.id
    limit ${BATCH}`.execute(r.db);
  return res.rows;
}

/** One run: archives batches until none is left (or `maxBatches`). Returns rows archived. */
export async function archiveObservations(r: Rails, store: ArchiveStore | null, maxBatches = 50): Promise<number> {
  if (!store) return 0;
  const cutoff = new Date(r.now() - r.archive.afterDays * DAY_MS);
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const rows = await candidates(r, cutoff);
    if (rows.length === 0) break;
    // one file per (mode, day): take the first group of this page
    const first = rows[0] as Candidate;
    const group = rows.filter((x) => x.livemode === first.livemode && x.day === first.day);
    const records: ArchivedObservation[] = group.map((x) => ({
      id: x.id,
      execution_id: x.execution_id,
      source: x.source,
      provider_status: x.provider_status,
      provider_updated_at: x.provider_updated_at,
      applied: x.applied,
      observed_at: x.observed_at,
      payload_json: x.payload_json,
      payload_sha256: hex(x.payload_sha256),
    }));
    const key = archiveKey(store.prefix, first.livemode, first.day, uuidv7());
    await store.put(key, encodeObservations(records));
    verifyReadBack(records, await decodeObservations(await store.get(key)));
    const now = new Date(r.now());
    await r.db.transaction().execute(async (tx) => {
      const res = await sql`
        update provider_observations o
        set payload = null, archive_key = ${key}, archive_row = v.row, archived_at = ${now}
        from unnest(${records.map((x) => x.id)}::uuid[], ${records.map((_, j) => j)}::int[]) as v(id, row)
        where o.id = v.id and o.payload is not null`.execute(tx);
      if (Number(res.numAffectedRows ?? 0n) !== records.length)
        throw new ArchiveVerificationError(`batch ${key}: rows changed while archiving`);
    });
    total += records.length;
    r.metrics.archived(records.length);
    r.log.info({ key, rows: records.length, store: store.describe }, "observations archived");
  }
  return total;
}
