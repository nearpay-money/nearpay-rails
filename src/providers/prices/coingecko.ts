/**
 * CoinGecko keyless secondary prices (lld/rails.md §8.2, §10; reference/landscape.md §8):
 * `GET <base>/simple/price?ids=<ids>&vs_currencies=usd&include_last_updated_at=true&precision=full`, one batched call
 * (≤ 515 ids … the URL stays below 8 KiB), 3 s timeout. Numbers are read from their JSON source text
 * (`parseJsonDecimals`), never through a float. 429 → `PriceRateLimited` (the loop backs off ×2 up to 10 min).
 * Keyless: no API key, no paid plan (ADR-0020).
 */
import { parseExactDecimal, parseJsonDecimals } from "../../domain/pricing/ratio.js";
import { type PriceProvider, PriceRateLimited, type SecondaryPrice } from "./port.js";

const MAX_IDS = 515;
const ID = /^[a-z0-9][a-z0-9-_.]{0,127}$/;

/** Parses a `simple/price` body (text) into id → price; malformed entries are skipped. */
export function parseSimplePrice(text: string): Map<string, SecondaryPrice> {
  const body = parseJsonDecimals(text) as Record<string, unknown>;
  const out = new Map<string, SecondaryPrice>();
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("coingecko: expected an object");
  for (const [id, v] of Object.entries(body)) {
    const e = v as { usd?: unknown; last_updated_at?: unknown } | null;
    if (!e || typeof e.usd !== "string" || typeof e.last_updated_at !== "string") continue;
    try {
      const p = parseExactDecimal(e.usd);
      if (p.num <= 0n) continue;
      const secs = parseExactDecimal(e.last_updated_at);
      if (secs.den !== 1n || secs.num <= 0n) continue;
      out.set(id, { usd: e.usd, updatedAt: new Date(Number(secs.num) * 1000) });
    } catch {}
  }
  return out;
}

export function coingeckoProvider(o: { baseUrl: string; fetch?: typeof fetch; timeoutMs?: number }): PriceProvider {
  const f = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/$/, "");
  return {
    source: "coingecko",
    async prices(ids) {
      const list = [...new Set(ids.filter((x) => ID.test(x)))].sort().slice(0, MAX_IDS);
      if (list.length === 0) return new Map();
      const q = new URLSearchParams({
        ids: list.join(","),
        vs_currencies: "usd",
        include_last_updated_at: "true",
        precision: "full",
      });
      const res = await f(`${base}/simple/price?${q}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(o.timeoutMs ?? 3_000),
      });
      if (res.status === 429) throw new PriceRateLimited("coingecko rate limit");
      if (!res.ok) throw new Error(`coingecko responded ${res.status}`);
      return parseSimplePrice(await res.text());
    },
  };
}
