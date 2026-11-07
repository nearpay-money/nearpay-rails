/**
 * 1Click adapter (lld/rails.md §3, §10; reference/landscape.md §2). Live mode only.
 *
 * Auth: a JWT partner key as `Authorization: Bearer`, any other key as `X-API-Key` (absent: quotes are
 * unauthenticated and cost +25 bps, appFees are still sent). Responses are validated as received against the spec's
 * transcription of the 1Click OpenAPI (`@nearpay-internal/spec` oneclick.ts, which accepts the live nullish shape since
 * spec 0.2.0); quotes are verified with the 1Click SDK
 * (`verifyQuoteSignature`, SP-01: Ed25519 over base58(sha256(stable-stringify(...))), appFees
 * excluded — rails checks them itself, domain/execution/integrity.ts).
 */
import { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import { type HttpClient, HttpError, httpClient } from "@nearpay-internal/http";
import {
  type OneClickQuoteRequest,
  type OneClickQuoteResponse,
  OneClickToken,
  OneClickQuoteResponse as QuoteSchema,
  OneClickStatusResponse as StatusSchema,
} from "@nearpay-internal/spec";
import { z } from "zod";
import { parseJsonDecimals } from "../../domain/pricing/ratio.js";
import type { ProviderToken } from "../../domain/token-registry/registry.js";
import { assertMode, type QuoteOutcome, type RouteProvider, type StatusOutcome } from "../port.js";
import { oneClickAuthHeaders } from "./auth.js";

export interface OneClickOptions {
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
  readonly fetch?: typeof fetch;
  readonly onResult?: Parameters<typeof httpClient>[0]["onResult"];
  /** Rate budgets (`NP_ONECLICK_QUOTE_RPS`, `NP_ONECLICK_STATUS_RPS`): resolve when a call may go. */
  readonly takeQuote?: () => Promise<boolean>;
  readonly takeStatus?: () => Promise<boolean>;
  /** Signature key override (tests only); default: the 1Click manager key pinned in the SDK. */
  readonly managerPublicKey?: string;
}

const TokenList = z.array(z.unknown());

/**
 * `/v0/tokens`: the body as text, so every `price` keeps its exact source digits (`parseJsonDecimals`, §8.2: feed
 * numbers never pass through a float). An already-parsed body (tests) falls back to the number's shortest decimal.
 */
export function parseTokens(body: unknown): ProviderToken[] {
  const text = typeof body === "string" ? body : null;
  const list = TokenList.parse(text === null ? body : JSON.parse(text));
  const exact = text === null ? null : (parseJsonDecimals(text) as { price?: unknown }[]);
  const out: ProviderToken[] = [];
  list.forEach((item, i) => {
    const t = OneClickToken.safeParse(item);
    if (!t.success) return;
    const at = Date.parse(t.data.priceUpdatedAt);
    const src = exact?.[i]?.price;
    const priceText = typeof src === "string" ? src : String(t.data.price);
    out.push({
      assetId: t.data.assetId,
      decimals: t.data.decimals,
      blockchain: t.data.blockchain,
      symbol: t.data.symbol,
      priceUsd: Number.isFinite(t.data.price) && t.data.price > 0 ? priceText : null,
      priceUpdatedAt: Number.isFinite(at) ? new Date(at) : null,
      contractAddress: t.data.contractAddress ?? null,
      coingeckoId: t.data.coingeckoId ?? null,
    });
  });
  return out;
}

/** A fetch whose responses never look like JSON to the HTTP client, so the body stays the raw text. */
export function textFetch(f: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const res = await f(input, init);
    const headers = new Headers(res.headers);
    headers.set("content-type", "text/plain; charset=utf-8");
    return new Response(await res.text(), { status: res.status, statusText: res.statusText, headers });
  };
}

