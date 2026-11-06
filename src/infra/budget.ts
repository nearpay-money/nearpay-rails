/**
 * Shared call budgets for 1Click (lld/rails.md §10: quotes `NP_ONECLICK_QUOTE_RPS`, status
 * `NP_ONECLICK_STATUS_RPS`): one token bucket in Valkey per budget, shared by every replica. When
 * Valkey is unreachable each replica keeps a local bucket at half the rate (two replicas per process
 * type, §2), so the provider budget is never exceeded.
 */
import { Redis } from "ioredis";

const BUCKET_LUA = `
local rate = tonumber(ARGV[1]); local burst = tonumber(ARGV[2]); local now = tonumber(ARGV[3])
local s = redis.call('HMGET', KEYS[1], 't', 'at')
local tokens = tonumber(s[1]) or burst; local at = tonumber(s[2]) or now
tokens = math.min(burst, tokens + ((now - at) / 1000) * rate)
local allowed = 0; local retry = 0
if tokens >= 1 then tokens = tokens - 1; allowed = 1 else retry = math.ceil(((1 - tokens) / rate) * 1000) end
redis.call('HSET', KEYS[1], 't', tokens, 'at', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(burst / rate * 1000) + 1000)
return {allowed, retry}`;

export interface Budgets {
  /** Takes one call from `name` (calls per second `rate`); waits up to `waitMs` for a token. */
  take(name: string, rate: number, waitMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

interface Local {
  tokens: number;
  at: number;
}

export function budgets(o: { valkeyUrl?: string | undefined; now?: () => number }): Budgets {
  const now = o.now ?? Date.now;
  const redis = o.valkeyUrl
    ? new Redis(o.valkeyUrl, {
        lazyConnect: false,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        connectTimeout: 1_000,
        commandTimeout: 250,
      })
    : null;
  redis?.on("error", () => {});
  const locals = new Map<string, Local>();

  async function once(name: string, rate: number): Promise<{ ok: boolean; retryMs: number }> {
    const burst = Math.max(1, rate);
    if (redis?.status === "ready") {
      try {
        const [allowed, retry] = (await redis.eval(BUCKET_LUA, 1, `rails:budget:${name}`, rate, burst, now())) as [
          number,
          number,
        ];
        return { ok: allowed === 1, retryMs: retry };
      } catch {}
    }
    const r = rate / 2;
    const b = Math.max(1, burst / 2);
    const s = locals.get(name) ?? { tokens: b, at: now() };
    const t = now();
    s.tokens = Math.min(b, s.tokens + ((t - s.at) / 1000) * r);
    s.at = t;
    locals.set(name, s);
    if (s.tokens >= 1) {
      s.tokens -= 1;
      return { ok: true, retryMs: 0 };
    }
    return { ok: false, retryMs: Math.ceil(((1 - s.tokens) / r) * 1000) };
  }

  return {
    async take(name, rate, waitMs = 0) {
      const until = now() + waitMs;
      for (;;) {
        const r = await once(name, rate);
        if (r.ok) return true;
        const wait = Math.max(r.retryMs, 10);
        if (now() + wait > until) return false;
        await new Promise((res) => setTimeout(res, wait));
      }
    },
    async close() {
      redis?.disconnect();
    },
  };
}
