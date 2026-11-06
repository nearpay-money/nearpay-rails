/** Dependencies shared by rails use cases, loops and consumers. */
import type { Kysely, Transaction } from "@nearpay-internal/db";
import type { Logger, ServiceMetrics } from "@nearpay-internal/service";
import type { ProviderSplit } from "../domain/execution/integrity.js";
import type { PricingPolicy } from "../domain/pricing/pricing.js";
import type { ChainProfiles } from "../domain/token-registry/chain-profiles.js";
import type { RouteClass } from "../domain/token-registry/registry.js";
import type { TierBLimits } from "../domain/verification/verification.js";
import type { Screening } from "../infra/clients/compliance.js";
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
  const lag = m.gauge("tracker_lag_blocks", "Blocks between the chain's final head and a tracker cursor.", ["tracker"]);
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
  /** Live appFees / Intents fee recipient (owner-provided); null = live quoting refused. */
  readonly treasury: string | null;
  /** Test-mode fee recipient (sandbox only). */
  readonly testTreasury: string;
  readonly intentsContract: string;
  readonly referral: string;
  readonly pricing: Omit<PricingPolicy, "nowMs">;
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
  readonly random: () => number;
  readonly now: () => number;
}

export const mode = (livemode: boolean) => (livemode ? "live" : "test");