/** Shared HTTP behaviour of both 1Click-compatible adapters. */
export function oneClickCalls(o: {
  client: HttpClient;
  /** Client whose bodies stay text (`textFetch`) for `/v0/tokens`; default `client`. */
  textClient?: HttpClient;
  headers: Record<string, string>;
  takeQuote: () => Promise<boolean>;
  takeStatus: () => Promise<boolean>;
}) {
  const message = (e: HttpError): string => {
    const b = e.body as { message?: unknown; error?: { message?: unknown } } | null;
    const m = typeof b?.message === "string" ? b.message : typeof b?.error?.message === "string" ? b.error.message : "";
    return m.slice(0, 300) || `rejected (${e.status})`;
  };
  async function status(
    path: string,
    init: { method: "GET" | "POST"; query?: Record<string, string>; body?: unknown },
  ) {
    if (!(await o.takeStatus())) return { ok: false, kind: "unavailable", detail: "status budget exhausted" } as const;
    try {
      const res = await o.client.request({
        method: init.method,
        path,
        headers: o.headers,
        ...(init.query ? { query: init.query } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
        timeoutMs: 4_000,
      });
      const parsed = StatusSchema.safeParse(res.body);
      if (!parsed.success) return { ok: false, kind: "unavailable", detail: "malformed status response" } as const;
      return { ok: true, status: parsed.data, raw: res.body } as const;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return { ok: false, kind: "not_found" } as const;
      return { ok: false, kind: "unavailable", detail: e instanceof Error ? e.message : String(e) } as const;
    }
  }
  return {
    async tokens(): Promise<ProviderToken[]> {
      const res = await (o.textClient ?? o.client).request({
        method: "GET",
        path: "/v0/tokens",
        headers: o.headers,
        timeoutMs: 5_000,
      });
      return parseTokens(res.body);
    },
    async quote(body: unknown): Promise<QuoteOutcome> {
      if (!(await o.takeQuote())) return { ok: false, kind: "unavailable", detail: "quote budget exhausted" };
      try {
        const res = await o.client.request({
          method: "POST",
          path: "/v0/quote",
          headers: o.headers,
          body,
          timeoutMs: 6_000,
        });
        const parsed = QuoteSchema.safeParse(res.body);
        if (!parsed.success) return { ok: false, kind: "malformed", detail: parsed.error.message.slice(0, 500) };
        return { ok: true, response: parsed.data, raw: res.body };
      } catch (e) {
        if (e instanceof HttpError && e.status === 400) return { ok: false, kind: "rejected", message: message(e) };
        return { ok: false, kind: "unavailable", detail: e instanceof Error ? e.message : String(e) };
      }
    },
    status(depositAddress: string, memo: string | null): Promise<StatusOutcome> {
      return status("/v0/status", {
        method: "GET",
        query: { depositAddress, ...(memo ? { depositMemo: memo } : {}) },
      });
    },
    submit(b: {
      txHash: string;
      depositAddress: string;
      memo: string | null;
      sender?: string;
    }): Promise<StatusOutcome> {
      return status("/v0/deposit/submit", {
        method: "POST",
        body: {
          txHash: b.txHash,
          depositAddress: b.depositAddress,
          ...(b.memo ? { memo: b.memo } : {}),
          ...(b.sender ? { nearSenderAccount: b.sender } : {}),
        },
      });
    },
  };
}

const always = async () => true;

export function oneClickProvider(o: OneClickOptions): RouteProvider {
  const client = httpClient({
    target: "oneclick",
    baseUrl: o.baseUrl,
    timeoutMs: 6_000,
    attempts: 1, // pollers and payments retry on their own schedules; budgets count every call
    breaker: { failureRate: 0.5, minCalls: 10, windowMs: 30_000, halfOpenAfterMs: 15_000 },
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...(o.onResult ? { onResult: o.onResult } : {}),
  });
  const textClient = httpClient({
    target: "oneclick",
    baseUrl: o.baseUrl,
    timeoutMs: 5_000,
    attempts: 1,
    breaker: false,
    fetch: textFetch(o.fetch),
  });
  const calls = oneClickCalls({
    client,
    textClient,
    headers: oneClickAuthHeaders(o.apiKey),
    takeQuote: o.takeQuote ?? always,
    takeStatus: o.takeStatus ?? always,
  });
  const p: RouteProvider = {
    name: "oneclick",
    livemode: true,
    tokens: calls.tokens,
    async quote(livemode: boolean, req: OneClickQuoteRequest) {
      assertMode(p, livemode);
      return calls.quote(req);
    },
    async status(livemode, address, memo) {
      assertMode(p, livemode);
      return calls.status(address, memo);
    },
    async submitDeposit(livemode, b) {
      assertMode(p, livemode);
      return calls.submit(b);
    },
    verifySignature: (r: OneClickQuoteResponse) =>
      o.managerPublicKey ? verifyQuoteSignature(r as never, o.managerPublicKey) : verifyQuoteSignature(r as never),
  };
  return p;
}
