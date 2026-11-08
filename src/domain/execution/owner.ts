/**
 * Execution ownership (lld/rails.md §20, spec 0.3.0 `Execution.owner`). Pure.
 *
 * An execution belongs to the service that consumes its events: `payments` (checkout attempts, refund legs) or
 * `agentpay` (cross-chain x402 `near-intents` quotes). Ownership is decided by the **caller identity** (the
 * service token's `sub`), never by the request alone, and every rule fails closed:
 *
 * - create: the effective owner (`owner ?? payments`) must be the calling service; only `payments` and
 *   `agentpay` create executions, only `payments` creates or abandons refund legs;
 * - write (`deposit_tx`, `signals`): only the owner;
 * - read: `agentpay` sees its own executions plus the payments executions it relays signed intents for
 *   (`intents_transfer` payments and refund legs carrying a `refund.transfer`, agentpay §5) — nothing else.
 *   Other services and console operators read every execution (unchanged).
 */

export const OWNERS = ["payments", "agentpay"] as const;
export type Owner = (typeof OWNERS)[number];

/** Who is calling, as far as ownership is concerned (from the verified internal token). */
export type Caller =
  | { readonly kind: "service"; readonly service: string }
  | { readonly kind: "ops" }
  | { readonly kind: "other" };

export function callerOf(principal: { readonly ptype?: string; readonly sub?: string } | null): Caller {
  if (principal?.ptype === "service" && typeof principal.sub === "string" && principal.sub.length > 0)
    return { kind: "service", service: principal.sub };
  if (principal?.ptype === "ops") return { kind: "ops" };
  return { kind: "other" };
}

export const isOwner = (v: unknown): v is Owner => v === "payments" || v === "agentpay";

/** The `x402:` idempotency namespace belongs to agentpay quotes (`x402:<binding>`, agentpay §3.1). */
export const X402_KEY_PREFIX = "x402:";

export type OwnerRefusal =
  | { readonly kind: "forbidden"; readonly message: string }
  | { readonly kind: "invalid"; readonly message: string; readonly param: string };

/** The fields of a `CreateExecution` body the ownership rules look at. */
export interface CreateShape {
  readonly owner?: string | undefined;
  readonly x402_binding?: string | undefined;
  readonly idempotency_key: string;
  readonly method: string;
  readonly reference?: unknown;
  readonly destination: { readonly type: string; readonly asset_id: string };
  readonly pricing: { readonly currency: string; readonly asset_id?: string | undefined };
  readonly fee: { readonly bearer: string };
}

/**
 * Decides the owner of a new execution, or refuses. `agentpay` executions have the exact shape of agentpay §3.1
 * step 2: `x402_binding` set and `idempotency_key = x402:<binding>`, no payments `reference`, `route_quote` to an
 * Intents account, priced in the destination asset itself, fee borne by the payer.
 */
export function decideCreateOwner(caller: Caller, b: CreateShape): { ok: true; owner: Owner } | OwnerRefusal {
  if (b.owner !== undefined && !isOwner(b.owner))
    return { kind: "invalid", message: `unknown owner ${b.owner}`, param: "owner" };
  const owner: Owner = (b.owner as Owner | undefined) ?? "payments";
  if (caller.kind !== "service" || caller.service !== owner)
    return {
      kind: "forbidden",
      message:
        caller.kind === "service"
          ? `${caller.service} may not create executions owned by ${owner}`
          : "only the owning service creates executions",
    };
  if (owner === "payments") {
    if (b.x402_binding !== undefined)
      return { kind: "invalid", message: "x402_binding is only for owner agentpay", param: "x402_binding" };
    if (b.idempotency_key.startsWith(X402_KEY_PREFIX))
      return { kind: "invalid", message: "the x402: key namespace is agentpay's", param: "idempotency_key" };
    return { ok: true, owner };
  }
  if (!b.x402_binding)
    return { kind: "invalid", message: "owner agentpay requires x402_binding", param: "x402_binding" };
  if (b.idempotency_key !== `${X402_KEY_PREFIX}${b.x402_binding}`)
    return { kind: "invalid", message: "idempotency_key must be x402:<x402_binding>", param: "idempotency_key" };
  if (b.reference !== undefined)
    return { kind: "invalid", message: "owner agentpay executions carry no payments reference", param: "reference" };
  if (b.method !== "route_quote")
    return { kind: "invalid", message: "owner agentpay executions are route quotes", param: "method" };
  if (b.destination.type !== "intents_account")
    return { kind: "invalid", message: "owner agentpay pays an Intents account", param: "destination.type" };
  if (b.pricing.currency !== "asset" || b.pricing.asset_id !== b.destination.asset_id)
    return {
      kind: "invalid",
      message: "owner agentpay is priced in the destination asset (pricing.currency asset)",
      param: "pricing",
    };
  if (b.fee.bearer !== "payer")
    return { kind: "invalid", message: "owner agentpay executions have fee bearer payer", param: "fee.bearer" };
  return { ok: true, owner };
}

/** Refund legs and abandoning them are payments' alone. */
export function mayManageRefundLegs(caller: Caller): boolean {
  return caller.kind === "service" && caller.service === "payments";
}

/** The fields of an execution row the read/write rules look at. */
export interface OwnedRow {
  readonly owner: string;
  readonly kind: string;
  readonly method: string;
  readonly refund: { readonly transfer?: unknown } | null;
}

/** Payments executions agentpay validates signed intents against (agentpay §5 `/internal/relay`). */
export function relayable(row: OwnedRow): boolean {
  if (row.owner !== "payments") return false;
  if (row.method === "intents_transfer") return true;
  return row.kind === "refund" && row.refund?.transfer !== undefined && row.refund?.transfer !== null;
}

export function mayRead(caller: Caller, row: OwnedRow): boolean {
  if (caller.kind === "service" && caller.service === "agentpay") return row.owner === "agentpay" || relayable(row);
  return true;
}

/** `deposit_tx` / `signals`: only the owning service (an unknown owner value never matches). */
export function mayWrite(caller: Caller, row: Pick<OwnedRow, "owner">): boolean {
  return caller.kind === "service" && isOwner(row.owner) && caller.service === row.owner;
}

/**
 * The owner filter a list read applies (`listEvidence`, deposit lookup): agentpay only ever sees its own
 * executions; other callers get what they asked for (`undefined` = every owner).
 */
export function listOwnerFilter(
  caller: Caller,
  requested: string | undefined,
): { ok: true; owner: Owner | undefined } | OwnerRefusal {
  if (requested !== undefined && !isOwner(requested))
    return { kind: "invalid", message: `unknown owner ${requested}`, param: "owner" };
  if (caller.kind === "service" && caller.service === "agentpay") {
    if (requested !== undefined && requested !== "agentpay")
      return { kind: "forbidden", message: "agentpay reads only its own executions" };
    return { ok: true, owner: "agentpay" };
  }
  return { ok: true, owner: requested as Owner | undefined };
}
