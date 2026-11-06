/** Tracker cursors (`cursors` table) and the shared loop helper for leader-elected feeds. */
import type { Rails } from "../app/context.js";

export async function readCursor<T>(r: Rails, name: string): Promise<T | null> {
  const row = await r.db.selectFrom("cursors").select("value").where("name", "=", name).executeTakeFirst();
  return row ? (row.value as T) : null;
}

export async function writeCursor(r: Rails, name: string, value: unknown): Promise<void> {
  const v = JSON.stringify(value);
  await r.db
    .insertInto("cursors")
    .values({ name, value: v, updated_at: new Date(r.now()) })
    .onConflict((oc) => oc.column("name").doUpdateSet({ value: v, updated_at: new Date(r.now()) }))
    .execute();
}

/** Forgets a cursor: an idle tracker restarts from the head when demand returns. */
export async function clearCursor(r: Rails, name: string): Promise<void> {
  await r.db.deleteFrom("cursors").where("name", "=", name).execute();
}

/** Runs `step` until `signal` aborts; `step` returns the delay before the next run (ms). */
export async function loop(
  r: Rails,
  name: string,
  signal: AbortSignal,
  step: () => Promise<number>,
  onErrorDelayMs = 5_000,
): Promise<void> {
  while (!signal.aborted) {
    let delay: number;
    try {
      delay = await step();
    } catch (e) {
      r.log.warn({ err: e, loop: name }, "feed step failed");
      delay = onErrorDelayMs;
    }
    if (signal.aborted) return;
    await new Promise<void>((res) => {
      const t = setTimeout(res, delay);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          res();
        },
        { once: true },
      );
    });
  }
}
