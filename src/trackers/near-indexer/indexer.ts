/**
 * NEAR indexer (lld/rails.md §8.6) and the sandbox feed (§9, L-RL-04), both leader-elected.
 *
 * - Live: neardata finalized blocks from the `near-indexer` cursor; intents.near DIP-4/NEP-245 events
 *   and NEP-141 `ft_transfer`s of the in-flight destination tokens. Demand-driven like the watchers:
 *   with no live execution in flight to NEAR it makes no call at all and forgets its cursor; when
 *   demand returns it starts at the final head. At-least-once (cursor after the block), matching is idempotent. > 50 blocks behind the
 *   head raises an alert (log, at most every 5 min while behind; gauge `nearpay_rails_tracker_lag_blocks{tracker=
 *   "near-indexer"}` for deploy's `TrackerLagging`). Stage 1 reads one source (neardata); the verifier's RPC lookup
 *   is the backstop while it stalls.
 * - Catch-up (audit RAILS-3): more than {@link BATCH} blocks behind (after downtime or a sleeping host), a step
 *   fetches up to {@link CATCHUP_WINDOW} blocks with {@link CATCHUP_CONCURRENCY} requests in flight and still applies
 *   them strictly in height order, writing the cursor after each block (monotonic; a failure stops at the last
 *   applied block).
 * - Test: the sandbox's simulated Verifier events (`/sim/intents/events`) through the same parser
 *   and matching code.
 */

import type { VaultEventRecord } from "@nearpay-internal/spec";
import type { Rails } from "../../app/context.js";
import { alertLimiter } from "../../infra/clients/error-class.js";
import type { Neardata } from "../../infra/clients/near.js";
import { clearCursor, readCursor, writeCursor } from "../cursors.js";
import { matchCredits } from "../matching.js";
import { type Credit, creditsOf, outcomesOfBlock } from "./parse.js";
import { forwardVaultEvents, type VaultRejectReason, vaultEventsOf } from "./vault.js";

const NEAR = "near:mainnet";
/** Blocks per step while (nearly) at the head, fetched one after another. */
export const BATCH = 50;
/** Blocks per step while catching up (lag > BATCH). */
export const CATCHUP_WINDOW = 400;
/** Block fetches in flight while catching up. */
export const CATCHUP_CONCURRENCY = 8;
/** While behind, the lag alert line repeats at most this often. */
export const LAG_ALERT_EVERY_MS = 5 * 60_000;
const lagAlerts = new WeakMap<object, ReturnType<typeof alertLimiter>>();

/**
 * Fetches `heights` with at most `concurrency` requests in flight and yields the results strictly in the given
 * order. Stopping early leaves no unhandled rejection behind.
 */
export async function* fetchInOrder<T>(
  heights: readonly number[],
  fetch: (h: number) => Promise<T>,
  concurrency: number,
): AsyncGenerator<[number, T]> {
  const pending: Promise<T>[] = [];
  let next = 0;
  for (let i = 0; i < heights.length; i++) {
    while (next < heights.length && pending.length < Math.max(1, concurrency)) {
      const p = fetch(heights[next] as number);
      p.catch(() => {});
      pending.push(p);
      next++;
    }
    yield [heights[i] as number, await (pending.shift() as Promise<T>)];
  }
}

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
  // Stage 4 (§8.6): with a live vault configured the indexer always runs (mandate events happen without executions)
  if (r.vault.live) return true;
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
  const behind = final - cursor;
  r.metrics.lag(name, behind);
  const catchingUp = behind > BATCH;
  const to = Math.min(cursor + (catchingUp ? CATCHUP_WINDOW : BATCH), final);
  const heights = Array.from({ length: to - cursor }, (_, i) => cursor + 1 + i);
  let processed = 0;
  for await (const [h, block] of fetchInOrder(
    heights,
    (x) => nd.block(x, signal),
    catchingUp ? CATCHUP_CONCURRENCY : 1,
  )) {
    if (signal?.aborted) break;
    if (block) {
      const ctx = { chain: NEAR, intentsContract: r.intentsContract, tokenContracts: contracts, blockRef: String(h) };
      const outcomes = outcomesOfBlock(block);
      const credits = outcomes.flatMap((o) => creditsOf(o, ctx));
      await matchCredits(r, credits, { livemode: true, source: "indexer", finality: "final" });
      if (r.vault.live) {
        // neardata serves final blocks only (rule 3 holds by construction)
        const vctx = {
          vaultContract: r.vault.live,
          final: true,
          blockHeight: h,
          blockHash: block.block.header.hash,
          blockTimestamp: block.block.header.timestamp_nanosec ?? null,
        };
        const parsed = outcomes.map((o) => vaultEventsOf(o, vctx));
        await forwardVaultEvents(
          r,
          true,
          parsed.flatMap((p) => p.records),
          parsed.flatMap((p) => p.rejected),
        );
      }
    }
    await writeCursor(r, name, { height: h });
    processed++;
  }
  const lag = final - (cursor + processed);
  r.metrics.lag(name, lag);
  let alert = lagAlerts.get(r);
  if (!alert) {
    alert = alertLimiter(LAG_ALERT_EVERY_MS, r.now);
    lagAlerts.set(r, alert);
  }
  if (lag > BATCH) {
    if (alert.due())
      r.log.error(
        { lag, cursor: cursor + processed, final, catching_up: catchingUp, steps: alert.count },
        "ALERT NEAR indexer is behind the final head",
      );
  } else if (alert.active) {
    r.log.info({ lag, steps: alert.count }, "NEAR indexer caught up with the final head");
    alert.reset();
  }
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

