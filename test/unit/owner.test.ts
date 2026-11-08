/** Execution ownership (lld/rails.md §20, spec 0.3.0): caller identity decides, every rule fails closed. */
import { describe, expect, it } from "vitest";
import {
  type Caller,
  type CreateShape,
  callerOf,
  decideCreateOwner,
  listOwnerFilter,
  mayManageRefundLegs,
  mayRead,
  mayWrite,
  relayable,
} from "../../src/domain/execution/owner.js";
import { erc20Transfers, TRANSFER_TOPIC } from "../../src/infra/clients/evm.js";

const svc = (service: string): Caller => ({ kind: "service", service });
const PAYMENTS = svc("payments");
const AGENTPAY = svc("agentpay");
const BINDING = "np1:4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

const paymentsBody = (over: Partial<CreateShape> = {}): CreateShape => ({
  idempotency_key: "attempt:pa_1",
  method: "route_quote",
  destination: { type: "chain_address", asset_id: USDC },
  pricing: { currency: "usd" },
  fee: { bearer: "merchant" },
  reference: { payment_intent: "pi_1", payment_attempt: "pa_1" },
  ...over,
});

const x402Body = (over: Partial<CreateShape> = {}): CreateShape => ({
  owner: "agentpay",
  x402_binding: BINDING,
  idempotency_key: `x402:${BINDING}`,
  method: "route_quote",
  destination: { type: "intents_account", asset_id: USDC },
  pricing: { currency: "asset", asset_id: USDC },
  fee: { bearer: "payer" },
  ...over,
});

describe("callerOf", () => {
  it("reads service identity only from service tokens", () => {
    expect(callerOf({ ptype: "service", sub: "agentpay" })).toEqual(AGENTPAY);
    expect(callerOf({ ptype: "ops", sub: "usr_1" })).toEqual({ kind: "ops" });
    expect(callerOf({ ptype: "secret_key", sub: "agentpay" })).toEqual({ kind: "other" });
    expect(callerOf({ ptype: "service", sub: "" })).toEqual({ kind: "other" });
    expect(callerOf(null)).toEqual({ kind: "other" });
  });
});

describe("decideCreateOwner", () => {
  it("payments creates payments executions; owner omitted means payments", () => {
    expect(decideCreateOwner(PAYMENTS, paymentsBody())).toEqual({ ok: true, owner: "payments" });
    expect(decideCreateOwner(PAYMENTS, paymentsBody({ owner: "payments" }))).toEqual({ ok: true, owner: "payments" });
  });

  it("agentpay creates agentpay executions of the x402 shape", () => {
    expect(decideCreateOwner(AGENTPAY, x402Body())).toEqual({ ok: true, owner: "agentpay" });
  });

  it("the owner must be the calling service (fail closed)", () => {
    expect(decideCreateOwner(AGENTPAY, paymentsBody())).toMatchObject({ kind: "forbidden" });
    expect(decideCreateOwner(AGENTPAY, x402Body({ owner: undefined }))).toMatchObject({ kind: "forbidden" });
    expect(decideCreateOwner(PAYMENTS, x402Body())).toMatchObject({ kind: "forbidden" });
    expect(decideCreateOwner(svc("billing"), paymentsBody())).toMatchObject({ kind: "forbidden" });
    expect(decideCreateOwner({ kind: "ops" }, paymentsBody())).toMatchObject({ kind: "forbidden" });
    expect(decideCreateOwner({ kind: "other" }, paymentsBody())).toMatchObject({ kind: "forbidden" });
    expect(decideCreateOwner(PAYMENTS, paymentsBody({ owner: "billing" }))).toMatchObject({
      kind: "invalid",
      param: "owner",
    });
  });

  it("payments may not use the x402 fields or key namespace", () => {
    expect(decideCreateOwner(PAYMENTS, paymentsBody({ x402_binding: BINDING }))).toMatchObject({
      param: "x402_binding",
    });
    expect(decideCreateOwner(PAYMENTS, paymentsBody({ idempotency_key: `x402:${BINDING}` }))).toMatchObject({
      param: "idempotency_key",
    });
  });

  it("an agentpay execution has exactly the agentpay §3.1 shape", () => {
    const refused = (over: Partial<CreateShape>, param: string) =>
      expect(decideCreateOwner(AGENTPAY, x402Body(over))).toMatchObject({ kind: "invalid", param });
    refused({ x402_binding: undefined }, "x402_binding");
    refused({ idempotency_key: "attempt:pa_1" }, "idempotency_key");
    refused({ idempotency_key: `x402:${BINDING}x` }, "idempotency_key");
    refused({ reference: { payment_intent: "pi_1", payment_attempt: "pa_1" } }, "reference");
    refused({ method: "intents_transfer" }, "method");
    refused({ destination: { type: "chain_address", asset_id: USDC } }, "destination.type");
    refused({ pricing: { currency: "usd" } }, "pricing");
    refused({ pricing: { currency: "asset", asset_id: "nep141:wrap.near" } }, "pricing");
    refused({ fee: { bearer: "merchant" } }, "fee.bearer");
  });
});

