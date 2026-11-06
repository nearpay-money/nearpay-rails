/**
 * Jobs (lld/rails.md §9), run by `rails-feeds` (leases, backoff, dead letters):
 *
 * | kind                 | when        | what                                                          |
 * |----------------------|-------------|---------------------------------------------------------------|
 * | minimums.refresh     | hourly      | destination minimums (§8.9)                                   |
 * | tags.release_orphans | every 5 min | tags reserved by a create that crashed before its execution existed |
 * | kit.purge            | hourly      | published outbox, old inbox, expired idempotency keys         |
 *
 * The observation archive (> 90 days → Parquet) arrives in Stage 2 with the server stage's S3.
 */
import { type JobHandler, purgeKitTables, type RecurringJob, sql } from "@nearpay-internal/db";
import type { Rails } from "../app/context.js";
import { refreshMinimums } from "../app/minimums.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const RECURRING: readonly RecurringJob[] = [
  { kind: "minimums.refresh", everyMs: HOUR, offsetMs: 5 * MINUTE },
  { kind: "tags.release_orphans", everyMs: 5 * MINUTE },
  { kind: "kit.purge", everyMs: HOUR },
];

/** Releases tags whose execution never got created (the create releases on every handled failure). */
export async function releaseOrphanTags(r: Rails): Promise<number> {
  const res = await sql`
    update amount_tags t set released_at = now()
    where t.released_at is null and t.allocated_at < now() - interval '5 minutes'
      and not exists (select 1 from executions e where e.id = t.execution_id)`.execute(r.db);
  return Number(res.numAffectedRows ?? 0n);
}

export function jobHandlers(r: Rails): Record<string, JobHandler> {
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
  };
}
