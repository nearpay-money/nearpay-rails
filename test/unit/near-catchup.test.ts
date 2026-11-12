import { describe, expect, it } from "vitest";
import { fetchInOrder } from "../../src/trackers/near-indexer/indexer.js";

describe("fetchInOrder (NEAR indexer catch-up, RAILS-3)", () => {
  it("keeps at most `concurrency` fetches in flight and yields strictly in order", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetch = async (h: number) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // later heights answer first: the order must still hold
      await new Promise((r) => setTimeout(r, (100 - (h % 100)) % 7));
      inFlight--;
      return `b${h}`;
    };
    const heights = Array.from({ length: 50 }, (_, i) => 1000 + i);
    const out: number[] = [];
    for await (const [h, v] of fetchInOrder(heights, fetch, 8)) {
      expect(v).toBe(`b${h}`);
      out.push(h);
    }
    expect(out).toEqual(heights);
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1);
  });

  it("concurrency 1 is sequential; a failure stops at the failed height; stopping early leaks no rejection", async () => {
    let peak = 0;
    let inFlight = 0;
    const seq: number[] = [];
    for await (const [h] of fetchInOrder(
      [1, 2, 3],
      async (h) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight--;
        return h;
      },
      1,
    ))
      seq.push(h);
    expect(seq).toEqual([1, 2, 3]);
    expect(peak).toBe(1);

    const applied: number[] = [];
    const failing = async (h: number) => {
      if (h === 3 || h === 5) throw new Error(`block ${h} unavailable`);
      return h;
    };
    await expect(
      (async () => {
        for await (const [h] of fetchInOrder([1, 2, 3, 4, 5], failing, 4)) applied.push(h);
      })(),
    ).rejects.toThrow("block 3 unavailable");
    expect(applied).toEqual([1, 2]);
    // break out early while later fetches (5 rejects) are still pending
    for await (const [h] of fetchInOrder([1, 2, 4, 5], failing, 4)) if (h === 2) break;
    await new Promise((r) => setTimeout(r, 5));
  });
});
