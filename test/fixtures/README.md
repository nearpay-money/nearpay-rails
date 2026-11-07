# Recorded fixtures

Public responses recorded from mainnet services; they pin the provider and chain shapes rails parses.

| File | Source | Recorded |
|---|---|---|
| `oneclick/dry-quote.json` (+ `.request.json`) | 1Click `POST /v0/quote` (dry, unauthenticated): appFees echoed split 50/50, signature verifies with the SDK | 2026-11-05 |
| `oneclick/quote-400.json` | 1Click `POST /v0/quote` with an unknown origin asset | 2026-11-06 |
| `oneclick/status-404.json` | 1Click `GET /v0/status` for an unknown deposit address | 2026-11-06 |
| `oneclick/tokens.json` | 1Click `GET /v0/tokens` (215 tokens) | 2026-11-06 |
| `near/block-*.json` | neardata `GET /v0/block/{height}` (intents.near DIP-4 / NEP-245 events, NEP-141 `ft_transfer`; SP-14) | 2026-11-06 |
| `near/tx-*.json` | NEAR RPC `EXPERIMENTAL_tx_status` (FastNEAR; any `sender_account_id` resolves) | 2026-11-06 |

| `ecb/eurofxref-daily-2026-11-06.xml` | **Synthetic**, in the exact layout of the ECB `eurofxref-daily.xml` (29 currencies, single-quoted attributes); rates are illustrative — egress to ecb.europa.eu is blocked from the build agents | 2026-11-08 |
| `coingecko/simple-price.json` | **Synthetic**, in the layout of CoinGecko keyless `GET /api/v3/simple/price?…&include_last_updated_at=true&precision=full` (full-precision numbers, an exponent-notation price, malformed entries); egress to api.coingecko.com is blocked from the build agents | 2026-11-08 |
| `explorer/transactions.json` | **Synthetic**, in the layout of the Explorer `GET /api/v0/transactions` rows (spec 0.2.0 `ExplorerTransaction`, live nulls) | 2026-11-08 |

Replace the synthetic ECB/CoinGecko/Explorer files with real recordings when a networked machine is available
(the parsers already accept the documented shapes).

Synthetic status responses (KNOWN_DEPOSIT_TX … REFUNDED) are built in the tests from the sandbox's
1Click-compatible shapes: a live deposit cannot be recorded without moving funds.
