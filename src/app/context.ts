/** Dependencies shared by rails use cases, loops and consumers. */
import type { Kysely, Transaction } from "@nearpay-internal/db";
import type { Logger, ServiceMetrics } from "@nearpay-internal/service";
import type { ProviderSplit } from "../domain/execution/integrity.js";
import type { PolicyConfig } from "../domain/pricing/pricing.js";
import { ROUTING_REASONS, type RoutingHealth } from "../domain/routing/health.js";
import type { ChainProfiles } from "../domain/token-registry/chain-profiles.js";
import type { RouteClass } from "../domain/token-registry/registry.js";
import type { TierBLimits } from "../domain/verification/verification.js";
import type { Screening } from "../infra/clients/compliance.js";
import type { Nonces } from "../infra/clients/nonces.js";
import type { SentinelClient } from "../infra/clients/sentinel.js";
import type { DB } from "../infra/db/schema.js";
import type { RouteProvider } from "../providers/port.js";
import type { SandboxChains } from "../providers/sandbox/client.js";

export type Tx = Transaction<DB>;

export interface RailsMetrics {
  quote(provider: string, outcome: string, seconds: number): void;
  statusCall(source: string, outcome: string): void;
  transition(to: string): void;
  verification(tier: string, result: string): void;
  timeToEvidence(routeClass: string, chain: string, seconds: number): void;
  unattributed(chain: string): void;
  pricingUnavailable(asset: string): void;
  tagsExhausted(): void;
  integrityFailure(provider: string): void;
  lag(name: string, blocks: number): void;
  explorer(res: { rows: number; recorded: number; nudged: number; unmatched: number }): void;
  archived(rows: number): void;
  /** Stage 4 (§21.4): `tier_a_degraded{chain}` (1 = the chain's pool is unhealthy or unset). */
  tierDegraded(chain: string, degraded: boolean): void;
  /** Stage 4: `chain_rpc_calls_total{chain,outcome}` per endpoint call of the Solana/Bitcoin pools. */
  chainRpcCall(chain: string, outcome: string): void;
  /** Stage 4 (§8.6): `vault_events_total{outcome}` — `forwarded`, `duplicate` or a reject reason. */
  vaultEvent(outcome: string): void;
  /**
   * ADR-0022 (§8.12): `finality_recheck_total{chain,outcome}` — `finalized`, `failed` (alert) or `timeout` (alert), for
   * every Tier-A family settled on one-block evidence (EVM, Solana, Bitcoin).
   */
  finalityRecheck(chain: string, outcome: "finalized" | "failed" | "timeout"): void;
  /**
   * Routing health of one mode (app/routing-health.ts): `routing_available{livemode}` (0/1),
   * `routing_blocked{livemode,reason}` (1 per blocking reason, 0 for every other code),
   * `token_registry_age_seconds{livemode}` (+Inf = never refreshed) and
   * `settlement_price_age_seconds{livemode,asset}` per settlement asset in use.
   */
  routingHealth(h: RoutingHealth, priceAges: ReadonlyMap<string, number>): void;
  /**
   * Kill-switch copy (app/kill-switch.ts, lld/rails.md §7 periodic read), only in the processes that keep it (api,
   * feeds): `kill_switch_engaged` (1 = live quoting refused by the copy: engaged or unknown) and
   * `kill_switch_version` (the sentinel version the copy came from; -1 = unknown).
   */
  killSwitchCopy(c: { engaged: boolean; version: number | null }): void;
  /**
   * Sentinel's answer at the last successful read: `kill_switch_source_engaged`, `kill_switch_source_version`
   * (-1 = sentinel sent none), `kill_switch_last_read_timestamp_seconds`, and `kill_switch_diverged` (1 when the copy
   * still differs from that answer after the read was applied — deploy alert `KillSwitchCopyDiverged`).
   */
  killSwitchSource(s: { engaged: boolean; version: number | null; readAtMs: number; diverged: boolean }): void;
}

export const noMetrics: RailsMetrics = {
  quote() {},
  statusCall() {},
  transition() {},
  verification() {},
  timeToEvidence() {},
  unattributed() {},
  pricingUnavailable() {},
  tagsExhausted() {},
  integrityFailure() {},
  lag() {},
  explorer() {},
  archived() {},
  tierDegraded() {},
  chainRpcCall() {},
  vaultEvent() {},
  finalityRecheck() {},
  routingHealth() {},
  killSwitchCopy() {},
  killSwitchSource() {},
};

