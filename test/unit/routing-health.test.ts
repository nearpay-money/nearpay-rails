import { HttpError, TimeoutError } from "@nearpay-internal/http";
import { describe, expect, it } from "vitest";
import type { Rails } from "../../src/app/context.js";
import { explainHealth, logTransition, type ModeAlertState } from "../../src/app/routing-health.js";
import { monitoredRefresh } from "../../src/app/tokens.js";
import { DEFAULT_POLICY, type FxObs, type PricedToken, type PricingPolicy } from "../../src/domain/pricing/pricing.js";
import { parseExactDecimal } from "../../src/domain/pricing/ratio.js";
import {
  optionReason,
  PRICE_REASONS,
  REASON_FIX,
  REASON_TEXT,
  ROUTING_REASONS,
  type RoutingInputs,
  routingHealth,
  settlementCheck,
} from "../../src/domain/routing/health.js";
import { alertLimiter, errorClass } from "../../src/infra/clients/error-class.js";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const ago = (s: number) => new Date(NOW - s * 1000);
const obs = (v: string, ageS = 10, source = "oneclick") => ({
  value: parseExactDecimal(v),
  asOf: ago(ageS),
  fetchedAt: ago(ageS),
  source,
});
const eur: FxObs = {
  currency: "eur",
  value: parseExactDecimal("1.08"),
  source: "ecb",
  referenceDate: "2026-11-11",
  asOf: ago(3600),
  fetchedAt: ago(60),
  validUntil: new Date(NOW + 3_600_000),
};
const p: PricingPolicy = { ...DEFAULT_POLICY, nowMs: NOW, fx: (c) => (c === "eur" ? eur : undefined) };
const token = (over: Partial<PricedToken> = {}): PricedToken => ({
  asset_id: "nep141:usdc",
  decimals: 6,
  peg_currency: "usd",
  primary: obs("0.9995"),
  secondary: null,
  ...over,
});

describe("settlementCheck (the unchanged par/dual rule, explained)", () => {
  it("a fresh USD stablecoin at par is settleable", () => {
    expect(settlementCheck(token(), p)).toEqual({ ok: true });
  });
  it("a volatile asset with two fresh agreeing prices is settleable", () => {
    expect(
      settlementCheck(token({ peg_currency: null, primary: obs("2500"), secondary: obs("2501", 30, "cg") }), p),
    ).toEqual({ ok: true });
  });
  it("a stablecoin whose primary price is older than 300 s is stale", () => {
    expect(settlementCheck(token({ primary: obs("1", 301) }), p)).toEqual({
      ok: false,
      reason: "settlement_price_stale",
    });
  });
  it("a stablecoin without a primary price is missing", () => {
    expect(settlementCheck(token({ primary: null }), p)).toEqual({ ok: false, reason: "settlement_price_missing" });
  });
  it("a stablecoin off its peg is a depeg (no dual-source rescue without a secondary)", () => {
    expect(settlementCheck(token({ primary: obs("0.95") }), p)).toEqual({
      ok: false,
      reason: "settlement_price_depeg",
    });
  });
  it("a stablecoin of a currency without a usable FX rate is fx_unavailable", () => {
    expect(settlementCheck(token({ peg_currency: "chf", primary: obs("1.13") }), p)).toEqual({
      ok: false,
      reason: "fx_unavailable",
    });
  });
  it("a volatile asset: missing secondary, stale, disagreeing", () => {
    const vol = (o: Partial<PricedToken>) => settlementCheck(token({ peg_currency: null, ...o }), p);
    expect(vol({ primary: obs("2500") })).toEqual({ ok: false, reason: "settlement_price_missing" });
    expect(vol({ primary: obs("2500", 121), secondary: obs("2500", 10, "cg") })).toEqual({
      ok: false,
      reason: "settlement_price_stale",
    });
    expect(vol({ primary: obs("2500"), secondary: obs("2600", 10, "cg") })).toEqual({
      ok: false,
      reason: "settlement_price_disagree",
    });
  });
});

const healthy: RoutingInputs = {
  livemode: true,
  killSwitch: "released",
  treasurySet: true,
  crossChainEnabled: true,
  settlement: [{ asset_id: "nep141:usdc", check: { ok: true } }],
  registry: { refreshedAt: ago(20), maxAgeMs: 90_000 },
  nowMs: NOW,
};
const h = (over: Partial<RoutingInputs>) => routingHealth({ ...healthy, ...over });

