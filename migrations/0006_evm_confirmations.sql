-- ADR-0022 (lld/rails.md §8.12): post-success `finalized` re-check of EVM evidence accepted on L2 block
-- confirmations. Scheduling columns (not material: no version, no event). A failed or timed-out re-check never
-- changes the execution's state (terminal states stay terminal); it alerts and stays visible to ops here and as a
-- `verifier` observation in the evidence trail.
alter table executions
  add column finality_recheck_status text
    check (finality_recheck_status is null or finality_recheck_status in ('pending', 'finalized', 'failed', 'timeout')),
  add column finality_recheck_at timestamptz,          -- next re-check (null = none due)
  add column finality_recheck_until timestamptz,       -- window end: still not finalized → 'timeout' (alert)
  add column finality_recheck_block_hash text,         -- block hash the confirmed evidence counted from
  add column finality_recheck_detail jsonb;            -- last outcome: reason, finalized head, receipt seen
create index executions_finality_recheck_due on executions (finality_recheck_at) where finality_recheck_at is not null;
create index executions_finality_recheck_alerts on executions (finality_recheck_status)
  where finality_recheck_status in ('failed', 'timeout');
