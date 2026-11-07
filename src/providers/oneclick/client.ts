/**
 * 1Click adapter (lld/rails.md §3, §10; reference/landscape.md §2). Live mode only.
 *
 * Auth: a JWT partner key as `Authorization: Bearer`, any other key as `X-API-Key` (absent: quotes are
 * unauthenticated and cost +25 bps, appFees are still sent). Responses are normalised (./normalize.ts: live
 * 1Click sends nulls the OpenAPI does not declare) and validated against the spec's transcription of the 1Click OpenAPI
 * (`@nearpay-internal/spec` oneclick.ts); quotes are verified with the 1Click SDK
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
import type { ProviderToken } from "../../domain/token-registry/registry.js";
import { assertMode, type QuoteOutcome, type RouteProvider, type StatusOutcome } from "../port.js";
import { normalizeOneClick, oneClickAuthHeaders } from "./normalize.js";

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

export function parseTokens(body: unknown): ProviderToken[] {
  const list = TokenList.parse(body);
  const out: ProviderToken[] = [];
  for (const item of list) {
    const t = OneClickToken.safeParse(item);
    if (!t.success) continue;
    const at = Date.parse(t.data.priceUpdatedAt);
    out.push({
      assetId: t.data.assetId,
      decimals: t.data.decimals,
      blockchain: t.data.blockchain,
      symbol: t.data.symbol,
      // JSON numbers become their shortest round-trip decimal string; parsed exactly downstream
      priceUsd: Number.isFinite(t.data.price) && t.data.price > 0 ? String(t.data.price) : null,
      priceUpdatedAt: Number.isFinite(at) ? new Date(at) : null,
      contractAddress: t.data.contractAddress ?? null,
    });
  }
  return out;
}

/** Shared HTTP behaviour of both 1Click-compatible adapters. */
export function oneClickCalls(o: {
  client: HttpClient;
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
      const parsed = StatusSchema.safeParse(normalizeOneClick(res.body));
      if (!parsed.success) return { ok: false, kind: "unavailable", detail: "malformed status response" } as const;
      return { ok: true, status: parsed.data, raw: res.body } as const;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return { ok: false, kind: "not_found" } as const;
      return { ok: false, kind: "unavailable", detail: e instanceof Error ? e.message : String(e) } as const;
    }
  }
  return {
    async tokens(): Promise<ProviderToken[]> {
      const res = await o.client.request({ method: "GET", path: "/v0/tokens", headers: o.headers, timeoutMs: 5_000 });
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
        const parsed = QuoteSchema.safeParse(normalizeOneClick(res.body));
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
  const calls = oneClickCalls({
    client,
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
