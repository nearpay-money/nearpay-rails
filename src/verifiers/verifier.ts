/**
 * Verifier (lld/rails.md §8.8, ADR-0012), run by `rails-tracker`: executions the provider reports
 * SUCCESS for, without watcher/indexer evidence yet, are checked against the destination chain using
 * the provider's destination tx hashes.
 *
 * - Tier A, EVM: receipt status 1 and the chain's confirmation policy (ADR-0022 as amended 2026-11-10 17:10: one
 *   block of the chain's own `latest` head by default — `latest − block + 1 ≥ 1` — with the receipt re-read in the
 *   same block right before the evidence applies; evidence `confirmed`, followed by the post-success `finalized`
 *   re-check, finality-recheck.ts; `finalized` / N blocks by override); ERC-20 `Transfer(to = recipient)` on the token
 *   contract, or a native transfer (`tx.to == recipient`). Large amounts need a second RPC's agreement. An internal
 *   native transfer cannot be proven: Tier B rules apply.
 * - Tier A, NEAR: `EXPERIMENTAL_tx_status` FINAL; `mt_transfer` to the Intents account (intents.near)
 *   or NEP-141 `ft_transfer` to the account (token contract).
 * - Test mode: the sandbox's simulated chain (`/sim/chains/{chain}/tx/{hash}`).
 * - Tier B chains: the provider's word within `NP_TIER_B_LIMITS`.
 * Not final / not found → retried every 2 s (Bitcoin: 5 s; ADR-0022 as amended — one block confirms, so the next
 * look should follow the next block closely) until `verification_timeout_s` → `held`. Idle, the loop looks for due
 * work every 500 ms.
 */

import { sql } from "@nearpay-internal/db";
import { parseEventLogs } from "@nearpay-internal/intents";
import { verificationTier } from "../app/chain-tier.js";
import type { Rails } from "../app/context.js";
import { applyChange, lockExecution } from "../app/ledger.js";
import type { EvidenceChainDetail } from "../app/observations.js";
import { applyEvidence, type EvidenceInput } from "../app/observations.js";
import { policyFor } from "../app/pricing.js";
import { tokenOf } from "../app/tokens.js";
import { type ExecutionRow, pricedToken } from "../app/views.js";
import { FINALIZED } from "../domain/chains/evm.js";
import type { HeldReason } from "../domain/execution/state.js";
import { usdMicros } from "../domain/pricing/pricing.js";
import {
  compareTransfers,
  type ObservedTransfer,
  tierBAllowed,
  type VerificationResult,
} from "../domain/verification/verification.js";
import type { Esplora } from "../infra/clients/esplora.js";
import { type EvmRpc, erc20Transfers } from "../infra/clients/evm.js";
import type { NearRpc } from "../infra/clients/near.js";
import type { SolanaRpc } from "../infra/clients/solana.js";
import { outcomeSucceeded, senderOf } from "../trackers/near-indexer/parse.js";
import { sandboxChainOutcome, toKey, verifyBitcoin, verifySolana } from "./chains.js";
import { checkEvmConfirmation } from "./evm-confirmation.js";

export interface VerifierDeps {
  readonly near: NearRpc | null;
  readonly evm: ReadonlyMap<string, EvmRpc>;
  /** Stage 4 (§21.4): null/absent when `NP_SOLANA_RPC_URLS` is empty (Solana is then Tier B at boot). */
  readonly solana?: SolanaRpc | null;
  /** Stage 4 (§21.4): null/absent when `NP_BITCOIN_ESPLORA_URLS` is empty. */
  readonly esplora?: Esplora | null;
}

export interface VerifyOutcome {
  readonly result: VerificationResult;
  readonly tier: "A" | "B";
  readonly source: EvidenceInput["source"];
  readonly finality: EvidenceInput["finality"];
  readonly txHash: string | null;
  readonly blockRef: string | null;
  readonly amount: bigint;
  /** spec 0.3.0 `Evidence.sender`: who sent the verified transfer (null = the chain did not say). */
  readonly sender?: string | null;
  readonly details: Record<string, unknown>;
  /** Hold at once (no point retrying). */
  readonly holdNow?: HeldReason;
  /** spec 0.4.0: `Evidence.solana` / `Evidence.bitcoin`. */
  readonly chainDetail?: EvidenceChainDetail;
}

/** Retry of a not-yet-final verification (§8.8): 2 s (EVM, NEAR, Solana blocks are ≤ 12 s), Bitcoin 5 s. */
export const RETRY_MS = 2_000;
export const BITCOIN_RETRY_MS = 5_000;
/** Idle cadence of the verifier loop (a claim query per tick). */
export const VERIFIER_TICK_MS = 500;
const LEASE_MS = 30_000;

