/**
 * Destination minimums (lld/rails.md §8.9), hourly: for each active watched (mode, chain, asset,
 * kind) a dry `EXACT_OUTPUT` quote of USD 100 of the destination asset from a liquid origin (a USD
 * stablecoin paid from Intents, so no payer chain is involved) yields the withdraw fee;
 * min = max(USD 1.00, 20 × withdraw fee). Intents-account destinations: USD 0.01. A failed
 * computation keeps the last value.
 */
import { NearAccountId } from "@nearpay/spec";
import type { OneClickQuoteRequest } from "@nearpay-internal/spec";
import { unitsForUsdMicros, usdMicros } from "../domain/pricing/pricing.js";
import { minimumUsdMicros } from "../domain/verification/verification.js";
import type { Rails } from "./context.js";
import { policyFor } from "./pricing.js";
import { enabledTokens, tokenOf } from "./tokens.js";
import { pricedToken, type TokenRowDb } from "./views.js";

const HUNDRED_USD = 100_000_000n;

function liquidOrigin(tokens: readonly TokenRowDb[], d: TokenRowDb): TokenRowDb | undefined {
  const stables = tokens.filter((t) => t.chain === "near:mainnet" && t.is_usd_stable && t.asset_id !== d.asset_id);
  return stables.find((t) => t.family === d.family) ?? stables.find((t) => t.family === "USDC") ?? stables[0];
}

async function withdrawFeeUsdMicros(
  r: Rails,
  livemode: boolean,
  d: TokenRowDb,
  address: string,
): Promise<bigint | null> {
  const provider = livemode ? r.providers.live : r.providers.test;
  if (!provider) return null;
  const p = await policyFor(r, livemode);
  const amount = unitsForUsdMicros(HUNDRED_USD, pricedToken(d), p);
  const origin = liquidOrigin(await enabledTokens(r, livemode), d);
  if (!amount || !origin) return null;
  const refundTo = livemode ? (r.treasury ?? r.intentsContract) : r.testTreasury;
  if (!NearAccountId.safeParse(refundTo).success) return null;
  const req: OneClickQuoteRequest = {
    dry: true,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset: origin.asset_id,
    depositType: "INTENTS",
    destinationAsset: d.asset_id,
    amount: amount.toString(),
    refundTo,
    refundType: "INTENTS",
    recipient: address,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(r.now() + 3_600_000).toISOString(),
    referral: r.referral,
    quoteWaitingTimeMs: 3_000,
  };
  const out = await provider.quote(livemode, req, livemode ? undefined : { amount: "0" });
  if (!out.ok) {
    r.log.warn({ asset: d.asset_id, kind: out.kind }, "minimum: dry quote failed");
    return null;
  }
  const fee = out.response.quote.withdrawFee;
  if (fee == null || !/^\d+$/.test(fee)) return null;
  return usdMicros(BigInt(fee), pricedToken(d), p);
}

/** Recomputes every active destination's minimum. Returns rows written. */
export async function refreshMinimums(r: Rails): Promise<number> {
  const groups = await r.db
    .selectFrom("watched_destinations")
    .select(["livemode", "chain", "asset_id", "type", "address_norm"])
    .where("active", "=", true)
    .distinctOn(["livemode", "chain", "asset_id", "type"])
    .orderBy("livemode")
    .orderBy("chain")
    .orderBy("asset_id")
    .orderBy("type")
    .orderBy("updated_at")
    .execute();
  let written = 0;
  for (const g of groups) {
    const d = await tokenOf(r, g.livemode, g.asset_id);
    if (!d?.enabled) continue;
    const kind = g.type === "intents_account" ? "intents" : "chain";
    const fee = kind === "chain" ? await withdrawFeeUsdMicros(r, g.livemode, d, g.address_norm) : 0n;
    const minUsd = minimumUsdMicros(kind, fee);
    if (minUsd === null) continue;
    const base = unitsForUsdMicros(minUsd, pricedToken(d), await policyFor(r, g.livemode));
    if (base === null) continue;
    const values = {
      livemode: g.livemode,
      chain: g.chain,
      asset_id: g.asset_id,
      kind: kind as "intents" | "chain",
      min_amount_base: base.toString(),
      min_usd_micros: minUsd.toString(),
      computed_at: new Date(r.now()),
    };
    await r.db
      .insertInto("destination_minimums")
      .values(values)
      .onConflict((oc) =>
        oc.columns(["livemode", "chain", "asset_id", "kind"]).doUpdateSet({
          min_amount_base: values.min_amount_base,
          min_usd_micros: values.min_usd_micros,
          computed_at: values.computed_at,
        }),
      )
      .execute();
    written++;
  }
  return written;
}
