/**
 * EVM destination watcher (lld/rails.md §8.7), one leader-elected loop per watched Tier-A chain.
 * Scans `finalized` blocks for ERC-20 `Transfer` logs to watched recipients and attributes them by
 * exact amount (tag). Demand-driven: while no live execution is in flight to the chain the watcher
 * makes no RPC call at all (nothing could be attributed) and forgets its cursor; when demand returns
 * it starts at the finalized head. An idle stack puts no load on public RPCs. Native assets are not log-visible (the verifier handles them).
 */
import { minOf } from "@nearpay-internal/money";
import type { Rails } from "../../app/context.js";
import { type EvmRpc, erc20Transfers } from "../../infra/clients/evm.js";
import { clearCursor, readCursor, writeCursor } from "../cursors.js";
import { matchCredits } from "../matching.js";
import type { Credit } from "../near-indexer/parse.js";

const WINDOW = 500n;
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
    // idle: no RPC call at all; when demand returns the scan starts at the then-finalized head
    // (a payout to a new execution can only land in later blocks)
    await clearCursor(r, name);
    r.metrics.lag(name, 0);
    return 0;
  }
  const finalized = await rpc.finalizedBlock();
  const stored = await readCursor<{ block: string }>(r, name);
  if (!stored) {
    await writeCursor(r, name, { block: finalized.toString() });
    r.metrics.lag(name, 0);
    return 0;
  }
  const cursor = BigInt(stored.block);
  if (cursor >= finalized) {
    r.metrics.lag(name, 0);
    return 0;
  }
  const from = cursor + 1n;
  const to = minOf(from + WINDOW - 1n, finalized);
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
        credits.push({
          chain,
          kind: "amount",
          to: t.to,
          from: t.from,
          assetId,
          amount: t.amount,
          memo: null,
          txHash: l.transactionHash,
          blockRef: BigInt(l.blockNumber).toString(),
          logRef: `${BigInt(l.logIndex)}`,
        });
      }
    }
  }
  await matchCredits(r, credits, {
    livemode: true,
    source: "watcher",
    finality: "finalized",
    confirm: async (c) => {
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
  await writeCursor(r, name, { block: to.toString() });
  r.metrics.lag(name, Number(finalized - to));
  return Number(to - from + 1n);
}