export function retryMsFor(r: Rails, chain: string): number {
  return r.profiles.get(chain)?.family === "bitcoin" ? BITCOIN_RETRY_MS : RETRY_MS;
}

const pending = (details: Record<string, unknown>, tier: "A" | "B" = "A"): VerifyOutcome => ({
  result: "pending",
  tier,
  source: "verifier",
  finality: "final",
  txHash: null,
  blockRef: null,
  amount: 0n,
  details,
});

async function verifyEvm(r: Rails, rpc: EvmRpc, row: ExecutionRow, hashes: readonly string[]): Promise<VerifyOutcome> {
  const token = await tokenOf(r, true, row.destination_asset_id);
  const contract = token?.contract_address?.toLowerCase() ?? null;
  const recipient = row.destination_key.split("|")[1] as string;
  const expected = BigInt(row.amount_out_expected);
  const policy = r.profiles.get(row.destination_chain)?.evmConfirmation ?? FINALIZED;
  let best: VerifyOutcome | null = null;
  for (const hash of hashes) {
    const receipt = await rpc.receipt(hash);
    if (!receipt) {
      best ??= { ...pending({ hash, reason: "receipt not found" }), result: "not_found" };
      continue;
    }
    if (receipt.status !== "0x1") {
      best = { ...pending({ hash, reason: "transaction reverted" }), result: "mismatch" };
      continue;
    }
    const conf = await checkEvmConfirmation(rpc, policy, receipt);
    if (conf.kind !== "counted") {
      // not deep enough yet, or reorganised between the reads: look again on the next attempt
      if (conf.kind === "reorged")
        r.log.warn({ execution: row.id, hash, ...conf.details }, "EVM receipt reorganised before confirmation");
      best = pending({ hash, ...conf.details });
      continue;
    }
    let transfers: ObservedTransfer[];
    if (contract) {
      transfers = erc20Transfers(receipt.logs)
        .filter((t) => t.token === contract)
        .map((t) => ({ to: t.to, from: t.from, assetId: row.destination_asset_id, amount: t.amount }));
    } else {
      const tx = await rpc.transaction(hash);
      transfers =
        tx?.to && tx.to.toLowerCase() === recipient
          ? [
              {
                to: recipient,
                from: tx.from ? tx.from.toLowerCase() : null,
                assetId: row.destination_asset_id,
                amount: BigInt(tx.value),
              },
            ]
          : [];
      if (transfers.length === 0) return tierB(r, row, { hash, reason: "native transfer not provable on chain" });
    }
    const c = compareTransfers(transfers, { recipient, assetId: row.destination_asset_id, expected });
    const out: VerifyOutcome = {
      result: c.result,
      tier: "A",
      source: "verifier",
      finality: conf.finality,
      txHash: hash,
      blockRef: conf.blockNumber.toString(),
      amount: c.amount,
      sender: c.sender,
      details: {
        hash,
        block_hash: conf.blockHash,
        ...(conf.confirmations !== null
          ? {
              confirmations: conf.confirmations,
              required_confirmations: policy.kind === "confirmations" ? policy.blocks : null,
            }
          : {}),
      },
    };
    if (c.result === "pass" || c.result === "short") {
      // agreement (§10): a second provider must see the same receipt for large amounts
      if (rpc.urls.length > 1 && (await needsAgreement(r, row))) {
        const other = await rpc.receipt(hash, 1).catch(() => null);
        if (other?.status !== "0x1" || other.blockHash !== receipt.blockHash)
          return pending({ hash, reason: "second RPC does not agree yet" });
      }
      return out;
    }
    best = out;
  }
  return best ?? pending({ reason: "no destination transactions yet" });
}

async function needsAgreement(r: Rails, row: ExecutionRow): Promise<boolean> {
  const t = await tokenOf(r, row.livemode, row.destination_asset_id);
  if (!t) return true;
  const usd = usdMicros(BigInt(row.amount_out_expected), pricedToken(t), await policyFor(r, row.livemode));
  return usd === null || usd >= r.agreementUsdMicros;
}

