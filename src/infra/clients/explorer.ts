/**
 * NEAR Intents Explorer API (lld/rails.md §8.5; spec 0.2.0 `Explorer*` wire schemas): `GET /api/v0/transactions`
 * with `Authorization: Bearer <owner's Partner Dashboard JWT>`, 1 request / 5 s per partner (429 beyond). The body
 * is a bare JSON array, newest first; `numberOfTransactions` ≤ 1,000; `statuses` comma-separated (the API default
 * omits PENDING_DEPOSIT and INCOMPLETE_DEPOSIT, so windows always set it); `startTimestamp` ISO and exclusive;
 * paging with `lastDepositAddress`/`lastDepositMemo` + `direction=next` (older rows). Rows are validated with
 * `ExplorerTransaction` (nullish optionals, `status` a plain string); malformed rows are dropped and counted.
 *
 * Test mode reads the sandbox mirror (`sandboxExplorerTransactions`, same query and row schemas) with rails'
 * service token instead of the JWT (INV-8: the live client never sees test executions and vice versa).
 */
import { HttpError, httpClient } from "@nearpay-internal/http";
import { EXPLORER_STATUSES, ExplorerTransaction, sandboxExplorerTransactions } from "@nearpay-internal/spec";

export type ExplorerTx = ExplorerTransaction;

export class ExplorerRateLimited extends Error {
  override readonly name = "ExplorerRateLimited";
}

/** The mirror is not served by this sandbox build (404): the test-mode feed idles. */
export class ExplorerUnavailable extends Error {
  override readonly name = "ExplorerUnavailable";
}

export interface ExplorerQuery {
  readonly statuses: readonly string[];
  readonly startTimestamp?: Date;
  readonly limit: number;
  /** Page cursor: the last row of the previous page (`direction=next`). */
  readonly after?: { readonly depositAddress: string; readonly depositMemo: string | null };
}

export interface Explorer {
  /** The mode whose executions this feed serves. */
  readonly livemode: boolean;
  transactions(q: ExplorerQuery): Promise<ExplorerTx[]>;
}

export const ALL_STATUSES = EXPLORER_STATUSES;

function params(q: ExplorerQuery, referral: string): Record<string, string> {
  const p: Record<string, string> = {
    numberOfTransactions: String(Math.min(Math.max(q.limit, 1), 1000)),
    referral,
    statuses: q.statuses.join(","),
  };
  if (q.startTimestamp) p.startTimestamp = q.startTimestamp.toISOString();
  if (q.after) {
    p.lastDepositAddress = q.after.depositAddress;
    if (q.after.depositMemo) p.lastDepositMemo = q.after.depositMemo;
    p.direction = "next";
  }
  return p;
}

/** Valid rows of a response body (anything but an array is an error). */
export function explorerRows(body: unknown, onDropped?: (n: number) => void): ExplorerTx[] {
  if (!Array.isArray(body)) throw new Error("explorer: expected an array of transactions");
  const out: ExplorerTx[] = [];
  for (const row of body) {
    const r = ExplorerTransaction.safeParse(row);
    if (r.success) out.push(r.data);
  }
  if (out.length < body.length) onDropped?.(body.length - out.length);
  return out;
}

export function explorer(o: {
  baseUrl: string;
  token: string;
  referral: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  onDropped?: (n: number) => void;
}): Explorer {
  const f = o.fetch ?? fetch;
  const base = o.baseUrl.replace(/\/$/, "");
  return {
    livemode: true,
    async transactions(q) {
      const p = new URLSearchParams(params(q, o.referral));
      const res = await f(`${base}/api/v0/transactions?${p}`, {
        headers: { accept: "application/json", authorization: `Bearer ${o.token}` },
        signal: AbortSignal.timeout(o.timeoutMs ?? 5_000),
      });
      if (res.status === 429) throw new ExplorerRateLimited("explorer rate limit");
      if (!res.ok) throw new Error(`explorer responded ${res.status}`);
      return explorerRows((await res.json()) as unknown, o.onDropped);
    },
  };
}

/** Test mode: the sandbox Explorer mirror, service-token authenticated, same schemas. */
export function sandboxExplorer(o: {
  baseUrl: string;
  serviceToken: () => Promise<string>;
  referral: string;
  fetch?: typeof fetch;
}): Explorer {
  const client = httpClient({
    target: "sandbox",
    baseUrl: o.baseUrl,
    timeoutMs: 2_000,
    attempts: 1,
    serviceToken: o.serviceToken,
    breaker: false,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  return {
    livemode: false,
    async transactions(q) {
      try {
        const body = await client.request({
          method: "GET",
          path: sandboxExplorerTransactions.path,
          query: params(q, o.referral),
        });
        return explorerRows(body.body);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) throw new ExplorerUnavailable("sandbox has no Explorer mirror");
        throw e;
      }
    },
  };
}
