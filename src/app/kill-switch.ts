/**
 * Rails' copy of sentinel's kill switch (`control_flags.quoting_enabled`, lld/rails.md §7, §"Spec 0.2.1 contract
 * changes"). `known` is false until sentinel's state was read with `getKillSwitch` or an
 * `evt.sentinel.kill_switch.*` event was applied; while unknown, live quoting (payments and refund legs) is refused
 * (fail closed). Test mode is unaffected. A read or event is stored only while the state is unknown or when its
 * `version` is newer than the stored one, so the copy never moves back to an older version and a late read never
 * overrides a newer event. A response without `version` (sentinel 0.2.0) is stored as version 0.
 *
 * Periodic read (audit RAILS-1): the event is not the only update path. The api and feeds processes re-read
 * sentinel every {@link RESYNC_MS} even while the state is known ({@link killSwitchSyncTask}), so a missed
 * `released` (or `engaged`) event — stopped consumer, dead letter, lost stream — repairs itself within a minute.
 * After each read the copy is compared with sentinel's answer: a missed event that the read repaired, or a
 * difference the read cannot repair (sentinel behind the copy, an operator `flag-set` override), logs
 * `ALERT kill_switch_copy_diverged`; gauges `nearpay_rails_kill_switch_*` let deploy alert `KillSwitchCopyDiverged`.
 * The quote path never waits for sentinel while the state is known.
 *
 * `quoting_enabled` is exactly `not engaged` of the newest sentinel version stored; `ops flag-set quoting_enabled`
 * changes only the value (emergency override), so the next newer sentinel state — event or periodic read — wins.
 */
import { sql } from "@nearpay-internal/db";
import { compareKillSwitchCopy, DIVERGENCE_FIX, type KillSwitchCopy } from "../domain/routing/kill-switch-copy.js";
import { alertLimiter, errorClass } from "../infra/clients/error-class.js";
import type { Rails, Tx } from "./context.js";

export type KillSwitchKnowledge = "engaged" | "released" | "unknown";

export async function quotingState(r: Pick<Rails, "db">): Promise<KillSwitchKnowledge> {
  const row = await r.db
    .selectFrom("control_flags")
    .select(["value", "known"])
    .where("name", "=", "quoting_enabled")
    .executeTakeFirst();
  if (!row?.known) return "unknown";
  return row.value ? "released" : "engaged";
}

/** The stored copy with its version (an absent row counts as unknown). */
export async function killSwitchCopy(r: Pick<Rails, "db">): Promise<KillSwitchCopy> {
  const row = await r.db
    .selectFrom("control_flags")
    .select(["value", "known", "source_version"])
    .where("name", "=", "quoting_enabled")
    .executeTakeFirst();
  if (!row) return { known: false, engaged: true, version: 0 };
  return { known: row.known, engaged: !row.value, version: Number(row.source_version) };
}

/** Stores a kill-switch state (event or read) in the caller's transaction or the pool; true when applied. */
export async function storeKillSwitch(
  db: Rails["db"] | Tx,
  s: { engaged: boolean; version: number; reason: string },
): Promise<boolean> {
  const r = await sql`
    insert into control_flags (name, value, reason, source_version, known, updated_at)
    values ('quoting_enabled', ${!s.engaged}, ${s.reason.slice(0, 500)}, ${s.version}, true, now())
    on conflict (name) do update set value = excluded.value, reason = excluded.reason,
      source_version = excluded.source_version, known = true, updated_at = now()
    where not control_flags.known or control_flags.source_version < excluded.source_version`.execute(db);
  return Number(r.numAffectedRows ?? 0n) === 1;
}

/** While the state stays unknown, sentinel is asked again at most this often per process. */
export const READ_RETRY_MS = 10_000;
/** While the state is known, sentinel is re-read this often per process (periodic read, audit RAILS-1). */
export const RESYNC_MS = 60_000;
/** A failing read logs `ALERT kill_switch_unknown` at once, then at most this often while it keeps failing. */
export const UNKNOWN_ALERT_EVERY_MS = 5 * 60_000;
/** A divergence the read cannot repair logs `ALERT kill_switch_copy_diverged` at most this often while it lasts. */
export const DIVERGED_ALERT_EVERY_MS = 5 * 60_000;
/**
 * A read that applies a newer state while the copy was known means the event was missed — unless sentinel changed
 * only this long ago (the event is still on its way): then it is logged without the ALERT marker.
 */
export const EVENT_IN_FLIGHT_MS = 30_000;