function nearTransfers(
  row: ExecutionRow,
  outcomes: readonly { executor: string; logs: readonly string[]; success: boolean }[],
  intents: string,
) {
  const out: ObservedTransfer[] = [];
  for (const o of outcomes) {
    if (!o.success) continue;
    for (const e of parseEventLogs(o.logs)) {
      if (!Array.isArray(e.data)) continue;
      if (
        row.recipient_type === "intents" &&
        o.executor === intents &&
        e.standard === "nep245" &&
        e.event === "mt_transfer"
      ) {
        for (const d of e.data as {
          old_owner_id?: string;
          new_owner_id?: string;
          token_ids?: string[];
          amounts?: string[];
        }[]) {
          (d.token_ids ?? []).forEach((id, i) => {
            const a = d.amounts?.[i];
            if (d.new_owner_id && a && /^\d+$/.test(a))
              out.push({
                to: d.new_owner_id.toLowerCase(),
                from: senderOf(d.old_owner_id),
                assetId: id,
                amount: BigInt(a),
              });
          });
        }
      }
      if (row.recipient_type === "destination_chain" && e.standard === "nep141" && e.event === "ft_transfer") {
        for (const d of e.data as { old_owner_id?: string; new_owner_id?: string; amount?: string }[]) {
          if (d.new_owner_id && d.amount && /^\d+$/.test(d.amount))
            out.push({
              to: d.new_owner_id.toLowerCase(),
              from: senderOf(d.old_owner_id),
              assetId: `nep141:${o.executor}`,
              amount: BigInt(d.amount),
            });
        }
      }
    }
  }
  return out;
}

async function verifyNear(
  r: Rails,
  rpc: NearRpc,
  row: ExecutionRow,
  hashes: readonly string[],
): Promise<VerifyOutcome> {
  const recipient = row.destination_key.split("|")[1] as string;
  const expected = BigInt(row.amount_out_expected);
  let best: VerifyOutcome | null = null;
  for (const hash of hashes) {
    const t = await rpc.txStatus(hash, r.intentsContract);
    if (t.kind === "error") return pending({ hash, reason: t.detail });
    if (t.kind === "unknown") {
      best ??= { ...pending({ hash, reason: "unknown transaction" }), result: "not_found" };
      continue;
    }
    if (!t.final) {
      best = pending({ hash, reason: `status ${t.tx.final_execution_status}` });
      continue;
    }
    const transfers = nearTransfers(
      row,
      t.tx.receipts_outcome.map((o) => ({
        executor: o.outcome.executor_id,
        logs: o.outcome.logs,
        success: outcomeSucceeded(o.outcome.status),
      })),
      r.intentsContract,
    );
    const c = compareTransfers(transfers, { recipient, assetId: row.destination_asset_id, expected });
    const out: VerifyOutcome = {
      result: c.result,
      tier: "A",
      source: "verifier",
      finality: "final",
      txHash: hash,
      blockRef: t.tx.receipts_outcome[0]?.block_hash ?? null,
      amount: c.amount,
      sender: c.sender,
      details: { hash },
    };
    if (c.result !== "mismatch") return out;
    best = out;
  }
  return best ?? pending({ reason: "no destination transactions yet" });
}

/**
 * A simulated transaction's transfers as the comparison reads them. Spec 0.3.1 `SimTx.transfers[].from` becomes the
 * candidate `Evidence.sender` (null/absent or not a plausible account = the simulated chain did not say).
 */
export function simTransfers(
  transfers: readonly { token: string; from?: string | null | undefined; to: string; amount: string }[],
  chain = "near:mainnet",
) {
  // Solana addresses are case-sensitive base58 (Stage 4): only the other families compare lower-case
  const solana = chain.startsWith("solana:");
  return transfers.map((t) => ({
    to: toKey(chain, t.to),
    from: solana
      ? typeof t.from === "string" && t.from.length > 0 && t.from.length <= 64
        ? t.from
        : null
      : senderOf(t.from),
    assetId: t.token,
    amount: BigInt(t.amount),
  }));
}

