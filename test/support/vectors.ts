/**
 * Spec test vectors. Spec 0.4.0 files come from the published package once it ships them, until then from the
 * copies of the spec branches under `test/fixtures/spec-0.4.0/` (placeholder, deleted in Phase B with `src/spec-0.4.0.ts`).
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export function specVector<T = unknown>(name: string): T {
  const pkg = dirname(require.resolve("@nearpay/spec/package.json"));
  const published = join(pkg, "test-vectors", name);
  const path = existsSync(published) ? published : new URL(`../fixtures/spec-0.4.0/${name}`, import.meta.url);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
