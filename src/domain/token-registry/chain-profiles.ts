/**
 * Chain profiles (lld/rails.md §4): which chains NearPay routes, their verification tier, deposit
 * windows and evidence timeouts. Pure: the profile file is parsed by infra; this module validates it
 * against the kit chain registry (address formats and explorers live there).
 */
import { type ChainInfo, getChain } from "@nearpay-internal/chains";
import { z } from "zod";

export const ChainProfileInput = z.object({
  chain: z.string().regex(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/),
  blockchain: z.string().regex(/^[a-z0-9_-]{2,32}$/),
  tier: z.enum(["A", "B"]),
  min_deadline_s: z.int().min(60).max(86_400),
  default_deadline_s: z.int().min(60).max(86_400),
  finality: z.string().min(1).max(100),
  verification_timeout_s: z.int().min(30).max(86_400),
  watcher: z.boolean().default(false),
  watch_interval_s: z.number().min(0.1).max(600).default(12),
  memo_mode: z.enum(["none", "required"]),
});

export interface ChainProfile {
  readonly chain: string;
  readonly blockchain: string;
  readonly family: ChainInfo["family"];
  readonly tier: "A" | "B";
  readonly minDeadlineS: number;
  readonly defaultDeadlineS: number;
  readonly finality: string;
  readonly verificationTimeoutS: number;
  readonly watcher: boolean;
  readonly watchIntervalS: number;
  readonly memoMode: "none" | "required";
  readonly explorerTxUrl: string;
  readonly info: ChainInfo;
}

export class ProfileError extends Error {
  override readonly name = "ProfileError";
}

/** Validates a parsed profile document (`{chains: [...]}`) into an indexed registry. */
export function chainProfiles(doc: unknown): ChainProfiles {
  const parsed = z.object({ chains: z.array(ChainProfileInput).min(1) }).safeParse(doc);
  if (!parsed.success) throw new ProfileError(`invalid chain profiles: ${parsed.error.message}`);
  const out = new Map<string, ChainProfile>();
  for (const p of parsed.data.chains) {
    const info = getChain(p.chain);
    if (!info) throw new ProfileError(`chain profile ${p.chain}: unknown chain (not in @nearpay-internal/chains)`);
    if (info.blockchain !== p.blockchain)
      throw new ProfileError(`chain profile ${p.chain}: blockchain ${p.blockchain} != ${info.blockchain}`);
    if (out.has(p.chain)) throw new ProfileError(`chain profile ${p.chain}: listed twice`);
    if (p.min_deadline_s > p.default_deadline_s)
      throw new ProfileError(`chain profile ${p.chain}: min_deadline_s exceeds default_deadline_s`);
    if (p.watcher && info.family !== "evm")
      throw new ProfileError(`chain profile ${p.chain}: watchers exist for EVM chains only`);
    if (p.watcher && p.tier !== "A") throw new ProfileError(`chain profile ${p.chain}: a watched chain is Tier A`);
    out.set(p.chain, {
      chain: p.chain,
      blockchain: p.blockchain,
      family: info.family,
      tier: p.tier,
      minDeadlineS: p.min_deadline_s,
      defaultDeadlineS: p.default_deadline_s,
      finality: p.finality,
      verificationTimeoutS: p.verification_timeout_s,
      watcher: p.watcher,
      watchIntervalS: p.watch_interval_s,
      memoMode: p.memo_mode,
      explorerTxUrl: info.explorer.tx,
      info,
    });
  }
  return new ChainProfiles(out);
}

export class ChainProfiles {
  readonly #byChain: ReadonlyMap<string, ChainProfile>;
  readonly #byBlockchain: ReadonlyMap<string, ChainProfile>;
  constructor(byChain: ReadonlyMap<string, ChainProfile>) {
    this.#byChain = byChain;
    this.#byBlockchain = new Map([...byChain.values()].map((p) => [p.blockchain, p]));
  }
  get(chain: string): ChainProfile | undefined {
    return this.#byChain.get(chain);
  }
  byBlockchain(code: string): ChainProfile | undefined {
    return this.#byBlockchain.get(code);
  }
  all(): ChainProfile[] {
    return [...this.#byChain.values()];
  }
  /** Spec view (`listChainProfiles`). */
  view(p: ChainProfile) {
    return {
      chain: p.chain,
      blockchain: p.blockchain,
      family: p.family,
      tier: p.tier,
      min_deadline_s: p.minDeadlineS,
      default_deadline_s: p.defaultDeadlineS,
      finality: p.finality,
      verification_timeout_s: p.verificationTimeoutS,
      memo_mode: p.memoMode,
      explorer_tx_url: p.explorerTxUrl,
    };
  }
}