type SimEvent = Awaited<ReturnType<NonNullable<Rails["providers"]["test"]>["chains"]["events"]>>["events"][number];

/**
 * Stage 4 (§8.6 v1.10, OQ-T-03): the sandbox vault stand-in's lines (items carrying `executor_id`) as receipts, with
 * their explicit `log_index`; the same rules as live apply with the stand-in account as the vault (sandbox blocks are
 * final).
 */
export function sandboxVaultReceipts(r: Rails, events: readonly SimEvent[]) {
  const byReceipt = new Map<string, { e: SimEvent; lines: { line: string; index: number }[] }>();
  for (const e of events) {
    if (!e.executor_id || e.executor_id === r.intentsContract) continue;
    const id = e.receipt_id ?? `${e.tx_hash}:${e.seq}`;
    const g = byReceipt.get(id) ?? { e, lines: [] };
    g.lines.push({ line: e.log, index: e.log_index ?? g.lines.length });
    byReceipt.set(id, g);
  }
  const records: VaultEventRecord[] = [];
  const rejected: VaultRejectReason[] = [];
  for (const [receiptId, g] of byReceipt) {
    const out = vaultEventsOf(
      {
        receiptId,
        txHash: g.e.tx_hash,
        executor: g.e.executor_id as string,
        logs: g.lines.map((l) => l.line),
        logIndexes: g.lines.map((l) => l.index),
        success: g.e.receipt_status !== "failure",
      },
      {
        vaultContract: r.vault.test,
        final: true,
        blockHeight: g.e.block_height,
        blockHash: g.e.block_hash ?? "",
        blockTimestamp: g.e.block_timestamp ?? null,
      },
    );
    records.push(...out.records);
    rejected.push(...out.rejected);
  }
  return { records, rejected };
}

/** One sandbox-feed step; returns events read. */
export async function sandboxFeedOnce(r: Rails): Promise<number> {
  const chains = r.providers.test?.chains;
  if (!chains) return 0;
  const name = "sandbox-feed";
  const cursor = (await readCursor<{ seq: number }>(r, name))?.seq ?? 0;
  const page = await chains.events(cursor, 500);
  if (page.events.length === 0) return 0;
  const vault = sandboxVaultReceipts(r, page.events);
  await forwardVaultEvents(r, false, vault.records, vault.rejected);
  const byTx = new Map<string, { height: number; logs: string[] }>();
  for (const e of page.events) {
    // vault stand-in lines (Stage 4) are not Verifier events
    if (e.executor_id && e.executor_id !== r.intentsContract) continue;
    const t = byTx.get(e.tx_hash) ?? { height: e.block_height, logs: [] };
    t.logs.push(e.log);
    byTx.set(e.tx_hash, t);
  }
  const credits = [...byTx.entries()].flatMap(([hash, t]) => sandboxCredits(r.intentsContract, hash, t.height, t.logs));
  await matchCredits(r, credits, { livemode: false, source: "indexer", finality: "final" });
  await writeCursor(r, name, { seq: page.next_cursor });
  return page.events.length;
}
