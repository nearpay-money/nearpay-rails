/**
 * Process wiring (lld/rails.md §2):
 * - `api`      internal executions/options/minimums/evidence/assets routes; public `GET /v1/assets`
 * - `tracker`  hot poller (N replicas, SKIP LOCKED) and verifier
 * - `feeds`    leader-elected loops (token refresh, sandbox feed, NEAR indexer, EVM watchers,
 *              Explorer feed), consumers, jobs, outbox relay
 */
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import type { KeySource } from "@nearpay-internal/auth";
import { serviceTokenClient } from "@nearpay-internal/auth";
import {
  type Bus,
  busReady,
  connectBus,
  consumerLag,
  domainConsumersTask,
  durablesOf,
  ensureStreams,
  publish,
} from "@nearpay-internal/bus";
import {
  createDb,
  type Database,
  deadLettersOpen,
  jobsDue,
  jobWorkerTask,
  leaderTask,
  migrationStatus,
  outboxLagSeconds,
  outboxRelayTask,
  recurringJobsTask,
  sql,
} from "@nearpay-internal/db";
import { type BackgroundTask, createService, type Service } from "@nearpay-internal/service";
import { STREAMS, type Subject } from "@nearpay-internal/spec";
import { parse as parseYaml } from "yaml";
import { railsRoutes } from "../api/routes.js";
import { type ArchiveStore, archiveStore } from "../archive/store.js";
import { type ApiConfig, evmRpcUrls, type FeedsConfig, type SharedConfig, type TrackerConfig } from "../config.js";
import { deadLetters, railsHandlers } from "../consumers/handlers.js";
import { DEFAULT_POLICY } from "../domain/pricing/pricing.js";
import { type ChainProfiles, chainProfiles } from "../domain/token-registry/chain-profiles.js";
import { type Budgets, budgets as createBudgets } from "../infra/budget.js";
import { complianceScreening, type Screening } from "../infra/clients/compliance.js";
import { type EvmRpc, evmRpc } from "../infra/clients/evm.js";
import { type Explorer, explorer as explorerClient, sandboxExplorer } from "../infra/clients/explorer.js";
import { type Neardata, type NearRpc, neardata as neardataClient, nearRpc } from "../infra/clients/near.js";
import { type Nonces, verifierNonces } from "../infra/clients/nonces.js";
import { type SentinelClient, sentinelClient } from "../infra/clients/sentinel.js";
import { MIGRATIONS_DIR } from "../infra/db/migrations.js";
import type { DB } from "../infra/db/schema.js";
import { ecbProvider, type FxFetch } from "../providers/fx/ecb.js";
import { oneClickProvider } from "../providers/oneclick/client.js";
import { coingeckoProvider } from "../providers/prices/coingecko.js";
import { type PriceProvider, PriceRateLimited } from "../providers/prices/port.js";
import { sandboxProvider } from "../providers/sandbox/client.js";
import { loop } from "../trackers/cursors.js";
import { watchOnce } from "../trackers/destination-watchers/evm-watcher.js";
import { explorerOnce } from "../trackers/explorer-feed/feed.js";
import { pollerTask } from "../trackers/hot-poller/poller.js";
import { indexOnce, sandboxFeedOnce } from "../trackers/near-indexer/indexer.js";
import { verifierTask } from "../verifiers/verifier.js";
import { jobHandlers, RECURRING } from "../workers/jobs.js";
import { noMetrics, type Providers, type Rails, railsMetrics } from "./context.js";
import { alertStale, refreshEcb, refreshSecondary } from "./fx.js";
import { killSwitchBootTask } from "./kill-switch.js";
import { refreshTokens } from "./tokens.js";

export const DEFAULT_CHAINS_FILE = fileURLToPath(new URL("../../config/chains.yaml", import.meta.url));

export function loadProfiles(file = DEFAULT_CHAINS_FILE): ChainProfiles {
  return chainProfiles(parseYaml(readFileSync(file, "utf8")));
}

export interface ServiceDeps {
  database?: Database<DB>;
  keys?: KeySource;
  serviceToken?: () => Promise<string>;
  providers?: Providers;
  screening?: Screening;
  sentinel?: SentinelClient | null;
  nonces?: Nonces;
  budgets?: Budgets;
  fetch?: typeof fetch;
  random?: () => number;
  now?: () => number;
}

const usdMicros = (usd: number) => BigInt(Math.round(usd * 1_000_000));

