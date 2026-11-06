/** Kysely table types (migrations/0001_rails.sql). Numeric columns travel as decimal strings. */
import type { ColumnType, KitTables } from "@nearpay-internal/db";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json<T> = ColumnType<T, string, string>;
type NullableJson<T> = ColumnType<T | null, string | null | undefined, string | null>;
type TextArray = ColumnType<string[], string[] | undefined, string[]>;
/** numeric(78,0) / numeric(38,18): pg returns strings; we write strings. */
type Numeric = ColumnType<string, string, string>;
type NullableNumeric = ColumnType<string | null, string | null | undefined, string | null>;
/** Nullable column that may be omitted on insert. */
type Opt<T> = ColumnType<T | null, T | null | undefined, T | null>;
/** Column with a database default. */
type Def<T> = ColumnType<T, T | undefined, T>;

export interface TokensTable {
  livemode: boolean;
  asset_id: string;
  blockchain: string;
  chain: string;
  symbol: string;
  decimals: number;
  contract_address: string | null;
  family: string;
  is_usd_stable: boolean;
  enabled: boolean;
  price_usd: NullableNumeric;
  price_updated_at: NullableTimestamp;
  secondary_price_usd: NullableNumeric;
  secondary_updated_at: NullableTimestamp;
  memo_required: boolean;
  refreshed_at: Timestamp;
}

export interface WatchedDestinationsTable {
  destination_id: string;
  account_id: string;
  livemode: boolean;
  chain: string;
  address_norm: string;
  asset_id: string;
  type: "chain_address" | "intents_account";
  active: boolean;
  source_version: number;
  updated_at: Timestamp;
}

export type ExecutionState =
  | "quoting"
  | "awaiting_deposit"
  | "deposit_detected"
  | "incomplete_deposit"
  | "settling"
  | "verifying"
  | "succeeded"
  | "refunded"
  | "failed"
  | "expired_unpaid"
  | "held";

export type PriceSnapshotRow = {
  primary_usd: string | null;
  secondary_usd: string | null;
  fx: string | null;
  par: boolean;
  as_of: string;
};

export type EvidenceRow = {
  chain: string;
  tx_hash: string;
  block_ref: string | null;
  recipient: string;
  asset_id: string;
  amount: string;
  finality: "final" | "finalized" | "confirmed";
  tier: "A" | "B";
  source: "watcher" | "indexer" | "verifier" | "provider" | "operator";
  observed_at: string;
  explorer_url: string | null;
};

export interface ExecutionsTable {
  id: string;
  account_id: string;
  livemode: boolean;
  owner: Def<"payments" | "agentpay">;
  kind: "payment" | "refund";
  method: "route_quote" | "intents_transfer";
  provider: "oneclick" | "sandbox" | "direct_intents";
  idempotency_key: string;
  state: ExecutionState;
  provider_status: Opt<string>;
  provider_updated_at: NullableTimestamp;
  origin_asset_id: string;
  origin_chain: string;
  refund_to: string;
  refund_type: "origin_chain" | "intents";
  destination_asset_id: string;
  recipient: string;
  recipient_type: "destination_chain" | "intents";
  destination_chain: string;
  destination_key: string;
  route_class: "same_asset" | "stable_pair" | "volatile" | "intents_transfer";
  applied_fee_bps: number;
  fee_recipient: Opt<string>;
  fee_amount: NullableNumeric;
  amount_out_base: Numeric;
  amount_tag: ColumnType<string, string | undefined, string>;
  amount_out_expected: Numeric;
  price_snapshot: NullableJson<PriceSnapshotRow>;
  quote_request: NullableJson<Record<string, unknown>>;
  quote_response: NullableJson<Record<string, unknown>>;
  correlation_id: Opt<string>;
  deposit_address: Opt<string>;
  deposit_memo: Opt<string>;
  amount_in: NullableNumeric;
  min_amount_in: NullableNumeric;
  binding: Opt<string>;
  deadline: Timestamp;
  time_when_inactive: NullableTimestamp;
  deposit_tx_hashes: TextArray;
  has_signal: ColumnType<boolean, boolean | undefined, boolean>;
  next_poll_at: NullableTimestamp;
  poll_count: ColumnType<number, number | undefined, number>;
  not_found_count: ColumnType<number, number | undefined, number>;
  priority: ColumnType<number, number | undefined, number>;
  verify_at: NullableTimestamp;
  verifying_since: NullableTimestamp;
  settled_amount: NullableNumeric;
  refunded_amount: NullableNumeric;
  refund_reason: Opt<string>;
  provider_amount_out: NullableNumeric;
  destination_tx_hashes: TextArray;
  evidence: NullableJson<EvidenceRow>;
  failure_code: Opt<string>;
  held_reason: Opt<string>;
  terminal_at: NullableTimestamp;
  tracking_until: NullableTimestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: ColumnType<number, number | undefined, number>;
}

