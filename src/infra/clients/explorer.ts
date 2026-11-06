/**
 * NEAR Intents Explorer API (lld/rails.md §8.5; contract read 2026-11-06 from
 * https://explorer.near-intents.org/api/v0/openapi.yaml): `GET /api/v0/transactions` with
 * `Authorization: Bearer <partner JWT>`, 1 request / 5 s per partner (429 beyond). The body is a
 * JSON array of transactions; `numberOfTransactions` ≤ 1,000; `statuses` is comma-separated (the
 * default omits PENDING_DEPOSIT and INCOMPLETE_DEPOSIT); `startTimestamp` is ISO and exclusive.
 * Whether time filters use creation or update time is undocumented (SP-10): the feed only nudges the
 * hot poller, so a missed or duplicated row is harmless.
 */
import { z } from "zod";

export const ExplorerTx = z.looseObject({
  depositAddress: z.string(),
  depositMemo: z.string().nullable().optional(),
  status: z.string(),
  createdAt: z.string().optional(),
  referral: z.string().nullable().optional(),
});
export type ExplorerTx = z.infer<typeof ExplorerTx>;

export class ExplorerRateLimited extends Error {
  override readonly name = "ExplorerRateLimited";
}

export interface Explorer {
  transactions(q: { statuses: readonly string[]; startTimestamp?: Date; limit: number }): Promise<ExplorerTx[]>;
}

export const ALL_STATUSES = [
  "PENDING_DEPOSIT",
  "INCOMPLETE_DEPOSIT",
  "PROCESSING",
  "SUCCESS",
  "REFUNDED",
  "FAILED",
] as const;

export function explorer(o: {
  baseUrl: string;
  token: string;
  referral: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Explorer {
  const f = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/$/, "");
  return {
    async transactions(q) {
      const p = new URLSearchParams({
        numberOfTransactions: String(Math.min(Math.max(q.limit, 1), 1000)),
        referral: o.referral,
        statuses: q.statuses.join(","),
      });
      if (q.startTimestamp) p.set("startTimestamp", q.startTimestamp.toISOString());
      const res = await f(`${base}/api/v0/transactions?${p}`, {
        headers: { accept: "application/json", authorization: `Bearer ${o.token}` },
        signal: AbortSignal.timeout(o.timeoutMs ?? 5_000),
      });
      if (res.status === 429) throw new ExplorerRateLimited("explorer rate limit");
      if (!res.ok) throw new Error(`explorer responded ${res.status}`);
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) throw new Error("explorer: expected an array of transactions");
      return body.flatMap((row) => {
        const r = ExplorerTx.safeParse(row);
        return r.success ? [r.data] : [];
      });
    },
  };
}
