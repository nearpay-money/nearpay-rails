/**
 * Process entry (foundations §15, lld/rails.md §2): `node dist/main.js api|tracker|feeds|migrate|healthcheck`.
 * - `api`      internal executions, options, minimums, evidence, assets; public `GET /v1/assets`
 * - `tracker`  hot poller and verifier (N replicas)
 * - `feeds`    leader-elected feeds (tokens, sandbox, NEAR indexer, EVM watchers, Explorer),
 *              consumers, jobs, outbox relay
 * - `migrate`  applies kit + rails migrations with the migrator role (one-shot)
 */
import { createDb, migrate } from "@nearpay-internal/db";
import { loadConfig, runMain } from "@nearpay-internal/service";
import { migrateShape, readApiConfig, readFeedsConfig, readTrackerConfig } from "./config.js";
import { MIGRATIONS_DIR } from "./infra/db/migrations.js";

await runMain({
  api: async () => {
    const { createApi } = await import("./app/services.js");
    return createApi(readApiConfig()).service;
  },
  tracker: async () => {
    const { createTracker } = await import("./app/services.js");
    return createTracker(readTrackerConfig()).service;
  },
  feeds: async () => {
    const { createFeeds } = await import("./app/services.js");
    return (await createFeeds(readFeedsConfig())).service;
  },
  migrate: async () => {
    const config = loadConfig(migrateShape);
    const database = createDb({ url: config.dbUrl, applicationName: "rails-migrate" });
    try {
      const applied = await migrate(database.db, MIGRATIONS_DIR, (m) => process.stdout.write(`${m}\n`));
      process.stdout.write(`migrations up to date (${applied.length} applied)\n`);
    } finally {
      await database.close();
    }
    return undefined;
  },
});
