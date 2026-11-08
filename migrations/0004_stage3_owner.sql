-- nearpay-rails Stage 3 (lld/rails.md §20, spec 0.3.0): executions owned by agentpay (cross-chain x402).
-- Additive and forward-only. `executions.owner` exists since 0001 (not null, default 'payments'), so every
-- existing row is already owned by payments; the backfill below is a no-op kept for the record.

alter table executions add column x402_binding text;  -- owner agentpay: the near-intents requirement binding

update executions set owner = 'payments' where owner is null;   -- no-op: the column is not null since 0001

-- an agentpay execution always carries its binding, a payments one never does
alter table executions add constraint ex_x402_binding_owner
  check ((owner = 'agentpay') = (x402_binding is not null));

-- one quote per binding (agentpay claims the binding before quoting; the idempotency key is x402:<binding>)
create unique index ex_x402_binding on executions (x402_binding) where x402_binding is not null;

-- reconciliation reads by owner (listEvidence ?owner=)
create index ex_account_owner_day on executions (account_id, livemode, owner, terminal_at);
