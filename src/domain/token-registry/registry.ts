/**
 * Token policy and route classes (lld/rails.md §4 `tokens`, §8.1 step 4). Pure.
 *
 * The registry is fed by the route provider's token list (1Click `/v0/tokens` live, the sandbox's
 * fixed list in test mode). A token is enabled when its chain has a profile; its `family` groups the
 * same asset across chains (USDC on Base and USDC on NEAR are `same_asset`), and `is_usd_stable`
 * marks the USD stablecoins that may settle at par (§8.2).
 */
import { AssetId, parseAssetId } from "@nearpay-money/spec";
import { splMintMatchesAssetId } from "../chains/solana.js";
import { parseExactDecimal, ratioToWire } from "../pricing/ratio.js";
import type { ChainProfiles } from "./chain-profiles.js";

/** USD stablecoins NearPay settles at par (depeg-guarded). Bridged variants keep their own symbol. */
export const USD_STABLE_FAMILIES: ReadonlySet<string> = new Set(["USDC", "USDT"]);

/** Wrapped representations that are the same asset for routing (1:1 redeemable). */
const FAMILY_ALIASES: Readonly<Record<string, string>> = {
  WNEAR: "NEAR",
  WETH: "ETH",
  WBTC: "BTC",
};

/** `family` of a provider symbol: upper-cased, wrapped aliases folded. */
export function familyOf(symbol: string): string {
  const s = symbol.trim().toUpperCase();
  return FAMILY_ALIASES[s] ?? s;
}

export interface ProviderToken {
  readonly assetId: string;
  readonly decimals: number;
  readonly blockchain: string;
  readonly symbol: string;
  /** Decimal string (never a float in arithmetic). */
  readonly priceUsd: string | null;
  readonly priceUpdatedAt: Date | null;
  readonly contractAddress: string | null;
  /** CoinGecko id (1Click `coingeckoId`), the secondary price key. */
  readonly coingeckoId?: string | null;
}

export interface TokenRow {
  readonly livemode: boolean;
  readonly asset_id: string;
  readonly blockchain: string;
  readonly chain: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly contract_address: string | null;
  readonly family: string;
  readonly is_usd_stable: boolean;
  readonly enabled: boolean;
  readonly price_usd: string | null;
  readonly price_updated_at: Date | null;
  readonly memo_required: boolean;
  /** Fiat currency of a stablecoin (`usd` for USD stablecoins, `NP_STABLE_PEGS` for others), or null. */
  readonly peg_currency: string | null;
  readonly coingecko_id: string | null;
  /** Exact primary price (reduced rational), null without a usable price. */
  readonly price_num: string | null;
  readonly price_den: string | null;
}

/**
 * Registry rows for a provider token list. Tokens on chains without a profile are kept (disabled) so
 * the registry mirrors the provider; malformed entries are dropped.
 */
export function registryRows(
  livemode: boolean,
  tokens: readonly ProviderToken[],
  profiles: ChainProfiles,
  o: {
    pegs?: Readonly<Record<string, string>>;
    coingeckoIds?: Readonly<Record<string, string>>;
    /** Stage 4 (§21.1): an entry dropped because its contract does not reproduce its asset id (alert). */
    onDrop?: (assetId: string, reason: string) => void;
    /**
     * Drift check (2026-11-12): an entry whose id no NearPay parser recognises, or whose id names another chain than
     * the provider's `blockchain` (alert; the entry is kept when the AssetId contract admits it — rails takes the chain
     * from `blockchain`; `1cs_v1:` ids are outside the contract and never enter the registry).
     */
    onDrift?: (assetId: string, drift: AssetIdDrift) => void;
  } = {},
): TokenRow[] {
  const seen = new Set<string>();
  const rows: TokenRow[] = [];
  for (const t of tokens) {
    // the drift check sees every listed id, including shapes the AssetId contract does not admit (e.g. 1cs_v1:)
    const drift = typeof t.assetId === "string" && !seen.has(t.assetId) ? assetIdDrift(t) : null;
    if (drift) o.onDrift?.(t.assetId, drift);
    if (!AssetId.safeParse(t.assetId).success || seen.has(t.assetId)) continue;
    if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 255) continue;
    const bound = contractBinding(t);
    if (bound !== null) {
      o.onDrop?.(t.assetId, bound);
      continue;
    }
    seen.add(t.assetId);
    const profile = profiles.byBlockchain(t.blockchain);
    const family = familyOf(t.symbol);
    const isUsd = USD_STABLE_FAMILIES.has(family);
    let price: { num: string; den: string } | null = null;
    if (t.priceUsd !== null) {
      try {
        const v = parseExactDecimal(t.priceUsd);
        if (v.num > 0n) price = ratioToWire(v);
      } catch {}
    }
    rows.push({
      livemode,
      asset_id: t.assetId,
      blockchain: t.blockchain,
      chain: profile?.chain ?? `unknown:${t.blockchain}`.slice(0, 40),
      symbol: t.symbol.slice(0, 40),
      decimals: t.decimals,
      contract_address: t.contractAddress,
      family,
      is_usd_stable: isUsd,
      enabled: profile !== undefined,
      price_usd: price ? t.priceUsd : null,
      price_updated_at: price ? t.priceUpdatedAt : null,
      memo_required: profile?.memoMode === "required",
      peg_currency: o.pegs?.[t.assetId] ?? (isUsd ? "usd" : null),
      coingecko_id: (o.coingeckoIds?.[t.assetId] ?? t.coingeckoId ?? null)?.slice(0, 128) ?? null,
      price_num: price?.num ?? null,
      price_den: price?.den ?? null,
    });
  }
  return rows;
}

