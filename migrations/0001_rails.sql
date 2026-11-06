-- nearpay-rails (lld/rails.md §4). Kit tables (outbox, inbox, idempotency_keys, jobs, dead_letters)
-- come from @nearpay-internal/db migrations.

-- Token registry, one per mode: live = 1Click /v0/tokens, test = the sandbox registry (spec 0.1.3).
create table tokens (
  livemode boolean not null,
  asset_id text not null,
  blockchain text not null,
  chain text not null,
  symbol text not null,
  decimals smallint not null check (decimals between 0 and 255),
  contract_address text,
  family text not null,                     -- 'USDC','USDT','ETH',… (same-asset routing)
  is_usd_stable boolean not null default false,
  enabled boolean not null default true,
  price_usd numeric(38,18),
  price_updated_at timestamptz,
  secondary_price_usd numeric(38,18),
  secondary_updated_at timestamptz,
  memo_required boolean not null default false,
  refreshed_at timestamptz not null,
  primary key (livemode, asset_id));
create index tokens_contract on tokens (livemode, chain, contract_address) where enabled;

-- Watch-list read model of identity destinations (evt.identity.settlement_destination.*).
create table watched_destinations (
  destination_id uuid primary key,
  account_id uuid not null,
  livemode boolean not null,
  chain text not null,
  address_norm text not null,
  asset_id text not null,
  type text not null check (type in ('chain_address','intents_account')),
  active boolean not null,
  source_version integer not null,          -- identity aggregate version (stale events are ignored)
  updated_at timestamptz not null default now());
create index wd_chain on watched_destinations (chain, address_norm) where active;
create index wd_key on watched_destinations (chain, address_norm, asset_id) where active;

create table executions (
  id uuid primary key,
  account_id uuid not null,
  livemode boolean not null,
  owner text not null default 'payments' check (owner in ('payments','agentpay')),
  kind text not null check (kind in ('payment','refund')),
  method text not null check (method in ('route_quote','intents_transfer')),
  provider text not null check (provider in ('oneclick','sandbox','direct_intents')),
  idempotency_key text not null unique,
  state text not null check (state in ('quoting','awaiting_deposit','deposit_detected','incomplete_deposit','settling',
                                       'verifying','succeeded','refunded','failed','expired_unpaid','held')),
  provider_status text,
  provider_updated_at timestamptz,
  origin_asset_id text not null,
  origin_chain text not null,
  refund_to text not null,
  refund_type text not null check (refund_type in ('origin_chain','intents')),
  destination_asset_id text not null,
  recipient text not null,
  recipient_type text not null check (recipient_type in ('destination_chain','intents')),
  destination_chain text not null,
  destination_key text not null,            -- chain|address_norm|asset_id
  route_class text not null check (route_class in ('same_asset','stable_pair','volatile','intents_transfer')),
  applied_fee_bps integer not null check (applied_fee_bps between 0 and 10000),
  fee_recipient text,
  fee_amount numeric(78,0),                 -- intents_transfer: the fee transfer (route quotes: in appFees)
  amount_out_base numeric(78,0) not null check (amount_out_base > 0),
  amount_tag numeric(78,0) not null default 0 check (amount_tag >= 0),
  amount_out_expected numeric(78,0) not null, -- base + tag
  price_snapshot jsonb,
  quote_request jsonb,
  quote_response jsonb,
  correlation_id text,
  deposit_address text,
  deposit_memo text,
  amount_in numeric(78,0),
  min_amount_in numeric(78,0),
  binding text,                             -- intents_transfer memo binding
  deadline timestamptz not null,
  time_when_inactive timestamptz,
  deposit_tx_hashes text[] not null default '{}',
  has_signal boolean not null default false,
  next_poll_at timestamptz,
  poll_count integer not null default 0,
  not_found_count integer not null default 0,
  priority smallint not null default 3,
  verify_at timestamptz,                    -- verifier schedule (verifying, and held with provider SUCCESS)
  verifying_since timestamptz,
  settled_amount numeric(78,0),
  refunded_amount numeric(78,0),
  refund_reason text,
  provider_amount_out numeric(78,0),        -- provider's claim; evidence decides settled_amount
  destination_tx_hashes text[] not null default '{}',
  evidence jsonb,
  failure_code text,
  held_reason text,
  terminal_at timestamptz,
  tracking_until timestamptz,               -- expired executions: late-refund sweep window
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 0,
  check (amount_out_expected = amount_out_base + amount_tag),
  check ((method = 'intents_transfer') = (binding is not null)));
