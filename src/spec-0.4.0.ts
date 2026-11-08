/**
 * PLACEHOLDER — spec 0.4.0 contract types that are not published yet (step 4.2 Phase A).
 *
 * This is the ONE file in rails that mirrors unpublished contracts. It copies, without changes, the schemas and helpers
 * rails needs from the spec branches:
 * - `nearpay-spec` `stage-4/4.1-chains` @25ab1af: `src/common/chains.ts` (Solana/Bitcoin evidence, confirmation tiers,
 *   omft ids), `Evidence.solana` / `Evidence.bitcoin`, `ChainProfile.explorer_address_url` / `confirmation_tiers`,
 *   sandbox `SimTx` additions;
 * - `nearpay-spec` `stage-4/4.1-autodebit` @d9ef8c6: `src/vault/contract.ts` (`VaultEvent`, `parseVaultEventLog`) and
 *   `src/internal/vault.ts` (`VaultEventRecord`, reject reasons), sandbox `/sim/intents/events` receipt fields.
 *
 * Phase B (spec 0.4.0 published): delete this file and import every name from `@nearpay/spec` /
 * `@nearpay-internal/spec`; the vector fixtures under `test/fixtures/spec-0.4.0/` go too (the package ships them).
 */
import { BaseUnits, closedEnum, MAX_SAFE_INTEGER, NearAccountId, openEnum, out, TxHash, z } from "@nearpay/spec";

// stage 4 — chains (nearpay-spec src/common/chains.ts)

export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
export const BITCOIN_MAINNET = "bip122:000000000019d6689c085ae165831e93" as const;

const B58 = "[1-9A-HJ-NP-Za-km-z]";
export const SolanaAddress = z.string().regex(new RegExp(`^${B58}{32,44}$`), "must be a base58 Solana address");
export const SolanaSignature = z.string().regex(new RegExp(`^${B58}{64,88}$`), "must be a base58 Solana signature");
export const BitcoinTxid = z.string().regex(/^[0-9a-f]{64}$/, "must be a 64-char lower-case hex txid");

export const SolanaEvidence = out({
  signature: SolanaSignature,
  slot: z.int().min(0),
  block_time: z.int().min(0).nullable(),
  mint: SolanaAddress.nullable(),
  token_program: SolanaAddress.nullable(),
  owner: SolanaAddress,
  token_accounts: z.array(SolanaAddress),
  pre_amount: BaseUnits.nullable(),
  post_amount: BaseUnits.nullable(),
});
export type SolanaEvidence = z.infer<typeof SolanaEvidence>;

export const BitcoinEvidence = out({
  txid: BitcoinTxid,
  outputs: z
    .array(
      out({
        vout: z.int().min(0),
        value: BaseUnits,
        script_pubkey: z.string().regex(/^[0-9a-f]{2,200}$/),
      }),
    )
    .min(1),
  block_height: z.int().min(0),
  block_hash: z.string().regex(/^[0-9a-f]{64}$/),
  confirmations: z.int().min(1),
  required_confirmations: z.int().min(1),
});
export type BitcoinEvidence = z.infer<typeof BitcoinEvidence>;

export const ConfirmationTier = out({
  below_usd_micros: z.int().min(1).nullable(),
  confirmations: z.int().min(1).max(100),
});
export type ConfirmationTier = z.infer<typeof ConfirmationTier>;

export function requiredConfirmations(tiers: readonly ConfirmationTier[], usdMicros: bigint): number {
  for (const t of tiers)
    if (t.below_usd_micros === null || usdMicros < BigInt(t.below_usd_micros)) return t.confirmations;
  throw new RangeError("confirmation tiers must end with an unbounded tier");
}

export const BITCOIN_CONFIRMATION_TIERS: readonly ConfirmationTier[] = Object.freeze([
  { below_usd_micros: 1_000_000_000, confirmations: 1 },
  { below_usd_micros: null, confirmations: 2 },
]);

export interface OmftAsset {
  readonly blockchain: string;
  readonly kind: "native" | "evm" | "hash20";
  readonly token: string | null;
}

export function parseOmftAssetId(assetId: string): OmftAsset | null {
  const m = /^nep141:([a-z0-9]+)(?:-(0x[0-9a-f]{40}|[0-9a-f]{40}))?\.omft\.near$/.exec(assetId);
  if (!m) return null;
  const blockchain = m[1] as string;
  const token = m[2] ?? null;
  if (token === null) return { blockchain, kind: "native", token: null };
  return { blockchain, kind: token.startsWith("0x") ? "evm" : "hash20", token };
}

/** spec 0.4.0 `Evidence.solana` / `Evidence.bitcoin` (nullable, optional) on top of the 0.3.1 fields. */
export interface EvidenceChainDetail {
  readonly solana?: SolanaEvidence | null;
  readonly bitcoin?: BitcoinEvidence | null;
}

/** spec 0.4.0 `ChainProfile` additions (nullable, optional). */
export interface ChainProfileAdditions {
  readonly explorer_address_url?: string | null;
  readonly confirmation_tiers?: readonly ConfirmationTier[] | null;
}

/** spec 0.4.0 sandbox `SimTx` additions (all optional). */
export const SimTxAdditions = out({
  block_ref: z.string().nullable().optional(),
  confirmations: z.int().min(0).nullable().optional(),
  failed: z.boolean().optional(),
  transfers: z
    .array(
      out({
        vout: z.int().min(0).nullable().optional(),
        token_account: z.string().nullable().optional(),
      }),
    )
    .optional(),
});
export type SimTxAdditions = z.infer<typeof SimTxAdditions>;

