/**
 * Token registry refresh (lld/rails.md §9 "token & price refresh": `/v0/tokens` every 30 s) and
 * lookups. One registry per mode: live from 1Click, test from the sandbox (spec 0.1.3).
 */
import { sql } from "@nearpay-internal/db";
import { registryRows } from "../domain/token-registry/registry.js";
import { alertLimiter, errorClass } from "../infra/clients/error-class.js";
import { mode, type Rails } from "./context.js";
import type { TokenRowDb } from "./views.js";

/** Registry refresh cadence (§9: `/v0/tokens` every 30 s). */
export const TOKEN_REFRESH_MS = 30_000;
/** A registry not refreshed for this long is stale (`token_registry_stale`, gauge `token_registry_age_seconds`). */
export const REGISTRY_STALE_MS = 3 * TOKEN_REFRESH_MS;
/** A failing refresh logs `ALERT token_registry_refresh_failed` at once, then at most this often. */
export const REFRESH_ALERT_EVERY_MS = 5 * 60_000;

/**
 * One refresh of the feeds loop: failures (1Click unreachable through the egress proxy, auth, an empty or malformed
 * list…) log `ALERT token_registry_refresh_failed` with the error class (rate-limited per mode) and an INFO once the
 * registry refreshes again. Never throws; returns the number of rows, or null on failure.
 */
export function monitoredRefresh(r: Rails) {
  const alerts = new Map<boolean, ReturnType<typeof alertLimiter>>();
  return async (livemode: boolean): Promise<number | null> => {
    let a = alerts.get(livemode);
    if (!a) {
      a = alertLimiter(REFRESH_ALERT_EVERY_MS, r.now);
      alerts.set(livemode, a);
    }
    try {
      const n = await refreshTokens(r, livemode);
      if (a.active) {
        r.log.info({ livemode, mode: mode(livemode), failures: a.count, tokens: n }, "token registry refreshed again");
        a.reset();
      }
      return n;
    } catch (e) {
      const c = errorClass(e);
      if (a.due())
        r.log.warn(
          {
            livemode,
            mode: mode(livemode),
            error_class: c.class,
            status: c.status,
            err: c.message,
            consecutive_failures: a.count,
          },
          `ALERT token_registry_refresh_failed: the ${mode(livemode)} token registry could not be refreshed from its provider (${c.class}); prices go stale and payments stop routing after 5 minutes`,
        );
      return null;
    }
  };
}

/** When the registry of one mode last refreshed successfully (every row is stamped on each refresh); null = never. */
export async function registryRefreshedAt(r: Rails, livemode: boolean): Promise<Date | null> {
  const row = await r.db
    .selectFrom("tokens")
    .select((eb) => eb.fn.max("refreshed_at").as("at"))
    .where("livemode", "=", livemode)
    .executeTakeFirst();
  return row?.at ? new Date(row.at as unknown as string | Date) : null;
}

/** Drift alerts already logged by this process (once per mode, asset id and kind). */
const driftReported = new Set<string>();