/**
 * Stage 4 (§21.1): an SPL bridge entry (`nep141:sol-<hash20>.omft.near`, or since 2026-11 `sol-0x<hash20>.omdep.near`)
 * is bound to its mint like an EVM contract — the mint must hash to the id's hash20; a `1cs_v1:sol:spl:<mint>` entry
 * must list that mint. Otherwise the entry is dropped (null = consistent / not an SPL id).
 */
export function contractBinding(t: Pick<ProviderToken, "assetId" | "blockchain" | "contractAddress">): string | null {
  const a = parseAssetId(t.assetId);
  const bridged = (a.scheme === "omft" || a.scheme === "omdep") && a.blockchain === "sol" && a.kind === "hash20";
  const v1 = a.scheme === "1cs_v1" && a.blockchain === "sol" && a.standard === "spl";
  if (!bridged && !v1) return null;
  if (!t.contractAddress) return "SPL asset without a mint";
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t.contractAddress)) return "SPL mint is not a Solana address";
  return splMintMatchesAssetId(t.contractAddress, t.assetId) ? null : "SPL mint does not reproduce the asset id";
}

export type AssetIdDrift =
  | { readonly kind: "unknown_shape"; readonly reason: string }
  | { readonly kind: "chain_disagrees"; readonly id_blockchain: string; readonly blockchain: string };

/**
 * Drift check (2026-11-12, after the `omdep` suffix appeared unannounced): null when spec `parseAssetId` recognises the
 * id and it names the provider's own `blockchain`. `nep245:` multi-token ids and NEP-141 accounts the provider lists on
 * NEAR count as recognised (their chain comes from `blockchain`).
 */
export function assetIdDrift(t: Pick<ProviderToken, "assetId" | "blockchain">): AssetIdDrift | null {
  const a = parseAssetId(t.assetId);
  if (a.scheme === "unknown") {
    if (t.assetId.startsWith("nep245:")) return null;
    if (t.assetId.startsWith("nep141:") && t.blockchain === "near") return null;
    return { kind: "unknown_shape", reason: a.reason };
  }
  return a.blockchain === t.blockchain
    ? null
    : { kind: "chain_disagrees", id_blockchain: a.blockchain, blockchain: t.blockchain };
}

export type RouteClass = "same_asset" | "stable_pair" | "volatile" | "intents_transfer";

export interface Classifiable {
  readonly asset_id: string;
  readonly family: string;
  readonly is_usd_stable: boolean;
}

/** §8.1 step 4. */
export function routeClass(origin: Classifiable, destination: Classifiable): Exclude<RouteClass, "intents_transfer"> {
  if (origin.asset_id === destination.asset_id || origin.family === destination.family) return "same_asset";
  if (origin.is_usd_stable && destination.is_usd_stable) return "stable_pair";
  return "volatile";
}

/** Slippage per route class, bps (§8.1, `NP_SLIPPAGE_BPS`). */
export const DEFAULT_SLIPPAGE_BPS: Readonly<Record<Exclude<RouteClass, "intents_transfer">, number>> = {
  same_asset: 30,
  stable_pair: 50,
  volatile: 100,
};

export type TokenContractView = {
  readonly standard: "erc20" | "native" | "nep141" | "spl" | "other";
  readonly address: string | null;
};

/**
 * How to transfer an asset on its chain (CR-15-06, spec `TokenContract`): `erc20` on EVM, `nep141` on NEAR, `spl` on
 * Solana with a contract; `native` without one; `other` for families without a wallet recipe.
 */
export function tokenContract(family: string | undefined, contract: string | null): TokenContractView {
  const address = contract && contract.length > 0 ? contract.slice(0, 256) : null;
  if (family === "evm") return address ? { standard: "erc20", address } : { standard: "native", address: null };
  if (family === "near") return address ? { standard: "nep141", address } : { standard: "native", address: null };
  if (family === "solana") return address ? { standard: "spl", address } : { standard: "native", address: null };
  if (family === "bitcoin") return { standard: "native", address: null };
  return { standard: "other", address };
}
