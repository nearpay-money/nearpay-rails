/**
 * ECB euro reference rates (lld/rails.md §8.2; `eurofxref-daily.xml`, reference/landscape.md §8). Pure.
 *
 * The file quotes `C per EUR` for ~29 currencies of one reference day. NearPay keeps every rate as USD per one unit
 * of the currency: `fx(eur) = USD_per_EUR`, `fx(c) = USD_per_EUR / C_per_EUR` — an exact rational (generally not a
 * finite decimal). `usd` needs no source.
 */
import { div, type Rational, rational } from "@nearpay-internal/money";
import { parseExactDecimal, reduce } from "./ratio.js";
import { ecbValidity } from "./target-calendar.js";

export interface EcbDaily {
  /** Reference day `YYYY-MM-DD`. */
  readonly day: string;
  /** Lower-case currency → units per one EUR. */
  readonly perEur: ReadonlyMap<string, Rational>;
}

const CUBE_TIME = /<Cube\s+time=["'](\d{4}-\d{2}-\d{2})["']\s*>/;
const CUBE_RATE = /<Cube\s+currency=["']([A-Z]{3})["']\s+rate=["']([0-9]+(?:\.[0-9]+)?)["']\s*\/>/g;

export class EcbFormatError extends Error {
  override readonly name = "EcbFormatError";
}

/** Parses the daily file; rejects anything without a day, USD, or with a non-positive rate. */
export function parseEcbDaily(xml: string): EcbDaily {
  const t = CUBE_TIME.exec(xml);
  if (!t) throw new EcbFormatError("no reference day");
  const day = t[1] as string;
  const perEur = new Map<string, Rational>();
  for (const m of xml.matchAll(CUBE_RATE)) {
    const v = parseExactDecimal(m[2] as string);
    if (v.num <= 0n) throw new EcbFormatError(`non-positive rate for ${m[1]}`);
    perEur.set((m[1] as string).toLowerCase(), v);
  }
  if (!perEur.has("usd")) throw new EcbFormatError("no USD rate");
  return { day, perEur };
}

export interface FxQuote {
  readonly currency: string;
  /** USD per one unit of `currency`. */
  readonly value: Rational;
  readonly referenceDate: string;
  readonly asOf: Date;
  readonly validUntil: Date;
}

/** USD per one unit of `currency` from a day's EUR quotes (`eur` itself included); undefined if not quoted. */
export function crossToUsd(d: EcbDaily, currency: string): Rational | undefined {
  const usdPerEur = d.perEur.get("usd") as Rational;
  if (currency === "eur") return reduce(usdPerEur);
  const perEur = d.perEur.get(currency);
  return perEur ? reduce(div(usdPerEur, perEur)) : undefined;
}

/** The USD rates of `currencies` (`usd` skipped: no source needed) with the §8.2 validity bound. */
export function ecbQuotes(
  d: EcbDaily,
  currencies: readonly string[],
  o: { graceS: number; maxAgeS: number },
): FxQuote[] {
  const { asOf, validUntil } = ecbValidity(d.day, o.graceS, o.maxAgeS);
  const out: FxQuote[] = [];
  for (const c of currencies) {
    if (c === "usd") continue;
    const value = crossToUsd(d, c);
    if (value) out.push({ currency: c, value, referenceDate: d.day, asOf, validUntil });
  }
  return out;
}

/** `usd` → USD: exactly one, source `fixed`. */
export const USD_ONE: Rational = rational(1n);
