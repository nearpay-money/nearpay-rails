-- nearpay-rails Stage 2 (lld/rails.md v1.3 §4): exact prices and FX (§8.2), refund legs (§6), the Explorer
-- cross-check (§8.5, §8.10) and the observation archive (§8.11). Additive and forward-only.

-- Prices as exact rationals next to the display numerics; peg currency (par settlement) and the CoinGecko id.
alter table tokens
  add column peg_currency text,                       -- 'usd' for USD stablecoins; NP_STABLE_PEGS for others
  add column coingecko_id text,                       -- 1Click /v0/tokens coingeckoId (NP_PRICE_SECONDARY_IDS overrides)
  add column price_num numeric(78,0),
  add column price_den numeric(78,0),
  add column secondary_num numeric(78,0),
  add column secondary_den numeric(78,0),
  add column secondary_source text,                   -- 'coingecko' (live) | 'sandbox' (test)
  add column secondary_fetched_at timestamptz,
  add constraint tokens_price_ratio check ((price_num is null) = (price_den is null) and (price_den is null or price_den > 0)),
  add constraint tokens_secondary_ratio check ((secondary_num is null) = (secondary_den is null) and (secondary_den is null or secondary_den > 0));

-- One row per (mode, currency): the latest rate to USD (USD per one unit of the currency).
create table fx_rates (
  livemode boolean not null,
  currency text not null check (currency ~ '^[a-z]{3}$'),
  num numeric(78,0) not null check (num > 0),
  den numeric(78,0) not null check (den > 0),
  source text not null check (source in ('ecb','fixed')),
  reference_date date,                                -- ECB reference day (null for fixed)
  as_of timestamptz not null,
  fetched_at timestamptz not null,
  valid_until timestamptz,                            -- null = no bound (fixed test table)
  primary key (livemode, currency));

-- Refund legs (spec 0.2.0): the payments object served and the refund-leg snapshot (INV-6, immutable).
alter table executions
  add column reference jsonb,                          -- ExecutionReference {payment_intent, payment_attempt, refund, refund_leg}
  add column refund jsonb,                             -- ExecutionRefund (kind 'refund' only)
  add column explorer_status text,                     -- last Explorer row status (§8.5; Tier-B cross-check §8.10)
  add column explorer_seen_at timestamptz,
  add constraint ex_refund_kind check ((kind = 'refund') = (refund is not null));

-- A binding is carried by intents_transfer executions and, since Stage 2, by refund route legs whose source is an
-- Intents account (the merchant signs one transfer to the 1Click INTENTS deposit address with memo = binding).
do $$
declare c record;
begin
  for c in select conname from pg_constraint
           where conrelid = 'executions'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) like '%intents_transfer%' and pg_get_constraintdef(oid) like '%binding%'
  loop
    execute format('alter table executions drop constraint %I', c.conname);
  end loop;
end $$;
alter table executions add constraint ex_binding_method check (
  (method = 'intents_transfer' and binding is not null)
  or (method = 'route_quote' and (binding is null or (kind = 'refund' and refund_type = 'intents'))));

create index ex_terminal on executions (terminal_at) where terminal_at is not null;
create index ex_ops_created on executions (livemode, created_at desc, id desc);

-- Observation archive (§8.11): archived rows keep the hash and point into the archive object.
alter table provider_observations
  alter column payload drop not null,
  add column archive_key text,
  add column archive_row integer check (archive_row is null or archive_row >= 0),
  add column archived_at timestamptz,
  add constraint obs_archived check ((payload is null) = (archive_key is not null)),
  add constraint obs_archive_ref check ((archive_key is null) = (archive_row is null) and (archive_key is null) = (archived_at is null));
create index obs_unarchived on provider_observations (execution_id) where payload is not null;
