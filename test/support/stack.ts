/**
 * Integration harness: Postgres provisioned like nearpay-deploy's `postgres-init` (migrator owns the
 * database, the app role has DML only), the real `api`, `tracker` and `feeds` processes built from the
 * factories `main.ts` uses, the real **nearpay-sandbox image** for test mode (its own database on the
 * same Postgres, service tokens verified against this harness's JWKS), compliance mocked from the
 * spec, and NATS for events.
 */
import { generateKeyPairSync } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo, createServer } from "node:net";
import { publicJwk } from "@nearpay-internal/auth";
import { type Bus, connectBus, type Envelope, publish } from "@nearpay-internal/bus";
import { createDb, type Database, migrate } from "@nearpay-internal/db";
import { newId } from "@nearpay-internal/ids";
import type { Service } from "@nearpay-internal/service";
import { createScreening, getKillSwitch, INTERNAL_ROUTES } from "@nearpay-internal/spec";
import {
  type EventProbe,
  eventProbe,
  type MockPeer,
  mintServiceToken,
  mockError,
  mockPeer,
  provisionServiceDatabase,
  type Started,
  startNats,
  startPostgres,
  testKeySource,
  testServiceToken,
  testSigningKey,
} from "@nearpay-internal/testing";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import type { Rails } from "../../src/app/context.js";
import { readKillSwitch } from "../../src/app/kill-switch.js";
import {
  createApi,
  createFeeds,
  createTracker,
  type FeedsDeps,
  type ServiceDeps,
  type TrackerDeps,
} from "../../src/app/services.js";
import type { ApiConfig, FeedsConfig } from "../../src/config.js";
import type { Nonces } from "../../src/infra/clients/nonces.js";
import { MIGRATIONS_DIR } from "../../src/infra/db/migrations.js";
import type { DB } from "../../src/infra/db/schema.js";
import { oneClickProvider } from "../../src/providers/oneclick/client.js";
import { sandboxProvider } from "../../src/providers/sandbox/client.js";
import type { FakeOneClick } from "./fakes.js";