create unique index ex_deposit on executions (provider, deposit_address, coalesce(deposit_memo, ''))
  where deposit_address is not null;
create unique index ex_binding on executions (binding) where binding is not null;
create index ex_due on executions (next_poll_at) where terminal_at is null and next_poll_at is not null;
create index ex_verify on executions (verify_at) where verify_at is not null;
create index ex_inflight_dest on executions (destination_key, amount_out_expected) where terminal_at is null;
create index ex_account_day on executions (account_id, livemode, terminal_at);
create index ex_inflight_chain on executions (livemode, destination_chain) where terminal_at is null;

-- Amount tags (§8.3). The settlement amount + tag must be unique among in-flight executions to the
-- same destination, otherwise an amount match could not tell two executions apart.
create table amount_tags (
  destination_key text not null,
  tag numeric(78,0) not null check (tag > 0),
  expected numeric(78,0) not null,
  execution_id uuid not null,
  allocated_at timestamptz not null default now(),
  released_at timestamptz);
create unique index tags_live on amount_tags (destination_key, expected) where released_at is null;
create unique index tags_execution on amount_tags (execution_id) where released_at is null;

create table provider_observations (
  id uuid primary key,
  execution_id uuid not null,
  source text not null check (source in ('quote','submit','hot_poll','explorer','indexer','watcher','verifier','operator')),
  provider_status text,
  payload jsonb not null,
  payload_sha256 bytea not null,
  provider_updated_at timestamptz,
  applied boolean not null default false,
  observed_at timestamptz not null default now());
create index obs_execution on provider_observations (execution_id, observed_at);

create table verifications (
  id uuid primary key,
  execution_id uuid not null,
  tier char(1) not null check (tier in ('A','B')),
  chain text not null,
  source text not null,
  tx_hash text,
  block_ref text,
  recipient text,
  asset_id text,
  amount numeric(78,0),
  finality text,
  result text not null check (result in ('pass','short','mismatch','not_found','pending')),
  details jsonb not null default '{}',
  checked_at timestamptz not null default now());
create index verifications_execution on verifications (execution_id, checked_at);

-- Transfers to watched destinations that matched no execution (merchant received unrelated funds).
create table unattributed_transfers (
  id uuid primary key,
  chain text not null,
  tx_hash text not null,
  log_ref text not null,
  recipient text not null,
  asset_id text not null,
  amount numeric(78,0) not null,
  reason text not null,
  observed_at timestamptz not null default now(),
  unique (chain, tx_hash, log_ref));

create table execution_transitions (
  id uuid primary key,
  execution_id uuid not null,
  from_state text,
  to_state text not null,
  cause text not null,
  actor text not null,                      -- api|hot_poll|explorer|indexer|watcher|verifier|operator
  observation_id uuid,
  evidence jsonb,
  created_at timestamptz not null default now());
create index execution_transitions_execution on execution_transitions (execution_id, created_at);

create table cursors (name text primary key, value jsonb not null, updated_at timestamptz not null default now());

-- 'quoting_enabled' (sentinel kill switch), 'explorer_enabled', 'cross_chain_enabled' (RB-01)
create table control_flags (
  name text primary key,
  value boolean not null,
  reason text,
  source_version integer not null default 0,
  updated_at timestamptz not null default now());
insert into control_flags (name, value, reason) values
  ('quoting_enabled', true, 'default'),
  ('cross_chain_enabled', true, 'default');

-- Destination minimums (§8.9), recomputed hourly; the API answers from here.
create table destination_minimums (
  livemode boolean not null,
  chain text not null,
  asset_id text not null,
  kind text not null check (kind in ('intents','chain')),
  min_amount_base numeric(78,0),
  min_usd_micros bigint,
  computed_at timestamptz,
  primary key (livemode, chain, asset_id, kind));

-- Append-only history (INV-9).
create function rails_append_only() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;
create trigger execution_transitions_append_only before update or delete on execution_transitions
  for each row execute function rails_append_only();
create trigger verifications_append_only before update or delete on verifications
  for each row execute function rails_append_only();
