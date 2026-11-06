/**
 * Token policy and route classes (lld/rails.md §4 `tokens`, §8.1 step 4). Pure.
 *
 * The registry is fed by the route provider's token list (1Click `/v0/tokens` live, the sandbox's
 * fixed list in test mode). A token is enabled when its chain has a profile; its `family` groups the
 * same asset across chains (USDC on Base and USDC on NEAR are `same_asset`), and `is_usd_stable`
 * marks the USD stablecoins that may settle at par (§8.2).
 */
import { AssetId } from "@nearpay/spec";
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
}

/**
 * Registry rows for a provider token list. Tokens on chains without a profile are kept (disabled) so
 * the registry mirrors the provider; malformed entries are dropped.
 */
export function registryRows(livemode: boolean, tokens: readonly ProviderToken[], profiles: ChainProfiles): TokenRow[] {
  const seen = new Set<string>();
  const rows: TokenRow[] = [];
  for (const t of tokens) {
    if (!AssetId.safeParse(t.assetId).success || seen.has(t.assetId)) continue;
    if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 255) continue;
    seen.add(t.assetId);
    const profile = profiles.byBlockchain(t.blockchain);
    const family = familyOf(t.symbol);
    rows.push({
      livemode,
      asset_id: t.assetId,
      blockchain: t.blockchain,
      chain: profile?.chain ?? `unknown:${t.blockchain}`.slice(0, 40),
      symbol: t.symbol.slice(0, 40),
      decimals: t.decimals,
      contract_address: t.contractAddress,
      family,
      is_usd_stable: USD_STABLE_FAMILIES.has(family),
      enabled: profile !== undefined,
      price_usd: t.priceUsd,
      price_updated_at: t.priceUpdatedAt,
      memo_required: profile?.memoMode === "required",
    });
  }
  return rows;
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
