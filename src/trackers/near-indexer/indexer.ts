/**
 * NEAR indexer (lld/rails.md §8.6) and the sandbox feed (§9, L-RL-04), both leader-elected.
 *
 * - Live: neardata finalized blocks from the `near-indexer` cursor; intents.near DIP-4/NEP-245 events
 *   and NEP-141 `ft_transfer`s of the in-flight destination tokens. Demand-driven like the watchers:
 *   with no live execution in flight to NEAR it makes no call at all and forgets its cursor; when
 *   demand returns it starts at the final head. At-least-once (cursor after the block), matching is idempotent. > 50 blocks behind the
 *   head raises an alert. Stage 1 reads one source (neardata); the verifier's RPC lookup is the
 *   backstop while it stalls.
 * - Test: the sandbox's simulated Verifier events (`/sim/intents/events`) through the same parser
 *   and matching code.
 */
import type { Rails } from "../../app/context.js";
import type { Neardata } from "../../infra/clients/near.js";
import { clearCursor, readCursor, writeCursor } from "../cursors.js";
import { matchCredits } from "../matching.js";
import { type Credit, creditsOf, outcomesOfBlock } from "./parse.js";

const NEAR = "near:mainnet";
const BATCH = 50;

async function tokenContracts(r: Rails, livemode: boolean): Promise<Set<string>> {
  const rows = await r.db
    .selectFrom("executions")
    .innerJoin("tokens", (j) =>
      j
        .onRef("tokens.asset_id", "=", "executions.destination_asset_id")
        .onRef("tokens.livemode", "=", "executions.livemode"),
    )
    .select("tokens.contract_address")
    .where("executions.livemode", "=", livemode)
    .where("executions.destination_chain", "=", NEAR)
    .where("executions.recipient_type", "=", "destination_chain")
    .where("executions.terminal_at", "is", null)
    .execute();
  return new Set(rows.flatMap((x) => (x.contract_address ? [x.contract_address] : [])));
}

async function hasDemand(r: Rails): Promise<boolean> {
  const row = await r.db
    .selectFrom("executions")
    .select("id")
    .where("livemode", "=", true)
    .where("destination_chain", "=", NEAR)
    .where("terminal_at", "is", null)
    .where("state", "<>", "expired_unpaid")
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/** One indexer step; returns blocks processed. */
export async function indexOnce(r: Rails, nd: Neardata, signal?: AbortSignal): Promise<number> {
  const name = "near-indexer";
  if (!(await hasDemand(r))) {
    // idle: no neardata call; when demand returns indexing starts at the then-final head
    await clearCursor(r, name);
    r.metrics.lag(name, 0);
    return 0;
  }
  const final = await nd.finalHeight(signal);
  const stored = await readCursor<{ height: number }>(r, name);
  if (!stored) {
    await writeCursor(r, name, { height: final });
    r.metrics.lag(name, 0);
    return 0;
  }
  const cursor = stored.height;
  if (cursor >= final) {
    r.metrics.lag(name, 0);
    return 0;
  }
  const contracts = await tokenContracts(r, true);
  const to = Math.min(cursor + BATCH, final);
  let processed = 0;
  for (let h = cursor + 1; h <= to; h++) {
    if (signal?.aborted) break;
    const block = await nd.block(h, signal);
    if (block) {
      const ctx = { chain: NEAR, intentsContract: r.intentsContract, tokenContracts: contracts, blockRef: String(h) };
      const credits = outcomesOfBlock(block).flatMap((o) => creditsOf(o, ctx));
      await matchCredits(r, credits, { livemode: true, source: "indexer", finality: "final" });
    }
    await writeCursor(r, name, { height: h });
    processed++;
  }
  const lag = final - (cursor + processed);
  r.metrics.lag(name, lag);
  if (lag > 50) r.log.error({ lag, cursor: cursor + processed, final }, "ALERT NEAR indexer is behind the final head");
  return processed;
}

/** Credits of one sandbox Verifier transaction's logs. */
export function sandboxCredits(
  intentsContract: string,
  txHash: string,
  blockHeight: number,
  logs: readonly string[],
): Credit[] {
  return creditsOf(
    { receiptId: txHash, txHash, executor: intentsContract, logs, success: true },
    { chain: NEAR, intentsContract, tokenContracts: new Set(), blockRef: String(blockHeight) },
  );
}

/** One sandbox-feed step; returns events read. */
export async function sandboxFeedOnce(r: Rails): Promise<number> {
  const chains = r.providers.test?.chains;
  if (!chains) return 0;
  const name = "sandbox-feed";
  const cursor = (await readCursor<{ seq: number }>(r, name))?.seq ?? 0;
  const page = await chains.events(cursor, 500);
  if (page.events.length === 0) return 0;
  const byTx = new Map<string, { height: number; logs: string[] }>();
  for (const e of page.events) {
    const t = byTx.get(e.tx_hash) ?? { height: e.block_height, logs: [] };
    t.logs.push(e.log);
    byTx.set(e.tx_hash, t);
  }
  const credits = [...byTx.entries()].flatMap(([hash, t]) => sandboxCredits(r.intentsContract, hash, t.height, t.logs));
  await matchCredits(r, credits, { livemode: false, source: "indexer", finality: "final" });
  await writeCursor(r, name, { seq: page.next_cursor });
  return page.events.length;
}
