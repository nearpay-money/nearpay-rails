/** Stage 1 ops CLI (src/ops/cli.ts) against the real database and sandbox. */
import { Execution } from "@nearpay-internal/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runOps } from "../../src/ops/cli.js";
import { routeQuote } from "../support/requests.js";
import { type Stack, startStack } from "../support/stack.js";

let s: Stack;
beforeAll(async () => {
  s = await startStack({ sandbox: true });
});
afterAll(async () => {
  await s?.stop();
});

async function ops(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runOps(argv, s.rails, { actor: "test", out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, json: out.length ? JSON.parse(out.join("\n")) : null, err: err.join("\n") };
}

describe("ops CLI", () => {
  it("tokens-refresh loads the test registry from the sandbox", async () => {
    const r = await ops("tokens-refresh", "test");
    expect(r.code).toBe(0);
    expect(r.json.tokens).toBeGreaterThan(10);
  });

  it("execution-show by id or deposit address", async () => {
    const created = await s.call("POST", "/internal/executions", { body: routeQuote() });
    const x = Execution.parse(created.body);
    const byId = await ops("execution-show", x.id);
    expect(byId.code).toBe(0);
    expect(byId.json.execution.id).toBe(x.id);
    expect(byId.json.transitions).toEqual([
      expect.objectContaining({ from: null, to: "awaiting_deposit", actor: "api" }),
    ]);
    expect(byId.json.observations).toEqual([expect.objectContaining({ source: "quote", applied: true })]);
    const byAddress = await ops("execution-show", x.deposit?.address as string);
    expect(byAddress.json.execution.id).toBe(x.id);
    const missing = await ops("execution-show", "ex_01jbz9k3m4n5p6q7r8s9t0v1w2");
    expect([missing.code, JSON.parse(missing.err).error.code]).toEqual([1, "resource_missing"]);
  });

  it("flag-set pauses cross-chain routes (RB-01) with a reason; flags lists them", async () => {
    expect((await ops("flag-set", "cross_chain_enabled", "false", "provider", "incident")).code).toBe(0);
    const flags = (await ops("flags")).json as { name: string; value: boolean; reason: string }[];
    expect(flags.find((f) => f.name === "cross_chain_enabled")).toMatchObject({
      value: false,
      reason: "test: provider incident",
    });
    const r = await s.call("POST", "/internal/executions", { body: routeQuote() });
    expect(r.status).toBe(503);
    expect((await ops("flag-set", "cross_chain_enabled", "true", "resolved")).code).toBe(0);
  });

  it("refuses bad usage", async () => {
    expect((await ops()).code).toBe(2);
    expect((await ops("nope")).code).toBe(2);
    expect((await ops("flag-set", "explorer_enabled", "true", "x")).code).toBe(2);
    expect((await ops("flag-set", "quoting_enabled", "yes", "x")).code).toBe(2);
    expect((await ops("flag-set", "quoting_enabled", "true")).code).toBe(2);
    expect((await ops("tokens-refresh", "both")).code).toBe(2);
    expect((await ops("execution-show")).code).toBe(2);
    expect((await ops("minimums-refresh")).json).toEqual({ written: 0 });
  });
});