describe("routingHealth", () => {
  it("available with no reasons when everything is in order", () => {
    expect(h({})).toEqual({
      livemode: true,
      available: true,
      reasons: [],
      warnings: [],
      settlement: [],
      registryAgeS: 20,
    });
  });
  it.each([
    [{ killSwitch: "engaged" as const }, "kill_switch_engaged"],
    [{ killSwitch: "unknown" as const }, "kill_switch_unknown"],
    [{ treasurySet: false }, "treasury_unset"],
    [{ crossChainEnabled: false }, "cross_chain_paused"],
    [
      { settlement: [{ asset_id: "a", check: { ok: false, reason: "settlement_price_stale" } as const }] },
      "settlement_price_stale",
    ],
    [
      { settlement: [{ asset_id: "a", check: { ok: false, reason: "settlement_price_depeg" } as const }] },
      "settlement_price_depeg",
    ],
    [
      { settlement: [{ asset_id: "a", check: { ok: false, reason: "settlement_price_missing" } as const }] },
      "settlement_price_missing",
    ],
    [{ settlement: [{ asset_id: "a", check: { ok: false, reason: "fx_unavailable" } as const }] }, "fx_unavailable"],
  ])("%o blocks with %s", (over, reason) => {
    const x = h(over);
    expect(x.available).toBe(false);
    expect(x.reasons).toEqual([reason]);
  });
  it("test mode ignores the kill switch and the live treasury", () => {
    expect(h({ livemode: false, killSwitch: "unknown", treasurySet: false }).available).toBe(true);
    expect(h({ livemode: false, crossChainEnabled: false }).reasons).toEqual(["cross_chain_paused"]);
  });
  it("reasons come in priority order, unique; failing assets are listed", () => {
    const x = h({
      settlement: [
        { asset_id: "b", check: { ok: false, reason: "settlement_price_stale" } },
        { asset_id: "c", check: { ok: false, reason: "settlement_price_stale" } },
        { asset_id: "d", check: { ok: true } },
      ],
      crossChainEnabled: false,
      treasurySet: false,
      killSwitch: "engaged",
    });
    expect(x.reasons).toEqual([
      "kill_switch_engaged",
      "treasury_unset",
      "cross_chain_paused",
      "settlement_price_stale",
    ]);
    expect(x.settlement.map((s) => s.asset_id)).toEqual(["b", "c"]);
  });
  it("token_registry_stale is a warning (registry older than its bound, or never refreshed); not checked → null", () => {
    const stale = h({ registry: { refreshedAt: ago(91), maxAgeMs: 90_000 } });
    expect([stale.available, stale.warnings, stale.registryAgeS]).toEqual([true, ["token_registry_stale"], 91]);
    const never = h({ registry: { refreshedAt: null, maxAgeMs: 90_000 } });
    expect([never.warnings, never.registryAgeS]).toEqual([["token_registry_stale"], Number.POSITIVE_INFINITY]);
    expect(h({ registry: null }).registryAgeS).toBeNull();
  });
  it("optionReason: the first reason; Intents transfers ignore cross_chain_paused (RB-01)", () => {
    const paused = h({ crossChainEnabled: false });
    expect(optionReason(paused, "route_quote")).toBe("cross_chain_paused");
    expect(optionReason(paused, "intents_transfer")).toBeNull();
    const both = h({
      crossChainEnabled: false,
      settlement: [{ asset_id: "a", check: { ok: false, reason: "fx_unavailable" } }],
    });
    expect(optionReason(both, "intents_transfer")).toBe("fx_unavailable");
    expect(optionReason(h({}), "route_quote")).toBeNull();
  });
  it("every code has a sentence and a fix; price codes are the settlement ones", () => {
    for (const r of ROUTING_REASONS) {
      expect(REASON_TEXT[r]).toBeTruthy();
      expect(REASON_FIX[r]).toBeTruthy();
    }
    expect([...PRICE_REASONS].every((r) => r.startsWith("settlement_price_") || r === "fx_unavailable")).toBe(true);
  });
});

function fakeLog() {
  const lines: { level: string; fields: Record<string, unknown>; msg: string }[] = [];
  const at = (level: string) => (fields: Record<string, unknown>, msg: string) => lines.push({ level, fields, msg });
  return { lines, log: { warn: at("warn"), info: at("info"), error: at("error"), debug: at("debug") } };
}

