/** Configuration (lld/rails.md §11, foundations §13). */
import { NearAccountId } from "@nearpay/spec";
import { baseConfigShape, list, loadConfig, secret, url } from "@nearpay-internal/service";
import { z } from "zod";
import { type EvmConfirmation, parseEvmConfirmation } from "./domain/chains/evm.js";

const json = <T extends z.ZodType>(schema: T, fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((s, ctx) => {
      try {
        const r = schema.safeParse(JSON.parse(s));
        if (r.success) return r.data as z.output<T>;
        ctx.addIssue({ code: "custom", message: r.error.message });
      } catch {
        ctx.addIssue({ code: "custom", message: "expected JSON" });
      }
      return z.NEVER;
    });

const bps = z.int().min(0).max(10_000);
const nearAccount = z.string().refine((s) => NearAccountId.safeParse(s).success, "must be a NEAR account id");
const rpcList = list(url(["https:", "http:"]));
/** `finalized` or a block count (ADR-0022); unset → the chain profile's rule. Invalid values fail the boot. */
const evmConfirmation = z
  .string()
  .optional()
  .transform((s, ctx): EvmConfirmation | undefined => {
    if (s === undefined || s.trim() === "") return undefined;
    try {
      return parseEvmConfirmation(s);
    } catch (e) {
      ctx.addIssue({ code: "custom", message: e instanceof Error ? e.message : String(e) });
      return z.NEVER;
    }
  });

const shared = {
  ...baseConfigShape,
  dbUrl: secret(url(["postgres:", "postgresql:"])),
  /** Shared provider budgets across replicas (optional: per-replica half budgets without it). */
  valkeyUrl: url(["redis:", "rediss:"]).optional(),
  identityUrl: url(["http:", "https:"]),
  serviceClientSecret: secret(),
  complianceUrl: url(["http:", "https:"]),
  /** Sentinel (`getKillSwitch` at boot, spec 0.2.1). Unset: the kill-switch state waits for an event (live quoting refused until then). */
  sentinelUrl: url(["http:", "https:"]).optional(),
  /** Test mode (nearpay-sandbox); without it test-mode executions are refused. */
  sandboxBaseUrl: url(["http:", "https:"]).optional(),
  sandboxSigningPubkey: z.string().min(32).optional(),
  oneclickBaseUrl: url(["https:", "http:"]).default("https://1click.chaindefuser.com"),
  /** Partner API key (`X-API-Key`); absent in Stage 1 local: unauthenticated quotes (+25 bps). */
  oneclickApiKey: secret().optional(),
  /** Live appFees / Intents fee recipient (owner-provided). Unset: live quoting is refused. */
  treasuryAccount: nearAccount.optional(),
  /** Fee recipient in test mode (sandbox only). */
  testTreasuryAccount: nearAccount.default("treasury.nearpay.near"),
  intentsContract: nearAccount.default("intents.near"),
  referral: z.string().min(1).max(64).default("nearpay"),
  /** Chain profiles YAML (default: config/chains.yaml in the image). */
  chainsFile: z.string().min(1).optional(),
  slippageBps: json(
    z.object({ same_asset: bps, stable_pair: bps, volatile: bps }),
    '{"same_asset":30,"stable_pair":50,"volatile":100}',
  ),
  /** Indicative fees for `GET /internal/options` (the merchant's schedule applies at create). */
  indicativeFeeBps: json(
    z.object({ same_asset: bps, stable_pair: bps, volatile: bps, intents_transfer: bps }),
    '{"same_asset":20,"stable_pair":50,"volatile":100,"intents_transfer":30}',
  ),
  /** 1Click appFees split (landscape §2): provider share and floors, bps. */
  providerSplit: json(
    z.object({ share_bps: bps, floor_bps: bps, stable_floor_bps: bps }),
    '{"share_bps":5000,"floor_bps":20,"stable_floor_bps":1}',
  ),
  oneclickQuoteRps: z.coerce.number().min(0.1).max(1000).default(5),
  oneclickStatusRps: z.coerce.number().min(0.1).max(1000).default(10),
  /** Accepted fiat pricing currencies (Stage 2 default; each must be `usd` or an ECB currency). */
  pricingCurrencies: list(z.string().regex(/^[a-z]{3}$/)).default(["usd", "eur", "gbp", "chf", "jpy", "cad", "aud"]),
  /** Non-USD stablecoins settled at par with their currency (`{asset_id: currency}`, e.g. EURC → eur). */
  stablePegs: json(z.record(z.string(), z.string().regex(/^[a-z]{3}$/)), "{}"),
  /** Secondary price feed (CoinGecko keyless; `NP_PRICE_SECONDARY_KEY_FILE` is not used in v1). */
  priceSecondaryUrl: url(["https:", "http:"]).default("https://api.coingecko.com/api/v3"),
  /** `{asset_id: coingecko id}` overrides of the 1Click `coingeckoId`. */
  priceSecondaryIds: json(z.record(z.string(), z.string().min(1).max(128)), "{}"),
  pricePrimaryMaxAgeS: z.coerce.number().int().min(10).max(3600).default(120),
  priceSecondaryMaxAgeS: z.coerce.number().int().min(10).max(3600).default(300),
  /** ECB daily reference rates (FX). */
  fxUrl: url(["https:", "http:"]).default("https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"),
  fxGraceS: z.coerce.number().int().min(0).max(86_400).default(7200),
  fxMaxAgeS: z.coerce
    .number()
    .int()
    .min(3600)
    .max(30 * 86_400)
    .default(518_400),
  /** Test-mode FX table `{currency: "<USD per unit, decimal string>"}` (source `fixed`, no staleness bound). */
  testFxRates: json(
    z.record(z.string().regex(/^[a-z]{3}$/), z.string().regex(/^\d+(\.\d+)?$/)),
    '{"eur":"1.08","gbp":"1.27","chf":"1.13","jpy":"0.0067","cad":"0.73","aud":"0.66"}',
  ),
  /** Observation archive store (`file:<dir>` or `s3://<bucket>/<prefix>`); unset → the archive job does nothing. */
  obsArchiveStore: z
    .string()
    .regex(/^(file:.+|s3:\/\/[a-z0-9.-]+(\/.*)?)$/)
    .optional(),
  obsArchiveAfterDays: z.coerce.number().int().min(1).max(3650).default(90),
  /** S3 credentials/endpoint for an `s3://` archive store (EU object storage). */
  obsArchiveS3Endpoint: url(["https:", "http:"]).optional(),
  obsArchiveS3Region: z.string().min(1).default("eu-central-1"),
  obsArchiveS3AccessKeyId: secret().optional(),
  obsArchiveS3SecretAccessKey: secret().optional(),
  tierBLimits: json(
    z.object({ per_payment_usd: z.number().min(0), per_day_usd: z.number().min(0) }),
    '{"per_payment_usd":2000,"per_day_usd":20000}',
  ),
  /** Compliance unreachable: refuse quotes at or above this many USD (§8.1 step 3). */
  screeningFailClosedUsd: z.coerce.number().min(0).default(1000),
  /** Watcher/verifier matches above this many USD need a second RPC's agreement (§10). */
  agreementUsd: z.coerce.number().min(0).default(10_000),
  /** Default: on when the owner's Explorer token is present (§8.5). */
  explorerEnabled: z
    .enum(["true", "false", "1", "0"])
    .transform((v) => v === "true" || v === "1")
    .optional(),
  explorerBaseUrl: url(["https:", "http:"]).default("https://explorer.near-intents.org"),
  explorerToken: secret().optional(),
  /** Without the Explorer feed the poller sweeps unsignalled deposits this often (L-RL-03). */
  awaitingSweepS: z.coerce.number().int().min(5).max(3600).default(30),
  nearRpcUrls: rpcList.default(["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"]),
  neardataUrl: url(["https:", "http:"]).default("https://mainnet.neardata.xyz"),
  evmRpcUrls_1: rpcList.default(["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"]),
  evmRpcUrls_8453: rpcList.default(["https://mainnet.base.org", "https://base-rpc.publicnode.com"]),
  evmRpcUrls_42161: rpcList.default(["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"]),
  /**
   * EVM evidence rule overrides (`NP_EVM_CONFIRMATIONS_<CHAINID>` = `finalized` | N blocks, ADR-0022). Defaults come
   * from config/chains.yaml: Base 10 and Arbitrum 40 L2 block confirmations, Ethereum `finalized`.
   */
  evmConfirmations_1: evmConfirmation,
  evmConfirmations_8453: evmConfirmation,
  evmConfirmations_42161: evmConfirmation,
  /** Post-success `finalized` re-check of confirmation-based EVM evidence (§8.12): window and cadence. */
  finalityRecheckWindowS: z.coerce.number().int().min(600).max(86_400).default(7200),
  finalityRecheckIntervalS: z.coerce.number().int().min(5).max(3600).default(60),
  /**
   * Stage 4 (§21.4): Solana RPC pool (≥ 2 recommended: the public endpoint + an owner-provided provider). Empty →
   * Solana is Tier B (provider-attested within `NP_TIER_B_LIMITS`) and its watcher is off.
   */
  solanaRpcUrls: rpcList.default(["https://api.mainnet-beta.solana.com"]),
  /** Stage 4 (§21.4): Bitcoin Esplora pool (keyless). Empty → Bitcoin is Tier B. */
  bitcoinEsploraUrls: rpcList.default(["https://mempool.space/api", "https://blockstream.info/api"]),
  /**
   * Stage 4 (§8.6): the subscription vault account whose `nearpay_vault` events are forwarded to
   * `evt.rails.vault.event` (e.g. `v1.vault.nearpay.near`). Unset → live vault events are not forwarded.
   */
  vaultContract: nearAccount.optional(),
  /** Stage 4 (§8.6, OQ-T-03): the sandbox vault stand-in account (test-mode vault events). */
  testVaultContract: nearAccount.default("vault.sandbox.near"),
};

export const apiShape = { ...shared };
export const trackerShape = { ...shared };
export const feedsShape = { ...shared, natsUrl: url(["nats:", "tls:"]) };
export const opsShape = { ...shared };
export const migrateShape = { ...baseConfigShape, dbUrl: secret(url(["postgres:", "postgresql:"])) };

export type SharedConfig = z.output<z.ZodObject<typeof shared>>;
export type ApiConfig = z.output<z.ZodObject<typeof apiShape>>;
export type TrackerConfig = z.output<z.ZodObject<typeof trackerShape>>;
export type FeedsConfig = z.output<z.ZodObject<typeof feedsShape>>;

export const readApiConfig = () => loadConfig(apiShape);
export const readTrackerConfig = () => loadConfig(trackerShape);
export const readFeedsConfig = () => loadConfig(feedsShape);
export const readOpsConfig = () => loadConfig(opsShape);

/** EVM evidence rule overrides by chain (`NP_EVM_CONFIRMATIONS_<CHAINID>`, ADR-0022). */
export function evmConfirmationOverrides(c: SharedConfig): Record<string, EvmConfirmation | undefined> {
  return {
    "eip155:1": c.evmConfirmations_1,
    "eip155:8453": c.evmConfirmations_8453,
    "eip155:42161": c.evmConfirmations_42161,
  };
}

/** EVM RPC pools by chain (`NP_EVM_RPC_URLS_<CHAINID>`). */
export function evmRpcUrls(c: SharedConfig): Record<string, readonly string[]> {
  return { "eip155:1": c.evmRpcUrls_1, "eip155:8453": c.evmRpcUrls_8453, "eip155:42161": c.evmRpcUrls_42161 };
}
