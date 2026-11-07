import { readFileSync } from "node:fs";
import { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import { type OneClickQuoteResponse, OneClickStatusResponse } from "@nearpay-internal/spec";
import { describe, expect, it } from "vitest";
import { oneClickAuthHeaders } from "../../src/providers/oneclick/auth.js";
import { oneClickCalls } from "../../src/providers/oneclick/client.js";

/** A real mainnet `GET /v0/status` body (PENDING_DEPOSIT, 2026-11-07); rails quoted it with quoteWaitingTimeMs 3000. */
const raw = readFileSync(new URL("../fixtures/oneclick-status-pending-live.json", import.meta.url), "utf8");
const live = JSON.parse(raw);

describe("live 1Click shape (spec 0.2.0 accepts it; no normalisation)", () => {
  it("the recorded live status body parses unmodified, nulls and all", () => {
    const parsed = OneClickStatusResponse.safeParse(live);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.status).toBe("PENDING_DEPOSIT");
    expect(parsed.data.swapDetails.amountOut ?? null).toBeNull();
    expect(parsed.data.quoteResponse.correlationId).toBeUndefined();
    expect(parsed.data.quoteResponse.quote.depositAddress).toBe("0x77B262Cb4dB1Ca5021F773388F244F05b66bE8F2");
    // the input is not changed by parsing
    expect(JSON.stringify(live)).toBe(JSON.stringify(JSON.parse(raw)));
  });

  it("the provider signature verifies on the body as received (nulls are unset fields for the SDK)", () => {
    const q = live.quoteResponse as OneClickQuoteResponse;
    // the status endpoint omits the request's quoteWaitingTimeMs, which is part of the signed hash
    expect(verifyQuoteSignature(q as never)).toBe(false);
    expect(verifyQuoteSignature({ ...q, quoteRequest: { ...q.quoteRequest, quoteWaitingTimeMs: 3000 } } as never)).toBe(
      true,
    );
  });

  it("the adapter's status call validates the live body as is", async () => {
    const calls = oneClickCalls({
      client: { request: async () => ({ status: 200, body: live, headers: new Headers() }) } as never,
      headers: {},
      takeQuote: async () => true,
      takeStatus: async () => true,
    });
    const out = await calls.status("0x77B262Cb4dB1Ca5021F773388F244F05b66bE8F2", null);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.raw).toBe(live);
  });
});

describe("oneClickAuthHeaders", () => {
  it("sends a JWT as a bearer token and any other key as X-API-Key", () => {
    expect(oneClickAuthHeaders("aaa.bbb-c.d_d")).toEqual({ authorization: "Bearer aaa.bbb-c.d_d" });
    expect(oneClickAuthHeaders("plain-key")).toEqual({ "x-api-key": "plain-key" });
    expect(oneClickAuthHeaders(undefined)).toEqual({});
    expect(oneClickAuthHeaders("")).toEqual({});
  });
});
