/**
 * Route provider port (lld/rails.md §3 `providers/port.ts`). Two adapters speak the 1Click API:
 * `oneclick` (live, 1Click itself) and `sandbox` (test mode, nearpay-sandbox). Each asserts its mode
 * (INV-8: test objects never reach mainnet providers, live objects never reach the simulator).
 */
import type { OneClickQuoteRequest, OneClickQuoteResponse, OneClickStatusResponse } from "@nearpay-internal/spec";
import type { ProviderToken } from "../domain/token-registry/registry.js";

export type QuoteOutcome =
  | { readonly ok: true; readonly response: OneClickQuoteResponse; readonly raw: unknown }
  /** 400: the provider refused the request (message is the provider's). */
  | { readonly ok: false; readonly kind: "rejected"; readonly message: string }
  /** 401/429/5xx/timeout/breaker open. */
  | { readonly ok: false; readonly kind: "unavailable"; readonly detail: string }
  /** 2xx that is not a valid quote. */
  | { readonly ok: false; readonly kind: "malformed"; readonly detail: string };

export type StatusOutcome =
  | { readonly ok: true; readonly status: OneClickStatusResponse; readonly raw: unknown }
  | { readonly ok: false; readonly kind: "not_found" }
  | { readonly ok: false; readonly kind: "unavailable"; readonly detail: string };

export class ModeViolation extends Error {
  override readonly name = "ModeViolation";
}

export interface RouteProvider {
  readonly name: "oneclick" | "sandbox";
  /** The only mode this provider serves. */
  readonly livemode: boolean;
  tokens(): Promise<ProviderToken[]>;
  /** `scenarioAmount` is the sandbox's scenario selector (ignored by 1Click). */
  quote(livemode: boolean, req: OneClickQuoteRequest, scenarioAmount?: string): Promise<QuoteOutcome>;
  status(livemode: boolean, depositAddress: string, memo: string | null): Promise<StatusOutcome>;
  submitDeposit(
    livemode: boolean,
    b: { txHash: string; depositAddress: string; memo: string | null; sender?: string },
  ): Promise<StatusOutcome>;
  /** Provider signature over the quote (1Click SDK construction). */
  verifySignature(response: OneClickQuoteResponse): boolean;
}

export function assertMode(p: { name: string; livemode: boolean }, livemode: boolean): void {
  if (p.livemode !== livemode)
    throw new ModeViolation(`${p.name} serves ${p.livemode ? "live" : "test"} mode only (INV-8)`);
}
