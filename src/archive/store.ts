/**
 * Archive store (lld/rails.md §8.11): `file:<dir>` (a Compose volume, local stage) or `s3://<bucket>/<prefix>` (EU
 * object storage, server stage; path-style requests signed with AWS Signature V4, no SDK). Objects are written once
 * and read back by the archive job before any payload is removed from the database.
 */
import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export interface ArchiveStore {
  /** Human-readable location (logs). */
  readonly describe: string;
  /** Key prefix every object key starts with (`""` for file stores). */
  readonly prefix: string;
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
}

function safeKey(key: string): string {
  if (!/^[A-Za-z0-9/_.=-]+$/.test(key) || key.split("/").some((p) => p === ".." || p === ""))
    throw new RangeError(`unsafe archive key: ${key}`);
  return key;
}

export function fileStore(dir: string): ArchiveStore {
  const root = resolve(dir);
  const path = (key: string) => {
    const p = resolve(join(root, safeKey(key)));
    if (!p.startsWith(root + sep)) throw new RangeError("archive key escapes the store");
    return p;
  };
  return {
    describe: `file:${root}`,
    prefix: "",
    async put(key, bytes) {
      const p = path(key);
      await mkdir(dirname(p), { recursive: true });
      const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, bytes, { flag: "wx" });
      await rename(tmp, p);
    },
    async get(key) {
      return new Uint8Array(await readFile(path(key)));
    },
  };
}

export interface S3Options {
  readonly bucket: string;
  readonly prefix: string;
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

const sha256hex = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const hmac = (k: Buffer | string, s: string) => createHmac("sha256", k).update(s).digest();
const encodePath = (p: string) =>
  p
    .split("/")
    .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");

/** AWS Signature V4 headers for a path-style S3 request (no query string). */
export function signS3(o: {
  method: "GET" | "PUT";
  url: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  payloadHash: string;
  nowMs: number;
}): Record<string, string> {
  const amz = new Date(o.nowMs)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = amz.slice(0, 8);
  const host = o.url.host;
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${o.payloadHash}\nx-amz-date:${amz}\n`;
  const signed = "host;x-amz-content-sha256;x-amz-date";
  const canonical = [o.method, o.url.pathname, "", canonicalHeaders, signed, o.payloadHash].join("\n");
  const scope = `${day}/${o.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amz, scope, sha256hex(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${o.secretAccessKey}`, day), o.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return {
    "x-amz-date": amz,
    "x-amz-content-sha256": o.payloadHash,
    authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
  };
}

export function s3Store(o: S3Options): ArchiveStore {
  const f = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const base = o.endpoint.replace(/\/$/, "");
  const url = (key: string) => new URL(`${base}/${encodePath(o.bucket)}/${encodePath(safeKey(key))}`);
  return {
    describe: `s3://${o.bucket}/${o.prefix}`,
    prefix: o.prefix,
    async put(key, bytes) {
      const u = url(key);
      const headers = signS3({ method: "PUT", url: u, ...o, payloadHash: sha256hex(bytes), nowMs: now() });
      const res = await f(u, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/vnd.apache.parquet" },
        body: Buffer.from(bytes),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`archive store PUT ${res.status}`);
    },
    async get(key) {
      const u = url(key);
      const headers = signS3({ method: "GET", url: u, ...o, payloadHash: sha256hex(""), nowMs: now() });
      const res = await f(u, { method: "GET", headers, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`archive store GET ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/** `NP_OBS_ARCHIVE_STORE` → a store (null when unset). */
export function archiveStore(
  spec: string | null,
  s3?: { endpoint?: string; region: string; accessKeyId?: string; secretAccessKey?: string; fetch?: typeof fetch },
): ArchiveStore | null {
  if (!spec) return null;
  if (spec.startsWith("file:")) return fileStore(spec.slice(5));
  const m = /^s3:\/\/([a-z0-9.-]+)(?:\/(.*))?$/.exec(spec);
  if (!m) throw new RangeError("NP_OBS_ARCHIVE_STORE must be file:<dir> or s3://<bucket>/<prefix>");
  if (!s3?.endpoint || !s3.accessKeyId || !s3.secretAccessKey)
    throw new RangeError("an s3:// archive store needs NP_OBS_ARCHIVE_S3_ENDPOINT and credentials");
  return s3Store({
    bucket: m[1] as string,
    prefix: (m[2] ?? "").replace(/\/+$/, ""),
    endpoint: s3.endpoint,
    region: s3.region,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    ...(s3.fetch ? { fetch: s3.fetch } : {}),
  });
}
