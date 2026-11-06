/** Configuration (lld/rails.md §11, foundations §13). */
import { NearAccountId } from "@nearpay/spec";
import { baseConfigShape, flag, list, loadConfig, secret, url } from "@nearpay-internal/service";
import { z } from "zod";

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

const shared = {
  ...baseConfigShape,
  dbUrl: secret(url(["postgres:", "postgresql:"])),
  /** Shared provider budgets across replicas (optional: per-replica half budgets without it). */
  valkeyUrl: url(["redis:", "rediss:"]).optional(),
  identityUrl: url(["http:", "https:"]),
  serviceClientSecret: secret(),
  complianceUrl: url(["http:", "https:"]),
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
  pricingCurrencies: list(z.string().regex(/^[a-z]{3}$/)).default(["usd"]),
  tierBLimits: json(
    z.object({ per_payment_usd: z.number().min(0), per_day_usd: z.number().min(0) }),
    '{"per_payment_usd":2000,"per_day_usd":20000}',
  ),
  /** Compliance unreachable: refuse quotes at or above this many USD (§8.1 step 3). */
  screeningFailClosedUsd: z.coerce.number().min(0).default(1000),
  /** Watcher/verifier matches above this many USD need a second RPC's agreement (§10). */
  agreementUsd: z.coerce.number().min(0).default(10_000),
  explorerEnabled: flag(false),
  explorerBaseUrl: url(["https:", "http:"]).default("https://explorer.near-intents.org"),
  explorerToken: secret().optional(),
  /** Without the Explorer feed the poller sweeps unsignalled deposits this often (L-RL-03). */
  awaitingSweepS: z.coerce.number().int().min(5).max(3600).default(30),
  nearRpcUrls: rpcList.default(["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"]),
  neardataUrl: url(["https:", "http:"]).default("https://mainnet.neardata.xyz"),
  evmRpcUrls_1: rpcList.default(["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"]),
  evmRpcUrls_8453: rpcList.default(["https://mainnet.base.org", "https://base-rpc.publicnode.com"]),
  evmRpcUrls_42161: rpcList.default(["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"]),
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

/** EVM RPC pools by chain (`NP_EVM_RPC_URLS_<CHAINID>`). */
export function evmRpcUrls(c: SharedConfig): Record<string, readonly string[]> {
  return { "eip155:1": c.evmRpcUrls_1, "eip155:8453": c.evmRpcUrls_8453, "eip155:42161": c.evmRpcUrls_42161 };
}
