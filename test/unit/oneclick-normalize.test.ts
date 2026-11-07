import { readFileSync } from "node:fs";
import { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import { OneClickQuoteResponse, OneClickStatusResponse } from "@nearpay-internal/spec";
import { describe, expect, it } from "vitest";
import { normalizeOneClick, oneClickAuthHeaders } from "../../src/providers/oneclick/normalize.js";

/** A real mainnet `GET /v0/status` body (PENDING_DEPOSIT, 2026-11-07); rails quoted it with quoteWaitingTimeMs 3000. */
const live = JSON.parse(
  readFileSync(new URL("../fixtures/oneclick-status-pending-live.json", import.meta.url), "utf8"),
);

describe("normalizeOneClick (live 1Click bodies vs its OpenAPI)", () => {
  it("the raw live status body fails the spec schema; the normalised one passes", () => {
    expect(OneClickStatusResponse.safeParse(live).success).toBe(false);
    const parsed = OneClickStatusResponse.safeParse(normalizeOneClick(live));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.status).toBe("PENDING_DEPOSIT");
    expect(parsed.data.swapDetails.amountOut).toBeUndefined();
    expect(parsed.data.quoteResponse.correlationId).toBe(live.correlationId);
    expect(parsed.data.quoteResponse.quote.depositAddress).toBe("0x77B262Cb4dB1Ca5021F773388F244F05b66bE8F2");
  });

  it("drops null properties at any depth, keeps arrays, zeros and empty strings, and does not mutate the input", () => {
    const input = { a: null, b: 0, c: "", d: [null, { e: null, f: 1 }], g: { h: null } };
    expect(normalizeOneClick(input)).toEqual({ b: 0, c: "", d: [null, { f: 1 }], g: {} });
    expect(input.a).toBeNull();
  });

  it("keeps an existing nested correlationId", () => {
    const body = { correlationId: "top", quoteResponse: { correlationId: "nested" } };
    expect((normalizeOneClick(body) as typeof body).quoteResponse.correlationId).toBe("nested");
  });

  it("changes nothing 1Click signs: the real signature verifies on the normalised quote", () => {
    const q = (normalizeOneClick(live) as { quoteResponse: OneClickQuoteResponse }).quoteResponse;
    expect(OneClickQuoteResponse.safeParse(q).success).toBe(true);
    // the status endpoint omits the request's quoteWaitingTimeMs, which is part of the signed hash
    expect(verifyQuoteSignature(q as never)).toBe(false);
    expect(verifyQuoteSignature({ ...q, quoteRequest: { ...q.quoteRequest, quoteWaitingTimeMs: 3000 } } as never)).toBe(
      true,
    );
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
