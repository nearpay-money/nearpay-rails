/**
 * Quote integrity against the recorded 1Click dry quote (2026-11-05): appFees come back split 50/50
 * with 1Click's fee account, and the quote signature excludes appFees — so the split check is the
 * only protection of NearPay's fee (and of the payer against fee inflation).
 */
import { readFileSync } from "node:fs";
import { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import { OneClickQuoteRequest, OneClickQuoteResponse } from "@nearpay-internal/spec";
import { describe, expect, it } from "vitest";
import { checkAppFees, checkQuote, minTreasuryShare } from "../../src/domain/execution/integrity.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/oneclick/${name}`, import.meta.url), "utf8"));
const recorded = OneClickQuoteResponse.parse(fixture("dry-quote.json"));
const sent = OneClickQuoteRequest.parse(fixture("dry-quote.request.json"));
const SPLIT = { shareBps: 5000, floorBps: 20, stableFloorBps: 1 };
const TREASURY = "intents.near"; // the recorded request used intents.near as the fee recipient

describe("recorded 1Click quote", () => {
  it("verifies with the SDK, even with appFees rewritten (they are not signed)", () => {
    expect(verifyQuoteSignature(recorded as never)).toBe(true);
    expect(
      verifyQuoteSignature({
        ...recorded,
        quoteRequest: { ...recorded.quoteRequest, recipient: "evil.near" },
      } as never),
    ).toBe(false);
    const fees = {
      ...recorded,
      quoteRequest: { ...recorded.quoteRequest, appFees: [{ recipient: "evil.near", fee: 500 }] },
    };
    expect(verifyQuoteSignature(fees as never)).toBe(true);
  });

  it("echoes the 50 bps fee split 25/25 — accepted", () => {
    expect(recorded.quoteRequest.appFees).toEqual([
      { recipient: "intents.near", fee: 25 },
      { recipient: "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd", fee: 25 },
    ]);
    expect(checkAppFees(recorded.quoteRequest.appFees, TREASURY, 50, SPLIT, true)).toEqual([]);
  });
});

describe("appFees split check", () => {
  const ok = (fees: { recipient: string; fee: number }[] | undefined, fee = 50, stable = true) =>
    checkAppFees(fees, TREASURY, fee, SPLIT, stable);

  it("accepts the unsplit form (partner key / sandbox before splitting)", () => {
    expect(ok([{ recipient: TREASURY, fee: 50 }])).toEqual([]);
  });

  it("refuses inflation, diversion, duplicates and extra recipients", () => {
    expect(
      ok([
        { recipient: TREASURY, fee: 25 },
        { recipient: "x", fee: 30 },
      ]),
    ).toEqual(["appFees total 55 bps != requested 50 bps"]);
    expect(
      ok([
        { recipient: TREASURY, fee: 10 },
        { recipient: "x", fee: 40 },
      ]),
    ).toEqual(["treasury appFee 10 bps < 25 bps"]);
    expect(ok([{ recipient: "x", fee: 50 }])).toEqual(["appFees pay the treasury 0 times"]);
    expect(
      ok([
        { recipient: TREASURY, fee: 25 },
        { recipient: TREASURY, fee: 25 },
      ]),
    ).toEqual(["appFees pay the treasury 2 times"]);
    expect(
      ok([
        { recipient: TREASURY, fee: 25 },
        { recipient: "a", fee: 15 },
        { recipient: "b", fee: 10 },
      ]),
    ).toEqual(["appFees has 3 entries (expected the treasury and the provider)"]);
    expect(ok(undefined)).toHaveLength(2);
  });

  it("fee-free quotes carry no appFees", () => {
    expect(ok([], 0)).toEqual([]);
    expect(ok(undefined, 0)).toEqual([]);
    expect(ok([{ recipient: TREASURY, fee: 1 }], 0)).toEqual(["appFees present on a fee-free quote"]);
  });

  it("respects the provider floor (20 bps volatile, 1 bp stable)", () => {
    expect(minTreasuryShare(100, SPLIT, false)).toBe(50);
    expect(minTreasuryShare(25, SPLIT, true)).toBe(12); // provider half rounds up
    expect(minTreasuryShare(30, SPLIT, false)).toBe(10); // provider floor 20
    expect(minTreasuryShare(10, SPLIT, false)).toBe(0);
  });
});

describe("checkQuote", () => {
  const live = {
    ...recorded,
    quoteRequest: { ...recorded.quoteRequest, dry: false },
    quote: {
      ...recorded.quote,
      depositAddress: "0x76b4c56085ed136a8744d52be956396624a730e8",
      deadline: "2026-11-05T18:26:53.000Z",
    },
  };
  const input = (over: Partial<Parameters<typeof checkQuote>[0]> = {}) => ({
    sent: { ...sent, dry: false },
    response: live,
    treasury: TREASURY,
    feeBps: 50,
    split: SPLIT,
    stableRoute: true,
    nowMs: Date.parse("2026-11-05T18:07:00.000Z"),
    minDeadlineS: 300,
    validDeposit: (a: string) => /^0x[0-9a-f]{40}$/.test(a),
    ...over,
  });

  it("accepts a consistent quote", () => {
    expect(checkQuote(input())).toEqual({ ok: true });
  });

  it("EXACT_INPUT (refund legs): exactly the requested amount in, positive minAmountOut ≤ amountOut", () => {
    const q = live.quote;
    const exin = (quote: Partial<typeof q>, amount = q.amountIn) =>
      checkQuote(
        input({
          sent: { ...sent, dry: false, swapType: "EXACT_INPUT", amount },
          response: {
            ...live,
            quoteRequest: { ...live.quoteRequest, swapType: "EXACT_INPUT", amount },
            quote: { ...q, ...quote },
          },
        }),
      );
    expect(exin({})).toEqual({ ok: true });
    expect(exin({}, (BigInt(q.amountIn) + 1n).toString())).toMatchObject({ ok: false });
    expect(exin({ minAmountOut: "0" })).toEqual({ ok: false, failures: ["minAmountOut is zero"] });
    expect(exin({ minAmountOut: (BigInt(q.amountOut) + 1n).toString() })).toEqual({
      ok: false,
      failures: ["minAmountOut exceeds amountOut"],
    });
  });

  it.each([
    ["recipient", { recipient: "evil.near" }],
    ["refundTo", { refundTo: "0x0000000000000000000000000000000000000001" }],
    ["destinationAsset", { destinationAsset: "nep141:evil.near" }],
    ["amount", { amount: "1" }],
    ["recipientType", { recipientType: "DESTINATION_CHAIN" as const }],
  ])("refuses a changed %s", (field, over) => {
    const r = checkQuote(input({ response: { ...live, quoteRequest: { ...live.quoteRequest, ...over } } }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.failures.some((f) => f.startsWith(`quoteRequest.${field}`))).toBe(true);
  });

  it("refuses wrong amounts, bad deposit addresses, dry runs and short deadlines", () => {
    const fail = (over: Partial<Parameters<typeof checkQuote>[0]>) => {
      const r = checkQuote(input(over));
      return r.ok ? [] : r.failures;
    };
    expect(fail({ response: { ...live, quote: { ...live.quote, amountOut: "2000016" } } })).toContain(
      "amountOut 2000016 != requested 2000017",
    );
    expect(fail({ response: { ...live, quote: { ...live.quote, depositAddress: "nope" } } })).toContain(
      "deposit address nope is invalid for the origin",
    );
    const { depositAddress: _d, ...noAddress } = live.quote;
    expect(fail({ response: { ...live, quote: noAddress } })).toContain("no deposit address");
    expect(fail({ response: { ...live, quoteRequest: { ...live.quoteRequest, dry: true } } })).toContain(
      "quote is a dry run",
    );
    expect(fail({ nowMs: Date.parse("2026-11-05T18:24:00.000Z") })).toContain(
      "quote deadline is shorter than the chain minimum",
    );
    const { deadline: _x, ...noDeadline } = live.quote;
    expect(fail({ response: { ...live, quote: noDeadline } })).toContain("quote has no deadline");
    expect(fail({ response: { ...live, quote: { ...live.quote, minAmountIn: "9999999999" } } })).toContain(
      "minAmountIn exceeds amountIn",
    );
    expect(fail({ response: { ...live, quote: { ...live.quote, amountIn: "0", minAmountIn: "0" } } })).toContain(
      "amountIn is zero",
    );
  });
});
