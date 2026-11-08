-- nearpay-rails spec 0.2.1 (lld/rails.md §"Spec 0.2.1 contract changes"): abandoned refund legs, observed fee,
-- deposited amount, payer fee share of amount_in, display decimals, and the kill switch read at boot.
-- Additive and forward-only.

alter table executions
  add column observed_fee_amount numeric(78,0),        -- Execution.observed_fee.amount (payments only; null = unknown)
  add column observed_fee_asset text,                  -- Execution.observed_fee.asset_id
  add column deposited_amount numeric(78,0),           -- what the payer deposited, origin base units (null = none seen)
  add column fee_amount_in numeric(78,0),              -- ExecutionDeposit.fee_amount_in (route_quote; display only)
  add column origin_decimals smallint,                 -- registry decimals of origin/settlement asset (display)
  add column destination_decimals smallint,
  add column abandoned_at timestamptz,                 -- abandonExecution (refund legs before any deposit)
  add column abandon_reason text,
  add column abandon_note text,
  add constraint ex_observed_fee_pair check ((observed_fee_amount is null) = (observed_fee_asset is null)),
  add constraint ex_abandon_refund_only check (abandoned_at is null or (kind = 'refund' and abandon_reason is not null));

-- display decimals of existing executions from the registry of their mode
update executions e set origin_decimals = t.decimals
  from tokens t where t.livemode = e.livemode and t.asset_id = e.origin_asset_id;
update executions e set destination_decimals = t.decimals
  from tokens t where t.livemode = e.livemode and t.asset_id = e.destination_asset_id;

-- Kill switch (spec 0.2.1 getKillSwitch): `known` is false until sentinel's state was read at boot or an
-- `evt.sentinel.kill_switch.*` event was applied; an unknown `quoting_enabled` stops live quoting (fail closed).
alter table control_flags add column known boolean not null default true;
update control_flags set known = false where name = 'quoting_enabled' and source_version = 0;
