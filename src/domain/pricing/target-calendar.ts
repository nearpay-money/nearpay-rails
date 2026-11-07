/**
 * ECB publication calendar and the FX staleness bound (lld/rails.md §8.2, ADR-0020 decision 5). Pure.
 *
 * The ECB publishes its euro reference rates once per TARGET working day at about 16:00 CET. TARGET closing days:
 * Saturdays, Sundays, 1 January, Good Friday, Easter Monday, 1 May, 25 and 26 December (Easter by the Gregorian
 * computus). For reference day D: `as_of = D 16:00 Europe/Berlin`;
 * `valid_until = min(next TARGET working day after D at 16:00 Europe/Berlin + grace, as_of + max age)`.
 */

/** `YYYY-MM-DD` → UTC midnight ms. */
function dayMs(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new RangeError(`not a date: ${day}`);
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== day)
    throw new RangeError(`not a date: ${day}`);
  return ms;
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const DAY = 86_400_000;

/** Easter Sunday of `year` (anonymous Gregorian algorithm), `YYYY-MM-DD`. */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function isTargetClosingDay(day: string): boolean {
  const ms = dayMs(day);
  const dow = new Date(ms).getUTCDay();
  if (dow === 0 || dow === 6) return true;
  const md = day.slice(5);
  if (md === "01-01" || md === "05-01" || md === "12-25" || md === "12-26") return true;
  const easter = dayMs(easterSunday(Number(day.slice(0, 4))));
  return ms === easter - 2 * DAY || ms === easter + DAY;
}

/** The first TARGET working day strictly after `day`. */
export function nextTargetWorkingDay(day: string): string {
  let ms = dayMs(day) + DAY;
  while (isTargetClosingDay(iso(ms))) ms += DAY;
  return iso(ms);
}

/** Last Sunday of `month` (1-12) in `year`, UTC midnight ms. */
function lastSunday(year: number, month: number): number {
  const last = Date.UTC(year, month, 0);
  return last - new Date(last).getUTCDay() * DAY;
}

/** The instant of `hh:mm` local time in Europe/Berlin on `day` (CET +01:00, CEST +02:00; EU rules since 1996). */
export function berlinInstant(day: string, hh: number, mm = 0): Date {
  const ms = dayMs(day);
  const year = new Date(ms).getUTCFullYear();
  // CEST from the last Sunday of March 01:00 UTC to the last Sunday of October 01:00 UTC
  const start = lastSunday(year, 3) + 3_600_000;
  const end = lastSunday(year, 10) + 3_600_000;
  const local = ms + (hh * 60 + mm) * 60_000;
  const summer = local - 2 * 3_600_000 >= start && local - 2 * 3_600_000 < end;
  return new Date(local - (summer ? 2 : 1) * 3_600_000);
}

export interface FxValidity {
  readonly asOf: Date;
  readonly validUntil: Date;
}

/** §8.2 bound for the ECB rates of reference day `day`. */
export function ecbValidity(day: string, graceS: number, maxAgeS: number): FxValidity {
  const asOf = berlinInstant(day, 16);
  const next = berlinInstant(nextTargetWorkingDay(day), 16).getTime() + graceS * 1000;
  return { asOf, validUntil: new Date(Math.min(next, asOf.getTime() + maxAgeS * 1000)) };
}
