/**
 * Contract (foundations §16): every Stage-1 rails route is bound (and nothing else); every subject the
 * catalogue routes to rails is handled; every subject rails produces is emitted; the 1Click wire
 * schemas parse the recorded responses (schema parity with the sandbox, sandbox LLD §7).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_ROUTES } from "@nearpay/spec";
import { unhandledSubjects } from "@nearpay-internal/bus";
import { unimplementedRoutes } from "@nearpay-internal/service";
import {
  INTERNAL_ROUTES,
  OneClickQuoteRequest,
  OneClickQuoteResponse,
  SUBJECTS,
  type Subject,
} from "@nearpay-internal/spec";
import { describe, expect, it } from "vitest";
import { railsRoutes } from "../../src/api/routes.js";
import { subjectFor } from "../../src/app/ledger.js";
import { railsHandlers } from "../../src/consumers/handlers.js";
import { fixture } from "../support/fakes.js";

const ALL = [...PUBLIC_ROUTES, ...INTERNAL_ROUTES];

describe("routes and events", () => {
  it("binds every Stage-1 rails route, and nothing else", () => {
    const bindings = railsRoutes({ profiles: { all: () => [] } } as never);
    expect(unimplementedRoutes("rails", ALL, bindings).map((r) => r.id)).toEqual([]);
    expect(bindings.map((b) => b.route.id).sort()).toEqual(
      ALL.filter((r) => r.service === "rails" && r.stage <= 1)
        .map((r) => r.id)
        .sort(),
    );
  });

  it("handles every subject the catalogue routes to rails", () => {
    const handlers = railsHandlers({} as never);
    expect(unhandledSubjects("rails", handlers)).toEqual([]);
    for (const subject of Object.keys(handlers) as Subject[]) expect(SUBJECTS[subject].consumers).toContain("rails");
  });

  it("emits every subject rails produces", () => {
    const produced = (Object.keys(SUBJECTS) as Subject[]).filter(
      (k) => SUBJECTS[k].producer === "rails" && SUBJECTS[k].stage <= 1,
    );
    const emitted = new Set(
      (["awaiting_deposit", "succeeded", "refunded", "failed", "held", "settling"] as const).map((to) =>
        subjectFor("verifying", to),
      ),
    );
    expect([...emitted].sort()).toEqual([...produced].sort());
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
    const src = files(new URL("../../src", import.meta.url).pathname)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    for (const s of produced) expect(src).toContain(s);
  });
});

describe("1Click wire schemas", () => {
  it("parse the recorded quote and request", () => {
    expect(OneClickQuoteResponse.safeParse(fixture("oneclick/dry-quote.json")).success).toBe(true);
    expect(OneClickQuoteRequest.safeParse(fixture("oneclick/dry-quote.request.json")).success).toBe(true);
  });
});
