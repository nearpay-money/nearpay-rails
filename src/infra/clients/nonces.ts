/**
 * Verifier nonces for refund legs signed from an Intents account (spec 0.2.1 `RefundTransfer.nonce`, foundations
 * §14): 32 bytes = the Verifier's 4-byte `current_salt` ‖ 28 random bytes, base64. Live mode reads `current_salt`
 * from the Intents contract over NEAR RPC (cached 60 s); test mode uses the sandbox Verifier's fixed salt, so a
 * test payload can never execute on mainnet (INV-8). Rails issues the nonce when it prepares the leg and payments
 * copies it into `next_action` unchanged.
 */
import { intentsRpc, makeNonce } from "@nearpay-internal/intents";

/** The sandbox Verifier's fixed `current_salt` (nearpay-sandbox `SANDBOX_SALT`). */
export const SANDBOX_SALT = "5a0dbe11";
export const SALT_TTL_MS = 60_000;

export interface Nonces {
  /** A fresh nonce for `livemode`; throws when the live salt cannot be read. */
  fresh(livemode: boolean): Promise<string>;
}

export function verifierNonces(o: {
  rpcUrls: readonly string[];
  contract?: string;
  fetch?: typeof fetch;
  now?: () => number;
  readSalt?: () => Promise<string>;
}): Nonces {
  const now = o.now ?? Date.now;
  const readSalt =
    o.readSalt ??
    (() => {
      const rpc = intentsRpc({
        rpcUrls: [...o.rpcUrls],
        timeoutMs: 2_000,
        ...(o.contract ? { contract: o.contract } : {}),
        ...(o.fetch ? { fetch: o.fetch } : {}),
      });
      return () => rpc.currentSalt();
    })();
  let cached: { salt: string; at: number } | null = null;
  return {
    async fresh(livemode) {
      if (!livemode) return makeNonce(SANDBOX_SALT);
      if (!cached || now() - cached.at > SALT_TTL_MS) {
        const salt = await readSalt();
        if (typeof salt !== "string" || !/^[0-9a-f]{8}$/.test(salt)) throw new Error("unexpected current_salt");
        cached = { salt, at: now() };
      }
      return makeNonce(cached.salt);
    },
  };
}
