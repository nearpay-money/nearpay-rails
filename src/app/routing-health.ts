/**
 * Routing health of a mode (domain/routing/health.ts) from the database, and the api background task that keeps the
 * `nearpay_rails_routing_*` gauges current and logs `ALERT routing_blocked` when live routing flips to blocked.
 *
 * Settlement assets: `options()` checks its destination asset; the gauges check every asset merchants settle in
 * (active watched destinations of the mode, enabled in the registry).
 */
import {
  REASON_FIX,
  REASON_TEXT,
  type RoutingHealth,
  type RoutingReason,
  routingHealth,
  settlementCheck,
} from "../domain/routing/health.js";
import { mode, type Rails } from "./context.js";
import { flag } from "./executions.js";
import { readKillSwitch } from "./kill-switch.js";
import { policyFor, pricedToken } from "./pricing.js";
import { REGISTRY_STALE_MS, registryRefreshedAt } from "./tokens.js";
import type { TokenRowDb } from "./views.js";

/** Enabled registry rows of the assets merchants settle in (active watched destinations of the mode). */
export async function settlementAssetsInUse(r: Rails, livemode: boolean): Promise<TokenRowDb[]> {
  return r.db
    .selectFrom("tokens")
    .selectAll()
    .where("livemode", "=", livemode)
    .where("enabled", "=", true)
    .where("asset_id", "in", (eb) =>
      eb
        .selectFrom("watched_destinations")
        .select("asset_id")
        .where("livemode", "=", livemode)
        .where("active", "=", true),
    )
    .orderBy("asset_id")
    .execute();
}

export interface HealthOptions {
  /** Check only this settlement asset (`options()`); default: the assets in use. */
  readonly settlement?: TokenRowDb;
  /** Also check registry freshness (default true; `options()` skips it: it does not block). */
  readonly registry?: boolean;
}

/** Routing health of one mode now (never throws for a missing piece: what is unknown is reported, fail closed). */
export async function computeRoutingHealth(r: Rails, livemode: boolean, o: HealthOptions = {}): Promise<RoutingHealth> {
  const [killSwitch, crossChainEnabled, policy, assets] = await Promise.all([
    livemode ? readKillSwitch(r) : Promise.resolve("released" as const),
    flag(r, "cross_chain_enabled"),
    policyFor(r, livemode),
    o.settlement ? Promise.resolve([o.settlement]) : settlementAssetsInUse(r, livemode),
  ]);
  const hasProvider = Boolean(livemode ? r.providers.live : r.providers.test);
  const registry =
    o.registry !== false && hasProvider
      ? { refreshedAt: await registryRefreshedAt(r, livemode), maxAgeMs: REGISTRY_STALE_MS }
      : null;
  return routingHealth({
    livemode,
    killSwitch,
    treasurySet: r.treasury !== null,
    crossChainEnabled,
    settlement: assets.map((t) => ({ asset_id: t.asset_id, check: settlementCheck(pricedToken(t), policy) })),
    registry,
    nowMs: r.now(),
  });
}

/** Seconds since each in-use settlement asset's primary price applied (gauge `settlement_price_age_seconds`). */
export async function settlementPriceAges(r: Rails, livemode: boolean): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const t of await settlementAssetsInUse(r, livemode)) {
    const at = t.price_updated_at ? new Date(t.price_updated_at).getTime() : null;
    out.set(t.asset_id, at === null ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor((r.now() - at) / 1000)));
  }
  return out;
}

/** The health as an operator reads it: each reason with its sentence and first fix (ops CLI, logs). */
export function explainHealth(h: RoutingHealth) {
  const explain = (reason: RoutingReason) => ({ reason, text: REASON_TEXT[reason], fix: REASON_FIX[reason] });
  return {
    mode: mode(h.livemode),
    livemode: h.livemode,
    available: h.available,
    reasons: h.reasons.map(explain),
    warnings: h.warnings.map(explain),
    settlement_assets_blocked: h.settlement,
    token_registry_age_s: h.registryAgeS === null || Number.isFinite(h.registryAgeS) ? h.registryAgeS : "never",
  };
}