export function railsMetrics(m: ServiceMetrics): RailsMetrics {
  const quote = m.histogram(
    "quote_duration_seconds",
    "Provider quote latency.",
    ["provider", "outcome"],
    [0.1, 0.25, 0.5, 1, 2, 4, 6, 8],
  );
  const status = m.counter("status_calls_total", "Provider status calls.", ["source", "outcome"]);
  const transitions = m.counter("execution_transitions_total", "Execution state changes.", ["to"]);
  const verifications = m.counter("verification_results_total", "Evidence checks.", ["tier", "result"]);
  const tte = m.histogram(
    "time_to_evidence_seconds",
    "Execution created → evidence accepted.",
    ["route_class", "chain"],
    [10, 30, 60, 120, 300, 600, 1200, 1800, 3600],
  );
  const unattributed = m.counter(
    "unattributed_transfers_total",
    "Transfers to watched destinations that matched no execution.",
    ["chain"],
  );
  const pricing = m.counter("pricing_unavailable_total", "Settlements refused for want of a reliable price.", [
    "asset",
  ]);
  const tags = m.counter("tags_exhausted_total", "Executions created untagged because the tag space was full.");
  const integrity = m.counter("quote_integrity_failures_total", "Quotes refused by the integrity checks (alert).", [
    "provider",
  ]);
  const explorerRows = m.counter("explorer_rows_total", "Explorer feed rows by outcome.", ["outcome"]);
  const archived = m.counter("observations_archived_total", "Observation payloads moved to the archive store.");
  const degraded = m.gauge("tier_a_degraded", "1 when a Tier-A chain's RPC pool is unset or unhealthy (§21.4).", [
    "chain",
  ]);
  const rpcCalls = m.counter("chain_rpc_calls_total", "Solana/Bitcoin pool endpoint calls by outcome.", [
    "chain",
    "outcome",
  ]);
  const vaultRejected = m.counter(
    "vault_event_rejected_total",
    "nearpay_vault logs dropped instead of forwarded (rails §8.6).",
    ["reason"],
  );
  const vaultForwarded = m.counter("vault_events_forwarded_total", "Vault events forwarded to evt.rails.vault.event.", [
    "outcome",
  ]);
  const recheck = m.counter(
    "finality_recheck_total",
    "Post-success re-checks of one-block evidence at finality (EVM finalized, Solana finalized, Bitcoin 6 conf; §8.12); failed/timeout alert.",
    ["chain", "outcome"],
  );
  const lag = m.gauge("tracker_lag_blocks", "Blocks between the chain's final head and a tracker cursor.", ["tracker"]);
  const routingAvailable = m.gauge(
    "routing_available",
    "1 when payments of the mode can be routed, 0 when every option is unavailable (see routing_blocked).",
    ["livemode"],
  );
  const routingBlocked = m.gauge(
    "routing_blocked",
    "1 for each reason that currently blocks routing in the mode (kill_switch_engaged, treasury_unset, …).",
    ["livemode", "reason"],
  );
  const registryAge = m.gauge(
    "token_registry_age_seconds",
    "Seconds since the mode's token registry last refreshed from its provider (+Inf = never).",
    ["livemode"],
  );
  const priceAge = m.gauge(
    "settlement_price_age_seconds",
    "Seconds since the primary price of a settlement asset in use applied (provider timestamp).",
    ["livemode", "asset"],
  );
  // registered on first use, so processes without a kill-switch copy (tracker) export no misleading zeros
  let ks: Record<
    "engaged" | "version" | "srcEngaged" | "srcVersion" | "diverged" | "readAt",
    ReturnType<typeof m.gauge>
  > | null = null;
  const ksGauges = () => {
    ks ??= {
      engaged: m.gauge(
        "kill_switch_engaged",
        "1 while rails' copy of sentinel's kill switch refuses live quoting (engaged, or state unknown).",
      ),
      version: m.gauge(
        "kill_switch_version",
        "Sentinel kill-switch version rails' copy came from (control_flags.source_version; -1 = unknown).",
      ),
      srcEngaged: m.gauge(
        "kill_switch_source_engaged",
        "Sentinel's kill switch at rails' last successful read (1 = engaged).",
      ),
      srcVersion: m.gauge(
        "kill_switch_source_version",
        "Sentinel's kill-switch version at rails' last successful read (-1 = sentinel sent none).",
      ),
      diverged: m.gauge(
        "kill_switch_diverged",
        "1 when rails' kill-switch copy still differs from sentinel after the last read was applied (alert).",
      ),
      readAt: m.gauge(
        "kill_switch_last_read_timestamp_seconds",
        "Unix time of rails' last successful read of sentinel's kill switch.",
      ),
    };
    return ks;
  };
  return {
    quote: (provider, outcome, s) => quote.observe({ provider, outcome }, s),
    statusCall: (source, outcome) => status.inc({ source, outcome }),
    transition: (to) => transitions.inc({ to }),
    verification: (tier, result) => verifications.inc({ tier, result }),
    timeToEvidence: (route_class, chain, s) => tte.observe({ route_class, chain }, s),
    unattributed: (chain) => unattributed.inc({ chain }),
    pricingUnavailable: (asset) => pricing.inc({ asset }),
    tagsExhausted: () => tags.inc(),
    integrityFailure: (provider) => integrity.inc({ provider }),
    lag: (name, blocks) => lag.set({ tracker: name }, blocks),
    explorer: (x) => {
      explorerRows.inc({ outcome: "recorded" }, x.recorded);
      explorerRows.inc({ outcome: "unmatched" }, x.unmatched);
      explorerRows.inc({ outcome: "unchanged" }, Math.max(0, x.rows - x.recorded - x.unmatched));
    },
    archived: (n) => archived.inc({}, n),
    tierDegraded: (chain, d) => degraded.set({ chain }, d ? 1 : 0),
    chainRpcCall: (chain, outcome) => rpcCalls.inc({ chain, outcome }),
    vaultEvent: (outcome) =>
      outcome === "forwarded" || outcome === "duplicate"
        ? vaultForwarded.inc({ outcome })
        : vaultRejected.inc({ reason: outcome }),
    finalityRecheck: (chain, outcome) => recheck.inc({ chain, outcome }),
    routingHealth: (h, ages) => {
      const livemode = String(h.livemode);
      routingAvailable.set({ livemode }, h.available ? 1 : 0);
      const blocking = new Set(h.reasons);
      for (const reason of ROUTING_REASONS)
        if (reason !== "token_registry_stale") routingBlocked.set({ livemode, reason }, blocking.has(reason) ? 1 : 0);
      if (h.registryAgeS !== null) registryAge.set({ livemode }, h.registryAgeS);
      for (const [asset, age] of ages) priceAge.set({ livemode, asset }, age);
    },
    killSwitchCopy: (c) => {
      const g = ksGauges();
      g.engaged.set(c.engaged ? 1 : 0);
      g.version.set(c.version ?? -1);
    },
    killSwitchSource: (x) => {
      const g = ksGauges();
      g.srcEngaged.set(x.engaged ? 1 : 0);
      g.srcVersion.set(x.version ?? -1);
      g.diverged.set(x.diverged ? 1 : 0);
      g.readAt.set(Math.floor(x.readAtMs / 1000));
    },
  };
}

