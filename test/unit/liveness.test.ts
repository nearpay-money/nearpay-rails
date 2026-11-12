import type { BackgroundTask } from "@nearpay-internal/service";
import { describe, expect, it } from "vitest";
import type { Rails } from "../../src/app/context.js";
import { killSwitchSyncTask } from "../../src/app/kill-switch.js";
import { runOps } from "../../src/ops/cli.js";
import { POLLER_MAX_SILENCE_MS, pollerTask } from "../../src/trackers/hot-poller/poller.js";
import { FINALITY_RECHECK_MAX_SILENCE_MS, finalityRecheckTask } from "../../src/verifiers/finality-recheck.js";
import { VERIFIER_MAX_SILENCE_MS, verifierTask } from "../../src/verifiers/verifier.js";

// a Rails without a database: every tick fails, which must still beat (an outage is readiness, not liveness)
const quiet = { error() {}, warn() {}, info() {} };
const r = { log: quiet, now: () => Date.now() } as unknown as Rails;
const readers = { evm: new Map(), near: null, solana: null, esplora: null } as never;

async function beatsOf(task: BackgroundTask): Promise<number> {
  let beats = 0;
  const running = await task.start({ beat: () => void beats++, idle: () => {} });
  await new Promise((res) => setTimeout(res, 60));
  await running.stop();
  return beats;
}

describe("kit 0.6.0 liveness (KIT-4): rails' own loops declare budgets and beat per tick", () => {
  it("hot poller", async () => {
    const t = pollerTask(r, { tickMs: 5 });
    expect(t.maxSilenceMs).toBe(POLLER_MAX_SILENCE_MS);
    // failed ticks back off 2 s, so one beat is all a 60 ms window sees
    expect(await beatsOf(t)).toBeGreaterThanOrEqual(1);
  });
  it("verifier", async () => {
    const t = verifierTask(r, readers, { tickMs: 5 });
    expect(t.maxSilenceMs).toBe(VERIFIER_MAX_SILENCE_MS);
    expect(await beatsOf(t)).toBeGreaterThan(1);
  });
  it("finality re-check", async () => {
    const t = finalityRecheckTask(r, readers, { tickMs: 5 });
    expect(t.maxSilenceMs).toBe(FINALITY_RECHECK_MAX_SILENCE_MS);
    expect(await beatsOf(t)).toBeGreaterThan(1);
  });
  it("kill-switch sync", async () => {
    const t = killSwitchSyncTask(r, { tickMs: 5 });
    expect(t.maxSilenceMs).toBe(120_000);
    expect(await beatsOf(t)).toBeGreaterThan(0);
  });
  it("tasks still start without a heartbeat (budgets opted out by the host)", async () => {
    const running = await pollerTask(r, { tickMs: 5 }).start();
    await running.stop();
  });
});

describe("ops CLI: dead-letters / outbox (kit runKitOps)", () => {
  it("routes to the kit and prints its usage on a bad sub-command", async () => {
    const errs: string[] = [];
    const db = {} as Rails["db"];
    const deps = { actor: "test", err: (l: string) => errs.push(l), out: () => {} };
    expect(await runOps(["dead-letters"], { db } as Rails, deps)).toBe(2);
    expect(await runOps(["outbox", "skip", "x"], { db } as Rails, deps)).toBe(2);
    expect(errs.join("\n")).toContain("outbox skip <id> --note <reason>");
  });
});
