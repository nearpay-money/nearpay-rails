/**
 * FX provider port and the ECB adapter (lld/rails.md §8.2, §10; ADR-0020 decision 5). Live: the ECB daily XML
 * (`eurofxref-daily.xml`, 5 s timeout) fetched every 30 min with a conditional GET (`If-None-Match` /
 * `If-Modified-Since`); test mode: the fixed table `NP_TEST_FX_RATES`.
 */
import { type EcbDaily, parseEcbDaily } from "../../domain/pricing/ecb.js";

export interface FxFetch {
  /** `null` = not modified since the last fetch. */
  daily(): Promise<EcbDaily | null>;
}

export function ecbProvider(o: { url: string; fetch?: typeof fetch; timeoutMs?: number }): FxFetch {
  const f = o.fetch ?? fetch;
  let etag: string | null = null;
  let lastModified: string | null = null;
  return {
    async daily() {
      const headers: Record<string, string> = { accept: "application/xml, text/xml" };
      if (etag) headers["if-none-match"] = etag;
      if (lastModified) headers["if-modified-since"] = lastModified;
      const res = await f(o.url, { headers, signal: AbortSignal.timeout(o.timeoutMs ?? 5_000) });
      if (res.status === 304) return null;
      if (!res.ok) throw new Error(`ecb responded ${res.status}`);
      const parsed = parseEcbDaily(await res.text());
      etag = res.headers.get("etag");
      lastModified = res.headers.get("last-modified");
      return parsed;
    },
  };
}
