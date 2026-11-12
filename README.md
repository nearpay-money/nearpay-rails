# nearpay-rails

Value-movement service: route providers (1Click live, sandbox in test mode), token registry, pricing and FX, executions, tracking (hot poller, Explorer feed, NEAR indexer, destination watchers with amount tags) and the chain verifiers that produce settlement evidence.

Part of [NearPay](https://github.com/nearpay-money/nearpay) — start there for the live demo, the architecture diagram and the full "do X, see Y" walkthrough.

- **Where it sits:** payments (and billing and agentpay, through the internal routes) ask it for options, quotes, executions and evidence; the gateway serves `/v1/assets` from it. It calls 1Click and the NEAR Intents Explorer, NEAR/EVM/Solana/Bitcoin RPCs, compliance (address screening) and, in test mode, sandbox. It never holds funds: it tracks what the route provider and the chains report.
- **Status:** NearPay runs on NEAR mainnet as a closed beta (https://nearpay.money). This service is part of that deployment.

|                                       |                                                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Group                                 | Services                                                                                                   |
| Kind                                  | service                                                                                                    |
| Ships as                              | image: ghcr.io/nearpay-money/rails · routes /v1/assets; internal /executions, /options, /assets, /evidence |
| Owns                                  | Execution, ProviderObservation, Verification, TokenRegistry, PriceSnapshot                                 |
| Depends on (published artifacts only) | spec, kit, compliance, sandbox, 1Click, RPCs                                                               |
| First built in                        | Stage 1 (step 1.2)                                                                                         |

## Documentation

Design docs live in [`nearpay-brain`](https://github.com/nearpay-money/nearpay-brain), not here.

- [`lld/rails.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/lld/rails.md) — low-level design this repo is implemented from
- [`lld/audits/rails.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/lld/audits/rails.md) — audit findings already folded into the LLD
- [`roadmap/development-plan.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/roadmap/development-plan.md) — stage and step this repo is built in
- [`architecture/hld.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/architecture/hld.md) — system design
- [`architecture/repositories.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/architecture/repositories.md) — repo topology and dependency rules
- [`architecture/hld.md#10-rails-architecture-value-movement`](https://github.com/nearpay-money/nearpay-brain/blob/main/architecture/hld.md#10-rails-architecture-value-movement)
- [`decisions/ADR-0003-route-provider-abstraction.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/decisions/ADR-0003-route-provider-abstraction.md)
- [`decisions/ADR-0012-independent-verification.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/decisions/ADR-0012-independent-verification.md)
- [`reference/landscape.md`](https://github.com/nearpay-money/nearpay-brain/blob/main/reference/landscape.md)

## Layout

```
nearpay-rails/
├── config/chains.yaml        chain profiles: tier, deadlines, finality, evidence timeouts, watchers
├── src/
│   ├── main.ts               process entry: `api` | `tracker` | `feeds` | `migrate` | `healthcheck`
│   ├── ops.ts                Stage 1 ops CLI entry (`node dist/ops.js <command>`, run inside rails-api)
│   ├── config.ts             NP_* configuration (secrets from files)
│   ├── api/                  spec route bindings
│   ├── app/                  use cases: create executions, apply observations/evidence (ledger), reads, minimums, tokens, wiring
│   ├── consumers/            identity destination watch-list, sentinel kill switch
│   ├── domain/               pure: state machine, pricing (par/depeg/dual source), tags, binding, quote integrity, schedule, evidence rules
│   ├── infra/                Kysely schema, shared call budgets (Valkey), compliance/NEAR/EVM/Explorer clients
│   ├── providers/            RouteProvider port; 1Click (live) and sandbox (test) adapters
│   ├── trackers/             hot poller, Explorer feed, NEAR indexer + sandbox feed, EVM destination watchers, attribution
│   ├── verifiers/            Tier A (EVM receipts, NEAR tx status, simulated chains) and Tier B
│   ├── ops/                  ops CLI commands
│   └── workers/              jobs: minimums, orphan tags, kit purge
├── migrations/               plain SQL (kit tables first, then 0001_rails.sql)
├── test/
│   ├── unit/ property/       domain (100 % lines), recorded 1Click quote, recorded mainnet blocks; state machine properties
│   ├── integration/          the real nearpay-sandbox image (test mode end to end), Anvil (EVM), recorded NEAR RPC/neardata, a signed 1Click fake
│   ├── contract/             route/subject coverage, 1Click wire schemas
│   ├── fixtures/             recorded provider and mainnet responses (see fixtures/README.md)
│   └── support/              stack, fakes, Anvil, request builders
└── Dockerfile                distroless Node 22 image, `node dist/main.js <process>`
```

## Verify this repo

Needs Node 22 (`.nvmrc`) and pnpm 9. `.npmrc` points the `@nearpay-money` and `@nearpay-internal` scopes at a local package registry, so start that first.

1. Start the local registry (no Docker, Node 22 only):
   `git clone https://github.com/nearpay-money/nearpay-deploy ../nearpay-deploy && ../nearpay-deploy/scripts/registry.sh start`
   → `curl http://127.0.0.1:4873/-/ping` answers `{}`.
2. `pnpm install --frozen-lockfile` → ends with `Done in …`, no registry errors.
3. `pnpm test` (unit and property tests over recorded 1Click quotes and recorded mainnet blocks; no Docker) → `Test Files  28 passed (28)`, `Tests  313 passed (313)`.
4. `pnpm verify` (the full gate: typecheck, lint, unit tests with the coverage gate of ≥ 90 % branches on `src/domain`, integration tests, build) → exits 0. The integration step needs a running Docker daemon: Testcontainers starts Postgres, NATS, Anvil and the `nearpay/sandbox:local` image, which you build first in a [nearpay-sandbox](https://github.com/nearpay-money/nearpay-sandbox) checkout (its README has the `docker build` line). Steps 1–3 need none of that.

What to read to check the one-block confirmation rule (ADR-0022): `config/chains.yaml` (per-chain evidence rule), `src/verifiers/` and `test/unit/`.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm install --frozen-lockfile` | Install; NearPay packages come from the local registry (see "Verify this repo") |
| `pnpm test` | Unit and property tests |
| `pnpm test:integration` | Integration and contract tests: Postgres, NATS, the `nearpay/sandbox:local` image and Anvil in Testcontainers (needs Docker; build the sandbox image first) |
| `pnpm verify` | typecheck + lint + unit tests with the coverage gate + integration tests + build |
| `docker build --network host --build-arg NP_REGISTRY_URL=http://127.0.0.1:4873 -t nearpay/rails:local .` | Image (what nearpay-deploy's `scripts/up.sh` runs) |

## Configuration

| Variable                                                                                                                                                                                                                       | Process             | Meaning                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NP_DB_URL_FILE`                                                                                                                                                                                                               | all                 | Database URL (app role; migrator role for `migrate`)                                                                                                                                                                                                                      |
| `NP_IDENTITY_URL`, `NP_SERVICE_CLIENT_SECRET_FILE`                                                                                                                                                                             | all                 | Service token (client `rails`: `compliance.screen`, `sandbox.use`)                                                                                                                                                                                                        |
| `NP_COMPLIANCE_URL`                                                                                                                                                                                                            | api                 | Refund-address screening (1.5 s; unreachable: refuse ≥ `NP_SCREENING_FAIL_CLOSED_USD` = 1,000)                                                                                                                                                                            |
| `NP_SANDBOX_BASE_URL`, `NP_SANDBOX_SIGNING_PUBKEY`                                                                                                                                                                             | all                 | Test mode (nearpay-sandbox) and its quote key; unset: test-mode executions are refused                                                                                                                                                                                    |
| `NP_ONECLICK_BASE_URL`, `NP_ONECLICK_API_KEY_FILE`                                                                                                                                                                             | all                 | 1Click; without a key quotes are unauthenticated (+25 bps)                                                                                                                                                                                                                |
| `NP_TREASURY_ACCOUNT`                                                                                                                                                                                                          | api                 | Live appFees / Intents fee recipient (owner-provided). **Unset: live quoting is refused** (`rail_unavailable`)                                                                                                                                                            |
| `NP_TEST_TREASURY_ACCOUNT`                                                                                                                                                                                                     | api                 | Test-mode fee recipient (`treasury.nearpay.near`, sandbox only)                                                                                                                                                                                                           |
| `NP_VALKEY_URL`                                                                                                                                                                                                                | api, tracker        | Shared 1Click budgets (`NP_ONECLICK_QUOTE_RPS` 5, `NP_ONECLICK_STATUS_RPS` 10); down → half per replica                                                                                                                                                                   |
| `NP_NATS_URL`                                                                                                                                                                                                                  | feeds               | Events in and out                                                                                                                                                                                                                                                         |
| `NP_NEAR_RPC_URLS`, `NP_NEARDATA_URL`                                                                                                                                                                                          | tracker, feeds      | NEAR verifier pool; finalized block stream for the indexer                                                                                                                                                                                                                |
| `NP_EVM_RPC_URLS_1`, `…_8453`, `…_42161`                                                                                                                                                                                       | tracker, feeds      | EVM pools (public defaults); ≥ 2 URLs enable agreement checks ≥ `NP_AGREEMENT_USD`                                                                                                                                                                                        |
| `NP_EVM_CONFIRMATIONS_1`, `…_8453`, `…_42161`                                                                                                                                                                                  | tracker, feeds      | EVM evidence rule per chain (ADR-0022 as amended 2026-11-10 17:10): `finalized` or a block count. Default (`config/chains.yaml`): ONE block of the chain's own `latest` head on every EVM chain. Invalid values fail the boot                                             |
| `NP_FINALITY_RECHECK_WINDOW_S` (7200), `NP_FINALITY_RECHECK_INTERVAL_S` (60); `…_SOLANA_WINDOW_S` (1800), `…_SOLANA_INTERVAL_S` (15); `…_BITCOIN_CONFIRMATIONS` (6), `…_BITCOIN_WINDOW_S` (21600), `…_BITCOIN_INTERVAL_S` (60) | tracker             | Post-success re-check of one-block evidence (rails §8.12): EVM at `finalized`, Solana at `finalized` commitment, Bitcoin at 6 confirmations in the same block; failure/timeout → `ALERT finalized re-check …` log + `nearpay_rails_finality_recheck_total{chain,outcome}` |
| `NP_SOLANA_RPC_URLS`, `NP_BITCOIN_ESPLORA_URLS` (Stage 4)                                                                                                                                                                      | api, tracker, feeds | Solana RPC / Bitcoin Esplora pools (public defaults); empty → the chain settles as Tier B (alert `tier_a_degraded`)                                                                                                                                                       |
| `NP_SOLANA_COMMITMENT` (`confirmed`)                                                                                                                                                                                           | tracker, feeds      | Solana evidence commitment: `confirmed` (supermajority-voted slot; re-checked at `finalized`) or `finalized`. `processed` is refused                                                                                                                                      |
| `NP_VAULT_CONTRACT`, `NP_TEST_VAULT_CONTRACT` (Stage 4)                                                                                                                                                                        | feeds               | Vault account whose `nearpay_vault` events are forwarded to `evt.rails.vault.event` (unset → none); sandbox stand-in (default `vault.sandbox.near`)                                                                                                                       |
| `NP_EXPLORER_ENABLED`, `NP_EXPLORER_TOKEN_FILE`                                                                                                                                                                                | feeds               | Explorer feed (on when the owner's partner JWT file exists; test mode reads the sandbox mirror)                                                                                                                                                                           |
| `NP_AWAITING_SWEEP_S`                                                                                                                                                                                                          | tracker             | Unsignalled deposits are polled this often while the Explorer feed is off (30)                                                                                                                                                                                            |
| `NP_CHAINS_FILE`, `NP_SLIPPAGE_BPS`, `NP_PROVIDER_SPLIT`, `NP_TIER_B_LIMITS`, `NP_PRICING_CURRENCIES`                                                                                                                          | all                 | Profiles, slippage per route class, 1Click appFees split, Tier B limits (USD 2,000 / 20,000 per day), pricing currencies (default `usd,eur,gbp,chf,jpy,cad,aud`)                                                                                                          |
| `NP_STABLE_PEGS`, `NP_PRICE_SECONDARY_URL`, `NP_PRICE_SECONDARY_IDS`, `NP_PRICE_PRIMARY_MAX_AGE_S`, `NP_PRICE_SECONDARY_MAX_AGE_S`                                                                                             | all                 | Non-USD stablecoins (`{asset_id: currency}`), CoinGecko keyless base URL, id overrides, price validity (120 s / 300 s)                                                                                                                                                    |
| `NP_FX_URL`, `NP_FX_GRACE_S`, `NP_FX_MAX_AGE_S`, `NP_TEST_FX_RATES`                                                                                                                                                            | all                 | ECB daily XML, staleness bound (next TARGET working day 16:00 CET + 7,200 s, cap 518,400 s), test-mode fixed table                                                                                                                                                        |
| `NP_OBS_ARCHIVE_STORE`, `NP_OBS_ARCHIVE_AFTER_DAYS`, `NP_OBS_ARCHIVE_S3_*`                                                                                                                                                     | feeds               | Observation archive (`file:<dir>` or `s3://<bucket>/<prefix>`; unset → off), age (90 days), S3 endpoint/region/credentials                                                                                                                                                |

## Behaviour

- **Create (`POST /internal/executions`):** idempotent on `idempotency_key`; live needs the treasury and the kill switch released; tokens from the mode's registry (live: 1Click `/v0/tokens`, test: the sandbox's); route class (`same_asset` / `stable_pair` / `volatile`) picks the fee and slippage; USD stablecoins settle at par (depeg guard ±2 %, price ≤ 5 min old) — non-par settlement needs two agreeing prices and is unavailable in Stage 1; the refund address is screened; the deadline is the chain default capped by the session. A tag makes `base + tag` unique among in-flight executions to the destination (§8.3). The quote is checked before anything is stored: recipient, assets, amount, refund address and types echo what was sent, `EXACT_OUTPUT` delivers the amount, the deposit address is valid, the deadline leaves the chain minimum, the provider signature verifies (1Click SDK), and the **appFees split** — 1Click echoes `[{treasury, fee}]` as `[{treasury, fee/2}, {1Click, fee/2}]` and the signature does not cover appFees, so the entries must total the requested fee with the treasury keeping its share. `intents_transfer` issues the two-transfer requirement with an `np1:` binding instead.
- **Tracking:** the hot poller (every tracker replica, `SKIP LOCKED` lease) polls 2/4/8/15 s after a signal or deposit, sweeps unsignalled deposits every 30 s while the Explorer feed is off, expires unpaid executions at deadline + 10 min and sweeps them for late refunds for 24 h. Only a _changed_ provider status moves the state; observations older than the stored provider time are recorded, not applied. Unknown statuses, FAILED after a deposit, and contradictions are `held` (alert).
- **Evidence (INV-2):** `SUCCESS` means `verifying`. Success needs evidence: an EVM watcher or NEAR indexer match (tag or binding; ambiguity attributes nothing), or the verifier on the provider's destination tx (one block of the destination chain's own consensus — EVM receipt in a block on `latest`, Solana `confirmed`, Bitcoin 1 confirmation; NEAR tx FINAL; simulated chain in test mode), followed by the post-success re-check at finality (§8.12). Tier B chains accept the provider within limits. No evidence by the chain's `verification_timeout_s` → `held`. Trackers are demand-driven: with nothing in flight they make no external call.
- **Events:** every applied change writes the row, a transition and `evt.rails.execution.updated|settled|refunded|failed|held` in one transaction; the feeds process relays the outbox.

## Ops CLI

```sh
docker compose -p nearpay exec rails-api /nodejs/bin/node dist/ops.js execution-show <ex_… | deposit address>
```

`execution-show` · `flags` · `flag-set quoting_enabled|cross_chain_enabled true|false <reason>` (RB-01) · `tokens-refresh live|test` · `minimums-refresh` · `routing-health live|test` · `dead-letters …` and `outbox …` (kit 0.6.0).

## Status

Stage 1 (step 1.2) and Stage 2 (step 2.2) implemented against `@nearpay-money/spec` / `@nearpay-internal/spec` 0.2.0 and kit 0.2.0: refund legs (`POST /internal/refund_executions`), pricing/FX (ECB reference rates with the TARGET-calendar bound, CoinGecko keyless secondary prices, exact rationals, `peg_currency` par), `GET /internal/fx-rates`, `/internal/settlement-estimate`, `/internal/executions/{id}/observations`, `/internal/evidence/summary`, the Explorer feed (owner token; sandbox mirror in test mode), the observation archive (Parquet, `file:` or `s3://` store) and the console routes `/ops/executions…`.

Stage 4 (step 4.2) is implemented as well: Solana and Bitcoin destination watchers and verifiers, and forwarding of the subscription vault's events. Since then: one-block confirmations on every chain with a re-check at finality (ADR-0022), asset ids in the 1Click `.omft.near`, `.omdep.near` and `1cs_v1:` shapes, routing health (`routing-health`), and kit 0.6.0 (liveness heartbeats, dead letters). Current pins (`package.json`): `@nearpay-money/spec` 0.5.2, kit packages 0.6.0.

## Built with

- Runtime: TypeScript 5 on Node 22; `@nearpay-internal/*` kit (service, db, bus, http, auth, chains, intents, money, ids) with Kysely + pg and NATS JetStream underneath; `@defuse-protocol/one-click-sdk-typescript` (quote signatures), `@noble/curves`, `@noble/hashes`, `@scure/base`, `bs58`, `ioredis` (Valkey budgets), `yaml`, `zod`, `hyparquet` and `hyparquet-writer` (observation archive).
- External services: NEAR Intents 1Click and Explorer, NEAR RPC and neardata, EVM/Solana RPCs, Bitcoin Esplora, ECB reference rates, CoinGecko (keyless).
- Tests and tooling: Vitest, fast-check, Testcontainers, Anvil (Foundry), Biome.
- Licence: Apache-2.0 (`LICENSE`).

Code and documentation are written with AI assistance (Claude) under human direction and review. Built for the NEAR Hackathon (Nov 2026).
