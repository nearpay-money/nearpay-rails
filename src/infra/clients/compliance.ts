/**
 * Compliance screening of refund addresses (lld/rails.md §8.1 step 3, §10: 1.5 s). Rails applies
 * the fail-closed threshold itself when compliance is unreachable: USD ≥ 1,000 → refuse, otherwise
 * proceed (compliance post-screens every settled execution).
 */
import { HttpError, httpClient } from "@nearpay-internal/http";
import { createScreening } from "@nearpay-internal/spec";

export type ScreeningOutcome =
  | { readonly kind: "allow"; readonly postScreenRequired: boolean; readonly screeningId: string }
  | { readonly kind: "block"; readonly screeningId: string }
  | { readonly kind: "unavailable"; readonly detail: string };

export interface Screening {
  screen(i: {
    subjectType: "address" | "near_account";
    chain?: string;
    subject: string;
    accountId: string;
    livemode: boolean;
    amountUsdMicros: bigint | null;
  }): Promise<ScreeningOutcome>;
}

export function complianceScreening(o: {
  baseUrl: string;
  serviceToken: () => Promise<string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
  onResult?: Parameters<typeof httpClient>[0]["onResult"];
}): Screening {
  const client = httpClient({
    target: "compliance",
    baseUrl: o.baseUrl,
    timeoutMs: o.timeoutMs ?? 1_500,
    attempts: 1,
    serviceToken: o.serviceToken,
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...(o.onResult ? { onResult: o.onResult } : {}),
  });
  return {
    async screen(i) {
      try {
        const micros = i.amountUsdMicros;
        const r = await client.call(createScreening, {
          body: {
            subject_type: i.subjectType,
            ...(i.chain && i.subjectType === "address" ? { chain: i.chain } : {}),
            subject: i.subject,
            context: "payment",
            account_id: i.accountId,
            livemode: i.livemode,
            ...(micros !== null && micros <= BigInt(Number.MAX_SAFE_INTEGER)
              ? { amount_usd_micros: Number(micros) }
              : {}),
          },
        });
        if (r.decision === "block") return { kind: "block", screeningId: r.screening_id };
        return { kind: "allow", postScreenRequired: r.post_screen_required, screeningId: r.screening_id };
      } catch (e) {
        if (e instanceof HttpError && e.status === 402) return { kind: "block", screeningId: "" };
        return { kind: "unavailable", detail: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