const lastRead = new WeakMap<object, number>();
const lastResync = new WeakMap<object, number>();
const lastCause = new WeakMap<object, string>();
const limiters = new WeakMap<
  object,
  Record<"unknown" | "diverged" | "resyncFailed", ReturnType<typeof alertLimiter>>
>();

function alerts(r: Rails) {
  let a = limiters.get(r);
  if (!a) {
    a = {
      unknown: alertLimiter(UNKNOWN_ALERT_EVERY_MS, r.now),
      diverged: alertLimiter(DIVERGED_ALERT_EVERY_MS, r.now),
      resyncFailed: alertLimiter(UNKNOWN_ALERT_EVERY_MS, r.now),
    };
    limiters.set(r, a);
  }
  return a;
}

/** Publishes the copy's gauges (`kill_switch_engaged`, `kill_switch_version`). */
async function publishCopy(r: Rails): Promise<KillSwitchCopy> {
  const c = await killSwitchCopy(r);
  r.metrics.killSwitchCopy({ engaged: !c.known || c.engaged, version: c.known ? c.version : null });
  return c;
}

/**
 * One read of sentinel: stores the answer (version-guarded), then compares the copy with it and logs/exports the
 * outcome. Throws when sentinel cannot be read (the caller decides how to report it).
 */
async function readFromSentinel(r: Rails & { sentinel: NonNullable<Rails["sentinel"]> }): Promise<void> {
  const before = await killSwitchCopy(r);
  const k = await r.sentinel.killSwitch();
  const version = k.version ?? null;
  const applied = await storeKillSwitch(r.db, {
    engaged: k.engaged,
    version: version ?? 0,
    reason: `${k.engaged ? "kill switch engaged" : "released"} by ${k.actor}: ${k.reason} (read from sentinel)`,
  });
  const after = await publishCopy(r);
  const divergence = compareKillSwitchCopy(after, { engaged: k.engaged, version });
  r.metrics.killSwitchSource({ engaged: k.engaged, version, readAtMs: r.now(), diverged: divergence !== null });
  const a = alerts(r).diverged;
  if (applied && before.known) {
    // the copy was known and behind: the event that should have moved it never applied (or is still in flight)
    const changedAt = Date.parse(k.updated_at ?? "");
    const inFlight = Number.isFinite(changedAt) && r.now() - changedAt < EVENT_IN_FLIGHT_MS;
    const fields = {
      cause: "copy_behind",
      resolved: true,
      from: { engaged: before.engaged, version: before.version },
      to: { engaged: k.engaged, version },
    };
    if (inFlight) r.log.info(fields, "kill switch state applied from sentinel's read ahead of its event");
    else
      r.log.warn(
        fields,
        `ALERT kill_switch_copy_diverged: rails' kill-switch copy was behind sentinel (an evt.sentinel.kill_switch.* event was missed); sentinel's newer state is applied now (live quoting ${k.engaged ? "stopped" : "resumed"}) — check the rails-feeds consumer and dead letters`,
      );
  } else if (applied) {
    r.log.warn({ engaged: k.engaged, version }, "kill switch state read from sentinel");
  }
  if (divergence) {
    // logged at once when the cause changes, else at most every DIVERGED_ALERT_EVERY_MS
    const due = a.due();
    const changed = lastCause.get(r) !== divergence;
    lastCause.set(r, divergence);
    if (due || changed)
      r.log.warn(
        {
          cause: divergence,
          copy: { known: after.known, engaged: after.engaged, version: after.version },
          sentinel: { engaged: k.engaged, version },
          reads: a.count,
          fix: DIVERGENCE_FIX[divergence],
        },
        `ALERT kill_switch_copy_diverged: rails' kill-switch copy differs from sentinel after a read (${divergence}); live quoting follows the copy (${after.known && !after.engaged ? "running" : "stopped"})`,
      );
  } else if (a.active) {
    r.log.info({ engaged: k.engaged, version, reads: a.count }, "kill switch copy agrees with sentinel again");
    a.reset();
    lastCause.delete(r);
  }
}

/**
 * Reads sentinel's state when the stored one is unknown and stores it. Never throws: a failed read leaves the
 * state unknown (live quoting stays refused) and logs `ALERT kill_switch_unknown` with why (rate-limited): `auth`
 * (rails' service token refused: scope `sentinel.read`), `network:*` / `timeout` (sentinel unreachable),
 * `http_<status>`, or `NP_SENTINEL_URL` unset. Returns the state afterwards. While the state is known it returns at
 * once (the hot path never waits for sentinel); {@link syncKillSwitch} re-reads it periodically.
 */