describe("reads and writes", () => {
  const row = (
    owner: string,
    kind = "payment",
    method = "route_quote",
    refund: { transfer?: unknown } | null = null,
  ) => ({
    owner,
    kind,
    method,
    refund,
  });

  it("agentpay reads its own executions and the payments executions it relays, nothing else", () => {
    expect(mayRead(AGENTPAY, row("agentpay"))).toBe(true);
    expect(mayRead(AGENTPAY, row("payments", "payment", "intents_transfer"))).toBe(true);
    expect(mayRead(AGENTPAY, row("payments", "refund", "intents_transfer", { transfer: {} }))).toBe(true);
    expect(mayRead(AGENTPAY, row("payments", "refund", "route_quote", { transfer: { memo: "np1:x" } }))).toBe(true);
    expect(mayRead(AGENTPAY, row("payments"))).toBe(false);
    expect(mayRead(AGENTPAY, row("payments", "refund", "route_quote", { transfer: null }))).toBe(false);
    expect(mayRead(AGENTPAY, row("payments", "refund", "route_quote", null))).toBe(false);
    expect(mayRead(AGENTPAY, row("billing"))).toBe(false);
    expect(relayable(row("agentpay", "payment", "intents_transfer"))).toBe(false);
  });

  it("other services and operators read every execution", () => {
    for (const c of [PAYMENTS, svc("sentinel"), svc("billing"), { kind: "ops" } as Caller]) {
      expect(mayRead(c, row("payments"))).toBe(true);
      expect(mayRead(c, row("agentpay"))).toBe(true);
    }
  });

  it("only the owner writes (deposit_tx, signals)", () => {
    expect(mayWrite(AGENTPAY, row("agentpay"))).toBe(true);
    expect(mayWrite(PAYMENTS, row("payments"))).toBe(true);
    expect(mayWrite(AGENTPAY, row("payments"))).toBe(false);
    expect(mayWrite(PAYMENTS, row("agentpay"))).toBe(false);
    expect(mayWrite({ kind: "ops" }, row("payments"))).toBe(false);
    expect(mayWrite(svc("billing"), row("billing"))).toBe(false);
  });

  it("refund legs are payments' alone", () => {
    expect(mayManageRefundLegs(PAYMENTS)).toBe(true);
    expect(mayManageRefundLegs(AGENTPAY)).toBe(false);
    expect(mayManageRefundLegs({ kind: "ops" })).toBe(false);
  });

  it("list reads: agentpay is narrowed to its own executions; others get the filter they ask for", () => {
    expect(listOwnerFilter(AGENTPAY, undefined)).toEqual({ ok: true, owner: "agentpay" });
    expect(listOwnerFilter(AGENTPAY, "agentpay")).toEqual({ ok: true, owner: "agentpay" });
    expect(listOwnerFilter(AGENTPAY, "payments")).toMatchObject({ kind: "forbidden" });
    expect(listOwnerFilter(PAYMENTS, "payments")).toEqual({ ok: true, owner: "payments" });
    expect(listOwnerFilter(PAYMENTS, undefined)).toEqual({ ok: true, owner: undefined });
    expect(listOwnerFilter({ kind: "ops" }, "agentpay")).toEqual({ ok: true, owner: "agentpay" });
    expect(listOwnerFilter(PAYMENTS, "billing")).toMatchObject({ kind: "invalid", param: "owner" });
  });
});

describe("ERC-20 Transfer logs name the sender", () => {
  it("from = topic 1", () => {
    const topic = (a: string) => `0x${a.replace(/^0x/, "").padStart(64, "0")}`;
    const [t] = erc20Transfers([
      {
        address: "0xA0B8",
        topics: [TRANSFER_TOPIC, topic("0xAbC0000000000000000000000000000000000001"), topic("0x02")],
        data: "0x64",
        blockNumber: "0x1",
        blockHash: "0xb",
        transactionHash: "0xt",
        logIndex: "0x0",
      },
    ]);
    expect(t).toMatchObject({
      token: "0xa0b8",
      from: "0xabc0000000000000000000000000000000000001",
      to: "0x0000000000000000000000000000000000000002",
      amount: 100n,
    });
  });
});