export interface Providers {
  readonly live: RouteProvider | null;
  readonly test: (RouteProvider & { chains: SandboxChains }) | null;
}

export interface Rails {
  readonly env: string;
  readonly db: Kysely<DB>;
  log: Logger;
  metrics: RailsMetrics;
  readonly profiles: ChainProfiles;
  readonly providers: Providers;
  readonly screening: Screening;
  /** Sentinel `getKillSwitch` (spec 0.2.1); null when `NP_SENTINEL_URL` is unset (the state then waits for an event). */
  readonly sentinel: SentinelClient | null;
  /** Verifier nonces for Intents-source refund legs (spec 0.2.1 `RefundTransfer.nonce`). */
  readonly nonces: Nonces;
  /** Live appFees / Intents fee recipient (owner-provided); null = live quoting refused. */
  readonly treasury: string | null;
  /** Test-mode fee recipient (sandbox only). */
  readonly testTreasury: string;
  readonly intentsContract: string;
  readonly referral: string;
  readonly pricing: PolicyConfig;
  readonly slippageBps: Readonly<Record<Exclude<RouteClass, "intents_transfer">, number>>;
  /** Indicative fees for options (payments applies the merchant's schedule when it creates the attempt). */
  readonly indicativeFeeBps: Readonly<Record<RouteClass, number>>;
  readonly providerSplit: ProviderSplit;
  readonly tierB: TierBLimits;
  readonly explorerEnabled: boolean;
  readonly awaitingSweepS: number;
  /** USD micros at or above which an unreachable compliance blocks a quote (§8.1 step 3). */
  readonly screeningFailClosedUsdMicros: bigint;
  /** Above this many USD micros a watcher match needs a second RPC's agreement (§10). */
  readonly agreementUsdMicros: bigint;
  /** Non-USD stablecoins (`NP_STABLE_PEGS`): asset id → peg currency. */
  readonly stablePegs: Readonly<Record<string, string>>;
  /** `NP_PRICE_SECONDARY_IDS`: asset id → CoinGecko id overrides. */
  readonly coingeckoIds: Readonly<Record<string, string>>;
  /** ECB staleness bound and the test-mode table (§8.2). */
  readonly fx: {
    readonly graceS: number;
    readonly maxAgeS: number;
    /** currency → USD per unit (decimal string). */
    readonly testRates: Readonly<Record<string, string>>;
  };
  /** Observation archive (§8.11); `store` null → the job does nothing. */
  readonly archive: { readonly store: string | null; readonly afterDays: number };
  /** Stage 4 (§8.6): vault accounts whose `nearpay_vault` events are forwarded (live: null = not forwarded). */
  readonly vault: { readonly live: string | null; readonly test: string };
  /**
   * ADR-0022 (§8.12): post-success re-check of one-block evidence — EVM against `finalized` (top-level window and
   * cadence), Solana against `finalized` commitment, Bitcoin at `confirmations` in the same block.
   */
  readonly finalityRecheck: {
    readonly windowS: number;
    readonly intervalS: number;
    readonly solana: { readonly windowS: number; readonly intervalS: number };
    readonly bitcoin: { readonly windowS: number; readonly intervalS: number; readonly confirmations: number };
  };
  readonly random: () => number;
  readonly now: () => number;
}

export const mode = (livemode: boolean) => (livemode ? "live" : "test");
