/**
 * Jobs (lld/rails.md §9), run by `rails-feeds` (leases, backoff, dead letters):
 *
 * | kind                 | when        | what                                                          |
 * |----------------------|-------------|---------------------------------------------------------------|
 * | minimums.refresh     | hourly      | destination minimums (§8.9)                                   |
 * | tags.release_orphans | every 5 min | tags reserved by a create that crashed before its execution existed |
 * | kit.purge            | hourly      | published outbox, old inbox, expired idempotency keys         |
 * | observations.archive | daily 03:00 | observations of executions terminal > 90 days → Parquet (§8.11) |
 */
import { type JobHandler, purgeKitTables, type RecurringJob, sql } from "@nearpay-internal/db";
import { archiveObservations } from "../app/archive.js";
import type { Rails } from "../app/context.js";
import { refreshMinimums } from "../app/minimums.js";
import type { ArchiveStore } from "../archive/store.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const RECURRING: readonly RecurringJob[] = [
  { kind: "minimums.refresh", everyMs: HOUR, offsetMs: 5 * MINUTE },
  { kind: "tags.release_orphans", everyMs: 5 * MINUTE },
  { kind: "kit.purge", everyMs: HOUR },
  { kind: "observations.archive", everyMs: 24 * HOUR, offsetMs: 3 * HOUR },
];

/** Releases tags whose execution never got created (the create releases on every handled failure). */
export async function releaseOrphanTags(r: Rails): Promise<number> {
  const res = await sql`
    update amount_tags t set released_at = now()
    where t.released_at is null and t.allocated_at < now() - interval '5 minutes'
      and not exists (select 1 from executions e where e.id = t.execution_id)`.execute(r.db);
  return Number(res.numAffectedRows ?? 0n);
}

export function jobHandlers(r: Rails, o: { archive?: ArchiveStore | null } = {}): Record<string, JobHandler> {
  return {
    "minimums.refresh": async () => {
      r.log.info({ written: await refreshMinimums(r) }, "destination minimums refreshed");
    },
    "tags.release_orphans": async () => {
      const n = await releaseOrphanTags(r);
      if (n) r.log.warn({ released: n }, "orphan amount tags released");
    },
    "kit.purge": async () => {
      r.log.info(await purgeKitTables(r.db), "kit tables purged");
    },
    "observations.archive": async (_payload, ctx) => {
      const n = await archiveObservations(r, o.archive ?? null, 50, () => ctx.extendLease());
      if (n) r.log.info({ archived: n }, "observation archive run");
    },
  };
}
