/**
 * Solana watcher (lld/rails.md §21.2), leader-elected in `rails-feeds`, every 4 s, demand-driven like §8.6/§8.7:
 * no RPC call at all while no live execution needs it, and its cursor is forgotten then.
 *
 * - Destinations: for each owner with TAGGED in-flight executions, the watched account is the owner's ATA for the
 *   mint (SPL) or the owner (SOL). New finalized signatures (`getSignaturesForAddress … until: cursor`) are read
 *   oldest first; failed ones (`err`) are skipped; each transaction's balance delta for (owner, mint) becomes an
 *   amount credit attributed by exact amount among tagged executions (`matchCredits`) → evidence with
 *   `Evidence.solana`. A payout that also creates the ATA is seen (the ATA is in the transaction) and counts in full.
 * - Deposits: for executions still waiting for their deposit on Solana, any new successful signature on the deposit
 *   account (the 1Click deposit address, or its ATA for an SPL origin asset) nudges the hot poller (signal only).
 * - Per-account cursors live in one `solana` cursor row (§8.10 completeness): an account seen for the first time
 *   starts at its newest signature (a payout can only land after the execution exists).
 */

import { recordPoolHealth } from "../../app/chain-tier.js";
import type { Rails } from "../../app/context.js";
import { associatedTokenAddress, solanaDelta, TOKEN_PROGRAM } from "../../domain/chains/solana.js";
import type { SignatureInfo, SolanaRpc } from "../../infra/clients/solana.js";
import { SOLANA_MAINNET } from "../../spec-0.4.0.js";
import { clearCursor, readCursor, writeCursor } from "../cursors.js";
import { matchCredits } from "../matching.js";
import type { Credit } from "../near-indexer/parse.js";
import { NUDGEABLE_STATES, nudge } from "../signals.js";

export const SOLANA_CURSOR = "solana";
const PAGE = 100;
const MAX_PAGES = 10;

interface DestinationWatch {
  readonly kind: "destination";
  readonly account: string;
  readonly owner: string;
  readonly mint: string | null;
  readonly assetId: string;
}
interface DepositWatch {
  readonly kind: "deposit";
  readonly account: string;
  readonly executionIds: string[];
}
type Watch = DestinationWatch | DepositWatch;

interface CursorValue {
  /** account → newest processed signature (null = the account had no signature when first seen). */
  readonly accounts: Record<string, string | null>;
}

async function mints(r: Rails, assets: readonly string[]): Promise<Map<string, string | null>> {
  if (assets.length === 0) return new Map();
  const rows = await r.db
    .selectFrom("tokens")
    .select(["asset_id", "contract_address"])
    .where("livemode", "=", true)
    .where("asset_id", "in", [...new Set(assets)])
    .execute();
  return new Map(rows.map((t) => [t.asset_id, t.contract_address]));
}

const ataOr = (owner: string, mint: string | null): string | null => {
  if (mint === null) return owner;
  try {
    return associatedTokenAddress(owner, mint, TOKEN_PROGRAM).address;
  } catch {
    return null;
  }
};

/** What to watch now (§21.2 demand). */
export async function solanaDemand(r: Rails, chain = SOLANA_MAINNET): Promise<Watch[]> {
  const now = new Date(r.now());
  const dest = await r.db
    .selectFrom("executions")
    .select(["destination_key", "destination_asset_id"])
    .where("livemode", "=", true)
    .where("destination_chain", "=", chain)
    .where("method", "=", "route_quote")
    .where("recipient_type", "=", "destination_chain")
    .where("terminal_at", "is", null)
    .where("amount_tag", "<>", "0")
    .where((eb) => eb.or([eb("state", "<>", "expired_unpaid"), eb("tracking_until", ">", now)]))
    .execute();
  const dep = await r.db
    .selectFrom("executions")
    .select(["id", "deposit_address", "origin_asset_id"])
    .where("livemode", "=", true)
    .where("origin_chain", "=", chain)
    .where("deposit_address", "is not", null)
    .where("terminal_at", "is", null)
    .where("state", "in", [...NUDGEABLE_STATES])
    .execute();
  const m = await mints(r, [...dest.map((d) => d.destination_asset_id), ...dep.map((d) => d.origin_asset_id)]);
  const out = new Map<string, Watch>();
  for (const d of dest) {
    const owner = d.destination_key.split("|")[1] as string;
    const mint = m.get(d.destination_asset_id) ?? null;
    const account = ataOr(owner, mint);
    if (account && !out.has(`d:${account}`))
      out.set(`d:${account}`, { kind: "destination", account, owner, mint, assetId: d.destination_asset_id });
  }
  for (const d of dep) {
    const account = ataOr(d.deposit_address as string, m.get(d.origin_asset_id) ?? null);
    if (!account) continue;
    const w = out.get(`p:${account}`) as DepositWatch | undefined;
    if (w) w.executionIds.push(d.id);
    else out.set(`p:${account}`, { kind: "deposit", account, executionIds: [d.id] });
  }
  return [...out.values()];
}

