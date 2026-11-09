import { rational } from "@nearpay-internal/money";
import { describe, expect, it } from "vitest";
import {
  baseAfterBearer,
  binding,
  destinationTagSpace,
  executionDeadline,
  intentsFee,
  parUnitsCeil,
  tagCandidates,
  tagSpace,
} from "../../src/domain/execution/amounts.js";
import { isExpired, nextPollAt } from "../../src/domain/execution/schedule.js";

describe("settlement amounts (domain-model §3)", () => {
  it("merchant bearer nets the fee (rounded down); payer bearer keeps the settlement", () => {
    expect(baseAfterBearer(10_000_000n, 50, "merchant")).toBe(9_950_000n);
    expect(baseAfterBearer(1_999n, 50, "merchant")).toBe(1_989n); // floor(1999 × 0.995)
    expect(baseAfterBearer(10_000_000n, 50, "payer")).toBe(10_000_000n);
  });

  it("intents fee: ceil(amount × bps) with a minimum", () => {
    expect(intentsFee(10_000_000n, 30, 1_000n)).toBe(30_000n);
    expect(intentsFee(1_000n, 30, 1_000n)).toBe(1_000n);
    expect(intentsFee(1_001n, 30, 0n)).toBe(4n); // ceil(3.003)
    expect(parUnitsCeil(1_000n, 6)).toBe(1_000n);
    expect(parUnitsCeil(1n, 2)).toBe(1n);
  });
});

describe("amount tags (§8.3)", () => {
  it("tag space is ≤ USD 0.01 and ≤ 9,999 slots; coarse assets are untagged", () => {
    expect(tagSpace(rational(1n), 6)).toBe(9_999); // USDC: 10,000 → capped
    expect(tagSpace(rational(2500n), 18)).toBe(9_999); // ETH
    expect(tagSpace(rational(80_000n), 8)).toBe(0); // BTC: 12 slots < 100 → untagged
    // BTC at USD 5,000 would give 200 slots, but Bitcoin destinations are never tagged (§21.1)
    expect(tagSpace(rational(5_000n), 8)).toBe(200);
    expect(destinationTagSpace("bitcoin", rational(5_000n), 8)).toBe(0);
    expect(tagSpace(rational(1n), 4)).toBe(100); // exactly 100 slots
    expect(tagSpace(rational(1n), 3)).toBe(0);
    expect(tagSpace(rational(0n), 6)).toBe(0);
  });

  it("candidates are up to 5 distinct draws within 1..T", () => {
    const seq = [0, 0.5, 0.5, 0.999999, 0.25];
    let i = 0;
    const c = tagCandidates(9_999, () => seq[i++ % seq.length] as number);
    expect(c).toEqual([1, 5000, 9999, 2500]);
    expect(tagCandidates(0, Math.random)).toEqual([]);
    for (let k = 0; k < 200; k++)
      for (const t of tagCandidates(100, Math.random)) expect(t >= 1 && t <= 100).toBe(true);
  });
});

describe("deadlines (§8.1 step 7)", () => {
  const profile = { defaultDeadlineS: 1800, minDeadlineS: 300 };
  const now = Date.UTC(2026, 10, 6, 6, 0, 0, 500);

  it("is now + default, capped by the session, in whole seconds", () => {
    expect(executionDeadline(now, null, profile)).toEqual({
      ok: true,
      deadline: new Date(Date.UTC(2026, 10, 6, 6, 30, 0)),
    });
    const cap = new Date(now + 600_000);
    expect(executionDeadline(now, cap, profile)).toEqual({
      ok: true,
      deadline: new Date(Date.UTC(2026, 10, 6, 6, 10, 0)),
    });
  });

  it("refuses a window shorter than the chain minimum", () => {
    expect(executionDeadline(now, new Date(now + 299_000), profile)).toEqual({ ok: false });
    expect(executionDeadline(now, new Date(now - 1), profile)).toEqual({ ok: false });
  });
});

