/**
 * Shared machinery of the Stage 4 chain pools (lld/rails.md §21.4): ordered endpoints with failover, a hedged second
 * request when the first is slow, per-endpoint back-off on HTTP 429 (×2, capped), and pool health (the pool is
 * unhealthy once every call has failed for a while; > 5 min degrades new executions to Tier B and raises
 * `tier_a_degraded{chain}`).
 */

export class PoolUnavailable extends Error {
  override readonly name: string = "PoolUnavailable";
}

/** An endpoint answered 429: back off. */
export class PoolRateLimited extends PoolUnavailable {
  override readonly name = "PoolRateLimited";
}

export interface PoolHealthView {
  /** Last successful call (ms), null before the first one. */
  readonly lastOkMs: number | null;
  /** Start of the current run of failures (ms), null while healthy. */
  readonly failingSinceMs: number | null;
}

/** Degradation threshold (§21.4). */
export const UNHEALTHY_AFTER_MS = 5 * 60_000;

export class PoolHealth {
  #lastOk: number | null = null;
  #failingSince: number | null = null;
  ok(now: number): void {
    this.#lastOk = now;
    this.#failingSince = null;
  }
  fail(now: number): void {
    this.#failingSince ??= now;
  }
  view(): PoolHealthView {
    return { lastOkMs: this.#lastOk, failingSinceMs: this.#failingSince };
  }
}

/** True when the pool has failed every call for longer than the threshold. */
export const unhealthy = (h: PoolHealthView, now: number): boolean =>
  h.failingSinceMs !== null && now - h.failingSinceMs > UNHEALTHY_AFTER_MS;

export interface PoolOptions {
  readonly urls: readonly string[];
  readonly timeoutMs: number;
  /** Start the next endpoint when the first has not answered after this long (hedged read). */
  readonly hedgeMs?: number;
  readonly now?: () => number;
  /** Observes every endpoint call (metrics `chain_rpc_calls_total{chain,outcome}`). */
  readonly onCall?: (outcome: "ok" | "error" | "rate_limited") => void;
}

/**
 * Runs `attempt(url, signal)` against the pool: preferred endpoint first, the next one hedged after `hedgeMs` or at
 * once on failure; the first success wins and becomes preferred. Endpoints in 429 back-off are skipped while others
 * remain.
 */
export function endpointPool(o: PoolOptions) {
  const now = o.now ?? Date.now;
  const health = new PoolHealth();
  const cooldown = new Map<number, { until: number; backoffMs: number }>();
  let preferred = 0;

  function order(): number[] {
    const n = o.urls.length;
    const all = Array.from({ length: n }, (_, i) => (preferred + i) % n);
    const t = now();
    const ready = all.filter((i) => (cooldown.get(i)?.until ?? 0) <= t);
    return ready.length > 0 ? ready : all;
  }

  async function run<T>(attempt: (url: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (o.urls.length === 0) throw new PoolUnavailable("no endpoint configured");
    const idx = order();
    const controllers: AbortController[] = [];
    let last: unknown = null;
    const tryOne = async (i: number): Promise<T> => {
      const c = new AbortController();
      controllers.push(c);
      const timer = setTimeout(() => c.abort(), o.timeoutMs);
      try {
        const v = await attempt(o.urls[i] as string, c.signal);
        cooldown.delete(i);
        preferred = i;
        o.onCall?.("ok");
        return v;
      } catch (e) {
        if (e instanceof PoolRateLimited) {
          const prev = cooldown.get(i)?.backoffMs ?? 500;
          const backoffMs = Math.min(prev * 2, 60_000);
          cooldown.set(i, { until: now() + backoffMs, backoffMs });
          o.onCall?.("rate_limited");
        } else o.onCall?.("error");
        last = e;
        throw e;
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      const v = await new Promise<T>((resolve, reject) => {
        let pending = 0;
        let next = 0;
        let settled = false;
        let hedge: NodeJS.Timeout | undefined;
        const launch = () => {
          if (settled || next >= idx.length) return;
          const i = idx[next++] as number;
          pending++;
          tryOne(i).then(
            (val) => {
              if (settled) return;
              settled = true;
              clearTimeout(hedge);
              resolve(val);
            },
            () => {
              pending--;
              if (settled) return;
              if (next < idx.length) launch();
              else if (pending === 0) {
                settled = true;
                clearTimeout(hedge);
                reject(last);
              }
            },
          );
          if (o.hedgeMs !== undefined && next < idx.length) {
            clearTimeout(hedge);
            hedge = setTimeout(launch, o.hedgeMs);
          }
        };
        launch();
      });
      health.ok(now());
      return v;
    } catch (e) {
      health.fail(now());
      throw e instanceof Error ? e : new PoolUnavailable(String(e));
    } finally {
      for (const c of controllers) c.abort();
    }
  }

  /** One specific endpoint (agreement reads, §21.3). */
  async function one<T>(index: number, attempt: (url: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    const url = o.urls[index];
    if (!url) throw new PoolUnavailable(`no endpoint #${index}`);
    const c = new AbortController();
    const timer = setTimeout(() => c.abort(), o.timeoutMs);
    try {
      return await attempt(url, c.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  return { run, one, health: () => health.view(), urls: o.urls };
}
