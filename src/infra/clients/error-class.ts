/**
 * A short, stable class for an outbound-call failure, for `ALERT …` log lines an operator can act on without reading
 * stack traces: `auth` (401/403), `proxy_denied` (407, or the egress proxy refusing the host), `http_<status>`,
 * `timeout`, `breaker_open`, `network:<code>` (DNS, refused, reset…), `malformed` (unparseable body), `empty`.
 */
import { BreakerOpenError, HttpError, TimeoutError } from "@nearpay-internal/http";

export interface ErrorClass {
  readonly class: string;
  readonly status: number | null;
  readonly message: string;
}

const causeCode = (e: unknown): string | null => {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^E[A-Z_]+$/.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
};

export function errorClass(e: unknown): ErrorClass {
  const message = (e instanceof Error ? e.message : String(e)).slice(0, 300);
  if (e instanceof HttpError) {
    const cls =
      e.status === 401 || e.status === 403
        ? "auth"
        : e.status === 407 || /proxy/i.test(message)
          ? "proxy_denied"
          : `http_${e.status}`;
    return { class: cls, status: e.status, message };
  }
  if (e instanceof TimeoutError) return { class: "timeout", status: null, message };
  if (e instanceof BreakerOpenError) return { class: "breaker_open", status: null, message };
  const code = causeCode(e);
  if (code) return { class: `network:${code}`, status: null, message };
  if (e instanceof SyntaxError || (e instanceof Error && e.name === "ZodError"))
    return { class: "malformed", status: null, message };
  if (/no usable tokens/.test(message)) return { class: "empty", status: null, message };
  if (e instanceof TypeError && /fetch failed/i.test(message)) return { class: "network", status: null, message };
  return { class: e instanceof Error ? e.name || "error" : "error", status: null, message };
}

/**
 * Rate limit for repeated alert lines: `due()` is true the first time, then at most once per `everyMs` while the
 * condition lasts; `reset()` when it clears (the next occurrence logs at once again).
 */
export function alertLimiter(everyMs: number, now: () => number) {
  let last: number | null = null;
  let count = 0;
  return {
    /** Records one occurrence; true when it should be logged. */
    due(): boolean {
      count++;
      const t = now();
      if (last !== null && t - last < everyMs) return false;
      last = t;
      return true;
    },
    /** Occurrences since the condition started. */
    get count() {
      return count;
    },
    /** Whether the condition is ongoing (an occurrence since the last reset). */
    get active() {
      return count > 0;
    },
    reset() {
      last = null;
      count = 0;
    },
  };
}