async function verifySandbox(r: Rails, row: ExecutionRow, hashes: readonly string[]): Promise<VerifyOutcome> {
  const chains = r.providers.test?.chains;
  if (!chains) return pending({ reason: "sandbox not configured" });
  const recipient = row.destination_key.split("|")[1] as string;
  const expected = BigInt(row.amount_out_expected);
  let best: VerifyOutcome | null = null;
  for (const hash of hashes) {
    const tx = await chains.tx(row.destination_chain, hash);
    if (!tx) {
      best ??= { ...pending({ hash, reason: "unknown simulated tx" }), result: "not_found" };
      continue;
    }
    const family = r.profiles.get(row.destination_chain)?.family;
    if (family === "solana" && !tx.finalized) {
      best = pending({ hash, reason: "simulated tx not finalized" });
      continue;
    }
    if (family === "solana" || family === "bitcoin") {
      // §21.5: confirmations (Bitcoin) and the failed flag (Solana) decide, then the Stage 4 evidence detail
      const out = await sandboxChainOutcome(
        r,
        row,
        family,
        hash,
        tx,
        simTransfers(tx.transfers, row.destination_chain),
        r.profiles.get(row.destination_chain)?.confirmationTiers ?? [],
      );
      if (out.result === "pass" || out.result === "short") return out;
      best = out.result === "pending" || best === null ? out : best;
      continue;
    }
    if (!tx.finalized) {
      best = pending({ hash, reason: "simulated tx not final" });
      continue;
    }
    const transfers = simTransfers(tx.transfers, row.destination_chain);
    const c = compareTransfers(transfers, { recipient, assetId: row.destination_asset_id, expected });
    const out: VerifyOutcome = {
      result: c.result,
      tier: "A",
      source: "verifier",
      finality: row.destination_chain.startsWith("near:") ? "final" : "finalized",
      txHash: hash,
      blockRef: null,
      amount: c.amount,
      sender: c.sender,
      details: { hash, simulated: true },
    };
    if (c.result !== "mismatch") return out;
    best = out;
  }
  return best ?? pending({ reason: "no destination transactions yet" });
}

/** Tier B (§5): accept the provider's settlement within the per-payment and daily limits. */
async function tierB(r: Rails, row: ExecutionRow, details: Record<string, unknown>): Promise<VerifyOutcome> {
  const hash = row.destination_tx_hashes[0] ?? null;
  if (!hash) return pending({ ...details, reason: "provider reported no destination transaction" }, "B");
  const claimed = row.provider_amount_out ? BigInt(row.provider_amount_out) : null;
  if (claimed === null) return pending({ ...details, reason: "provider reported no amount" }, "B");
  const p = await policyFor(r, row.livemode);
  const token = await tokenOf(r, row.livemode, row.destination_asset_id);
  const usd = token ? usdMicros(claimed, pricedToken(token), p) : null;
  const today = await tierBToday(r, row);
  const ok = tierBAllowed(usd, today, r.tierB);
  const expected = BigInt(row.amount_out_expected);
  const base = {
    tier: "B" as const,
    source: "provider" as const,
    finality: "confirmed" as const,
    txHash: hash,
    blockRef: null,
    amount: claimed,
  };
  if (!ok.ok)
    return { ...base, result: "pending", details: { ...details, reason: ok.reason }, holdNow: "evidence_timeout" };
  return {
    ...base,
    result: claimed >= expected ? "pass" : "short",
    details: { ...details, usd_micros: usd?.toString() },
  };
}

async function tierBToday(r: Rails, row: ExecutionRow): Promise<bigint> {
  const rows = await sql<{ asset: string; amount: string }>`
    select destination_asset_id as asset, settled_amount::text as amount from executions
    where account_id = ${row.account_id} and livemode = ${row.livemode} and state = 'succeeded'
      and terminal_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
      and evidence->>'tier' = 'B'`.execute(r.db);
  let total = 0n;
  const p = await policyFor(r, row.livemode);
  for (const x of rows.rows) {
    const t = await tokenOf(r, row.livemode, x.asset);
    total += (t && x.amount ? usdMicros(BigInt(x.amount), pricedToken(t), p) : null) ?? 0n;
  }
  return total;
}

export async function verifyExecution(r: Rails, deps: VerifierDeps, row: ExecutionRow): Promise<VerifyOutcome> {
  const profile = r.profiles.get(row.destination_chain);
  if (!profile) return { ...pending({ reason: "chain has no profile" }), holdNow: "evidence_timeout" };
  const hashes = row.destination_tx_hashes;
  // §21.4: the tier the execution was created with (pinned since 0005), not today's profile
  if (verificationTier(r, row) === "B") return tierB(r, row, {});
  if (!row.livemode) return verifySandbox(r, row, hashes);
  if (hashes.length === 0) return pending({ reason: "no destination transactions yet" });
  if (profile.family === "evm") {
    const rpc = deps.evm.get(row.destination_chain);
    if (!rpc) return pending({ reason: "no RPC for chain" });
    return verifyEvm(r, rpc, row, hashes);
  }
  if (profile.family === "near") {
    if (!deps.near) return pending({ reason: "no NEAR RPC" });
    return verifyNear(r, deps.near, row, hashes);
  }
  const agreement = () => needsAgreement(r, row);
  if (profile.family === "solana") {
    // a Tier-A execution whose pool is gone is retried until its timeout, then held — never downgraded (§21.4)
    if (!deps.solana) return pending({ reason: "no Solana RPC pool" });
    return verifySolana(r, deps.solana, row, hashes, agreement);
  }
  if (profile.family === "bitcoin") {
    if (!deps.esplora) return pending({ reason: "no Bitcoin Esplora pool" });
    return verifyBitcoin(r, deps.esplora, row, hashes, profile.confirmationTiers ?? [], agreement);
  }
  return tierB(r, row, { reason: "no Tier A verifier for this chain family" });
}

