/**
 * Test doubles for external systems that cannot run locally: a 1Click-compatible server (signed with a
 * test key using the SDK's quote hash), and fixture-serving neardata / NEAR RPC servers. The sandbox
 * (test mode) and EVM chains (Anvil) run for real in containers instead.
 */
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { quoteHash } from "@defuse-protocol/one-click-sdk-typescript";
import bs58 from "bs58";

export interface FakeServer {
  readonly url: string;
  readonly requests: { method: string; path: string; headers: IncomingMessage["headers"]; body: unknown }[];
  stop(): Promise<void>;
}

export type Handler = (req: {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: IncomingMessage["headers"];
}) =>
  | { status: number; body: unknown; headers?: Record<string, string> }
  | Promise<{ status: number; body: unknown; headers?: Record<string, string> }>;

export async function fakeServer(handler: Handler): Promise<FakeServer> {
  const requests: FakeServer["requests"] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {}
    const u = new URL(req.url ?? "/", "http://x");
    requests.push({ method: req.method ?? "GET", path: u.pathname, headers: req.headers, body });
    try {
      const out = await handler({
        method: req.method ?? "GET",
        path: u.pathname,
        query: u.searchParams,
        body,
        headers: req.headers,
      });
      res.writeHead(out.status, { "content-type": "application/json", ...out.headers });
      res.end(out.body === undefined ? "" : JSON.stringify(out.body));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: String(e) }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    stop: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export const fixture = (path: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8"));

// ---------------------------------------------------------------------------------------------
// 1Click
// ---------------------------------------------------------------------------------------------

export interface FakeOneClick extends FakeServer {
  /** `ed25519:<base58>` public key the fake signs with. */
  readonly managerPublicKey: string;
  /** Status responses by deposit address (absent → 404). */
  readonly statuses: Map<string, { status: string; updatedAt?: string; swapDetails?: Record<string, unknown> }>;
  /** Mutates every quote response before signing (tamper tests). */
  tamper: ((q: Record<string, unknown>) => void) | null;
  /** Mutates after signing (signature-failure tests). */
  afterSign: ((q: Record<string, unknown>) => void) | null;
  /** Next quote answers with this status and body instead. */
  reject: { status: number; body: unknown } | null;
  readonly quotes: Map<string, Record<string, unknown>>;
}

export async function fakeOneClick(): Promise<FakeOneClick> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const statuses: FakeOneClick["statuses"] = new Map();
  const quotes: FakeOneClick["quotes"] = new Map();
  // the handler reads the controls from the returned object itself (set by the tests)
  const state = { tamper: null, afterSign: null, reject: null } as Pick<
    FakeOneClick,
    "tamper" | "afterSign" | "reject"
  >;
  let self: typeof state = state;
  const server = await fakeServer((req) => {
    if (req.path === "/v0/tokens") return { status: 200, body: fixture("oneclick/tokens.json") };
    if (req.path === "/v0/quote") {
      if (self.reject) {
        const r = self.reject;
        self.reject = null;
        return r;
      }
      const q = req.body as Record<string, unknown>;
      const fees = (q.appFees as { recipient: string; fee: number }[] | undefined) ?? [];
      const split = fees.flatMap((f) => [
        { recipient: f.recipient, fee: f.fee - Math.ceil(f.fee / 2) },
        { recipient: "5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd", fee: Math.ceil(f.fee / 2) },
      ]);
      const amount = BigInt(q.amount as string);
      // EXACT_INPUT (refund legs): exactly `amount` in, 1 % route cost out, minAmountOut the requested slippage below
      // (1Click: floor(amountOut × (10 000 − slippageTolerance) / 10 000))
      const exactIn = q.swapType === "EXACT_INPUT";
      const out = exactIn ? (amount * 9_900n) / 10_000n : amount;
      const address =
        q.depositType === "INTENTS"
          ? `dep-${randomBytes(8).toString("hex")}.near`
          : `0x${randomBytes(20).toString("hex")}`;
      const response: Record<string, unknown> = {
        correlationId: randomBytes(8).toString("hex"),
        timestamp: new Date().toISOString(),
        quoteRequest: {
          ...q,
          depositMode: q.depositMode ?? "SIMPLE",
          confidentiality: "public",
          appFees: split,
          insured: false,
        },
        quote: {
          ...(q.dry ? {} : { depositAddress: address, deadline: q.deadline, timeWhenInactive: q.deadline }),
          amountIn: (exactIn ? amount : (amount * 10_100n) / 10_000n).toString(),
          amountInFormatted: "x",
          amountInUsd: "x",
          minAmountIn: amount.toString(),
          amountOut: out.toString(),
          amountOutFormatted: "x",
          amountOutUsd: "x",
          minAmountOut: (exactIn
            ? (out * (10_000n - BigInt((q.slippageTolerance as number | undefined) ?? 0))) / 10_000n
            : amount
          ).toString(),
          timeEstimate: 20,
          refundFee: "0",
          withdrawFee: "20000",
        },
      };
      self.tamper?.(response);
      const hash = quoteHash({ ...response, signature: "" } as never);
      response.signature = `ed25519:${bs58.encode(sign(null, Buffer.from(hash, "utf8"), privateKey))}`;
      self.afterSign?.(response);
      if (!q.dry) quotes.set(address, response);
      return { status: 200, body: response };
    }
    if (req.path === "/v0/status" || req.path === "/v0/deposit/submit") {
      const address =
        req.path === "/v0/status"
          ? req.query.get("depositAddress")
          : (req.body as { depositAddress?: string }).depositAddress;
      const s = address ? statuses.get(address) : undefined;
      const quote = address ? quotes.get(address) : undefined;
      if (!s || !quote) return { status: 404, body: fixture("oneclick/status-404.json") };
      return {
        status: 200,
        body: {
          correlationId: "c",
          quoteResponse: quote,
          status: s.status,
          updatedAt: s.updatedAt ?? new Date().toISOString(),
          swapDetails: {
            intentHashes: [],
            nearTxHashes: [],
            originChainTxHashes: [],
            destinationChainTxHashes: [],
            ...s.swapDetails,
          },
        },
      };
    }
    return { status: 404, body: { message: "not found" } };
  });
  const fake = Object.assign(server, {
    managerPublicKey: `ed25519:${bs58.encode(raw)}`,
    statuses,
    quotes,
    tamper: null,
    afterSign: null,
    reject: null,
  }) as FakeOneClick;
  self = fake;
  return fake;
}

// ---------------------------------------------------------------------------------------------
// NEAR
// ---------------------------------------------------------------------------------------------

/** neardata serving recorded blocks; heights without a fixture are skipped (`null`). */
export async function fakeNeardata(final: () => number): Promise<FakeServer> {
  return fakeServer((req) => {
    if (req.path === "/v0/last_block/final") {
      const h = final();
      return { status: 200, body: { block: { header: { height: h, hash: `h${h}` } }, shards: [] } };
    }
    const m = /^\/v0\/block\/(\d+)$/.exec(req.path);
    if (m) {
      try {
        return { status: 200, body: fixture(`near/block-${m[1]}.json`) };
      } catch {
        return { status: 200, body: null };
      }
    }
    return { status: 404, body: null };
  });
}

/** NEAR JSON-RPC answering EXPERIMENTAL_tx_status from recorded responses (hash → fixture). */
export async function fakeNearRpc(txs: Record<string, string>): Promise<FakeServer> {
  return fakeServer((req) => {
    const b = req.body as { method: string; params: { tx_hash: string } };
    const file = txs[b.params?.tx_hash];
    if (b.method !== "EXPERIMENTAL_tx_status")
      return { status: 200, body: { jsonrpc: "2.0", id: 1, error: { message: "unsupported" } } };
    return { status: 200, body: file ? fixture(`near/${file}`) : fixture("near/tx-unknown.json") };
  });
}
