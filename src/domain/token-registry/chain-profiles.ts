/**
 * Chain profiles (lld/rails.md §4): which chains NearPay routes, their verification tier, deposit
 * windows and evidence timeouts. Pure: the profile file is parsed by infra; this module validates it
 * against the kit chain registry (address formats and explorers live there).
 */

import type { ConfirmationTier } from "@nearpay/spec";
import { type ChainInfo, getChain } from "@nearpay-internal/chains";
import { z } from "zod";
import {
  DEFAULT_EVM_CONFIRMATION,
  type EvmConfirmation,
  FINALIZED,
  MAX_CONFIRMATIONS,
  policyLabel,
} from "../chains/evm.js";

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
  /** Stage 4 (§21.1): confirmations by settlement value (Bitcoin), ascending, the last tier unbounded. */
  confirmation_tiers: z
    .array(
      z.object({
        below_usd_micros: z.int().min(1).nullable(),
        confirmations: z.int().min(1).max(100),
      }),
    )
    .min(1)
    .optional(),
  /**
   * EVM evidence rule (ADR-0022): `{kind: finalized}` or `{kind: confirmations, blocks}` (L2 block confirmations).
   * Absent → the chain's default (Base 10, Arbitrum 40 confirmations; others `finalized`). EVM chains only.
   */
  evm_confirmation: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("finalized") }),
      z.object({ kind: z.literal("confirmations"), blocks: z.int().min(1).max(MAX_CONFIRMATIONS) }),
    ])
    .optional(),
});

/** Families whose Tier-A evidence needs an RPC pool configured at boot (§21.4); others are always available. */
export const POOLED_FAMILIES: ReadonlySet<ChainInfo["family"]> = new Set(["solana", "bitcoin"]);

function tiersValid(tiers: readonly ConfirmationTier[]): boolean {
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i] as ConfirmationTier;
    const last = i === tiers.length - 1;
    if (last !== (t.below_usd_micros === null)) return false;
    if (i > 0) {
      const prev = tiers[i - 1] as ConfirmationTier;
      if (!last && (t.below_usd_micros as number) <= (prev.below_usd_micros as number)) return false;
      if (t.confirmations < prev.confirmations) return false;
    }
  }
  return true;
}

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
  /** Stage 4 (spec 0.4.0 `explorer_address_url`). */
  readonly explorerAddressUrl: string;
  /** Stage 4 (spec 0.4.0 `confirmation_tiers`): null for chains with a finality flag. */
  readonly confirmationTiers: readonly ConfirmationTier[] | null;
  /** EVM evidence rule (ADR-0022); null for non-EVM chains. */
  readonly evmConfirmation: EvmConfirmation | null;
  /** Tier the profile file declares (before the boot-time pool check, §21.4). */
  readonly configuredTier: "A" | "B";
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
    if (p.watcher && info.family === "near")
      throw new ProfileError(`chain profile ${p.chain}: NEAR is tracked by the indexer, not a watcher`);
    if (p.confirmation_tiers && !tiersValid(p.confirmation_tiers))
      throw new ProfileError(
        `chain profile ${p.chain}: confirmation_tiers must ascend and end with one unbounded tier`,
      );
    if (info.family === "bitcoin" && p.tier === "A" && !p.confirmation_tiers)
      throw new ProfileError(`chain profile ${p.chain}: a Tier-A Bitcoin chain needs confirmation_tiers`);
    if (p.watcher && p.tier !== "A") throw new ProfileError(`chain profile ${p.chain}: a watched chain is Tier A`);
    if (p.evm_confirmation && info.family !== "evm")
      throw new ProfileError(`chain profile ${p.chain}: evm_confirmation is for EVM chains only`);
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
      explorerAddressUrl: info.explorer.address,
      confirmationTiers: p.confirmation_tiers ?? null,
      evmConfirmation:
        info.family === "evm" ? (p.evm_confirmation ?? DEFAULT_EVM_CONFIRMATION[p.chain] ?? FINALIZED) : null,
      configuredTier: p.tier,
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
  /**
   * Boot-time tiers (§21.4): a Tier-A chain of a pooled family (Solana, Bitcoin) whose RPC pool is not configured is
   * Tier B (provider-attested within `NP_TIER_B_LIMITS`) and its watcher is off. Returns the effective profiles and the
   * chains degraded (alert `tier_a_degraded{chain}`).
   */
  withPools(hasPool: (chain: string) => boolean): { profiles: ChainProfiles; degraded: string[] } {
    const degraded: string[] = [];
    const out = new Map<string, ChainProfile>();
    for (const p of this.#byChain.values()) {
      if (p.configuredTier === "A" && POOLED_FAMILIES.has(p.family) && !hasPool(p.chain)) {
        degraded.push(p.chain);
        out.set(p.chain, { ...p, tier: "B", watcher: false });
      } else out.set(p.chain, p);
    }
    return { profiles: new ChainProfiles(out), degraded };
  }
  /**
   * Environment overrides of the EVM evidence rule (`NP_EVM_CONFIRMATIONS_<CHAINID>`, ADR-0022), keyed by CAIP-2 chain.
   * An override for a chain without a profile, or for a non-EVM chain, is refused (fail closed: a typo must not pass).
   */
  withEvmConfirmations(overrides: Readonly<Record<string, EvmConfirmation | undefined>>): ChainProfiles {
    const out = new Map(this.#byChain);
    for (const [chain, policy] of Object.entries(overrides)) {
      if (!policy) continue;
      const p = out.get(chain);
      if (!p) throw new ProfileError(`EVM confirmation override for ${chain}: no chain profile`);
      if (p.family !== "evm") throw new ProfileError(`EVM confirmation override for ${chain}: not an EVM chain`);
      out.set(chain, { ...p, evmConfirmation: policy });
    }
    return new ChainProfiles(out);
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
      // the effective EVM evidence rule (env overrides included); other chains: the profile text
      finality: p.evmConfirmation ? policyLabel(p.evmConfirmation) : p.finality,
      verification_timeout_s: p.verificationTimeoutS,
      memo_mode: p.memoMode,
      explorer_tx_url: p.explorerTxUrl,
      // spec 0.4.0 ChainProfile fields
      explorer_address_url: p.explorerAddressUrl,
      confirmation_tiers: p.confirmationTiers ? p.confirmationTiers.map((t) => ({ ...t })) : null,
    };
  }
}
