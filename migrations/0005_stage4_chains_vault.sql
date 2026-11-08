-- nearpay-rails Stage 4 (lld/rails.md §21, §8.6; spec 0.4.0). Additive and forward-only.

-- §21.4: an execution keeps the verification tier it was created with (a Tier-A execution is never downgraded to the
-- provider's word when its chain's RPC pool fails later). Null for rows created before 0005: the profile's tier applies.
alter table executions add column verification_tier text
  check (verification_tier is null or verification_tier in ('A', 'B'));

-- §8.6: forwarded nearpay_vault events, deduplicated by receipt_id:log_index (at-least-once indexing, INV-4).
-- One row per forwarded event, written in the same transaction as its outbox row.
create table vault_events (
  livemode boolean not null,
  receipt_id text not null,
  log_index integer not null check (log_index >= 0),
  vault_contract text not null,
  tx_hash text not null,
  block_height bigint not null,
  block_hash text not null,
  event text not null,
  mandate_id bigint not null,
  outbox_event_id uuid not null,
  forwarded_at timestamptz not null default now(),
  primary key (livemode, receipt_id, log_index)
);
create index vault_events_mandate on vault_events (vault_contract, mandate_id, block_height);
