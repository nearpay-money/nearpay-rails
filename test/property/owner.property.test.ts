/**
 * Stage 3 properties (lld/rails.md §20, spec 0.3.0):
 * - Ownership: whatever the request says, a created execution's owner is the calling service; agentpay never
 *   reads or writes a payments execution it does not relay, and nobody but the owner writes.
 * - Evidence comparison with senders: the settled amount is unchanged by sender information (INV-2 money), and
 *   the named sender is one of the counted transfers' senders (never a transfer to someone else).
 */
import { maxOf } from "@nearpay-internal/money";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Caller,
  decideCreateOwner,
  listOwnerFilter,
  mayRead,
  mayWrite,
  relayable,
} from "../../src/domain/execution/owner.js";
import { compareTransfers } from "../../src/domain/verification/verification.js";

const caller: fc.Arbitrary<Caller> = fc.oneof(
  fc
    .constantFrom("payments", "agentpay", "billing", "sentinel", "identity", "")
    .map((service) => (service ? ({ kind: "service", service } as Caller) : ({ kind: "other" } as Caller))),
  fc.constant({ kind: "ops" } as Caller),
);
const binding = fc.constantFrom("np1:aaa", "np1:bbb");
const asset = fc.constantFrom("nep141:usdc.near", "nep141:wrap.near");
const body = fc.record({
  owner: fc.option(fc.constantFrom("payments", "agentpay", "billing"), { nil: undefined }),
  x402_binding: fc.option(binding, { nil: undefined }),
  idempotency_key: fc.oneof(
    binding.map((b) => `x402:${b}`),
    fc.constant("attempt:pa_1"),
  ),
  method: fc.constantFrom("route_quote", "intents_transfer"),
  reference: fc.option(fc.constant({ payment_intent: "pi_1" }), { nil: undefined }),
  destination: fc.record({ type: fc.constantFrom("intents_account", "chain_address"), asset_id: asset }),
  pricing: fc.oneof(
    fc.record({ currency: fc.constant("asset"), asset_id: asset }),
    fc.record({ currency: fc.constant("usd") }),
  ),
  fee: fc.record({ bearer: fc.constantFrom("payer", "merchant") }),
});
const row = fc.record({
  owner: fc.constantFrom("payments", "agentpay", "billing"),
  kind: fc.constantFrom("payment", "refund"),
  method: fc.constantFrom("route_quote", "intents_transfer"),
  refund: fc.option(fc.record({ transfer: fc.option(fc.constant({ memo: "np1:x" }), { nil: null }) }), { nil: null }),
});

describe("ownership (property)", () => {
  it("a created execution is owned by the calling service, with the x402 shape iff agentpay", () => {
    fc.assert(
      fc.property(caller, body, (c, b) => {
        const d = decideCreateOwner(c, b);
        if (!("ok" in d)) return;
        expect(c.kind).toBe("service");
        expect(d.owner).toBe(c.kind === "service" ? c.service : "never");
        expect(d.owner).toBe(b.owner ?? "payments");
        if (d.owner === "agentpay") {
          expect(b.idempotency_key).toBe(`x402:${b.x402_binding}`);
          expect(b.destination.type).toBe("intents_account");
          expect(b.method).toBe("route_quote");
          expect(b.fee.bearer).toBe("payer");
          expect(b.reference).toBeUndefined();
          expect(b.pricing).toEqual({ currency: "asset", asset_id: b.destination.asset_id });
        } else {
          expect(b.x402_binding).toBeUndefined();
          expect(b.idempotency_key.startsWith("x402:")).toBe(false);
        }
      }),
    );
  });

  it("agentpay never sees a payments execution it does not relay; only the owner writes", () => {
    fc.assert(
      fc.property(caller, row, (c, r) => {
        const agentpay = c.kind === "service" && c.service === "agentpay";
        if (agentpay && mayRead(c, r)) expect(r.owner === "agentpay" || relayable(r)).toBe(true);
        if (!agentpay) expect(mayRead(c, r)).toBe(true);
        if (mayWrite(c, r)) expect(c.kind === "service" && c.service === r.owner).toBe(true);
        const f = listOwnerFilter(c, undefined);
        if (agentpay) expect(f).toEqual({ ok: true, owner: "agentpay" });
      }),
    );
  });
});

const transfer = fc.record({
  to: fc.constantFrom("m.near", "other.near"),
  from: fc.option(fc.constantFrom("solver-a.near", "solver-b.near", "payer.near"), { nil: null }),
  assetId: asset,
  amount: fc.bigInt({ min: 0n, max: 10n ** 24n }),
});

describe("evidence senders (property)", () => {
  it("the amount ignores senders; the sender is one of the counted transfers'", () => {
    fc.assert(
      fc.property(fc.array(transfer, { maxLength: 8 }), fc.bigInt({ min: 1n, max: 10n ** 24n }), (ts, expected) => {
        const expect_ = { recipient: "m.near", assetId: "nep141:usdc.near", expected };
        const withSenders = compareTransfers(ts, expect_);
        const anonymous = compareTransfers(
          ts.map(({ from: _from, ...t }) => t),
          expect_,
        );
        expect(withSenders.amount).toBe(anonymous.amount);
        expect(withSenders.result).toBe(anonymous.result);
        expect(anonymous.sender).toBeNull();
        const counted = ts.filter((t) => t.to === "m.near" && t.assetId === "nep141:usdc.near" && t.amount > 0n);
        if (withSenders.sender !== null) {
          expect(counted.map((t) => t.from)).toContain(withSenders.sender);
          const max = counted.reduce((m, t) => maxOf(m, t.amount), 0n);
          expect(counted.find((t) => t.amount === max)?.from).toBe(withSenders.sender);
        }
        if (withSenders.result === "mismatch") expect(withSenders.sender).toBeNull();
      }),
    );
  });
});
