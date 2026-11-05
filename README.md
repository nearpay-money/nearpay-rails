# nearpay-rails

> Value movement: route providers (1Click, sandbox, direct-intents), token registry, pricing/FX, executions, tracking (hot poller, Explorer feed, NEAR indexer, destination watchers with amount tags), Tier-A chain verifiers.

| | |
|---|---|
| Group | Services |
| Kind | service |
| Ships as | image: ghcr.io/nearpay-money/rails · routes /v1/assets; internal /executions, /quotes |
| Owns | Execution, ProviderObservation, Verification, TokenRegistry, PriceSnapshot |
| Depends on (published artifacts only) | spec, kit, compliance, sandbox, 1Click, RPCs |
| First built in | Stage 1 (step 1.2) |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/lld/rails.md` — **low-level design (dev-ready; implement from this)**
- `nearpay-brain/lld/audits/rails.md` — audit findings already folded into the LLD
- `nearpay-brain/roadmap/development-plan.md` — stage and step this repo is built in
- `nearpay-brain/architecture/hld.md` — system design
- `nearpay-brain/architecture/repositories.md` — repo topology and dependency rules
- `nearpay-brain/architecture/hld.md#10-rails-architecture-value-movement`
- `nearpay-brain/decisions/ADR-0003-route-provider-abstraction.md`
- `nearpay-brain/decisions/ADR-0012-independent-verification.md`
- `nearpay-brain/reference/landscape.md`

## Layout

```
nearpay-rails/
├── migrations/
├── src/
│   ├── api/
│   ├── app/
│   ├── consumers/
│   ├── domain/
│   │   ├── execution/
│   │   ├── pricing/
│   │   ├── token-registry/
│   │   └── verification/
│   ├── infra/
│   │   ├── bus/
│   │   ├── clients/
│   │   └── db/
│   ├── providers/
│   │   ├── direct-intents/
│   │   ├── oneclick/
│   │   └── sandbox/
│   ├── trackers/
│   │   ├── destination-watchers/
│   │   ├── explorer-feed/
│   │   ├── hot-poller/
│   │   └── near-indexer/
│   ├── verifiers/
│   │   ├── bitcoin/
│   │   ├── evm/
│   │   ├── near/
│   │   └── solana/
│   └── workers/
├── test/
│   ├── contract/
│   ├── fixtures/
│   │   └── oneclick/
│   ├── integration/
│   ├── property/
│   └── unit/
└── .github/
    └── workflows/
```

## Status

Scaffold only. Implementation starts in **Stage 1 (step 1.2)** (`nearpay-brain/roadmap/development-plan.md`).

## Built with

Libraries are listed here as they are added (hackathon rule Q-005). Code and documentation are written with AI assistance (Claude) under human direction and review.
