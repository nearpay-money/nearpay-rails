/**
 * EVM destination watcher (lld/rails.md §8.7), one leader-elected loop per watched Tier-A chain.
 * Scans counted blocks for ERC-20 `Transfer` logs to watched recipients and attributes them by exact amount (tag).
 * Counted = the chain's confirmation policy (ADR-0022 as amended 2026-11-10 17:10): by default one block on every EVM
 * chain (up to `latest`); `latest − blocks + 1` or the `finalized` tag by override. Under a confirmations policy each attributed log's
 * receipt is re-read and must still be in the log's block with status 1 (reorg check); otherwise nothing settles and
 * the cursor stops before that block so it is scanned again. Evidence is then `confirmed` (with `confirmations` and
 * `block_hash`) and the post-success `finalized` re-check follows (§8.12). Demand-driven: while no live execution is
 * in flight to the chain the watcher makes no RPC call at all (nothing could be attributed) and forgets its cursor;
 * when demand returns it starts {@link FIRST_SIGHT_MARGIN} blocks below the counted head. An idle stack puts no load on public RPCs. Native assets are not log-visible (the verifier handles them).
 */
import { minOf } from "@nearpay-internal/money";
import type { Rails } from "../../app/context.js";
import { confirmationsOf, countedHead, FINALIZED } from "../../domain/chains/evm.js";
import { type EvmRpc, erc20Transfers } from "../../infra/clients/evm.js";
import { clearCursor, readCursor, writeCursor } from "../cursors.js";
import { matchCredits } from "../matching.js";
import type { Credit } from "../near-indexer/parse.js";

const WINDOW = 500n;
/**
 * First sight of demand starts this many blocks below the counted head. Under the one-block rule (ADR-0022 as
 * amended) the counted head is `latest` itself, so a payout mined in the block the watcher first sees (leader just
 * elected, demand just appeared) would otherwise be skipped; rescanning a few blocks is cheap and matching is
 * idempotent (the old 10/40-block and `finalized` rules left this margin implicitly).
 */
export const FIRST_SIGHT_MARGIN = 10n;
const CHUNK = 500;

interface Demand {
  readonly contracts: Map<string, string>; // contract → asset id
  readonly recipients: string[];
}

async function demand(r: Rails, chain: string): Promise<Demand | null> {
  const inflight = await r.db
    .selectFrom("executions")
    .select(["destination_asset_id", "destination_key"])
    .where("livemode", "=", true)
    .where("destination_chain", "=", chain)
    .where("method", "=", "route_quote")
    .where("recipient_type", "=", "destination_chain")
    .where("terminal_at", "is", null)
    .where("state", "<>", "expired_unpaid")
    .execute();
  if (inflight.length === 0) return null;
  const assets = [...new Set(inflight.map((x) => x.destination_asset_id))];
  const tokens = await r.db
    .selectFrom("tokens")
    .select(["asset_id", "contract_address"])
    .where("livemode", "=", true)
    .where("asset_id", "in", assets)
    .execute();
  const contracts = new Map<string, string>();
  for (const t of tokens) if (t.contract_address) contracts.set(t.contract_address.toLowerCase(), t.asset_id);
  if (contracts.size === 0) return null;
  const watched = await r.db
    .selectFrom("watched_destinations")
    .select("address_norm")
    .where("livemode", "=", true)
    .where("chain", "=", chain)
    .where("active", "=", true)
    .execute();
  const recipients = [
    ...new Set([
      ...inflight.map((x) => x.destination_key.split("|")[1] as string),
      ...watched.map((w) => w.address_norm),
    ]),
  ];
  return { contracts, recipients };
}

