/**
 * Sandbox adapter (lld/rails.md §3, sandbox LLD §3): the same 1Click API on nearpay-sandbox, called
 * with rails' service token (`sandbox.use`). Test mode only. Quotes are signed with the sandbox key
 * using the 1Click construction, so the same SDK call verifies them with `NP_SANDBOX_SIGNING_PUBKEY`.
 * Also the simulated chains and Verifier feed the sandbox verifier and sandbox feed read.
 */
import { verifyQuoteSignature } from "@defuse-protocol/one-click-sdk-typescript";
import { httpClient } from "@nearpay-internal/http";
import {
  type OneClickQuoteRequest,
  type OneClickQuoteResponse,
  sandboxGetTx,
  sandboxIntentsEvents,
} from "@nearpay-internal/spec";
import bs58 from "bs58";
import { oneClickCalls } from "../oneclick/client.js";
import { assertMode, type RouteProvider } from "../port.js";

/** `ed25519:<base58>` from the seed script's base64url raw key (or an `ed25519:` key as is). */
export function sandboxManagerKey(pub: string): string {
  if (pub.startsWith("ed25519:")) return pub;
  const raw = Buffer.from(pub, "base64url");
  if (raw.length !== 32) throw new RangeError("NP_SANDBOX_SIGNING_PUBKEY must be a 32-byte Ed25519 public key");
  return `ed25519:${bs58.encode(raw)}`;
}

export interface SandboxOptions {
  readonly baseUrl: string;
  readonly signingPubkey: string;
  readonly serviceToken: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly onResult?: Parameters<typeof httpClient>[0]["onResult"];
}

export interface SandboxChains {
  tx(
    chain: string,
    hash: string,
  ): Promise<{ finalized: boolean; transfers: { token: string; to: string; amount: string }[] } | null>;
  events(
    cursor: number,
    limit: number,
  ): Promise<{
    events: { seq: number; tx_hash: string; block_height: number; log: string }[];
    next_cursor: number;
  }>;
}

export function sandboxProvider(o: SandboxOptions): RouteProvider & { chains: SandboxChains } {
  const client = httpClient({
    target: "sandbox",
    baseUrl: o.baseUrl,
    timeoutMs: 4_000,
    attempts: 1,
    serviceToken: o.serviceToken,
    breaker: false,
    ...(o.fetch ? { fetch: o.fetch } : {}),
    ...(o.onResult ? { onResult: o.onResult } : {}),
  });
  const calls = oneClickCalls({ client, headers: {}, takeQuote: async () => true, takeStatus: async () => true });
  const key = sandboxManagerKey(o.signingPubkey);
  const p: RouteProvider & { chains: SandboxChains } = {
    name: "sandbox",
    livemode: false,
    tokens: calls.tokens,
    async quote(livemode: boolean, req: OneClickQuoteRequest, scenarioAmount?: string) {
      assertMode(p, livemode);
      return calls.quote({ ...req, ...(scenarioAmount ? { scenario_amount: scenarioAmount } : {}) });
    },
    async status(livemode, address, memo) {
      assertMode(p, livemode);
      return calls.status(address, memo);
    },
    async submitDeposit(livemode, b) {
      assertMode(p, livemode);
      return calls.submit(b);
    },
    verifySignature: (r: OneClickQuoteResponse) => verifyQuoteSignature(r as never, key),
    chains: {
      async tx(chain, hash) {
        try {
          return await client.call(sandboxGetTx, { params: { chain, hash } });
        } catch (e) {
          if ((e as { status?: number }).status === 404) return null;
          throw e;
        }
      },
      events: (cursor, limit) => client.call(sandboxIntentsEvents, { query: { cursor, limit } }),
    },
  };
  return p;
}
