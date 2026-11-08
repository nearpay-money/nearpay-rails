/**
 * Domain-event consumers (lld/rails.md §7), run by `rails-feeds`:
 *
 * | Subject                                                | Effect                                  |
 * |--------------------------------------------------------|-----------------------------------------|
 * | evt.identity.settlement_destination.activated/disabled | upsert the watch-list (`watched_destinations`) |
 * | evt.sentinel.kill_switch.engaged/released              | `control_flags.quoting_enabled` (known) |
 *
 * Each handler records the event in the inbox in the same transaction and ignores events older than
 * the stored aggregate version.
 */
import type { Envelope, EventHandler } from "@nearpay-internal/bus";
import { deadLetterSink, enqueueJob, inboxHandler, type Kysely } from "@nearpay-internal/db";
import { toUuid } from "@nearpay-internal/ids";
import type { Subject } from "@nearpay-internal/spec";
import type { Tx } from "../app/context.js";
import { storeKillSwitch } from "../app/kill-switch.js";
import type { DB } from "../infra/db/schema.js";

interface DestinationObject {
  id: string;
  account: string;
  livemode: boolean;
  chain: string;
  address_norm: string;
  asset_id: string;
  type: "chain_address" | "intents_account";
  status: string;
}

async function watch(tx: Tx, e: Envelope, active: boolean): Promise<void> {
  const d = e.data.object as unknown as DestinationObject;
  const id = toUuid(d.id, "sd");
  const version = e.aggregate.version;
  const address = d.type === "intents_account" ? d.address_norm.toLowerCase() : d.address_norm;
  await tx
    .insertInto("watched_destinations")
    .values({
      destination_id: id,
      account_id: toUuid(d.account, "acct"),
      livemode: d.livemode,
      chain: d.chain,
      address_norm: address,
      asset_id: d.asset_id,
      type: d.type,
      active,
      source_version: version,
      updated_at: new Date(),
    })
    .onConflict((oc) =>
      oc
        .column("destination_id")
        .doUpdateSet({ active, source_version: version, updated_at: new Date() })
        .where("watched_destinations.source_version", "<", version),
    )
    .execute();
  // a new destination needs its minimum now, not at the next hourly refresh
  if (active)
    await enqueueJob(tx, { kind: "minimums.refresh", payload: {}, dedupeKey: `minimums.refresh:${id}:${version}` });
}

async function killSwitch(tx: Tx, e: Envelope): Promise<void> {
  const k = e.data.object as unknown as { engaged: boolean; reason: string; actor: string };
  // applies when newer than the stored version, or when the state was unknown (spec 0.2.1 boot read)
  await storeKillSwitch(tx, {
    engaged: k.engaged,
    version: e.aggregate.version,
    reason: `${k.engaged ? "kill switch engaged" : "released"} by ${k.actor}: ${k.reason}`,
  });
}

export function railsHandlers(db: Kysely<DB>): Partial<Record<Subject, EventHandler>> {
  const h = (fn: (tx: Tx, e: Envelope) => Promise<void>) => inboxHandler(db, fn);
  return {
    "evt.identity.settlement_destination.activated": h((tx, e) => watch(tx, e, true)),
    "evt.identity.settlement_destination.disabled": h((tx, e) => watch(tx, e, false)),
    "evt.sentinel.kill_switch.engaged": h(killSwitch),
    "evt.sentinel.kill_switch.released": h(killSwitch),
  };
}

export const deadLetters = (db: Kysely<DB>) => deadLetterSink(db, "consumer:rails");
