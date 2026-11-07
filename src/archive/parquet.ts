/**
 * Observation archive file format (lld/rails.md §8.11): one Parquet file per batch with the columns `id,
 * execution_id, source, provider_status, provider_updated_at, applied, observed_at, payload_json, payload_sha256`
 * (payload as its stored JSON text, hash as lower-case hex).
 */
import { parquetReadObjects } from "hyparquet";
import { parquetWriteBuffer } from "hyparquet-writer";

export interface ArchivedObservation {
  readonly id: string;
  readonly execution_id: string;
  readonly source: string;
  readonly provider_status: string | null;
  readonly provider_updated_at: Date | null;
  readonly applied: boolean;
  readonly observed_at: Date;
  readonly payload_json: string;
  readonly payload_sha256: string;
}

export const ARCHIVE_COLUMNS = [
  "id",
  "execution_id",
  "source",
  "provider_status",
  "provider_updated_at",
  "applied",
  "observed_at",
  "payload_json",
  "payload_sha256",
] as const;

export function encodeObservations(rows: readonly ArchivedObservation[]): Uint8Array {
  const col = <K extends keyof ArchivedObservation>(k: K) => rows.map((x) => x[k]);
  const buf = parquetWriteBuffer({
    columnData: [
      { name: "id", data: col("id"), type: "STRING" },
      { name: "execution_id", data: col("execution_id"), type: "STRING" },
      { name: "source", data: col("source"), type: "STRING" },
      { name: "provider_status", data: col("provider_status"), type: "STRING" },
      { name: "provider_updated_at", data: col("provider_updated_at"), type: "TIMESTAMP" },
      { name: "applied", data: col("applied"), type: "BOOLEAN" },
      { name: "observed_at", data: col("observed_at"), type: "TIMESTAMP" },
      { name: "payload_json", data: col("payload_json"), type: "STRING" },
      { name: "payload_sha256", data: col("payload_sha256"), type: "STRING" },
    ],
    kvMetadata: [{ key: "nearpay.schema", value: "rails.observations.v1" }],
  });
  return new Uint8Array(buf);
}

export async function decodeObservations(bytes: Uint8Array): Promise<ArchivedObservation[]> {
  const file = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const rows = (await parquetReadObjects({ file })) as Record<string, unknown>[];
  return rows.map((x) => ({
    id: String(x.id),
    execution_id: String(x.execution_id),
    source: String(x.source),
    provider_status: x.provider_status === null || x.provider_status === undefined ? null : String(x.provider_status),
    provider_updated_at: x.provider_updated_at instanceof Date ? x.provider_updated_at : null,
    applied: x.applied === true,
    observed_at: x.observed_at as Date,
    payload_json: String(x.payload_json),
    payload_sha256: String(x.payload_sha256),
  }));
}