export interface RoutingMonitorOptions {
  /** Evaluation cadence (default 15 s; Prometheus scrapes every 30 s). */
  readonly intervalMs?: number;
  /** No alert lines during this long after start, while the boot read of the kill switch settles (default 30 s). */
  readonly graceMs?: number;
  /** While still blocked, the alert line repeats at most this often (default 15 min). */
  readonly remindMs?: number;
  /** A change of reasons while blocked logs again, but at most this often (default 60 s). */
  readonly minLogMs?: number;
}

/** Per-mode alert state of the monitor (exported for tests). */
export interface ModeAlertState {
  available: boolean | null;
  key: string;
  loggedAt: number | null;
}

/**
 * Applies one evaluation to the alert state and logs as needed: live → `ALERT routing_blocked` (WARN) on the flip to
 * blocked, again when the reasons change (≥ minLogMs apart) or as a reminder; INFO when it recovers. Test mode logs
 * the same without the `ALERT` marker.
 */
export function logTransition(
  r: Pick<Rails, "log" | "now">,
  st: ModeAlertState,
  h: RoutingHealth,
  o: { quiet: boolean; remindMs: number; minLogMs: number },
): void {
  const key = h.reasons.join(",");
  const now = r.now();
  const since = st.loggedAt === null ? Number.POSITIVE_INFINITY : now - st.loggedAt;
  if (!h.available) {
    // during the boot grace period nothing is committed, so a block still present afterwards alerts as a flip
    if (o.quiet) return;
    const flipped = st.available !== false;
    // `key` is the last logged reason set: a change not logged yet (minLogMs) is logged on a later tick
    const changed = !flipped && key !== st.key && since >= o.minLogMs;
    const remind = !flipped && since >= o.remindMs;
    st.available = false;
    if (!(flipped || changed || remind)) return;
    const ex = explainHealth(h);
    const fields = {
      livemode: h.livemode,
      reasons: h.reasons,
      explanation: ex.reasons.map((x) => `${x.reason}: ${x.text} (fix: ${x.fix})`),
      warnings: h.warnings,
      settlement_assets_blocked: h.settlement,
      token_registry_age_s: ex.token_registry_age_s,
    };
    const what = `${mode(h.livemode)} payments cannot route (${h.reasons.join(", ")})`;
    r.log.warn(fields, h.livemode ? `ALERT routing_blocked: ${what}` : `routing_blocked: ${what}`);
    st.loggedAt = now;
    st.key = key;
    return;
  }
  if (st.available === false && st.loggedAt !== null)
    r.log.info({ livemode: h.livemode, previous: st.key.split(",") }, `${mode(h.livemode)} payments route again`);
  st.available = true;
  st.key = "";
  st.loggedAt = null;
}

/** Background task (api): gauges + alert lines for both modes. */
export function routingHealthTask(r: Rails, o: RoutingMonitorOptions = {}) {
  const intervalMs = o.intervalMs ?? 15_000;
  const graceMs = o.graceMs ?? 30_000;
  const opts = { remindMs: o.remindMs ?? 15 * 60_000, minLogMs: o.minLogMs ?? 60_000 };
  return {
    name: "routing-health",
    start() {
      const startedAt = r.now();
      const states = new Map<boolean, ModeAlertState>([
        [true, { available: null, key: "", loggedAt: null }],
        [false, { available: null, key: "", loggedAt: null }],
      ]);
      let stopped = false;
      let timer: NodeJS.Timeout | null = null;
      const tick = async () => {
        if (stopped) return;
        for (const livemode of [true, false]) {
          if (!livemode && !r.providers.test) continue;
          try {
            const h = await computeRoutingHealth(r, livemode);
            r.metrics.routingHealth(h, await settlementPriceAges(r, livemode));
            const quiet = r.now() - startedAt < graceMs;
            logTransition(r, states.get(livemode) as ModeAlertState, h, { ...opts, quiet });
          } catch (e) {
            if (!stopped) r.log.warn({ err: e, livemode }, "routing health could not be evaluated");
          }
        }
        if (!stopped) timer = setTimeout(tick, intervalMs);
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
