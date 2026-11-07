import { readFileSync } from "node:fs";
import { rational } from "@nearpay-internal/money";
import { describe, expect, it } from "vitest";
import { crossToUsd, EcbFormatError, ecbQuotes, parseEcbDaily } from "../../src/domain/pricing/ecb.js";
import {
  convertUnits,
  parseExactDecimal,
  parseJsonDecimals,
  ratioFromWire,
  ratioToWire,
  reduce,
  relDiff,
  toDisplayDecimal,
} from "../../src/domain/pricing/ratio.js";
import {
  berlinInstant,
  easterSunday,
  ecbValidity,
  isTargetClosingDay,
  nextTargetWorkingDay,
} from "../../src/domain/pricing/target-calendar.js";
import { parseSimplePrice } from "../../src/providers/prices/coingecko.js";

const fixture = (p: string) => readFileSync(new URL(`../fixtures/${p}`, import.meta.url), "utf8");

describe("exact ratios", () => {
  it("parse decimals and exponent notation exactly; reject anything else", () => {
    expect(parseExactDecimal("1.0823")).toEqual(rational(10823n, 10000n));
    expect(parseExactDecimal("1.2e-7")).toEqual(rational(12n, 100_000_000n));
    expect(parseExactDecimal("1e3")).toEqual(rational(1000n));
    expect(parseExactDecimal("-2.50")).toEqual(rational(-5n, 2n));
    expect(() => parseExactDecimal("0x10")).toThrow(RangeError);
    expect(() => parseExactDecimal("1e999")).toThrow(RangeError);
    expect(() => reduce({ num: 1n, den: 0n })).toThrow(RangeError);
    expect(reduce({ num: 2n, den: -4n })).toEqual({ num: -1n, den: 2n });
  });

  it("wire form round-trips reduced; malformed wire refused", () => {
    expect(ratioToWire(rational(50n, 100n))).toEqual({ num: "1", den: "2" });
    expect(ratioFromWire({ num: "1", den: "2" })).toEqual(rational(1n, 2n));
    expect(() => ratioFromWire({ num: "1", den: "0" })).toThrow(RangeError);
    expect(() => ratioToWire(rational(-1n))).toThrow(RangeError);
  });

  it("display decimals round half-even to 18 places and trim zeros", () => {
    expect(toDisplayDecimal(rational(1n, 3n))).toBe("0.333333333333333333");
    expect(toDisplayDecimal(rational(2n, 3n))).toBe("0.666666666666666667");
    expect(toDisplayDecimal(rational(5n, 2n), 0)).toBe("2");
    expect(toDisplayDecimal(rational(3n, 2n), 0)).toBe("2");
    expect(toDisplayDecimal(rational(108n, 100n))).toBe("1.08");
    expect(toDisplayDecimal(rational(7n))).toBe("7");
    expect(() => toDisplayDecimal(rational(-1n))).toThrow(RangeError);
  });

  it("convertUnits rounds as asked; relDiff is relative to the reference", () => {
    expect(convertUnits(1000n, 2, rational(108n, 100n), 6, "floor")).toBe(10_800_000n);
    expect(convertUnits(1n, 0, rational(1n, 3n), 0, "floor")).toBe(0n);
    expect(convertUnits(1n, 0, rational(1n, 3n), 0, "ceil")).toBe(1n);
    expect(convertUnits(3n, 0, rational(1n, 3n), 0, "ceil")).toBe(1n);
    expect(relDiff(rational(98n), rational(100n))).toEqual(rational(1n, 50n));
  });

  it("JSON numbers keep their source text", () => {
    expect(parseJsonDecimals('{"p":0.1000000000000000055511151231257827,"n":[1e3,2]}')).toEqual({
      p: "0.1000000000000000055511151231257827",
      n: ["1e3", "2"],
    });
  });
});

