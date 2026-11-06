/** Request builders for the rails API. */
import { randomBytes } from "node:crypto";
import { newId } from "@nearpay-internal/ids";
import { MERCHANT_EVM, PAYER, USDC_ARB, USDC_BASE, USDC_NEAR } from "./stack.js";

export const FEE_SCHEDULE = {
  id: newId("fs"),
  name: "standard",
  rules: {
    same_asset: { total_bps: 20, min_fee_usd_micros: 0 },
    stable_pair: { total_bps: 50, min_fee_usd_micros: 0 },
    volatile: { total_bps: 100, min_fee_usd_micros: 0 },
    intents_transfer: { total_bps: 30, min_fee_usd_micros: 1000 },
  },
  provider_split: { oneclick: { share_bps: 5000, floor_bps: 20, stable_floor_bps: 1 } },
};

export const ACCOUNT = newId("acct");

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface CreateBody {
  idempotency_key: string;
  kind: "payment";
  method: "route_quote" | "intents_transfer";
  account_id: string;
  livemode: boolean;
  origin: { asset_id: string; chain: string; refund_to: string; refund_type: "origin_chain" | "intents" };
  destination: { asset_id: string; type: "chain_address" | "intents_account"; chain: string; address: string };
  pricing: { currency: string; amount: number } | { currency: "asset"; asset_id: string; amount: string };
  fee: { schedule: typeof FEE_SCHEDULE; bearer: "payer" | "merchant" };
  deadline_cap: string | null;
  slippage_bps?: number;
}

/** Base USDC → Arbitrum USDC address, USD 20.00 (scenario 00), test mode. */
export function routeQuote(over: DeepPartial<CreateBody> = {}): CreateBody {
  const b: CreateBody = {
    idempotency_key: `attempt:${newId("pa")}`,
    kind: "payment",
    method: "route_quote",
    account_id: ACCOUNT,
    livemode: false,
    origin: { asset_id: USDC_BASE, chain: "eip155:8453", refund_to: PAYER, refund_type: "origin_chain" },
    destination: { asset_id: USDC_ARB, type: "chain_address", chain: "eip155:42161", address: MERCHANT_EVM },
    pricing: { currency: "usd", amount: 2000 },
    fee: { schedule: FEE_SCHEDULE, bearer: "payer" },
    deadline_cap: null,
  };
  return {
    ...b,
    ...over,
    origin: { ...b.origin, ...over.origin },
    destination: { ...b.destination, ...over.destination },
    pricing: (over.pricing ?? b.pricing) as CreateBody["pricing"],
    fee: { ...b.fee, ...(over.fee as object) } as CreateBody["fee"],
  } as CreateBody;
}

/** Base USDC → a merchant Intents account (NEAR USDC). */
export function toIntents(account: string, over: DeepPartial<CreateBody> = {}): CreateBody {
  return routeQuote({
    ...over,
    destination: {
      asset_id: USDC_NEAR,
      type: "intents_account",
      chain: "near:mainnet",
      address: account,
      ...over.destination,
    },
  });
}

/** Payer Intents account → merchant Intents account, same asset. */
export function intentsTransfer(payer: string, merchant: string, over: DeepPartial<CreateBody> = {}): CreateBody {
  return routeQuote({
    method: "intents_transfer",
    ...over,
    origin: { asset_id: USDC_NEAR, chain: "near:mainnet", refund_to: payer, refund_type: "intents", ...over.origin },
    destination: {
      asset_id: USDC_NEAR,
      type: "intents_account",
      chain: "near:mainnet",
      address: merchant,
      ...over.destination,
    },
  });
}

export const randomEvm = () => `0x${randomBytes(20).toString("hex")}`;