export async function readKillSwitch(r: Rails, o: { force?: boolean } = {}): Promise<KillSwitchKnowledge> {
  const cur = await quotingState(r);
  const alert = alerts(r).unknown;
  if (cur !== "unknown") {
    if (alert.active) {
      r.log.info({ state: cur, failed_reads: alert.count }, "kill switch state known again: live quoting follows it");
      alert.reset();
    }
    return cur;
  }
  if (!r.sentinel) {
    if (alert.due())
      r.log.warn(
        { cause: "sentinel_url_unset", failed_reads: alert.count },
        "ALERT kill_switch_unknown: NP_SENTINEL_URL is not set, so rails waits for an evt.sentinel.kill_switch.* event; live quoting stays refused until then",
      );
    return cur;
  }
  const last = lastRead.get(r);
  if (!o.force && last !== undefined && r.now() - last < READ_RETRY_MS) return cur;
  lastRead.set(r, r.now());
  try {
    await readFromSentinel(r as Rails & { sentinel: NonNullable<Rails["sentinel"]> });
  } catch (e) {
    const c = errorClass(e);
    if (alert.due())
      r.log.warn(
        { cause: c.class, status: c.status, err: c.message, failed_reads: alert.count, retry_ms: READ_RETRY_MS },
        "ALERT kill_switch_unknown: kill switch state could not be read from sentinel: live quoting stays refused while it is unknown",
      );
  }
  const after = await quotingState(r);
  if (after !== "unknown" && alert.active) {
    r.log.info({ state: after, failed_reads: alert.count }, "kill switch state known again: live quoting follows it");
    alert.reset();
  }
  return after;
}

/**
 * Periodic read (audit RAILS-1): re-reads sentinel at most every {@link RESYNC_MS} (unless `force`) even while the
 * state is known, stores a newer answer (never an older one) and reports a divergence. While unknown it is
 * {@link readKillSwitch}. Never throws; a failed re-read keeps the known state (it never turns `unknown`) and logs a
 * rate-limited warning. Refreshes the copy's gauges on every call. Returns the state afterwards.
 */
export async function syncKillSwitch(r: Rails, o: { force?: boolean } = {}): Promise<KillSwitchKnowledge> {
  const cur = await quotingState(r);
  if (cur === "unknown" || !r.sentinel) {
    const st = await readKillSwitch(r, o);
    await publishCopy(r);
    return st;
  }
  const last = lastResync.get(r);
  if (!o.force && last !== undefined && r.now() - last < RESYNC_MS) {
    await publishCopy(r);
    return cur;
  }
  lastResync.set(r, r.now());
  const failed = alerts(r).resyncFailed;
  try {
    await readFromSentinel(r as Rails & { sentinel: NonNullable<Rails["sentinel"]> });
    if (failed.active) {
      r.log.info({ failed_reads: failed.count }, "kill switch re-read from sentinel works again");
      failed.reset();
    }
  } catch (e) {
    const c = errorClass(e);
    await publishCopy(r);
    if (failed.due())
      r.log.warn(
        { cause: c.class, status: c.status, err: c.message, failed_reads: failed.count, state: cur },
        "kill switch could not be re-read from sentinel: rails keeps its copy and retries (a missed event cannot be repaired until sentinel answers)",
      );
  }
  return quotingState(r);
}

/**
 * Background task (api and feeds): reads the state at boot, retries every {@link READ_RETRY_MS} while it stays
 * unknown, then keeps re-reading every {@link RESYNC_MS} (periodic read) and refreshes the copy's gauges.
 */
export function killSwitchSyncTask(r: Rails, o: { tickMs?: number } = {}) {
  return {
    name: "kill-switch-sync",
    start() {
      let stopped = false;
      let timer: NodeJS.Timeout | null = null;
      let first = true;
      let known = false;
      const tick = async () => {
        if (stopped) return;
        const st = await syncKillSwitch(r, { force: first }).catch(() => "unknown" as const);
        first = false;
        if (st !== "unknown" && !known) r.log.info({ state: st }, "kill switch state known");
        known = st !== "unknown";
        if (!stopped) timer = setTimeout(tick, o.tickMs ?? READ_RETRY_MS);
      };
      void tick();
      return {
        async stop() {
          stopped = true;
          if (timer) clearTimeout(timer);
        },
      };
    },
  };
}
