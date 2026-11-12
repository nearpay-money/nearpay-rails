/**
 * Sentinel `getKillSwitch` (spec 0.2.1, service scope `sentinel.read`): read at boot while the local state is unknown,
 * then every 60 s (periodic read, lld/rails.md §7).
 */
import { httpClient } from "@nearpay-internal/http";
import { getKillSwitch } from "@nearpay-internal/spec";

export interface KillSwitchRead {
  readonly engaged: boolean;
  readonly reason: string;
  readonly actor: string;
  /** Envelope `aggregate.version` of sentinel's latest kill-switch event; absent from sentinel 0.2.0. */
  readonly version?: number | undefined;
  /** When sentinel's state last changed (ISO-8601). */
  readonly updated_at?: string | undefined;
}

export interface SentinelClient {
  killSwitch(): Promise<KillSwitchRead>;
}

export function sentinelClient(o: {
  baseUrl: string;
  serviceToken: () => Promise<string>;
  fetch?: typeof fetch;
}): SentinelClient {
  const client = httpClient({
    target: "sentinel",
    baseUrl: o.baseUrl,
    timeoutMs: 2_000,
    attempts: 2,
    serviceToken: o.serviceToken,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  return { killSwitch: () => client.call(getKillSwitch) };
}
