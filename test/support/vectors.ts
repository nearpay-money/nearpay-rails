/** Spec test vectors, read from the published `@nearpay/spec` package (`test-vectors/`). */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export function specVector<T = unknown>(name: string): T {
  const pkg = dirname(require.resolve("@nearpay/spec/package.json"));
  return JSON.parse(readFileSync(join(pkg, "test-vectors", name), "utf8")) as T;
}
