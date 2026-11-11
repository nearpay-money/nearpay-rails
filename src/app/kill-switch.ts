/**
 * Rails' copy of sentinel's kill switch (`control_flags.quoting_enabled`, lld/rails.md §7, §"Spec 0.2.1 contract
 * changes"). `known` is false until sentinel's state was read with `getKillSwitch` or an
 * `evt.sentinel.kill_switch.*` event was applied; while unknown, live quoting (payments and refund legs) is refused
 * (fail closed). Test mode is unaffected. A read is stored only while the state is unknown or when its `version`
 * is newer than the stored one; events apply when newer (or when the state is unknown), so a late boot read never
 * overrides a newer event. A response without `version` (sentinel 0.2.0) is stored as version 0.
 */
import { sql } from "@nearpay-internal/db";
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

/** Stores a kill-switch state (event or boot read) in the caller's transaction or the pool; true when applied. */
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
/** A failing read logs `ALERT kill_switch_unknown` at once, then at most this often while it keeps failing. */
export const UNKNOWN_ALERT_EVERY_MS = 5 * 60_000;
const lastRead = new WeakMap<object, number>();
const unknownAlerts = new WeakMap<object, ReturnType<typeof alertLimiter>>();

function unknownAlert(r: Rails) {
  let a = unknownAlerts.get(r);
  if (!a) {
    a = alertLimiter(UNKNOWN_ALERT_EVERY_MS, r.now);
    unknownAlerts.set(r, a);
  }
  return a;
}

/**
 * Reads sentinel's state when the stored one is unknown and stores it. Never throws: a failed read leaves the
 * state unknown (live quoting stays refused) and logs `ALERT kill_switch_unknown` with why (rate-limited): `auth`
 * (rails' service token refused: scope `sentinel.read`), `network:*` / `timeout` (sentinel unreachable),
 * `http_<status>`, or `NP_SENTINEL_URL` unset. Returns the state afterwards.
 */
export async function readKillSwitch(r: Rails, o: { force?: boolean } = {}): Promise<KillSwitchKnowledge> {
  const cur = await quotingState(r);
  const alert = unknownAlert(r);
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
    const k = await r.sentinel.killSwitch();
    const applied = await storeKillSwitch(r.db, {
      engaged: k.engaged,
      version: k.version ?? 0,
      reason: `${k.engaged ? "kill switch engaged" : "released"} by ${k.actor}: ${k.reason} (read from sentinel)`,
    });
    if (applied) r.log.warn({ engaged: k.engaged, version: k.version ?? null }, "kill switch state read from sentinel");
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

/** Background task: reads the state at boot and retries while it stays unknown (api and feeds processes). */
export function killSwitchBootTask(r: Rails, o: { retryMs?: number } = {}) {
  return {
    name: "kill-switch-boot-read",
    start() {
      let stopped = false;
      let timer: NodeJS.Timeout | null = null;
      const tick = async () => {
        if (stopped) return;
        const st = await readKillSwitch(r, { force: true }).catch(() => "unknown" as const);
        if (st === "unknown" && !stopped) timer = setTimeout(tick, o.retryMs ?? READ_RETRY_MS);
        else if (st === "unknown") return;
        else r.log.info({ state: st }, "kill switch state known");
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