describe("TARGET calendar and the ECB staleness bound", () => {
  it("Easter by the Gregorian computus", () => {
    expect(easterSunday(2024)).toBe("2024-03-31");
    expect(easterSunday(2025)).toBe("2025-04-20");
    expect(easterSunday(2026)).toBe("2026-04-05");
    expect(easterSunday(2027)).toBe("2027-03-28");
    expect(easterSunday(2038)).toBe("2038-04-25");
  });

  it("closing days: weekends, 1 Jan, Good Friday, Easter Monday, 1 May, 25/26 Dec", () => {
    for (const d of [
      "2026-11-07",
      "2026-11-08",
      "2027-01-01",
      "2026-04-03",
      "2026-04-06",
      "2026-05-01",
      "2026-12-25",
      "2026-12-26",
    ])
      expect(isTargetClosingDay(d)).toBe(true);
    for (const d of ["2026-11-06", "2026-04-02", "2026-04-07", "2026-12-24", "2026-12-31"])
      expect(isTargetClosingDay(d)).toBe(false);
    expect(() => isTargetClosingDay("2026-02-30")).toThrow(RangeError);
    expect(nextTargetWorkingDay("2026-11-06")).toBe("2026-11-09");
    expect(nextTargetWorkingDay("2026-04-02")).toBe("2026-04-07");
    expect(nextTargetWorkingDay("2026-12-24")).toBe("2026-12-28");
  });

  it("16:00 Europe/Berlin is 15:00Z in winter and 14:00Z in summer (DST edges)", () => {
    expect(berlinInstant("2026-11-06", 16).toISOString()).toBe("2026-11-06T15:00:00.000Z");
    expect(berlinInstant("2026-07-01", 16).toISOString()).toBe("2026-07-01T14:00:00.000Z");
    expect(berlinInstant("2026-03-29", 16).toISOString()).toBe("2026-03-29T14:00:00.000Z"); // DST starts that night
    expect(berlinInstant("2026-03-28", 16).toISOString()).toBe("2026-03-28T15:00:00.000Z");
    expect(berlinInstant("2026-10-25", 16).toISOString()).toBe("2026-10-25T15:00:00.000Z"); // DST ended
    expect(berlinInstant("2026-10-24", 16).toISOString()).toBe("2026-10-24T14:00:00.000Z");
  });

  it("a Friday rate serves until Monday 18:00 CET; Easter Thursday until Tuesday; 6-day cap", () => {
    const fri = ecbValidity("2026-11-06", 7200, 518_400);
    expect(fri.asOf.toISOString()).toBe("2026-11-06T15:00:00.000Z");
    expect(fri.validUntil.toISOString()).toBe("2026-11-09T17:00:00.000Z");
    const easter = ecbValidity("2026-04-02", 7200, 518_400);
    expect(easter.validUntil.toISOString()).toBe("2026-04-07T16:00:00.000Z"); // Tue 18:00 CEST
    const capped = ecbValidity("2026-04-02", 7200, 86_400);
    expect(capped.validUntil.getTime() - capped.asOf.getTime()).toBe(86_400_000);
  });
});

describe("ECB daily file", () => {
  const daily = parseEcbDaily(fixture("ecb/eurofxref-daily-2026-11-06.xml"));
  it("parses the day and every EUR quote", () => {
    expect(daily.day).toBe("2026-11-06");
    expect(daily.perEur.size).toBe(30);
    expect(daily.perEur.get("usd")).toEqual(rational(10823n, 10000n));
  });

  it("cross rates via EUR are exact rationals", () => {
    expect(crossToUsd(daily, "eur")).toEqual(rational(10823n, 10000n));
    expect(crossToUsd(daily, "gbp")).toEqual(reduce({ num: 10823n * 100000n, den: 10000n * 83265n }));
    expect(crossToUsd(daily, "xyz")).toBeUndefined();
    const q = ecbQuotes(daily, ["usd", "eur", "jpy", "xyz"], { graceS: 7200, maxAgeS: 518_400 });
    expect(q.map((x) => x.currency)).toEqual(["eur", "jpy"]);
    expect(q[0]?.validUntil.toISOString()).toBe("2026-11-09T17:00:00.000Z");
  });

  it("refuses files without a day, without USD, or with a zero rate", () => {
    expect(() => parseEcbDaily("<Cube currency='USD' rate='1.1'/>")).toThrow(EcbFormatError);
    expect(() => parseEcbDaily("<Cube time='2026-11-06'><Cube currency='JPY' rate='160'/></Cube>")).toThrow(
      EcbFormatError,
    );
    expect(() =>
      parseEcbDaily("<Cube time='2026-11-06'><Cube currency='USD' rate='1.1'/><Cube currency='JPY' rate='0'/></Cube>"),
    ).toThrow(EcbFormatError);
  });
});

describe("CoinGecko simple/price", () => {
  it("reads prices from their source text; skips malformed entries", () => {
    const m = parseSimplePrice(fixture("coingecko/simple-price.json"));
    expect(m.get("usd-coin")?.usd).toBe("0.9998031415683941");
    expect(m.get("ethereum")?.updatedAt.toISOString()).toBe("2025-11-06T11:56:35.000Z");
    expect(m.get("tiny")?.usd).toBe("1.2e-7");
    expect(m.has("broken")).toBe(false);
    expect(m.has("neg")).toBe(false);
    expect(() => parseSimplePrice("[]")).toThrow();
  });
});
