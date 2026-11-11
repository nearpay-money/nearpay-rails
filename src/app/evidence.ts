/**
 * Evidence reads (lld/rails.md §6, §8.10, §8.11): an execution's observations (archived rows carry their archive
 * reference) and the per-day evidence summary payments reconciles against. Every query filters by account and mode
 * (INV-8) except the by-id observation read, which is scoped by the execution itself.
 */

import { sql } from "@nearpay-internal/db";
import { fromUuid, toUuid } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import type { EvidenceSummary, getEvidenceSummary, ProviderObservation } from "@nearpay-internal/spec";
import type { RouteQuery } from "@nearpay-money/spec";
import type { Owner } from "../domain/execution/owner.js";
import { dayComplete, evidenceDigest, utcDay } from "../domain/reconciliation/digest.js";
import type { Rails } from "./context.js";
import { getExecutionRow } from "./executions.js";

export type ObservationPage = { data: ProviderObservation[]; has_more: boolean };

export async function observationsPage(
  r: Rails,
  exId: string,
  q: { starting_after?: string | undefined; limit: number },
): Promise<ObservationPage> {
  const ex = await getExecutionRow(r, exId);
  let query = r.db.selectFrom("provider_observations").selectAll().where("execution_id", "=", ex.id);
  if (q.starting_after) query = query.where("id", ">", toUuid(q.starting_after, "obs"));
  const rows = await query
    .orderBy("id")
    .limit(q.limit + 1)
    .execute();
  return {
    data: rows.slice(0, q.limit).map(
      (o) =>
        ({
          id: fromUuid("obs", o.id),
          execution_id: fromUuid("ex", o.execution_id),
          source: o.source,
          provider_status: o.provider_status,
          provider_updated_at: o.provider_updated_at?.toISOString() ?? null,
          applied: o.applied,
          observed_at: o.observed_at.toISOString(),
          payload_sha256: Buffer.from(o.payload_sha256).toString("hex"),
          payload: o.archive_key ? null : o.payload,
          archive:
            o.archive_key && o.archived_at
              ? { object_key: o.archive_key, row: o.archive_row ?? 0, archived_at: o.archived_at.toISOString() }
              : null,
        }) as ProviderObservation,
    ),
    has_more: rows.length > q.limit,
  };
}

// Stage 4 (§21.2): the Solana and Bitcoin watcher cursors join the completeness rule
const TRACKER_CURSORS = (name: string) =>
  name === "near-indexer" || name === "explorer" || name.startsWith("evm:") || name === "solana" || name === "bitcoin";

/**
 * `owner` (spec 0.3.1) narrows `totals`, `tier_b`, `digest`, `in_flight` and `held_open` to that owner's executions;
 * `complete` stays account-wide (it says whether the day's evidence can still change, whoever owns it). The route
 * passes the caller-resolved owner, never the raw query value.
 */
export async function evidenceSummary(
  r: Rails,
  q: RouteQuery<typeof getEvidenceSummary>,
  owner: Owner | undefined,
): Promise<EvidenceSummary> {
  const account = toUuid(q.account_id, "acct");
  let range: { start: Date; end: Date };
  try {
    range = utcDay(q.day);
  } catch {
    throw ApiError.invalid("not a calendar day", "day");
  }
  const { start, end } = range;
  const now = new Date(r.now());
  const lm = q.livemode;

  let day = r.db
    .selectFrom("executions")
    .where("account_id", "=", account)
    .where("livemode", "=", lm)
    .where("state", "in", ["succeeded", "refunded", "failed"])
    .where("terminal_at", ">=", start)
    .where("terminal_at", "<", end);
  if (owner) day = day.where("owner", "=", owner);
  // `in_flight`/`held_open` count the owner's open executions; `open_before_end` (completeness) counts every owner's
  const ownerMatch = owner ? sql<boolean>`owner = ${owner}` : sql<boolean>`true`;

  const [totals, members, tierB, open, cursors] = await Promise.all([
    day
      .select([
        "kind",
        "state",
        "destination_asset_id as asset_id",
        sql<string>`count(*)::text`.as("count"),
        sql<string>`coalesce(sum(settled_amount), 0)::text`.as("settled"),
        sql<string>`coalesce(sum(refunded_amount), 0)::text`.as("refunded"),
      ])
      .groupBy(["kind", "state", "destination_asset_id"])
      .orderBy("kind")
      .orderBy("state")
      .orderBy("destination_asset_id")
      .execute(),
    day.select(["id", "version"]).execute(),
    day
      .select(["id", "explorer_status"])
      .where("state", "=", "succeeded")
      .where(sql<boolean>`evidence->>'tier' = 'B'`)
      .orderBy("id")
      .execute(),
    r.db
      .selectFrom("executions")
      .select([
        sql<string>`count(*) filter (where ${ownerMatch})::text`.as("in_flight"),
        sql<string>`count(*) filter (where state = 'held' and ${ownerMatch})::text`.as("held_open"),
        sql<string>`count(*) filter (where state <> 'held' and deadline < ${end})::text`.as("open_before_end"),
      ])
      .where("account_id", "=", account)
      .where("livemode", "=", lm)
      .where("terminal_at", "is", null)
      .where("created_at", "<", end)
      // expired executions stop counting once their late-settlement window has closed (§5 "Expiry")
      .where((eb) =>
        eb.or([eb("state", "<>", "expired_unpaid"), eb("tracking_until", "is", null), eb("tracking_until", ">", now)]),
      )
      .executeTakeFirstOrThrow(),
    r.db.selectFrom("cursors").select(["name", "updated_at"]).execute(),
  ]);

  const confirmed = tierB.filter((x) => x.explorer_status === "SUCCESS");
  const relevantCursors = cursors.filter(
    (c) => TRACKER_CURSORS(c.name) && (c.name !== "explorer" || r.explorerEnabled),
  );
  return {
    account_id: q.account_id,
    livemode: lm,
    day: q.day,
    complete: dayComplete({
      nowMs: now.getTime(),
      endMs: end.getTime(),
      cursorUpdatedMs: lm ? relevantCursors.map((c) => c.updated_at.getTime()) : [],
      openBeforeEnd: Number(open.open_before_end),
    }),
    in_flight: Number(open.in_flight),
    held_open: Number(open.held_open),
    totals: totals.map((t) => ({
      kind: t.kind,
      state: t.state as "succeeded" | "refunded" | "failed",
      asset_id: t.asset_id,
      count: Number(t.count),
      settled_amount: BigInt(t.settled.split(".")[0] as string).toString(),
      refunded_amount: BigInt(t.refunded.split(".")[0] as string).toString(),
    })),
    tier_b: {
      count: tierB.length,
      explorer_confirmed: r.explorerEnabled ? confirmed.length : 0,
      unconfirmed: r.explorerEnabled
        ? tierB.filter((x) => x.explorer_status !== "SUCCESS").map((x) => fromUuid("ex", x.id))
        : [],
    },
    digest: evidenceDigest(members.map((m) => ({ id: fromUuid("ex", m.id), version: Math.max(1, m.version) }))),
    generated_at: now.toISOString(),
  } as EvidenceSummary;
}