describe("logTransition (ALERT routing_blocked, rate-limited)", () => {
  const opts = { quiet: false, remindMs: 900_000, minLogMs: 60_000 };
  it("alerts on the flip, stays quiet while unchanged, re-alerts on a change (≥ 60 s) and reminds; INFO on recovery", () => {
    let now = NOW;
    const { lines, log } = fakeLog();
    const r = { log, now: () => now } as unknown as Pick<Rails, "log" | "now">;
    const st: ModeAlertState = { available: null, key: "", loggedAt: null };
    logTransition(r, st, h({}), opts);
    expect(lines).toEqual([]);
    logTransition(r, st, h({ killSwitch: "unknown" }), opts);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("warn");
    expect(lines[0]?.msg).toMatch(/^ALERT routing_blocked: live payments cannot route \(kill_switch_unknown\)/);
    expect(lines[0]?.fields.reasons).toEqual(["kill_switch_unknown"]);
    now += 15_000;
    logTransition(r, st, h({ killSwitch: "unknown" }), opts);
    logTransition(r, st, h({ killSwitch: "unknown", treasurySet: false }), opts); // changed, but < 60 s
    expect(lines).toHaveLength(1);
    now += 60_000;
    logTransition(r, st, h({ killSwitch: "unknown", treasurySet: false }), opts); // the change, now logged
    expect(lines).toHaveLength(2);
    now += 900_000;
    logTransition(r, st, h({ killSwitch: "unknown", treasurySet: false }), opts); // reminder
    expect(lines).toHaveLength(3);
    logTransition(r, st, h({}), opts);
    expect(lines[3]).toMatchObject({ level: "info", msg: "live payments route again" });
    logTransition(r, st, h({}), opts);
    expect(lines).toHaveLength(4);
  });
  it("boot grace: nothing is logged or committed; a block that lasts past it alerts as a flip; test mode has no ALERT marker", () => {
    const { lines, log } = fakeLog();
    const r = { log, now: () => NOW } as unknown as Pick<Rails, "log" | "now">;
    const st: ModeAlertState = { available: null, key: "", loggedAt: null };
    logTransition(r, st, h({ killSwitch: "unknown" }), { ...opts, quiet: true });
    expect([lines.length, st.available]).toEqual([0, null]);
    logTransition(r, st, h({ treasurySet: false }), opts);
    expect(lines[0]?.msg).toMatch(/^ALERT routing_blocked/);
    const t: ModeAlertState = { available: null, key: "", loggedAt: null };
    logTransition(r, t, h({ livemode: false, crossChainEnabled: false }), opts);
    expect(lines[1]?.msg).toMatch(/^routing_blocked: test payments cannot route/);
  });
  it("explainHealth gives text and fix per reason; a never-refreshed registry reads 'never'", () => {
    const x = explainHealth(h({ treasurySet: false, registry: { refreshedAt: null, maxAgeMs: 1 } }));
    expect(x).toMatchObject({
      mode: "live",
      available: false,
      reasons: [{ reason: "treasury_unset", fix: expect.stringContaining("NP_TREASURY_ACCOUNT") }],
      warnings: [{ reason: "token_registry_stale" }],
      token_registry_age_s: "never",
    });
  });
});

describe("errorClass and alertLimiter", () => {
  it("classifies outbound failures", () => {
    expect(errorClass(new HttpError(401, null, null, "sentinel")).class).toBe("auth");
    expect(errorClass(new HttpError(403, null, null, "sentinel")).class).toBe("auth");
    expect(errorClass(new HttpError(407, null, null, "oneclick")).class).toBe("proxy_denied");
    expect(errorClass(new HttpError(503, null, null, "oneclick"))).toMatchObject({ class: "http_503", status: 503 });
    expect(errorClass(new TimeoutError("oneclick", 5000)).class).toBe("timeout");
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    expect(errorClass(refused).class).toBe("network:ECONNREFUSED");
    expect(errorClass(new TypeError("fetch failed")).class).toBe("network");
    expect(errorClass(new SyntaxError("Unexpected token")).class).toBe("malformed");
    expect(errorClass(new Error("oneclick returned no usable tokens")).class).toBe("empty");
    expect(errorClass("boom")).toMatchObject({ class: "error", message: "boom" });
    expect(errorClass(new RangeError("x")).class).toBe("RangeError");
  });
  it("logs the first occurrence, then at most once per interval; reset starts over", () => {
    let now = 0;
    const a = alertLimiter(1000, () => now);
    expect([a.due(), a.due(), a.active, a.count]).toEqual([true, false, true, 2]);
    now = 1000;
    expect(a.due()).toBe(true);
    a.reset();
    expect([a.active, a.due()]).toEqual([false, true]);
  });
});

describe("monitoredRefresh (ALERT token_registry_refresh_failed)", () => {
  it("logs the error class once per interval and never throws", async () => {
    let now = NOW;
    const { lines, log } = fakeLog();
    const r = {
      log,
      now: () => now,
      providers: {
        live: {
          name: "oneclick",
          tokens: async () => {
            throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
          },
        },
        test: null,
      },
    } as unknown as Rails;
    const refresh = monitoredRefresh(r);
    expect(await refresh(true)).toBeNull();
    expect(await refresh(true)).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.msg).toMatch(/^ALERT token_registry_refresh_failed: the live token registry/);
    expect(lines[0]?.fields).toMatchObject({
      livemode: true,
      error_class: "network:ENOTFOUND",
      consecutive_failures: 1,
    });
    now += 5 * 60_000;
    await refresh(true);
    expect(lines[1]?.fields.consecutive_failures).toBe(3);
  });
});
