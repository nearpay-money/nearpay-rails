/**
 * Secondary token price port (lld/rails.md §8.2, ADR-0020 decision 5): a vendor is a new adapter, not a contract
 * change. Live: CoinGecko keyless `simple/price`; test mode: the sandbox registry price (role `secondary`).
 */
export interface SecondaryPrice {
  /** USD per one whole token, exact decimal text as the source wrote it. */
  readonly usd: string;
  /** When the source says the price applies. */
  readonly updatedAt: Date;
}

export class PriceRateLimited extends Error {
  override readonly name = "PriceRateLimited";
}

export interface PriceProvider {
  readonly source: "coingecko" | "sandbox";
  /** Prices for the given source ids (missing ids are simply absent). */
  prices(ids: readonly string[]): Promise<Map<string, SecondaryPrice>>;
}