/** Replaces the registry of one mode with the provider's list; tokens that disappeared are disabled. */
export async function refreshTokens(r: Rails, livemode: boolean): Promise<number> {
  const provider = livemode ? r.providers.live : r.providers.test;
  if (!provider) return 0;
  const list = await provider.tokens();
  const rows = registryRows(livemode, list, r.profiles, {
    pegs: r.stablePegs,
    coingeckoIds: r.coingeckoIds,
    onDrop: (asset_id, reason) =>
      r.log.error(
        { asset_id, reason, livemode },
        "ALERT token registry entry dropped (asset id not bound to its contract)",
      ),
    onDrift: (asset_id, drift) => {
      const key = `${livemode}|${asset_id}|${drift.kind}`;
      if (driftReported.has(key)) return;
      driftReported.add(key);
      if (driftReported.size > 10_000) driftReported.clear();
      r.log.error(
        { asset_id, livemode, ...drift },
        drift.kind === "unknown_shape"
          ? "ALERT unknown_asset_id_shape: the provider lists an asset id no NearPay parser recognises (update spec parseAssetId before payers use it)"
          : "ALERT asset_id_chain_disagrees: the asset id names another chain than the provider's blockchain",
      );
    },
  });
  if (rows.length === 0) throw new Error(`${provider.name} returned no usable tokens`);
  const now = new Date(r.now());
  await r.db.transaction().execute(async (tx) => {
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200).map((t) => ({
        livemode: t.livemode,
        asset_id: t.asset_id,
        blockchain: t.blockchain,
        chain: t.chain,
        symbol: t.symbol,
        decimals: t.decimals,
        contract_address: t.contract_address,
        family: t.family,
        is_usd_stable: t.is_usd_stable,
        enabled: t.enabled,
        price_usd: t.price_usd,
        price_updated_at: t.price_updated_at,
        memo_required: t.memo_required,
        refreshed_at: now,
        peg_currency: t.peg_currency,
        coingecko_id: t.coingecko_id,
        price_num: t.price_num,
        price_den: t.price_den,
        // test mode: the sandbox price is the secondary source too (lld/rails.md §8.2 sources table)
        ...(livemode
          ? {}
          : {
              secondary_price_usd: t.price_usd,
              secondary_updated_at: t.price_updated_at,
              secondary_num: t.price_num,
              secondary_den: t.price_den,
              secondary_source: t.price_num ? "sandbox" : null,
              secondary_fetched_at: t.price_num ? now : null,
            }),
      }));
      await tx
        .insertInto("tokens")
        .values(chunk)
        .onConflict((oc) =>
          oc.columns(["livemode", "asset_id"]).doUpdateSet((eb) => ({
            blockchain: eb.ref("excluded.blockchain"),
            chain: eb.ref("excluded.chain"),
            symbol: eb.ref("excluded.symbol"),
            decimals: eb.ref("excluded.decimals"),
            contract_address: eb.ref("excluded.contract_address"),
            family: eb.ref("excluded.family"),
            is_usd_stable: eb.ref("excluded.is_usd_stable"),
            enabled: eb.ref("excluded.enabled"),
            price_usd: eb.ref("excluded.price_usd"),
            price_updated_at: eb.ref("excluded.price_updated_at"),
            memo_required: eb.ref("excluded.memo_required"),
            refreshed_at: eb.ref("excluded.refreshed_at"),
            peg_currency: eb.ref("excluded.peg_currency"),
            coingecko_id: eb.ref("excluded.coingecko_id"),
            price_num: eb.ref("excluded.price_num"),
            price_den: eb.ref("excluded.price_den"),
            ...(livemode
              ? {}
              : {
                  secondary_price_usd: eb.ref("excluded.secondary_price_usd"),
                  secondary_updated_at: eb.ref("excluded.secondary_updated_at"),
                  secondary_num: eb.ref("excluded.secondary_num"),
                  secondary_den: eb.ref("excluded.secondary_den"),
                  secondary_source: eb.ref("excluded.secondary_source"),
                  secondary_fetched_at: eb.ref("excluded.secondary_fetched_at"),
                }),
          })),
        )
        .execute();
    }
    await tx
      .updateTable("tokens")
      .set({ enabled: false })
      .where("livemode", "=", livemode)
      .where("refreshed_at", "<", now)
      .execute();
  });
  return rows.length;
}

export async function tokenOf(r: Rails, livemode: boolean, assetId: string): Promise<TokenRowDb | undefined> {
  return r.db
    .selectFrom("tokens")
    .selectAll()
    .where("livemode", "=", livemode)
    .where("asset_id", "=", assetId)
    .executeTakeFirst();
}

/** `livemode` given: that registry; omitted: live, falling back to test (spec 0.1.3). */
export async function tokenAnyMode(r: Rails, assetId: string, livemode?: boolean): Promise<TokenRowDb | undefined> {
  if (livemode !== undefined) return tokenOf(r, livemode, assetId);
  const rows = await r.db
    .selectFrom("tokens")
    .selectAll()
    .where("asset_id", "=", assetId)
    .where("enabled", "=", true)
    .orderBy("livemode", "desc")
    .execute();
  return rows[0];
}

export async function enabledTokens(r: Rails, livemode?: boolean): Promise<TokenRowDb[]> {
  let q = r.db.selectFrom("tokens").selectAll().where("enabled", "=", true);
  if (livemode !== undefined) q = q.where("livemode", "=", livemode);
  return q.orderBy("asset_id").execute();
}

/** Public registry (`GET /v1/assets`): enabled assets, the live row preferred over the test row. */
export async function publicAssets(r: Rails): Promise<TokenRowDb[]> {
  const rows = await sql<TokenRowDb>`
    select distinct on (asset_id) * from tokens where enabled order by asset_id, livemode desc`.execute(r.db);
  return rows.rows;
}
