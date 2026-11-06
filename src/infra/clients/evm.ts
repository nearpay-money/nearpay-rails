/**
 * EVM JSON-RPC pool (lld/rails.md §8.7, §8.8, §10: ≥ 2 providers per chain, failover, agreement for
 * large amounts). Only the reads rails needs: the `finalized` head, ERC-20 Transfer logs, receipts
 * and transactions.
 */

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface EvmLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly logIndex: string;
  readonly removed?: boolean;
}

export interface EvmReceipt {
  readonly status: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly transactionHash: string;
  readonly logs: readonly EvmLog[];
}

export interface EvmTx {
  readonly hash: string;
  readonly to: string | null;
  readonly value: string;
  readonly blockNumber: string | null;
}

export class RpcUnavailable extends Error {
  override readonly name = "RpcUnavailable";
}

export interface EvmRpc {
  readonly urls: readonly string[];
  finalizedBlock(): Promise<bigint>;
  logs(q: {
    fromBlock: bigint;
    toBlock: bigint;
    addresses: readonly string[];
    recipients: readonly string[];
  }): Promise<EvmLog[]>;
  receipt(hash: string, urlIndex?: number): Promise<EvmReceipt | null>;
  transaction(hash: string): Promise<EvmTx | null>;
}

const hex = (n: bigint) => `0x${n.toString(16)}`;
/** 32-byte topic of an address. */
export const addressTopic = (a: string) => `0x${a.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
export const topicAddress = (t: string) => `0x${t.slice(-40).toLowerCase()}`;

export function evmRpc(o: { urls: readonly string[]; fetch?: typeof fetch; timeoutMs?: number }): EvmRpc {
  const f = o.fetch ?? fetch;
  let preferred = 0;
  async function callOne(url: string, method: string, params: unknown[]): Promise<unknown> {
    const res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 3_000),
    });
    if (!res.ok) throw new RpcUnavailable(`${method} responded ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new RpcUnavailable(`${method}: ${body.error.message ?? "rpc error"}`);
    return body.result ?? null;
  }
  async function call(method: string, params: unknown[]): Promise<unknown> {
    if (o.urls.length === 0) throw new RpcUnavailable("no RPC configured");
    let last: unknown;
    for (let i = 0; i < o.urls.length; i++) {
      const idx = (preferred + i) % o.urls.length;
      try {
        const r = await callOne(o.urls[idx] as string, method, params);
        preferred = idx;
        return r;
      } catch (e) {
        last = e;
      }
    }
    throw last instanceof Error ? last : new RpcUnavailable(String(last));
  }
  return {
    urls: o.urls,
    async finalizedBlock() {
      const b = (await call("eth_getBlockByNumber", ["finalized", false])) as { number?: string } | null;
      if (!b?.number) throw new RpcUnavailable("no finalized block");
      return BigInt(b.number);
    },
    async logs(q) {
      if (q.addresses.length === 0 || q.recipients.length === 0) return [];
      const r = (await call("eth_getLogs", [
        {
          fromBlock: hex(q.fromBlock),
          toBlock: hex(q.toBlock),
          address: q.addresses.map((a) => a.toLowerCase()),
          topics: [TRANSFER_TOPIC, null, q.recipients.map(addressTopic)],
        },
      ])) as EvmLog[] | null;
      return (r ?? []).filter((l) => !l.removed);
    },
    async receipt(hash, urlIndex) {
      if (urlIndex !== undefined) {
        const url = o.urls[urlIndex];
        if (!url) throw new RpcUnavailable(`no RPC #${urlIndex}`);
        return (await callOne(url, "eth_getTransactionReceipt", [hash])) as EvmReceipt | null;
      }
      return (await call("eth_getTransactionReceipt", [hash])) as EvmReceipt | null;
    },
    async transaction(hash) {
      return (await call("eth_getTransactionByHash", [hash])) as EvmTx | null;
    },
  };
}

/** ERC-20 transfers to `recipients` in a receipt, by token contract. */
export function erc20Transfers(
  logs: readonly EvmLog[],
): { token: string; to: string; amount: bigint; logIndex: string }[] {
  const out: { token: string; to: string; amount: bigint; logIndex: string }[] = [];
  for (const l of logs) {
    if (l.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || l.topics.length !== 3) continue;
    let amount: bigint;
    try {
      amount = BigInt(l.data === "0x" ? "0x0" : l.data);
    } catch {
      continue;
    }
    out.push({ token: l.address.toLowerCase(), to: topicAddress(l.topics[2] as string), amount, logIndex: l.logIndex });
  }
  return out;
}
