/**
 * Exact rates (lld/rails.md §8.2, INV-5). Pure. A rate is a reduced bigint rational; the wire form is the spec's
 * `Ratio` `{num, den}` of integer strings; `decimal` renderings are for display only and never re-enter arithmetic.
 * Feed numbers are read from their JSON source text (`parseJsonDecimals`), never through a float.
 */
import { cmp, div, floor, mul, type Rational, rational, sub } from "@nearpay-internal/money";

export type { Rational };

export interface RatioWire {
  readonly num: string;
  readonly den: string;
}

const gcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) [x, y] = [y, x % y];
  return x;
};

/** Reduced, positive denominator. */
export function reduce(r: Rational): Rational {
  if (r.den === 0n) throw new RangeError("zero denominator");
  const s = r.den < 0n ? -1n : 1n;
  const g = gcd(r.num, r.den) || 1n;
  return { num: (s * r.num) / g, den: (s * r.den) / g };
}

export function ratioToWire(r: Rational): RatioWire {
  const x = reduce(r);
  if (x.num < 0n) throw new RangeError("rates are non-negative");
  return { num: x.num.toString(), den: x.den.toString() };
}

export function ratioFromWire(w: RatioWire): Rational {
  if (!/^(0|[1-9]\d*)$/.test(w.num) || !/^[1-9]\d*$/.test(w.den)) throw new RangeError("malformed ratio");
  return reduce(rational(BigInt(w.num), BigInt(w.den)));
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * An exact decimal (plain or exponent notation, as JSON number tokens and feed attributes are written) as a
 * rational. Throws on anything else; never goes through a float.
 */
export function parseExactDecimal(s: string): Rational {
  const m = DECIMAL.exec(s.trim());
  if (!m) throw new RangeError(`not a decimal: ${s.slice(0, 40)}`);
  const [, sign, int, frac = "", exp = "0"] = m;
  const e = Number.parseInt(exp, 10) - frac.length;
  if (Math.abs(e) > 400) throw new RangeError("exponent out of range");
  let num = BigInt(`${int}${frac}`);
  if (sign === "-") num = -num;
  return e >= 0 ? reduce(rational(num * 10n ** BigInt(e))) : reduce(rational(num, 10n ** BigInt(-e)));
}

/** Round-half-even integer of a rational. */
function halfEven(r: Rational): bigint {
  const x = reduce(r);
  const f = floor(x);
  const rem = sub(x, rational(f));
  const c = cmp(rem, rational(1n, 2n));
  if (c < 0) return f;
  if (c > 0) return f + 1n;
  return f % 2n === 0n ? f : f + 1n;
}

/** Display rendering: plain decimal, at most `places` fraction digits, half-even, trailing zeros trimmed. */
export function toDisplayDecimal(r: Rational, places = 18): string {
  const x = reduce(r);
  if (x.num < 0n) throw new RangeError("display of negative rates is not supported");
  const scaled = halfEven(mul(x, rational(10n ** BigInt(places))));
  const s = scaled.toString().padStart(places + 1, "0");
  const int = s.slice(0, s.length - places);
  const frac = s.slice(s.length - places).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

export type Rounding = "floor" | "ceil";

/**
 * `amount / 10^fromExp × rate × 10^toExp`, rounded explicitly: settlement amounts round `floor`, minimums and payer
 * totals `ceil` (foundations §6).
 */
export function convertUnits(amount: bigint, fromExp: number, rate: Rational, toExp: number, mode: Rounding): bigint {
  const exact = div(mul(mul(rational(amount), rate), rational(10n ** BigInt(toExp))), rational(10n ** BigInt(fromExp)));
  const f = floor(exact);
  if (mode === "floor") return f;
  return cmp(sub(exact, rational(f)), rational(0n)) > 0 ? f + 1n : f;
}

/** |a − b| / b (b > 0). */
export function relDiff(a: Rational, b: Rational): Rational {
  const d = sub(a, b);
  return div(rational(d.num < 0n ? -d.num : d.num, d.den), b);
}

/**
 * JSON with every number token kept as its exact source text (a decimal string): feed prices never pass through a
 * float. Needs JSON.parse source-text access (Node ≥ 21); throws rather than silently losing digits.
 */
export function parseJsonDecimals(text: string): unknown {
  return JSON.parse(text, function (this: unknown, _key: string, value: unknown, context?: { source?: string }) {
    if (typeof value !== "number") return value;
    if (typeof context?.source !== "string") throw new Error("JSON.parse source text access is unavailable");
    return context.source;
  } as never);
}