// end stage 4 — chains

// stage 4 — autodebit (nearpay-spec src/vault/contract.ts, src/internal/vault.ts, src/internal/sandbox.ts)

export const VAULT_EVENT_STANDARD = "nearpay_vault" as const;
export const VAULT_EVENT_VERSION = "1.0.0" as const;
export const EVENT_JSON_PREFIX = "EVENT_JSON:" as const;

const U128 = z.string().regex(/^(0|[1-9][0-9]{0,38})$/, "must be a canonical u128 decimal string");
const U64Ns = z.string().regex(/^(0|[1-9][0-9]{0,19})$/, "must be a canonical u64 decimal string");
const MandateIdNum = z.int().min(0).max(MAX_SAFE_INTEGER);
const PeriodSecs = z.int().min(86_400).max(379_468_800);
const MaxPeriods = z.int().min(1).max(2_147_483_647).nullable();
const FeeBps = z.int().min(0).max(10_000);
const ExtRef = z
  .string()
  .max(64)
  .regex(/^[\x20-\x7e]*$/, "must be printable ASCII");
const VaultReceiverKind = closedEnum(["intents_account", "near_account"], "Receiver kind.");

const VAULT_EVENTS = {
  mandate_created: out({
    mandate_id: MandateIdNum,
    payer: NearAccountId,
    merchant_receiver: NearAccountId,
    token: NearAccountId,
    amount_per_period: U128,
    period_secs: PeriodSecs,
    start_at: U64Ns,
    max_periods: MaxPeriods,
    fee_bps: FeeBps,
    ext_ref: ExtRef,
    receiver_kind: VaultReceiverKind,
    balance: U128,
  }),
  topped_up: out({ mandate_id: MandateIdNum, amount: U128, balance: U128 }),
  collected: out({
    mandate_id: MandateIdNum,
    period: z.int().min(1),
    amount: U128,
    merchant_share: U128,
    fee: U128,
    balance: U128,
  }),
  collect_failed: out({
    mandate_id: MandateIdNum,
    period: z.int().min(1),
    reason: openEnum(["merchant_transfer_failed"], "Why."),
  }),
  canceled: out({ mandate_id: MandateIdNum, by: NearAccountId, refunded: U128 }),
  withdrawn: out({ mandate_id: MandateIdNum, amount: U128 }),
  exhausted: out({ mandate_id: MandateIdNum }),
} as const;
type VaultEventName = keyof typeof VAULT_EVENTS;
const VAULT_EVENT_NAMES = Object.keys(VAULT_EVENTS) as [VaultEventName, ...VaultEventName[]];

const variant = <N extends VaultEventName>(name: N) =>
  out({
    standard: z.literal(VAULT_EVENT_STANDARD),
    version: z.literal(VAULT_EVENT_VERSION),
    event: z.literal(name),
    data: z.tuple([VAULT_EVENTS[name]]),
  });

export const VaultEvent = z.discriminatedUnion(
  "event",
  VAULT_EVENT_NAMES.map((n) => variant(n)) as unknown as [ReturnType<typeof variant>, ...ReturnType<typeof variant>[]],
);
export type VaultEvent = {
  [N in VaultEventName]: {
    standard: typeof VAULT_EVENT_STANDARD;
    version: typeof VAULT_EVENT_VERSION;
    event: N;
    data: [z.infer<(typeof VAULT_EVENTS)[N]>];
  };
}[VaultEventName];

export function parseVaultEventLog(line: string): VaultEvent | null {
  if (!line.startsWith(EVENT_JSON_PREFIX)) return null;
  let json: unknown;
  try {
    json = JSON.parse(line.slice(EVENT_JSON_PREFIX.length));
  } catch {
    return null;
  }
  const r = VaultEvent.safeParse(json);
  return r.success ? (r.data as VaultEvent) : null;
}

export const VaultEventRecord = out({
  vault_contract: NearAccountId,
  tx_hash: TxHash,
  receipt_id: z.string().min(1).max(64),
  log_index: z.int().min(0),
  block_height: z.int().min(0),
  block_hash: z.string().min(1).max(64),
  block_timestamp: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  event: VaultEvent,
});
export type VaultEventRecord = z.infer<typeof VaultEventRecord>;

export function vaultEventDedupeKey(r: Pick<VaultEventRecord, "receipt_id" | "log_index">): string {
  return `${r.receipt_id}:${r.log_index}`;
}

export const VAULT_EVENT_REJECT_REASONS = [
  "wrong_executor",
  "failed_receipt",
  "not_final",
  "bad_version",
  "bad_schema",
] as const;

/** Subject of the forwarded events (catalogue entry `evt.rails.vault.event`, aggregate `vault_mandate`). */
export const VAULT_EVENT_SUBJECT = "evt.rails.vault.event" as const;

/** Sandbox `/sim/intents/events` item receipt fields (Stage 4, all optional). */
export const SimEventReceiptFields = out({
  receipt_id: z.string().optional(),
  log_index: z.int().min(0).optional(),
  executor_id: NearAccountId.optional(),
  block_hash: z.string().optional(),
  block_timestamp: z.string().optional(),
  receipt_status: closedEnum(["success", "failure"], "Receipt outcome.").optional(),
});
export type SimEventReceiptFields = z.infer<typeof SimEventReceiptFields>;

// end stage 4 — autodebit