/** One watcher step; returns blocks scanned. */
export async function watchOnce(r: Rails, chain: string, rpc: EvmRpc): Promise<number> {
  const name = `evm:${chain}`;
  const d = await demand(r, chain);
  if (!d) {
    // idle: no RPC call at all; when demand returns the scan starts a few blocks below the then-counted head
    // (a payout to a new execution can only land in later blocks; the margin covers a just-elected leader)
    await clearCursor(r, name);
    r.metrics.lag(name, 0);
    return 0;
  }
  const policy = r.profiles.get(chain)?.evmConfirmation ?? FINALIZED;
  const latest = policy.kind === "confirmations" ? await rpc.latestBlock() : undefined;
  const head =
    latest === undefined
      ? countedHead(policy, { finalized: await rpc.finalizedBlock() })
      : countedHead(policy, { latest });
  const stored = await readCursor<{ block: string }>(r, name);
  if (!stored) {
    const start = head > FIRST_SIGHT_MARGIN ? head - FIRST_SIGHT_MARGIN : 0n;
    await writeCursor(r, name, { block: start.toString() });
    r.metrics.lag(name, Number(head - start));
    return 0;
  }
  const cursor = BigInt(stored.block);
  if (cursor >= head) {
    r.metrics.lag(name, 0);
    return 0;
  }
  const from = cursor + 1n;
  const to = minOf(from + WINDOW - 1n, head);
  const credits: Credit[] = [];
  for (let i = 0; i < d.recipients.length; i += CHUNK) {
    const logs = await rpc.logs({
      fromBlock: from,
      toBlock: to,
      addresses: [...d.contracts.keys()],
      recipients: d.recipients.slice(i, i + CHUNK),
    });
    for (const l of logs) {
      for (const t of erc20Transfers([l])) {
        const assetId = d.contracts.get(t.token);
        if (!assetId) continue;
        const block = BigInt(l.blockNumber);
        credits.push({
          chain,
          kind: "amount",
          to: t.to,
          from: t.from,
          assetId,
          amount: t.amount,
          memo: null,
          txHash: l.transactionHash,
          blockRef: block.toString(),
          logRef: `${BigInt(l.logIndex)}`,
          blockHash: l.blockHash,
          details: {
            block_hash: l.blockHash,
            ...(latest !== undefined && policy.kind === "confirmations"
              ? { confirmations: Number(confirmationsOf(latest, block)), required_confirmations: policy.blocks }
              : {}),
          },
        });
      }
    }
  }
  // lowest block whose attributed log failed the reorg check: the cursor stops before it (rescanned next step)
  let reorgedAt: bigint | null = null;
  await matchCredits(r, credits, {
    livemode: true,
    source: "watcher",
    finality: policy.kind === "confirmations" ? "confirmed" : "finalized",
    confirm: async (c) => {
      if (policy.kind === "confirmations") {
        // reorg check (ADR-0022): the receipt must still be in the log's block, with status 1
        const again = await rpc.receipt(c.txHash);
        if (
          again?.status !== "0x1" ||
          again.blockHash.toLowerCase() !== c.blockHash?.toLowerCase() ||
          BigInt(again.blockNumber).toString() !== c.blockRef
        ) {
          const block = BigInt(c.blockRef);
          r.log.warn(
            { chain, tx: c.txHash, block: c.blockRef, block_hash: c.blockHash, now: again?.blockHash ?? null },
            "EVM transfer reorganised before confirmation; rescanning",
          );
          reorgedAt = reorgedAt === null || block < reorgedAt ? block : reorgedAt;
          return false;
        }
      }
      // large amounts: a second provider must return the same receipt (§10 agreement)
      if (rpc.urls.length < 2 || c.amount === 0n) return true;
      const x = await r.db
        .selectFrom("tokens")
        .select(["decimals", "is_usd_stable"])
        .where("livemode", "=", true)
        .where("asset_id", "=", c.assetId)
        .executeTakeFirst();
      const approxUsdMicros = x?.is_usd_stable
        ? (c.amount * 1_000_000n) / 10n ** BigInt(x.decimals)
        : r.agreementUsdMicros;
      if (approxUsdMicros < r.agreementUsdMicros) return true;
      const other = await rpc.receipt(c.txHash, 1).catch(() => null);
      return other?.status === "0x1" && BigInt(other.blockNumber).toString() === c.blockRef;
    },
  });
  const done: bigint = reorgedAt === null ? to : (reorgedAt as bigint) - 1n;
  await writeCursor(r, name, { block: done.toString() });
  r.metrics.lag(name, Number(head - done));
  return Number(done - from + 1n);
}
