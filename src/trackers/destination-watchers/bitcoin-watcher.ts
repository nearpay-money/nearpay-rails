/**
 * Bitcoin watcher (lld/rails.md §21.2), leader-elected in `rails-feeds`, every 60 s, demand-driven, SIGNAL ONLY:
 * Bitcoin is never amount-tagged (§21.1), so a transfer seen here is never evidence by itself. For each destination
 * address of an in-flight live execution, and each deposit address still awaiting its deposit, Esplora
 * `GET /address/{addr}/txs`; a newly CONFIRMED transaction with an output paying the address (re-derived from the
 * scriptPubKey; split outputs count) nudges the hot poller, whose provider status then carries the destination txid
 * for the verifier (§21.3). Mempool transactions are not counted. Seen txids live in the `bitcoin` cursor row
 * (§8.10 completeness); an address seen for the first time records its current history without nudging.
 */

import { BITCOIN_MAINNET } from "@nearpay/spec";
import { recordPoolHealth } from "../../app/chain-tier.js";
import type { Rails } from "../../app/context.js";
import { normalizeBitcoinAddress, outputsTo } from "../../domain/chains/bitcoin.js";
import type { Esplora } from "../../infra/clients/esplora.js";
import { clearCursor, readCursor, writeCursor } from "../cursors.js";
import { NUDGEABLE_STATES, nudge } from "../signals.js";

export const BITCOIN_CURSOR = "bitcoin";
const KEEP = 60;

interface CursorValue {
  /** address → confirmed txids already seen (newest first, capped). */
  readonly seen: Record<string, string[]>;
}

/** Addresses to watch → the executions a new payment to them concerns. */
export async function bitcoinDemand(r: Rails, chain = BITCOIN_MAINNET): Promise<Map<string, string[]>> {
  const dest = await r.db
    .selectFrom("executions")
    .select(["id", "destination_key"])
    .where("livemode", "=", true)
    .where("destination_chain", "=", chain)
    .where("recipient_type", "=", "destination_chain")
    .where("terminal_at", "is", null)
    .where("state", "in", [...NUDGEABLE_STATES])
    .execute();
  const dep = await r.db
    .selectFrom("executions")
    .select(["id", "deposit_address"])
    .where("livemode", "=", true)
    .where("origin_chain", "=", chain)
    .where("deposit_address", "is not", null)
    .where("terminal_at", "is", null)
    .where("state", "in", [...NUDGEABLE_STATES])
    .execute();
  const out = new Map<string, string[]>();
  const add = (address: string, id: string) => {
    const a = normalizeBitcoinAddress(address);
    out.set(a, [...(out.get(a) ?? []), id]);
  };
  for (const d of dest) add(d.destination_key.split("|")[1] as string, d.id);
  for (const d of dep) add(d.deposit_address as string, d.id);
  return out;
}

export async function bitcoinWatchOnce(
  r: Rails,
  esplora: Esplora,
  chain = BITCOIN_MAINNET,
): Promise<{ addresses: number; nudged: number }> {
  const demand = await bitcoinDemand(r, chain);
  if (demand.size === 0) {
    await clearCursor(r, BITCOIN_CURSOR);
    return { addresses: 0, nudged: 0 };
  }
  const prev = (await readCursor<CursorValue>(r, BITCOIN_CURSOR))?.seen ?? {};
  const next: Record<string, string[]> = {};
  const toNudge: string[] = [];
  try {
    for (const [address, ids] of demand) {
      const txs = await esplora.addressTxs(address);
      const confirmed = txs.filter((t) => t.status.confirmed).map((t) => ({ t, id: t.txid.toLowerCase() }));
      const known = prev[address];
      if (known) {
        const before = new Set(known);
        const fresh = confirmed.filter((x) => !before.has(x.id) && outputsTo(x.t, address).length > 0);
        if (fresh.length > 0) toNudge.push(...ids);
      }
      next[address] = [...new Set([...confirmed.map((x) => x.id), ...(known ?? [])])].slice(0, KEEP);
    }
  } finally {
    await recordPoolHealth(r, chain, esplora.health()).catch(() => {});
  }
  const nudged = await nudge(r, toNudge);
  await writeCursor(r, BITCOIN_CURSOR, { seen: next } satisfies CursorValue);
  return { addresses: demand.size, nudged };
}