export interface AmountTagsTable {
  destination_key: string;
  tag: Numeric;
  expected: Numeric;
  execution_id: string;
  allocated_at: Timestamp;
  released_at: NullableTimestamp;
}

export type ObservationSource =
  | "quote"
  | "submit"
  | "hot_poll"
  | "explorer"
  | "indexer"
  | "watcher"
  | "verifier"
  | "operator";

export interface ProviderObservationsTable {
  id: string;
  execution_id: string;
  source: ObservationSource;
  provider_status: string | null;
  payload: Json<unknown>;
  payload_sha256: Buffer;
  provider_updated_at: NullableTimestamp;
  applied: boolean;
  observed_at: Timestamp;
}

export interface VerificationsTable {
  id: string;
  execution_id: string;
  tier: "A" | "B";
  chain: string;
  source: string;
  tx_hash: string | null;
  block_ref: string | null;
  recipient: string | null;
  asset_id: string | null;
  amount: NullableNumeric;
  finality: string | null;
  result: "pass" | "short" | "mismatch" | "not_found" | "pending";
  details: Json<Record<string, unknown>>;
  checked_at: Timestamp;
}

export interface UnattributedTransfersTable {
  id: string;
  chain: string;
  tx_hash: string;
  log_ref: string;
  recipient: string;
  asset_id: string;
  amount: Numeric;
  reason: string;
  observed_at: Timestamp;
}

export interface ExecutionTransitionsTable {
  id: string;
  execution_id: string;
  from_state: string | null;
  to_state: string;
  cause: string;
  actor: string;
  observation_id: string | null;
  evidence: NullableJson<unknown>;
  created_at: Timestamp;
}

export interface CursorsTable {
  name: string;
  value: Json<unknown>;
  updated_at: Timestamp;
}

export interface ControlFlagsTable {
  name: string;
  value: boolean;
  reason: string | null;
  source_version: ColumnType<number, number | undefined, number>;
  updated_at: Timestamp;
}

export interface DestinationMinimumsTable {
  livemode: boolean;
  chain: string;
  asset_id: string;
  kind: "intents" | "chain";
  min_amount_base: NullableNumeric;
  min_usd_micros: ColumnType<string | null, string | number | null | undefined, string | number | null>;
  computed_at: NullableTimestamp;
}

export interface RailsTables {
  tokens: TokensTable;
  watched_destinations: WatchedDestinationsTable;
  executions: ExecutionsTable;
  amount_tags: AmountTagsTable;
  provider_observations: ProviderObservationsTable;
  verifications: VerificationsTable;
  unattributed_transfers: UnattributedTransfersTable;
  execution_transitions: ExecutionTransitionsTable;
  cursors: CursorsTable;
  control_flags: ControlFlagsTable;
  destination_minimums: DestinationMinimumsTable;
}

export type DB = RailsTables & KitTables;
