import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ArchiveVerificationError, archiveKey, verifyReadBack } from "../../src/app/archive.js";
import { type ArchivedObservation, decodeObservations, encodeObservations } from "../../src/archive/parquet.js";
import { archiveStore, fileStore, s3Store, signS3 } from "../../src/archive/store.js";
import { dayComplete, evidenceDigest, utcDay } from "../../src/domain/reconciliation/digest.js";

describe("reconciliation digest and completeness (§8.10)", () => {
  it("digest is order-independent and changes with a version or membership change", () => {
    const a = [
      { id: "ex_b", version: 2 },
      { id: "ex_a", version: 5 },
    ];
    expect(evidenceDigest(a)).toBe(evidenceDigest([...a].reverse()));
    expect(evidenceDigest(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(evidenceDigest(a)).not.toBe(evidenceDigest([{ id: "ex_b", version: 3 }, a[1] as never]));
    expect(evidenceDigest(a)).not.toBe(evidenceDigest([a[0] as never]));
    // empty day: sha256 of nothing
    expect(evidenceDigest([])).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("complete only an hour after the day, with cursors past it and nothing open before it", () => {
    const { start, end } = utcDay("2026-11-06");
    expect(start.toISOString()).toBe("2026-11-06T00:00:00.000Z");
    const base = { nowMs: end.getTime() + 3_600_000, endMs: end.getTime(), cursorUpdatedMs: [], openBeforeEnd: 0 };
    expect(dayComplete(base)).toBe(true);
    expect(dayComplete({ ...base, nowMs: end.getTime() + 3_599_999 })).toBe(false);
    expect(dayComplete({ ...base, cursorUpdatedMs: [end.getTime() - 1] })).toBe(false);
    expect(dayComplete({ ...base, cursorUpdatedMs: [end.getTime() + 5] })).toBe(true);
    expect(dayComplete({ ...base, openBeforeEnd: 1 })).toBe(false);
    expect(() => utcDay("2026-02-30")).toThrow(RangeError);
  });
});

const rows: ArchivedObservation[] = [
  {
    id: "0190f000-0000-7000-8000-000000000001",
    execution_id: "0190f000-0000-7000-8000-0000000000aa",
    source: "quote",
    provider_status: "PENDING_DEPOSIT",
    provider_updated_at: null,
    applied: true,
    observed_at: new Date("2026-08-01T10:00:00.123Z"),
    payload_json: '{"a": 1, "nested": {"b": [1, 2]}}',
    payload_sha256: "ab".repeat(32),
  },
  {
    id: "0190f000-0000-7000-8000-000000000002",
    execution_id: "0190f000-0000-7000-8000-0000000000aa",
    source: "hot_poll",
    provider_status: null,
    provider_updated_at: new Date("2026-08-01T10:00:05.000Z"),
    applied: false,
    observed_at: new Date("2026-08-01T10:00:06.000Z"),
    payload_json: "null",
    payload_sha256: "cd".repeat(32),
  },
];

describe("observation archive (§8.11)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rails-archive-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("Parquet round-trips every column, nulls included", async () => {
    expect(await decodeObservations(encodeObservations(rows))).toEqual(rows);
  });

  it("the read-back check refuses any difference", () => {
    expect(() => verifyReadBack(rows, rows)).not.toThrow();
    expect(() => verifyReadBack(rows, rows.slice(1))).toThrow(ArchiveVerificationError);
    expect(() => verifyReadBack(rows, [rows[1] as never, rows[0] as never])).toThrow(/id mismatch/);
    expect(() => verifyReadBack(rows, [{ ...rows[0], payload_json: "{}" } as never, rows[1] as never])).toThrow(
      /payload mismatch/,
    );
    expect(() => verifyReadBack(rows, [{ ...rows[0], payload_sha256: "00" } as never, rows[1] as never])).toThrow(
      /hash mismatch/,
    );
    expect(() => verifyReadBack(rows, [{ ...rows[0], observed_at: new Date(0) } as never, rows[1] as never])).toThrow(
      /observed_at/,
    );
  });

  it("keys follow <prefix>/rails/observations/<mode>/<yyyy>/<mm>/<dd>/<batch>.parquet", () => {
    expect(archiveKey("", true, "2026-08-01", "b1")).toBe("rails/observations/live/2026/08/01/b1.parquet");
    expect(archiveKey("np", false, "2026-08-01", "b1")).toBe("np/rails/observations/test/2026/08/01/b1.parquet");
  });

  it("file store writes atomically under its root and refuses escaping keys", async () => {
    const s = fileStore(dir);
    await s.put("rails/x/a.parquet", new Uint8Array([1, 2, 3]));
    expect([...(await s.get("rails/x/a.parquet"))]).toEqual([1, 2, 3]);
    expect(readdirSync(join(dir, "rails/x"))).toEqual(["a.parquet"]);
    await expect(s.put("../evil", new Uint8Array())).rejects.toThrow(RangeError);
    await expect(s.put("a//b", new Uint8Array())).rejects.toThrow(RangeError);
    expect(archiveStore(`file:${dir}`)?.describe).toBe(`file:${dir}`);
    expect(archiveStore(null)).toBeNull();
    expect(() => archiveStore("s3://bucket/p", { region: "eu-central-1" })).toThrow(/credentials/);
    expect(() => archiveStore("ftp://x")).toThrow(RangeError);
  });

  it("s3 store signs path-style requests with SigV4 and round-trips through an S3-like server", async () => {
    const objects = new Map<string, Buffer>();
    const auth: string[] = [];
    const srv = createServer((req, res) => {
      auth.push(String(req.headers.authorization));
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (req.method === "PUT") {
          objects.set(String(req.url), Buffer.concat(chunks));
          res.writeHead(200).end();
        } else {
          const o = objects.get(String(req.url));
          if (!o) res.writeHead(404).end();
          else res.writeHead(200).end(o);
        }
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const endpoint = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const s = archiveStore("s3://np-archive/eu/prod", {
      endpoint,
      region: "eu-central-1",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
    });
    expect(s?.prefix).toBe("eu/prod");
    await s?.put("eu/prod/rails/a.parquet", new Uint8Array([9, 8]));
    expect([...((await s?.get("eu/prod/rails/a.parquet")) ?? [])]).toEqual([9, 8]);
    expect([...objects.keys()]).toEqual(["/np-archive/eu/prod/rails/a.parquet"]);
    expect(auth[0]).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    await expect(
      s3Store({ bucket: "b", prefix: "", endpoint, region: "r", accessKeyId: "a", secretAccessKey: "s" }).get("nope"),
    ).rejects.toThrow(/404/);
    await new Promise<void>((r) => srv.close(() => r()));
    // deterministic signature for fixed inputs
    const sig = signS3({
      method: "GET",
      url: new URL("https://s3.example.com/b/k"),
      region: "eu-central-1",
      accessKeyId: "a",
      secretAccessKey: "s",
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      nowMs: Date.parse("2026-11-08T00:00:00Z"),
    });
    expect(sig["x-amz-date"]).toBe("20261108T000000Z");
    expect(sig.authorization).toBe(
      signS3({
        method: "GET",
        url: new URL("https://s3.example.com/b/k"),
        region: "eu-central-1",
        accessKeyId: "a",
        secretAccessKey: "s",
        payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        nowMs: Date.parse("2026-11-08T00:00:00Z"),
      }).authorization,
    );
  });
});