/** Claims executions due for verification (`verify_at` ≤ now) with a lease. */
async function claimVerifications(r: Rails, limit: number): Promise<ExecutionRow[]> {
  const res = await sql<ExecutionRow>`
    update executions set verify_at = now() + make_interval(secs => ${LEASE_MS / 1000})
    where id in (
      select id from executions where verify_at is not null and verify_at <= now() and state in ('verifying','held')
      order by verify_at limit ${limit} for update skip locked)
    returning *`.execute(r.db);
  return res.rows;
}

export async function verifyOnce(r: Rails, deps: VerifierDeps, batch = 20): Promise<number> {
  const rows = await claimVerifications(r, batch);
  for (const row of rows) {
    let v: VerifyOutcome;
    try {
      v = await verifyExecution(r, deps, row);
    } catch (e) {
      v = pending({ reason: e instanceof Error ? e.message : String(e) });
    }
    await r.db.transaction().execute(async (tx) => {
      const cur = await lockExecution(tx, row.id);
      if (!cur || (cur.state !== "verifying" && cur.state !== "held")) return;
      const profile = r.profiles.get(cur.destination_chain);
      const since = (cur.verifying_since ?? cur.updated_at).getTime();
      const timedOut = r.now() - since > (profile?.verificationTimeoutS ?? 600) * 1000;
      const settles = v.result === "pass" || v.result === "short";
      if (!settles && !timedOut && !v.holdNow) {
        // not final / not found yet: retry without recording every attempt
        await applyChange(
          r,
          tx,
          cur,
          { verifyAt: new Date(r.now() + retryMsFor(r, cur.destination_chain)) },
          { cause: "verify later", actor: "verifier" },
        );
        return;
      }
      const after = await applyEvidence(r, tx, cur, {
        result: v.result,
        tier: v.tier,
        source: v.source,
        chain: cur.destination_chain,
        txHash: v.txHash,
        blockRef: v.blockRef,
        recipient: cur.destination_key.split("|")[1] as string,
        sender: v.sender ?? null,
        assetId: cur.destination_asset_id,
        amount: v.amount,
        finality: v.finality,
        details: v.details,
        ...(v.chainDetail ? { chainDetail: v.chainDetail } : {}),
      });
      if (after.state === "succeeded") return;
      if (after.state === "held") {
        // a held execution is re-verified while the provider claims success; stop at the timeout
        await applyChange(
          r,
          tx,
          after,
          { verifyAt: timedOut || v.holdNow ? null : new Date(r.now() + retryMsFor(r, cur.destination_chain)) },
          {
            cause: "re-verify",
            actor: "verifier",
          },
        );
        return;
      }
      const reason: HeldReason = v.holdNow ?? (v.result === "mismatch" ? "evidence_mismatch" : "evidence_timeout");
      r.log.error(
        { execution: cur.id, result: v.result, details: v.details },
        "ALERT execution held: no acceptable evidence",
      );
      await applyChange(
        r,
        tx,
        after,
        { state: "held", heldReason: reason, verifyAt: null, nextPollAt: new Date(r.now() + 300_000) },
        {
          cause: `verification ${v.result}: ${String(v.details.reason ?? "")}`.trim(),
          actor: "verifier",
        },
      );
    });
  }
  return rows.length;
}

export function verifierTask(r: Rails, deps: VerifierDeps, o: { tickMs?: number } = {}) {
  return {
    name: "verifier",
    start() {
      let stopped = false;
      let timer: NodeJS.Timeout | undefined;
      let running: Promise<void> = Promise.resolve();
      const tick = () => {
        if (stopped) return;
        running = verifyOnce(r, deps)
          .catch((e) => r.log.error({ err: e }, "verifier tick failed"))
          .then(() => {
            if (!stopped) timer = setTimeout(tick, o.tickMs ?? VERIFIER_TICK_MS);
          });
      };
      tick();
      return {
        async stop() {
          stopped = true;
          clearTimeout(timer);
          await running;
        },
      };
    },
  };
}
