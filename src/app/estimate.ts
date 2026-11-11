/**
 * `GET /internal/settlement-estimate` (lld/rails.md §6, §8.2): the execution pricing rules without quoting. Payments
 * values non-USD prices in USD micros (minimums, unverified cap) and gets the options `amount_out`.
 */

import { ApiError } from "@nearpay-internal/service";
import type { estimateSettlement, SettlementEstimate } from "@nearpay-internal/spec";
import type { RouteQuery } from "@nearpay-money/spec";
import { type Pricing, PricingError, settle, usdValue } from "../domain/pricing/pricing.js";
import { convertUnits, toDisplayDecimal } from "../domain/pricing/ratio.js";
import type { Rails } from "./context.js";
import { pricingApiError } from "./executions.js";
import { policyFor, pricedToken } from "./pricing.js";
import { tokenAnyMode, tokenOf } from "./tokens.js";

type Query = RouteQuery<typeof estimateSettlement>;

export async function estimate(r: Rails, q: Query): Promise<SettlementEstimate> {
  if (q.currency === "asset" && !q.asset_id)
    throw ApiError.invalid("asset_id is required for asset pricing", "asset_id");
  const probe = q.asset_id ?? q.settlement_asset;
  const lm = q.livemode ?? (probe ? (await tokenAnyMode(r, probe))?.livemode : undefined) ?? true;
  const pricingAsset = q.currency === "asset" ? await tokenOf(r, lm, q.asset_id as string) : undefined;
  if (q.currency === "asset" && !pricingAsset?.enabled)
    throw new ApiError("asset_unsupported", { params: { asset_id: q.asset_id as string }, param: "asset_id" });
  const d = q.settlement_asset ? await tokenOf(r, lm, q.settlement_asset) : undefined;
  if (q.settlement_asset && !d?.enabled)
    throw new ApiError("asset_unsupported", { params: { asset_id: q.settlement_asset }, param: "settlement_asset" });

  const pricing: Pricing =
    q.currency === "asset"
      ? { currency: "asset", assetId: q.asset_id as string, amount: BigInt(q.amount) }
      : { currency: q.currency, amount: BigInt(q.amount) };
  const p = await policyFor(r, lm);
  const lookup = (id: string) => (pricingAsset && pricingAsset.asset_id === id ? pricedToken(pricingAsset) : undefined);
  try {
    const v = usdValue(pricing, p, lookup);
    const usdMicros = convertUnits(1n, 0, v.usd, 6, "floor");
    const pricingView = { amount: q.amount, currency: q.currency, asset_id: q.asset_id ?? null };
    if (d) {
      const s = settle(pricing, pricedToken(d), p, lookup);
      return {
        pricing: pricingView,
        usd_micros: usdMicros.toString(),
        settlement: { asset_id: d.asset_id, amount_base: s.amount.toString(), par: s.par },
        price_snapshot: s.snapshot,
      } as SettlementEstimate;
    }
    return {
      pricing: pricingView,
      usd_micros: usdMicros.toString(),
      settlement: null,
      price_snapshot: {
        primary_usd: null,
        secondary_usd: null,
        fx: v.fx ? toDisplayDecimal(v.fx.value) : null,
        par: false,
        as_of: new Date(p.nowMs).toISOString(),
        currency: q.currency,
        par_currency: null,
        rates: v.rates,
      },
    } as SettlementEstimate;
  } catch (e) {
    if (e instanceof PricingError) {
      if (e.code === "amount_too_small") throw ApiError.invalid(e.message, "amount");
      const err = pricingApiError(r, e, "amount");
      throw err;
    }
    throw e;
  }
}
