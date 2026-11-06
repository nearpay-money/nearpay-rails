/**
 * Stage 1 ops CLI (platform §3): `docker compose exec rails-api /nodejs/bin/node dist/ops.js <command>`.
 * Every command prints one JSON document; errors print `{"error": …}` and exit 1 (2: usage).
 *
 * The live kill switch belongs to sentinel (`evt.sentinel.kill_switch.*`); `flag-set` is the RB-01
 * operator control for pausing cross-chain routes (and, in an emergency, quoting) locally.
 */
import { parseArgs } from "node:util";
import { isId, toUuid } from "@nearpay-internal/ids";
import { ApiError } from "@nearpay-internal/service";
import type { Rails } from "../app/context.js";
import { refreshMinimums } from "../app/minimums.js";
import { refreshTokens } from "../app/tokens.js";
import { executionView } from "../app/views.js";

export const USAGE = `usage: ops.js <command> [arguments]

  execution-show <ex_… | deposit address>   the execution, its transitions, observations and verifications
  flags                                     control flags
  flag-set <quoting_enabled|cross_chain_enabled> <true|false> <reason…>
  tokens-refresh [live|test]                reload a token registry from its provider now
  minimums-refresh                          recompute destination minimums now`;

class UsageError extends Error {}

const FLAGS = new Set(["quoting_enabled", "cross_chain_enabled"]);

export interface OpsDeps {
  actor: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export async function runOps(argv: readonly string[], r: Rails, deps: OpsDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => process.stderr.write(`${l}\n`));
  try {
    const { positionals } = parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: {} });
    const [cmd, ...args] = positionals;
    const result = await run(r, cmd, args, deps.actor);
    out(JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    return 0;
  } catch (e) {
    if (e instanceof UsageError || (e as { code?: string }).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
      err(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
      return 2;
    }
    err(JSON.stringify({ error: e instanceof ApiError ? { code: e.code, message: e.message } : String(e) }));
    return 1;
  }
}

async function run(r: Rails, cmd: string | undefined, args: string[], actor: string): Promise<unknown> {
  switch (cmd) {
    case "execution-show": {
      const ref = args[0];
      if (!ref) throw new UsageError("missing execution id or deposit address");
      const q = r.db.selectFrom("executions").selectAll();
      const row = await (isId("ex", ref) ? q.where("id", "=", toUuid(ref, "ex")) : q.where("deposit_address", "=", ref))
        .orderBy("created_at", "desc")
        .executeTakeFirst();
      if (!row) throw ApiError.missing("execution", ref);
      const [transitions, observations, verifications] = await Promise.all([
        r.db
          .selectFrom("execution_transitions")
          .selectAll()
          .where("execution_id", "=", row.id)
          .orderBy("created_at")
          .execute(),
        r.db
          .selectFrom("provider_observations")
          .select(["source", "provider_status", "applied", "provider_updated_at", "observed_at"])
          .where("execution_id", "=", row.id)
          .orderBy("observed_at")
          .execute(),
        r.db.selectFrom("verifications").selectAll().where("execution_id", "=", row.id).orderBy("checked_at").execute(),
      ]);
      return {
        execution: executionView(row),
        schedule: {
          next_poll_at: row.next_poll_at,
          verify_at: row.verify_at,
          poll_count: row.poll_count,
          tracking_until: row.tracking_until,
        },
        transitions: transitions.map((t) => ({
          from: t.from_state,
          to: t.to_state,
          cause: t.cause,
          actor: t.actor,
          at: t.created_at,
        })),
        observations,
        verifications: verifications.map((v) => ({
          tier: v.tier,
          source: v.source,
          result: v.result,
          tx_hash: v.tx_hash,
          amount: v.amount,
          at: v.checked_at,
          details: v.details,
        })),
      };
    }
    case "flags":
      return r.db.selectFrom("control_flags").selectAll().orderBy("name").execute();
    case "flag-set": {
      const [name, value, ...reason] = args;
      if (!name || !FLAGS.has(name)) throw new UsageError(`flag must be one of ${[...FLAGS].join(", ")}`);
      if (value !== "true" && value !== "false") throw new UsageError("value must be true or false");
      if (reason.length === 0) throw new UsageError("a reason is required");
      const row = await r.db
        .updateTable("control_flags")
        .set({ value: value === "true", reason: `${actor}: ${reason.join(" ")}`.slice(0, 500), updated_at: new Date() })
        .where("name", "=", name)
        .returningAll()
        .executeTakeFirstOrThrow();
      r.log.warn({ flag: name, value: row.value, actor }, "control flag changed by an operator");
      return row;
    }
    case "tokens-refresh": {
      const which = args[0] ?? "test";
      if (which !== "live" && which !== "test") throw new UsageError("tokens-refresh live|test");
      return { mode: which, tokens: await refreshTokens(r, which === "live") };
    }
    case "minimums-refresh":
      return { written: await refreshMinimums(r) };
    default:
      throw new UsageError(cmd ? `unknown command ${cmd}` : "missing command");
  }
}
