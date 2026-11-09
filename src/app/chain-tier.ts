/**
 * Effective verification tier of a chain (lld/rails.md §21.4).
 *
 * - The boot-time profile tier already reflects configuration: a Solana/Bitcoin profile without an RPC pool is Tier B.
 * - At runtime a pooled chain whose pool has failed every call for > 5 min is Tier B for NEW executions (alert
 *   `tier_a_degraded{chain}`). Health is shared across processes through the `cursors` table (`health:<chain>`,
 *   written by the tracker and the feeds that call the pools, read by the API at create).
 * - An execution keeps the tier it was created with (`executions.verification_tier`): a Tier-A execution whose pool
 *   fails later is retried until its verification timeout and then held — never downgraded to the provider's word.
 */
import { POOLED_FAMILIES } from "../domain/token-registry/chain-profiles.js";
import { type PoolHealthView, UNHEALTHY_AFTER_MS, unhealthy } from "../infra/clients/pool.js";
import { readCursor, writeCursor } from "../trackers/cursors.js";
import type { Rails } from "./context.js";

const healthCursor = (chain: string) => `health:${chain}`;

interface StoredHealth {
  readonly failing_since_ms: number | null;
  readonly last_ok_ms: number | null;
}

/** Persists a pool's health when it changed state (healthy ↔ failing), so the API sees it. */
export async function recordPoolHealth(r: Rails, chain: string, h: PoolHealthView): Promise<void> {
  const prev = await readCursor<StoredHealth>(r, healthCursor(chain));
  const failing = h.failingSinceMs;
  const degraded = unhealthy(h, r.now());
  r.metrics.tierDegraded(chain, degraded);
  if (degraded) r.log.error({ chain, failing_since_ms: failing }, "ALERT tier_a_degraded: chain RPC pool unhealthy");
  if (prev && prev.failing_since_ms === failing) return;
  await writeCursor(r, healthCursor(chain), { failing_since_ms: failing, last_ok_ms: h.lastOkMs });
}

/** Tier a new execution settling on `chain` is created with. */
export async function tierAtCreate(r: Rails, chain: string): Promise<"A" | "B"> {
  const p = r.profiles.get(chain);
  if (!p) return "B";
  if (p.tier === "B" || !POOLED_FAMILIES.has(p.family)) return p.tier;
  const h = await readCursor<StoredHealth>(r, healthCursor(chain));
  if (h?.failing_since_ms != null && r.now() - h.failing_since_ms > UNHEALTHY_AFTER_MS) return "B";
  return "A";
}

/** Tier an execution is verified with: the pinned one, else (rows older than 0005) the profile's. */
export function verificationTier(r: Rails, row: { destination_chain: string; verification_tier: string | null }) {
  if (row.verification_tier === "A" || row.verification_tier === "B") return row.verification_tier;
  return r.profiles.get(row.destination_chain)?.tier ?? "B";
}