/** New signatures of `account` after `until`, oldest first (pages back with `before` while pages are full). */
async function newSignatures(rpc: SolanaRpc, account: string, until: string | null): Promise<SignatureInfo[]> {
  const all: SignatureInfo[] = [];
  let before: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const sigs = await rpc.signatures(account, { until, before, limit: PAGE });
    all.push(...sigs);
    if (sigs.length < PAGE) break;
    before = (sigs[sigs.length - 1] as SignatureInfo).signature;
  }
  return all.reverse();
}

export interface SolanaWatchResult {
  readonly accounts: number;
  readonly signatures: number;
  readonly settled: number;
  readonly nudged: number;
}

/** One watcher cycle. */
export async function solanaWatchOnce(r: Rails, rpc: SolanaRpc, chain = SOLANA_MAINNET): Promise<SolanaWatchResult> {
  const watches = await solanaDemand(r, chain);
  if (watches.length === 0) {
    await clearCursor(r, SOLANA_CURSOR);
    return { accounts: 0, signatures: 0, settled: 0, nudged: 0 };
  }
  const prev = (await readCursor<CursorValue>(r, SOLANA_CURSOR))?.accounts ?? {};
  const next: Record<string, string | null> = {};
  let signatures = 0;
  let settled = 0;
  const toNudge: string[] = [];
  try {
    for (const w of watches) {
      if (w.account in next) continue; // the same account as destination and deposit: read once per cycle
      if (!(w.account in prev)) {
        const newest = await rpc.signatures(w.account, { limit: 1 });
        next[w.account] = newest[0]?.signature ?? null;
        continue;
      }
      const sigs = await newSignatures(rpc, w.account, prev[w.account] ?? null);
      signatures += sigs.length;
      const ok = sigs.filter((s) => s.err === null || s.err === undefined);
      const sameAccount = watches.filter((x) => x.account === w.account);
      for (const x of sameAccount) {
        if (x.kind === "deposit") {
          if (ok.length > 0) toNudge.push(...x.executionIds);
          continue;
        }
        const credits: Credit[] = [];
        for (const s of ok) {
          const tx = await rpc.transaction(s.signature);
          if (!tx || (tx.meta?.err !== null && tx.meta?.err !== undefined)) continue;
          const d = solanaDelta(tx, x.owner, x.mint);
          if (!d || d.amount <= 0n) continue;
          credits.push({
            chain,
            kind: "amount",
            to: x.owner,
            from: d.sender,
            assetId: x.assetId,
            amount: d.amount,
            memo: null,
            txHash: s.signature,
            blockRef: String(tx.slot),
            logRef: x.account,
            detail: {
              solana: {
                signature: s.signature,
                slot: tx.slot,
                block_time: typeof tx.blockTime === "number" && tx.blockTime >= 0 ? tx.blockTime : null,
                mint: x.mint,
                token_program: x.mint ? (d.tokenProgram ?? TOKEN_PROGRAM) : null,
                owner: x.owner,
                token_accounts: d.tokenAccounts,
                pre_amount: d.pre.toString(),
                post_amount: d.post.toString(),
              },
              bitcoin: null,
            },
          });
        }
        const res = await matchCredits(r, credits, {
          livemode: true,
          source: "watcher",
          finality: "finalized",
          confirm: (c) => agree(r, rpc, c),
        });
        settled += res.settled;
      }
      const newest = sigs[sigs.length - 1];
      next[w.account] = newest ? newest.signature : (prev[w.account] ?? null);
    }
  } finally {
    await recordPoolHealth(r, chain, rpc.health()).catch(() => {});
  }
  const nudged = await nudge(r, toNudge);
  await writeCursor(r, SOLANA_CURSOR, { accounts: next } satisfies CursorValue);
  return { accounts: Object.keys(next).length, signatures, settled, nudged };
}

/** Large amounts: a second endpoint must return the same slot and amount (§21.3 agreement). */
async function agree(r: Rails, rpc: SolanaRpc, c: Credit): Promise<boolean> {
  if (rpc.urls.length < 2) return true;
  const t = await r.db
    .selectFrom("tokens")
    .select(["decimals", "is_usd_stable"])
    .where("livemode", "=", true)
    .where("asset_id", "=", c.assetId)
    .executeTakeFirst();
  const approx = t?.is_usd_stable ? (c.amount * 1_000_000n) / 10n ** BigInt(t.decimals) : r.agreementUsdMicros;
  if (approx < r.agreementUsdMicros) return true;
  const other = await rpc.transaction(c.txHash, 1).catch(() => null);
  if (!other || String(other.slot) !== c.blockRef) return false;
  const mint = c.detail?.solana?.mint ?? null;
  return solanaDelta(other, c.to, mint)?.amount === c.amount;
}
