import { describe, expect, it } from "vitest";
import { assertFeedsPool, FEEDS_POOL_MAX, FEEDS_QUERY_HEADROOM } from "../../src/app/services.js";

// step 2.4: ten leader-elected loops held kit's default pool of 10 and every feed query hung
describe("feeds pool sizing", () => {
  it("leaves query headroom next to the connections leaders hold", () => {
    expect(() => assertFeedsPool(12, FEEDS_POOL_MAX)).not.toThrow();
    expect(() => assertFeedsPool(FEEDS_POOL_MAX - FEEDS_QUERY_HEADROOM, FEEDS_POOL_MAX)).not.toThrow();
    expect(() => assertFeedsPool(FEEDS_POOL_MAX - FEEDS_QUERY_HEADROOM + 1, FEEDS_POOL_MAX)).toThrow(/pool max/);
    expect(() => assertFeedsPool(10, 10)).toThrow(/at least 18/);
  });
  it("does not judge an injected database (tests size their own pool)", () => {
    expect(() => assertFeedsPool(100, null)).not.toThrow();
  });
});