function readiness(database: Database<DB>) {
  return {
    db: () => sql`select 1`.execute(database.db),
    migrations: async () => {
      const s = await migrationStatus(database.db, MIGRATIONS_DIR);
      if (s.pending.length || s.drift.length)
        throw new Error(`pending ${s.pending.join(",") || "-"} drift ${s.drift.join(",") || "-"}`);
    },
  };
}

interface Built {
  rails: Rails;
  database: Database<DB>;
  budgets: Budgets;
  serviceToken: () => Promise<string>;
}

/**
 * Pool size of the feeds process. Every leader-elected loop (kit `advisoryLeader`) holds one pooled connection
 * for as long as it leads, and the single feeds replica leads them all: with kit's default of 10, ten leaders
 * (Stage 2: token/price/FX refresh, sandbox, NEAR indexer, three EVM watchers, Explorer, recurring jobs) took the
 * whole pool and every query of the loops waited forever for a connection — the token registry was never
 * refreshed, test-mode prices went stale (`pricing_unavailable`) and no feed advanced (step 2.4 integration).
 */
export const FEEDS_POOL_MAX = 32;
/** Connections kept free for the loops' own queries, the job worker, the outbox relay and consumers. */
export const FEEDS_QUERY_HEADROOM = 8;

function build(config: SharedConfig, deps: ServiceDeps, app: string, poolMax?: number): Built {
  const database =
    deps.database ??
    createDb<DB>({ url: config.dbUrl, applicationName: `rails-${app}`, ...(poolMax ? { max: poolMax } : {}) });
  const serviceToken =
    deps.serviceToken ??
    (() => {
      const c = serviceTokenClient({
        identityUrl: config.identityUrl,
        clientId: "rails",
        secret: config.serviceClientSecret,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
      return () => c.getToken();
    })();
  const budgets = deps.budgets ?? createBudgets({ valkeyUrl: config.valkeyUrl });
  const providers: Providers = deps.providers ?? {
    live: oneClickProvider({
      baseUrl: config.oneclickBaseUrl,
      apiKey: config.oneclickApiKey,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      takeQuote: () => budgets.take("oneclick:quote", config.oneclickQuoteRps, 1_000),
      takeStatus: () => budgets.take("oneclick:status", config.oneclickStatusRps, 0),
    }),
    test:
      config.sandboxBaseUrl && config.sandboxSigningPubkey
        ? sandboxProvider({
            baseUrl: config.sandboxBaseUrl,
            signingPubkey: config.sandboxSigningPubkey,
            serviceToken,
            ...(deps.fetch ? { fetch: deps.fetch } : {}),
          })
        : null,
  };
  const rails: Rails = {
    env: config.env,
    db: database.db,
    log: undefined as unknown as Rails["log"],
    metrics: noMetrics,
    profiles: loadProfiles(config.chainsFile),
    providers,
    screening:
      deps.screening ??
      complianceScreening({
        baseUrl: config.complianceUrl,
        serviceToken,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      }),
    sentinel:
      deps.sentinel !== undefined
        ? deps.sentinel
        : config.sentinelUrl
          ? sentinelClient({ baseUrl: config.sentinelUrl, serviceToken, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
          : null,
    nonces:
      deps.nonces ??
      verifierNonces({
        rpcUrls: config.nearRpcUrls,
        contract: config.intentsContract,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      }),
    treasury: config.treasuryAccount ?? null,
    testTreasury: config.testTreasuryAccount,
    intentsContract: config.intentsContract,
    referral: config.referral,
    pricing: {
      ...DEFAULT_POLICY,
      currencies: new Set(config.pricingCurrencies),
      primaryMaxAgeMs: config.pricePrimaryMaxAgeS * 1000,
      secondaryMaxAgeMs: config.priceSecondaryMaxAgeS * 1000,
    },
    stablePegs: config.stablePegs,
    coingeckoIds: config.priceSecondaryIds,
    fx: { graceS: config.fxGraceS, maxAgeS: config.fxMaxAgeS, testRates: config.testFxRates },
    archive: { store: config.obsArchiveStore ?? null, afterDays: config.obsArchiveAfterDays },
    slippageBps: config.slippageBps,
    indicativeFeeBps: config.indicativeFeeBps,
    providerSplit: {
      shareBps: config.providerSplit.share_bps,
      floorBps: config.providerSplit.floor_bps,
      stableFloorBps: config.providerSplit.stable_floor_bps,
    },
    tierB: {
      perPaymentUsdMicros: usdMicros(config.tierBLimits.per_payment_usd),
      perDayUsdMicros: usdMicros(config.tierBLimits.per_day_usd),
    },
    explorerEnabled: (config.explorerEnabled ?? Boolean(config.explorerToken)) && Boolean(config.explorerToken),
    awaitingSweepS: config.awaitingSweepS,
    screeningFailClosedUsdMicros: usdMicros(config.screeningFailClosedUsd),
    agreementUsdMicros: usdMicros(config.agreementUsd),
    random: deps.random ?? Math.random,
    now: deps.now ?? Date.now,
  };
  return { rails, database, budgets, serviceToken };
}

function attach(b: Built, service: Service, deps: ServiceDeps) {
  b.rails.log = service.log;
  b.rails.metrics = railsMetrics(service.metrics);
  service.onShutdown(async () => {
    await b.budgets.close();
    if (!deps.database) await b.database.close();
  });
}

/** The rails context for the ops CLI (no listener, no background tasks). */
export function createOpsContext(
  config: SharedConfig,
  log: Rails["log"],
  deps: ServiceDeps = {},
): { rails: Rails; close(): Promise<void> } {
  const b = build(config, deps, "ops");
  b.rails.log = log;
  return {
    rails: b.rails,
    async close() {
      await b.budgets.close();
      if (!deps.database) await b.database.close();
    },
  };
}

export function createApi(config: ApiConfig, deps: ServiceDeps = {}): { service: Service; rails: Rails } {
  const b = build(config, deps, "api");
  const service = createService({
    name: "rails",
    config,
    ...(deps.keys ? { keys: deps.keys } : {}),
    routes: railsRoutes(b.rails),
    readiness: readiness(b.database),
  });
  attach(b, service, deps);
  // spec 0.2.1: learn sentinel's kill-switch state at boot (live quoting is refused while it is unknown)
  service.addBackground(killSwitchBootTask(b.rails));
  return { service, rails: b.rails };
}

export interface TrackerDeps extends ServiceDeps {
  near?: NearRpc | null;
  evm?: ReadonlyMap<string, EvmRpc>;
  tickMs?: number;
}

export function evmPools(config: SharedConfig, profiles: ChainProfiles, f?: typeof fetch): Map<string, EvmRpc> {
  const urls = evmRpcUrls(config);
  const out = new Map<string, EvmRpc>();
  for (const p of profiles.all()) {
    if (p.family !== "evm" || p.tier !== "A") continue;
    const list = urls[p.chain];
    if (list?.length) out.set(p.chain, evmRpc({ urls: list, ...(f ? { fetch: f } : {}) }));
  }
  return out;
}

export function createTracker(config: TrackerConfig, deps: TrackerDeps = {}): { service: Service; rails: Rails } {
  const b = build(config, deps, "tracker");
  const service = createService({ name: "rails", config, readiness: readiness(b.database) });
  attach(b, service, deps);
  const verifierDeps = {
    near:
      deps.near === undefined
        ? nearRpc({ urls: config.nearRpcUrls, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
        : deps.near,
    evm: deps.evm ?? evmPools(config, b.rails.profiles, deps.fetch),
  };
  service.addBackground(pollerTask(b.rails, deps.tickMs ? { tickMs: deps.tickMs } : {}));
  service.addBackground(verifierTask(b.rails, verifierDeps, deps.tickMs ? { tickMs: deps.tickMs } : {}));
  service.metrics.gauge("executions_inflight", "Executions not yet terminal, by state.", ["state"], async (g) => {
    const rows = await sql<{ state: string; n: string }>`
      select state, count(*)::text as n from executions where terminal_at is null group by state`.execute(
      b.database.db,
    );
    g.reset();
    for (const x of rows.rows) g.set({ state: x.state }, Number(x.n));
  });
  return { service, rails: b.rails };
}

export interface FeedsDeps extends ServiceDeps {
  bus?: Bus;
  neardata?: Neardata | null;
  evm?: ReadonlyMap<string, EvmRpc>;
  explorer?: Explorer | null;
  /** Test-mode Explorer (sandbox mirror); default: the mirror when the sandbox is configured. */
  testExplorer?: Explorer | null;
  /** Secondary price provider (live); default CoinGecko keyless. */
  prices?: PriceProvider | null;
  /** FX provider (live); default the ECB daily XML. */
  fx?: FxFetch | null;
  /** Observation archive store; default from `NP_OBS_ARCHIVE_STORE`. */
  archive?: ArchiveStore | null;
  tickMs?: number;
  /** Loop cadences (tests shorten them). */
  intervals?: Partial<Record<"tokens" | "sandbox" | "indexer" | "watcher" | "prices" | "fx", number>>;
}

export async function createFeeds(
  config: FeedsConfig,
  deps: FeedsDeps = {},
): Promise<{ service: Service; rails: Rails }> {
  const b = build(config, deps, "feeds", FEEDS_POOL_MAX);
  const r = b.rails;
  const service = createService({ name: "rails", config, readiness: readiness(b.database) });
  attach(b, service, deps);
  const db = b.database;

  const bus = deps.bus ?? (await connectBus({ url: config.natsUrl, name: `rails-feeds@${hostname()}` }));
  await ensureStreams(bus, [STREAMS.rails]);
  service.addReadiness("bus", () => {
    if (!busReady(bus)) throw new Error("NATS connection is closed");
  });
  const handlers = railsHandlers(db.db);
  const durables = durablesOf("rails", Object.keys(handlers) as Subject[]);
  service.metrics.collectConsumerLag(async () =>
    Object.fromEntries(
      await Promise.all(durables.map(async (d) => [d.durable, await consumerLag(bus, d.stream, d.durable)])),
    ),
  );
  service.metrics.collectOutboxLag(() => outboxLagSeconds(db.db));
  service.metrics.collectJobsDue(() => jobsDue(db.db));
  service.metrics.collectDeadLettersOpen(() => deadLettersOpen(db.db));

  const onError = (e: unknown) => service.log.error({ err: e }, "background error");
  service.addBackground(
    outboxRelayTask({
      db: db.db,
      pool: db.pool,
      publish: (s, e, mid) => publish(bus, s, e, mid).then(() => {}),
      onError,
    }),
  );
  service.addBackground(
    domainConsumersTask({ bus, consumer: "rails", handlers, onDeadLetter: deadLetters(db.db), onError }),
  );
  service.addBackground(killSwitchBootTask(r));
  const archive =
    deps.archive !== undefined
      ? deps.archive
      : archiveStore(config.obsArchiveStore ?? null, {
          ...(config.obsArchiveS3Endpoint ? { endpoint: config.obsArchiveS3Endpoint } : {}),
          region: config.obsArchiveS3Region,
          ...(config.obsArchiveS3AccessKeyId ? { accessKeyId: config.obsArchiveS3AccessKeyId } : {}),
          ...(config.obsArchiveS3SecretAccessKey ? { secretAccessKey: config.obsArchiveS3SecretAccessKey } : {}),
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        });
  service.addBackground(
    jobWorkerTask({
      db: db.db,
      workerId: `rails-feeds@${hostname()}:${process.pid}`,
      handlers: jobHandlers(r, { archive }),
      onError: (e, job) => service.log.warn({ err: e, job }, "job failed"),
      onDeadLetter: (j) => service.log.error({ job: j }, "job dead-lettered"),
      ...(deps.tickMs ? { pollMs: deps.tickMs } : {}),
    }),
  );
  let leaders = 1; // recurring jobs (below); each `leader(…)` adds one
  service.addBackground(
    recurringJobsTask({
      db: db.db,
      pool: db.pool,
      name: "rails:recurring-jobs",
      jobs: RECURRING,
      onError,
      ...(deps.tickMs ? { tickMs: deps.tickMs } : {}),
    }),
  );

  const iv = {
    tokens: 30_000,
    sandbox: 1_000,
    indexer: 1_000,
    watcher: 0,
    prices: 60_000,
    fx: 30 * 60_000,
    ...deps.intervals,
  };
  const leader = (name: string, run: (signal: AbortSignal) => Promise<void>): BackgroundTask => {
    leaders++;
    return leaderTask({
      pool: db.pool,
      name: `rails:${name}`,
      run,
      onError,
      ...(deps.tickMs ? { retryMs: deps.tickMs } : {}),
    });
  };

  service.addBackground(
    leader("token-refresh", (signal) =>
      loop(r, "token-refresh", signal, async () => {
        for (const lm of [false, true]) {
          if (!(lm ? r.providers.live : r.providers.test)) continue;
          await refreshTokens(r, lm).catch((e) => r.log.warn({ err: e, livemode: lm }, "token refresh failed"));
        }
        return iv.tokens;
      }),
    ),
  );
  // secondary prices (live, CoinGecko keyless): 60 s; 429 → back off ×2 up to 10 min (§9)
  const prices =
    deps.prices !== undefined
      ? deps.prices
      : r.providers.live
        ? coingeckoProvider({ baseUrl: config.priceSecondaryUrl, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
        : null;
  if (prices) {
    let backoff = iv.prices;
    service.addBackground(
      leader("secondary-prices", (signal) =>
        loop(r, "secondary-prices", signal, async () => {
          try {
            await refreshSecondary(r, prices);
            backoff = iv.prices;
          } catch (e) {
            if (!(e instanceof PriceRateLimited)) throw e;
            backoff = Math.min(backoff * 2, 600_000);
            r.log.warn({ delay_ms: backoff }, "secondary price feed rate-limited; backing off");
          }
          return backoff;
        }),
      ),
    );
  }
  // FX (live, ECB daily XML, conditional GET every 30 min); test mode: the fixed table, once at boot
  const fx =
    deps.fx !== undefined ? deps.fx : ecbProvider({ url: config.fxUrl, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  if (fx) {
    service.addBackground(
      leader("fx-refresh", (signal) =>
        loop(
          r,
          "fx-refresh",
          signal,
          async () => {
            await refreshEcb(r, fx).catch(async (e) => {
              await alertStale(r);
              throw e;
            });
            return iv.fx;
          },
          60_000,
        ),
      ),
    );
  }
  if (r.providers.test) {
    service.addBackground(
      leader("sandbox-feed", (signal) =>
        loop(r, "sandbox-feed", signal, async () => ((await sandboxFeedOnce(r)) >= 500 ? 0 : iv.sandbox)),
      ),
    );
  }
  const nd =
    deps.neardata === undefined
      ? neardataClient({ baseUrl: config.neardataUrl, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
      : deps.neardata;
  if (nd) {
    service.addBackground(
      leader("near-indexer", (signal) =>
        loop(r, "near-indexer", signal, async () => ((await indexOnce(r, nd, signal)) > 0 ? 0 : iv.indexer)),
      ),
    );
  }
  const evm = deps.evm ?? evmPools(config, r.profiles, deps.fetch);
  for (const [chain, rpc] of evm) {
    const profile = r.profiles.get(chain);
    if (!profile?.watcher) continue;
    const every = iv.watcher || profile.watchIntervalS * 1000;
    service.addBackground(
      leader(`evm:${chain}`, (signal) =>
        loop(r, `evm:${chain}`, signal, async () => ((await watchOnce(r, chain, rpc)) >= 500 ? 0 : every)),
      ),
    );
  }
  const ex =
    deps.explorer !== undefined
      ? deps.explorer
      : r.explorerEnabled && config.explorerToken
        ? explorerClient({
            baseUrl: config.explorerBaseUrl,
            token: config.explorerToken,
            referral: r.referral,
            ...(deps.fetch ? { fetch: deps.fetch } : {}),
          })
        : null;
  if (ex) {
    let turn = 0;
    service.addBackground(
      leader("explorer-feed", (signal) => loop(r, "explorer-feed", signal, () => explorerOnce(r, ex, turn++), 10_000)),
    );
  }
  // test mode: the sandbox's Explorer mirror, same client code and schemas (§8.5)
  const tex =
    deps.testExplorer !== undefined
      ? deps.testExplorer
      : config.sandboxBaseUrl
        ? sandboxExplorer({
            baseUrl: config.sandboxBaseUrl,
            serviceToken: b.serviceToken,
            referral: r.referral,
            ...(deps.fetch ? { fetch: deps.fetch } : {}),
          })
        : null;
  if (tex) {
    let turn = 0;
    service.addBackground(
      leader("explorer-feed-test", (signal) =>
        loop(r, "explorer-feed-test", signal, () => explorerOnce(r, tex, turn++), 5_000),
      ),
    );
  }
  // fail at boot rather than hang: leaders that hold the whole pool starve every query (see FEEDS_POOL_MAX)
  assertFeedsPool(leaders, deps.database ? null : FEEDS_POOL_MAX);
  service.onShutdown(async () => {
    if (!deps.bus) await bus.close();
  });
  return { service, rails: r };
}

/** Throws when `leaders` held connections would leave fewer than FEEDS_QUERY_HEADROOM in a pool of `max`. */
export function assertFeedsPool(leaders: number, max: number | null): void {
  if (max !== null && leaders + FEEDS_QUERY_HEADROOM > max)
    throw new Error(
      `rails feeds: ${leaders} leader-elected loops need at least ${leaders + FEEDS_QUERY_HEADROOM} pooled connections (pool max ${max})`,
    );
}