export const SANDBOX_IMAGE = process.env.NP_SANDBOX_IMAGE ?? "nearpay/sandbox:local";
export const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const USDC_BASE = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
export const USDC_ARB = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
export const USDT_NEAR = "nep141:usdt.tether-token.near";
export const ETH_BASE = "nep141:base.omft.near";
export const PAYER = "0x52908400098527886e0f7030069857d2e4169ee7";
export const MERCHANT_EVM = "0x1111111111111111111111111111111111111111";
export const TREASURY = "treasury.nearpay.near";

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function waitHttp(url: string, ms = 60_000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (r.ok) return;
    } catch {}
    if (Date.now() > until) throw new Error(`${url} did not become ready`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

export interface Sandbox {
  readonly url: string;
  readonly signingPubkey: string;
  readonly containers: StartedTestContainer[];
  call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
}

/** The real nearpay-sandbox image on the host network, its database on the harness Postgres. */
async function startSandbox(pgUrl: string, jwksUrl: string): Promise<Sandbox> {
  const { migratorUrl, appUrl } = await provisionServiceDatabase(pgUrl, "sandbox");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const port = await freePort();
  const metricsPort = await freePort();
  const base = (dbUrl: string) =>
    new GenericContainer(SANDBOX_IMAGE)
      .withNetworkMode("host")
      .withCopyContentToContainer([
        { content: dbUrl, target: "/run/secrets/db_url", mode: 0o444 },
        { content: pem, target: "/run/secrets/key", mode: 0o444 },
      ])
      .withEnvironment({
        NP_ENV: "local",
        NP_LOG_LEVEL: "warn",
        NP_PORT: String(port),
        NP_METRICS_PORT: String(metricsPort),
        NP_HOST: "127.0.0.1",
        NP_DB_URL_FILE: "/run/secrets/db_url",
        NP_SANDBOX_SIGNING_KEY_FILE: "/run/secrets/key",
        NP_JWKS_URL: jwksUrl,
        NP_SANDBOX_TIME_SCALE: "0.02",
        NP_SANDBOX_TICK_MS: "25",
      });
  // one-shot: resolves once the migrator exited 0
  const migrator = await base(migratorUrl)
    .withCommand(["dist/main.js", "migrate"])
    .withWaitStrategy(Wait.forOneShotStartup())
    .start();
  const api = await base(appUrl).withCommand(["dist/main.js", "api"]).start();
  const url = `http://127.0.0.1:${port}`;
  await waitHttp(`${url}/readyz`);
  return {
    url,
    signingPubkey: publicKey.export({ format: "jwk" }).x as string,
    containers: [migrator, api],
    async call(method, path, body) {
      const r = await fetch(`${url}${path}`, {
        method,
        headers: {
          "x-nearpay-token": await mintServiceToken("payments"),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await r.text();
      return { status: r.status, body: text ? JSON.parse(text) : undefined };
    },
  };
}

export interface Stack {
  readonly pg: Started;
  readonly admin: Database<DB>;
  readonly api: Service;
  readonly rails: Rails;
  readonly apiUrl: string;
  readonly compliance: MockPeer;
  /** Sentinel mock answering `getKillSwitch` (spec 0.2.1) with {@link Stack.killSwitch}. */
  readonly sentinel: MockPeer;
  readonly killSwitch: { engaged: boolean; version: number; fail: boolean };
  readonly sandbox: Sandbox | null;
  readonly nats: (Started & { monitorUrl: string }) | null;
  readonly bus: Bus | null;
  readonly tracker: { service: Service; rails: Rails } | null;
  readonly feeds: { service: Service; rails: Rails } | null;
  call(
    method: "GET" | "POST",
    path: string,
    o?: { body?: unknown; service?: "payments" | "sentinel" | "identity" | "agentpay"; token?: string | null },
  ): Promise<{ status: number; body: unknown }>;
  publishEvent(e: Envelope): Promise<void>;
  probe(filter?: string): Promise<EventProbe>;
  stop(): Promise<void>;
}

export interface StackOptions {
  sandbox?: boolean;
  tracker?: boolean | TrackerDeps;
  feeds?: boolean | FeedsDeps;
  oneclick?: FakeOneClick;
  config?: Partial<ApiConfig>;
  /** Verifier nonces (spec 0.2.1); default: the service's own (live salt over the unreachable test RPC). */
  nonces?: Nonces;
  /** Leave the kill-switch state unknown at start (tests of the boot read). */
  killSwitchUnknown?: boolean;
  /** api routing-health monitor cadence (default: the service's 15 s). */
  routingHealth?: ServiceDeps["routingHealth"];
}

export async function startStack(o: StackOptions = {}): Promise<Stack> {
  const [pg, nats] = await Promise.all([startPostgres({ database: "postgres" }), o.feeds ? startNats() : null]);
  const { migratorUrl, appUrl } = await provisionServiceDatabase(pg.url, "rails");
  const migrator = createDb<DB>({ url: migratorUrl });
  await migrate(migrator.db, MIGRATIONS_DIR);
  await migrator.close();
  const admin = createDb<DB>({ url: appUrl, applicationName: "rails-test" });

  // JWKS for the sandbox container (it verifies rails' service tokens like it would identity's)
  const jwk = await publicJwk(testSigningKey());
  const jwks = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [{ ...jwk, alg: "EdDSA", use: "sig" }] }));
  });
  await new Promise<void>((r) => jwks.listen(0, "127.0.0.1", r));
  const jwksUrl = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/internal/jwks`;
  const sandbox = o.sandbox ? await startSandbox(pg.url, jwksUrl) : null;

  const compliance = await mockPeer({ service: "compliance", routes: INTERNAL_ROUTES });
  compliance.on(createScreening, async (ctx) => ({
    screening_id: newId("scr"),
    decision: ctx.body.subject.includes("sanctioned") ? ("block" as const) : ("allow" as const),
    risk: null,
    reasons: [],
    cached: false,
    post_screen_required: false,
  }));

  const killSwitch = { engaged: false, version: 0, fail: false };
  const sentinel = await mockPeer({ service: "sentinel", routes: INTERNAL_ROUTES });
  sentinel.on(getKillSwitch, async () => {
    if (killSwitch.fail) throw mockError("rail_unavailable");
    return {
      engaged: killSwitch.engaged,
      reason: "test",
      actor: "sentinel",
      updated_at: new Date().toISOString(),
      version: killSwitch.version,
    };
  });

  const serviceToken = testServiceToken("rails");
  const providers = {
    live: o.oneclick
      ? oneClickProvider({ baseUrl: o.oneclick.url, managerPublicKey: o.oneclick.managerPublicKey })
      : oneClickProvider({ baseUrl: "http://127.0.0.1:9" }), // never the real 1Click from tests
    test: sandbox
      ? sandboxProvider({ baseUrl: sandbox.url, signingPubkey: sandbox.signingPubkey, serviceToken })
      : null,
  };
  const config: FeedsConfig = {
    env: "test",
    logLevel: "silent",
    host: "127.0.0.1",
    port: 0,
    metricsPort: 0,
    dbUrl: appUrl,
    identityUrl: "http://127.0.0.1:9",
    serviceClientSecret: "unused",
    complianceUrl: compliance.url,
    sentinelUrl: sentinel.url,
    oneclickBaseUrl: o.oneclick?.url ?? "http://127.0.0.1:9",
    testTreasuryAccount: TREASURY,
    intentsContract: "intents.near",
    referral: "nearpay",
    slippageBps: { same_asset: 30, stable_pair: 50, volatile: 100 },
    indicativeFeeBps: { same_asset: 20, stable_pair: 50, volatile: 100, intents_transfer: 30 },
    providerSplit: { share_bps: 5000, floor_bps: 20, stable_floor_bps: 1 },
    oneclickQuoteRps: 50,
    oneclickStatusRps: 100,
    pricingCurrencies: ["usd", "eur", "gbp", "chf", "jpy", "cad", "aud"],
    stablePegs: {},
    priceSecondaryUrl: "http://127.0.0.1:9",
    priceSecondaryIds: {},
    pricePrimaryMaxAgeS: 120,
    priceSecondaryMaxAgeS: 300,
    fxUrl: "http://127.0.0.1:9/ecb.xml",
    fxGraceS: 7200,
    fxMaxAgeS: 518_400,
    testFxRates: { eur: "1.08", gbp: "1.27", chf: "1.13", jpy: "0.0067", cad: "0.73", aud: "0.66" },
    obsArchiveAfterDays: 90,
    obsArchiveS3Region: "eu-central-1",
    tierBLimits: { per_payment_usd: 2000, per_day_usd: 20000 },
    screeningFailClosedUsd: 1000,
    agreementUsd: 10_000,
    explorerEnabled: false,
    explorerBaseUrl: "http://127.0.0.1:9",
    awaitingSweepS: 5,
    nearRpcUrls: ["http://127.0.0.1:9"],
    neardataUrl: "http://127.0.0.1:9",
    evmRpcUrls_1: [],
    evmRpcUrls_8453: [],
    evmRpcUrls_42161: [],
    evmConfirmations_1: undefined,
    evmConfirmations_8453: undefined,
    evmConfirmations_42161: undefined,
    finalityRecheckWindowS: 7200,
    finalityRecheckIntervalS: 5,
    finalityRecheckSolanaIntervalS: 5,
    finalityRecheckSolanaWindowS: 1800,
    finalityRecheckBitcoinConfirmations: 6,
    finalityRecheckBitcoinIntervalS: 10,
    finalityRecheckBitcoinWindowS: 21_600,
    solanaRpcUrls: [],
    solanaCommitment: "confirmed",
    bitcoinEsploraUrls: [],
    testVaultContract: "vault.sandbox.near",
    natsUrl: nats?.url ?? "nats://127.0.0.1:9",
    ...(sandbox ? { sandboxBaseUrl: sandbox.url, sandboxSigningPubkey: sandbox.signingPubkey } : {}),
    ...(o.config as object),
  } as FeedsConfig;
  const deps = { keys: testKeySource(), serviceToken, providers, ...(o.nonces ? { nonces: o.nonces } : {}) };

  const apiDb = createDb<DB>({ url: appUrl, applicationName: "rails-api-test" });
  const { service: api, rails } = createApi(config, {
    ...deps,
    database: apiDb,
    ...(o.routingHealth ? { routingHealth: o.routingHealth } : {}),
  });
  const { port } = await api.start();
  // the boot read runs in the background; make the state known before any test quotes live (spec 0.2.1)
  if (o.killSwitchUnknown !== true) await readKillSwitch(rails, { force: true });

  let tracker: Stack["tracker"] = null;
  if (o.tracker) {
    const t = createTracker(config, {
      ...deps,
      database: createDb<DB>({ url: appUrl, applicationName: "rails-tracker-test" }),
      tickMs: 50,
      near: null,
      evm: new Map(),
      ...(typeof o.tracker === "object" ? o.tracker : {}),
    });
    await t.service.start();
    tracker = t;
  }
  let feeds: Stack["feeds"] = null;
  let bus: Bus | null = null;
  if (o.feeds && nats) {
    bus = await connectBus({ url: nats.url, name: "rails-test-publisher" });
    const f = await createFeeds(config, {
      ...deps,
      database: createDb<DB>({ url: appUrl, applicationName: "rails-feeds-test" }),
      tickMs: 50,
      neardata: null,
      evm: new Map(),
      explorer: null,
      testExplorer: null,
      prices: null,
      fx: null,
      archive: null,
      intervals: { tokens: 60_000, sandbox: 100, indexer: 100, watcher: 100 },
      ...(typeof o.feeds === "object" ? o.feeds : {}),
    });
    await f.service.start();
    feeds = f;
  }
  const apiUrl = `http://127.0.0.1:${port}`;
  return {
    pg,
    admin,
    api,
    rails,
    apiUrl,
    compliance,
    sentinel,
    killSwitch,
    sandbox,
    nats,
    bus,
    tracker,
    feeds,
    async call(method, path, c = {}) {
      const token = c.token === undefined ? await mintServiceToken(c.service ?? "payments") : c.token;
      const res = await fetch(`${apiUrl}${path}`, {
        method,
        headers: {
          ...(token ? { "x-nearpay-token": token } : {}),
          ...(c.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: c.body === undefined ? undefined : JSON.stringify(c.body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    },
    async publishEvent(e) {
      if (!bus) throw new Error("no bus (start the stack with feeds)");
      await publish(bus, e.subject, e, e.id);
    },
    async probe(filter = "evt.rails.>") {
      if (!nats) throw new Error("no NATS");
      return eventProbe(nats.url, filter);
    },
    async stop() {
      await feeds?.service.stop().catch(() => {});
      await tracker?.service.stop().catch(() => {});
      await api.stop().catch(() => {});
      await bus?.close().catch(() => {});
      await compliance.stop().catch(() => {});
      await sentinel.stop().catch(() => {});
      for (const c of sandbox?.containers ?? []) await c.stop().catch(() => {});
      await new Promise<void>((r) => jwks.close(() => r()));
      await admin.close();
      await nats?.stop().catch(() => {});
      await pg.stop().catch(() => {});
    },
  };
}