describe("binding (§8.1 intents_transfer)", () => {
  const b = {
    executionId: "0190f000-0000-7000-8000-000000000001",
    payTo: "merchant.near",
    token: "nep141:usdc.near",
    amount: 10_000n,
    feeTo: "treasury.nearpay.near",
    feeAmount: 25n,
    deadline: new Date(Date.UTC(2026, 10, 6, 7, 0, 0)),
  };
  it("is np1 + base58(sha256(JCS(...))), deterministic and sensitive to every field", () => {
    const x = binding(b);
    expect(x).toMatch(/^np1:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(binding({ ...b })).toBe(x);
    for (const over of [
      { amount: 10_001n },
      { feeAmount: 26n },
      { payTo: "evil.near" },
      { feeTo: "x.near" },
      { token: "nep141:usdt.near" },
      { executionId: "0190f000-0000-7000-8000-000000000002" },
      { deadline: new Date(0) },
    ])
      expect(binding({ ...b, ...over })).not.toBe(x);
  });
});

describe("poll schedule (§8.4)", () => {
  const base = {
    state: "deposit_detected" as const,
    hasSignal: true,
    pollCount: 0,
    createdAtMs: 0,
    deadlineMs: 1_800_000,
    nowMs: 60_000,
    explorerEnabled: false,
    awaitingSweepS: 30,
  };
  it("polls fast after a signal: 2, 4, 8, 15, 15 s; 5 min after 2 h", () => {
    expect([0, 1, 2, 3, 9].map((pollCount) => (nextPollAt({ ...base, pollCount }) as number) - base.nowMs)).toEqual([
      2_000, 4_000, 8_000, 15_000, 15_000,
    ]);
    expect((nextPollAt({ ...base, nowMs: 7_300_000 }) as number) - 7_300_000).toBe(300_000);
  });

  it("awaiting without a signal: sweeps every 30 s without Explorer, once at deadline + 10 min with it", () => {
    const a = { ...base, state: "awaiting_deposit" as const, hasSignal: false };
    expect(nextPollAt(a)).toBe(90_000);
    expect(nextPollAt({ ...a, explorerEnabled: true })).toBe(1_800_000 + 600_000);
    expect(nextPollAt({ ...a, nowMs: 2_390_000 })).toBe(2_400_000); // capped at the sweep
    expect(nextPollAt({ ...a, nowMs: 2_500_000 })).toBe(2_560_000);
    expect(nextPollAt({ ...a, hasSignal: true })).toBe(62_000);
  });

  it("verifying and terminal executions are not polled; expired ones until deadline + 24 h; held slowly", () => {
    for (const state of ["verifying", "succeeded", "refunded", "failed", "quoting"] as const)
      expect(nextPollAt({ ...base, state })).toBeNull();
    expect(nextPollAt({ ...base, state: "expired_unpaid" })).toBe(60_000 + 900_000);
    expect(nextPollAt({ ...base, state: "expired_unpaid", nowMs: 1_800_000 + 86_400_000 })).toBeNull();
    expect(nextPollAt({ ...base, state: "held" })).toBe(360_000);
    expect(nextPollAt({ ...base, state: "settling" })).toBe(62_000);
  });

  it("expires an unpaid execution after deadline + 10 min", () => {
    const e = {
      state: "awaiting_deposit" as const,
      depositSeen: false,
      providerStatus: "PENDING_DEPOSIT",
      deadlineMs: 0,
      nowMs: 600_001,
    };
    expect(isExpired(e)).toBe(true);
    expect(isExpired({ ...e, nowMs: 600_000 })).toBe(false);
    expect(isExpired({ ...e, depositSeen: true })).toBe(false);
    expect(isExpired({ ...e, providerStatus: "PROCESSING" })).toBe(false);
    expect(isExpired({ ...e, providerStatus: null })).toBe(true);
    expect(isExpired({ ...e, state: "settling" })).toBe(false);
  });
});

describe("spec 0.2.1 fee helpers", () => {
  it("feeShareOfAmountIn: payer pays bps of amount_in; merchant or fee-free 0; malformed null", async () => {
    const { feeShareOfAmountIn } = await import("../../src/domain/execution/amounts.js");
    expect(feeShareOfAmountIn("1000000", 50, "payer")).toBe(5000n);
    expect(feeShareOfAmountIn("1000001", 50, "payer")).toBe(5001n); // ceil, like payments' estimate
    expect(feeShareOfAmountIn("1000000", 50, "merchant")).toBe(0n);
    expect(feeShareOfAmountIn("1000000", 0, "payer")).toBe(0n);
    expect(feeShareOfAmountIn(null, 50, "payer")).toBeNull();
    expect(feeShareOfAmountIn("1.5", 50, "payer")).toBeNull();
  });

  it("observedRouteFee: total reported bps on the settled amountIn; invalid entries make it unknown", async () => {
    const { observedRouteFee } = await import("../../src/domain/execution/amounts.js");
    expect(observedRouteFee("2000000", [{ fee: 25 }, { fee: 25 }])).toBe(10000n);
    expect(observedRouteFee("2000000", [])).toBe(0n);
    expect(observedRouteFee("2000000", undefined)).toBeNull();
    expect(observedRouteFee(null, [{ fee: 25 }])).toBeNull();
    expect(observedRouteFee("0", [{ fee: 25 }])).toBeNull();
    expect(observedRouteFee("2000000", [{ fee: -1 }])).toBeNull();
    expect(observedRouteFee("2000000", [{ fee: 1.5 }])).toBeNull();
    expect(observedRouteFee("2000000", [{ fee: 6000 }, { fee: 6000 }])).toBeNull();
  });
});

describe("spec 0.2.1 Verifier nonces", () => {
  it("test mode uses the sandbox salt; live reads current_salt once per minute; a bad salt throws", async () => {
    const { verifierNonces, SANDBOX_SALT, SALT_TTL_MS } = await import("../../src/infra/clients/nonces.js");
    let now = 0;
    let reads = 0;
    let salt = "0a0b0c0d";
    const n = verifierNonces({
      rpcUrls: [],
      now: () => now,
      readSalt: async () => {
        reads++;
        return salt;
      },
    });
    const hex = (b64: string) => Buffer.from(b64, "base64").toString("hex");
    const t = await n.fresh(false);
    expect(Buffer.from(t, "base64")).toHaveLength(32);
    expect(hex(t).slice(0, 8)).toBe(SANDBOX_SALT);
    expect(reads).toBe(0);
    const a = await n.fresh(true);
    const b = await n.fresh(true);
    expect(hex(a).slice(0, 8)).toBe("0a0b0c0d");
    expect(a).not.toBe(b);
    expect(reads).toBe(1);
    now = SALT_TTL_MS + 1;
    salt = "nothex!!";
    await expect(n.fresh(true)).rejects.toThrow(/current_salt/);
  });
});
