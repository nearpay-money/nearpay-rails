/**
 * Credit → execution attribution shared by the NEAR indexer, the sandbox feed and the EVM watchers
 * (lld/rails.md §8.6, §8.7). Idempotent: re-processing a block finds the execution already settled.
 *
 * - Binding credits (DIP-4 transfer with an `np1:` memo) settle the `intents_transfer` execution with
 *   that binding when receiver and asset match: amount ≥ expected → pass, less → short.
 * - Amount credits settle the single in-flight `route_quote` execution to that destination expecting
 *   exactly that amount, and only a tagged one (untagged executions rely on the provider tx hash).
 *   Ambiguity attributes nothing (domain/verification attribute()).
 * - Transfers to a watched destination that match nothing are recorded as unattributed.
 */
import { uuidv7 } from "@nearpay-internal/ids";
import type { Rails } from "../app/context.js";
import { type EvidenceInput, settleWithEvidence } from "../app/observations.js";
import { attribute } from "../domain/verification/verification.js";
import type { Credit } from "./near-indexer/parse.js";

export interface MatchOptions {
  readonly livemode: boolean;
  readonly source: "indexer" | "watcher";
  readonly finality: EvidenceInput["finality"];
  readonly tier?: "A" | "B";
  /** Extra confirmation for an attributed credit (e.g. a second RPC for large amounts). */
  readonly confirm?: (c: Credit, executionId: string, expected: bigint) => Promise<boolean>;
}

export interface MatchResult {
  readonly settled: number;
  readonly unattributed: number;
}

interface Candidate {
  readonly id: string;
  readonly expected: bigint;
  readonly tagged: boolean;
}

export async function matchCredits(r: Rails, credits: readonly Credit[], o: MatchOptions): Promise<MatchResult> {
  let settled = 0;
  let unattributed = 0;
  if (credits.length === 0) return { settled, unattributed };
  const evidence = (c: Credit, result: "pass" | "short", details: Record<string, unknown>): EvidenceInput => ({
    result,
    tier: o.tier ?? "A",
    source: o.source,
    chain: c.chain,
    txHash: c.txHash,
    blockRef: c.blockRef,
    recipient: c.to,
    sender: c.from,
    assetId: c.assetId,
    amount: c.amount,
    finality: o.finality,
    details: { log_ref: c.logRef, ...(c.details ?? {}), ...details },
    ...(c.detail ? { chainDetail: c.detail } : {}),
  });

  // 1. bindings
  const bindings = [
    ...new Set(credits.filter((c) => c.kind === "binding" && c.memo?.startsWith("np1:")).map((c) => c.memo as string)),
  ];
  if (bindings.length) {
    const rows = await r.db
      .selectFrom("executions")
      .select(["id", "kind", "binding", "recipient", "fee_recipient", "destination_asset_id", "amount_out_expected"])
      .where("binding", "in", bindings)
      .where("livemode", "=", o.livemode)
      .where("terminal_at", "is", null)
      .where((eb) => eb.or([eb("state", "<>", "expired_unpaid"), eb("tracking_until", ">", new Date(r.now()))]))
      .execute();
    for (const x of rows) {
      const c = credits.find(
        (k) =>
          k.kind === "binding" && k.memo === x.binding && k.to === x.recipient && k.assetId === x.destination_asset_id,
      );
      if (!c) continue;
      const expected = BigInt(x.amount_out_expected);
      const result = c.amount >= expected ? "pass" : "short";
      if (o.confirm && !(await o.confirm(c, x.id, expected))) continue;
      // spec 0.2.1: the executed payload's fee transfer (same binding, same tx, to the fee recipient) is the observed
      // fee of a payment; what the payer moved is the merchant transfer plus that fee
      const feeTo = x.fee_recipient?.toLowerCase() ?? null;
      const fee =
        x.kind === "payment" && feeTo
          ? credits
              .filter(
                (k) =>
                  k.kind === "binding" &&
                  k.memo === x.binding &&
                  k.txHash === c.txHash &&
                  k.to === feeTo &&
                  k.assetId === x.destination_asset_id,
              )
              .reduce((a, k) => a + k.amount, 0n)
          : 0n;
      const done = await settleWithEvidence(r, x.id, {
        ...evidence(c, result, { binding: x.binding }),
        ...(x.kind === "payment" ? { observedFee: { amount: fee, assetId: x.destination_asset_id } } : {}),
        depositedAmount: c.amount + fee,
      });
      if (done?.state === "succeeded") settled++;
    }
  }

  // 2. amounts
  const amountCredits = credits.filter((c) => c.kind === "amount");
  if (amountCredits.length) {
    const keys = [...new Set(amountCredits.map((c) => `${c.chain}|${c.to}|${c.assetId}`))];
    const rows = await r.db
      .selectFrom("executions")
      .select(["id", "destination_key", "amount_out_expected", "amount_tag"])
      .where("destination_key", "in", keys)
      .where("livemode", "=", o.livemode)
      .where("method", "=", "route_quote")
      .where("terminal_at", "is", null)
      // expired executions stay attributable during the late-refund window only (their tag is released after it)
      .where((eb) => eb.or([eb("state", "<>", "expired_unpaid"), eb("tracking_until", ">", new Date(r.now()))]))
      .execute();
    const byKey = new Map<string, Candidate[]>();
    for (const x of rows) {
      const list = byKey.get(x.destination_key) ?? [];
      list.push({ id: x.id, expected: BigInt(x.amount_out_expected), tagged: BigInt(x.amount_tag) > 0n });
      byKey.set(x.destination_key, list);
    }
    const watched = await watchedKeys(r, o.livemode, keys);
    for (const c of amountCredits) {
      const key = `${c.chain}|${c.to}|${c.assetId}`;
      const hit = attribute(byKey.get(key) ?? [], c.amount);
      if (hit?.tagged && (!o.confirm || (await o.confirm(c, hit.id, hit.expected)))) {
        const done = await settleWithEvidence(r, hit.id, evidence(c, "pass", { tag_match: true }));
        if (done?.state === "succeeded") settled++;
        continue;
      }
      if (watched.has(key)) {
        unattributed++;
        r.metrics.unattributed(c.chain);
        await r.db
          .insertInto("unattributed_transfers")
          .values({
            id: uuidv7(),
            chain: c.chain,
            tx_hash: c.txHash,
            log_ref: c.logRef,
            recipient: c.to,
            asset_id: c.assetId,
            amount: c.amount.toString(),
            reason: hit
              ? "untagged execution (provider hash attributes)"
              : "no in-flight execution expects this amount",
          })
          .onConflict((oc) => oc.columns(["chain", "tx_hash", "log_ref"]).doNothing())
          .execute();
      }
    }
  }
  return { settled, unattributed };
}

async function watchedKeys(r: Rails, livemode: boolean, keys: readonly string[]): Promise<Set<string>> {
  const parts = keys.map((k) => k.split("|") as [string, string, string]);
  if (parts.length === 0) return new Set();
  const rows = await r.db
    .selectFrom("watched_destinations")
    .select(["chain", "address_norm", "asset_id"])
    .where("livemode", "=", livemode)
    .where("active", "=", true)
    .where("address_norm", "in", [...new Set(parts.map((p) => p[1]))])
    .execute();
  return new Set(rows.map((w) => `${w.chain}|${w.address_norm}|${w.asset_id}`));
}
