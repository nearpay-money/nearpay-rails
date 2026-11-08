/** Indexer parsing on recorded mainnet blocks (SP-14, neardata 2026-11-06). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NeardataBlock, TxStatus } from "../../src/infra/clients/near.js";
import { sandboxCredits } from "../../src/trackers/near-indexer/indexer.js";
import { creditsOf, outcomeSucceeded, outcomesOfBlock } from "../../src/trackers/near-indexer/parse.js";

const load = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/near/${name}`, import.meta.url), "utf8"));
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const ctx = (tokens: string[] = []) => ({
  chain: "near:mainnet",
  intentsContract: "intents.near",
  tokenContracts: new Set(tokens),
  blockRef: "223270700",
});

describe("neardata block 223270700", () => {
  const block = NeardataBlock.parse(load("block-223270700.json"));
  const outcomes = outcomesOfBlock(block);

  it("parses the block and its receipt outcomes", () => {
    expect(block.block.header.height).toBe(223270700);
    expect(outcomes.length).toBeGreaterThan(10);
    expect(outcomes.every((o) => typeof o.receiptId === "string")).toBe(true);
  });

  it("a DIP-4 transfer with a memo is a binding credit; its mt_transfer is an amount credit without memo", () => {
    const credits = outcomes.flatMap((o) => creditsOf(o, ctx()));
    const tx = credits.filter((c) => c.txHash === "F4j6f6d1V1tRycSMuTfVjFX2LN2dfQwWBmg1yF6Wu7Hv");
    const binding = tx.filter((c) => c.kind === "binding");
    const amount = tx.filter((c) => c.kind === "amount");
    expect(binding).toHaveLength(1);
    expect(binding[0]).toMatchObject({
      to: "51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe",
      assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      amount: 1_000_000n,
    });
    expect(binding[0]?.memo).toMatch(/^Abg/);
    expect(amount).toHaveLength(1);
    expect(amount[0]).toMatchObject({
      to: binding[0]?.to,
      assetId: binding[0]?.assetId,
      amount: 1_000_000n,
      memo: null,
    });
    expect(new Set(credits.map((c) => `${c.txHash}|${c.logRef}`)).size).toBe(credits.length);
  });

  it("names the sender of every credit (spec 0.3.0 Evidence.sender): DIP-4 account_id, NEP-245/NEP-141 old_owner_id", () => {
    const credits = outcomes.flatMap((o) => creditsOf(o, ctx([USDC])));
    const tx = credits.filter((c) => c.txHash === "F4j6f6d1V1tRycSMuTfVjFX2LN2dfQwWBmg1yF6Wu7Hv");
    const sender = "437e16df6fd7cb37745ce0d104d1ecba34d80fcbe99f5d0b674be74548d3fc89";
    expect(tx.map((c) => [c.kind, c.from])).toEqual([
      ["binding", sender],
      ["amount", sender],
    ]);
    expect(credits.find((c) => c.to === "hollowpine4417.near")?.from).toBe("dclv2.ref-labs.near");
    expect(credits.every((c) => c.from !== null)).toBe(true);
  });

  it("NEP-141 ft_transfers count only for watched token contracts", () => {
    const none = outcomes.flatMap((o) => creditsOf(o, ctx())).filter((c) => c.assetId === `nep141:${USDC}`);
    expect(none).toHaveLength(0);
    const usdc = outcomes.flatMap((o) => creditsOf(o, ctx([USDC]))).filter((c) => c.assetId === `nep141:${USDC}`);
    expect(usdc.map((c) => [c.to, c.amount])).toEqual(
      expect.arrayContaining([
        ["e6bb0ba0850ad9d5126e8b9790b6fc5688463e8bef963e7a3c06433907ebfd34", 213_006_045n],
        ["hollowpine4417.near", 73_230_594n],
        ["u-cexdex.near", 64_199_344n],
      ]),
    );
  });
});

describe("other recorded blocks", () => {
  it("block 223270707: an mt_transfer of a solver delivery without memo", () => {
    const credits = outcomesOfBlock(NeardataBlock.parse(load("block-223270707.json"))).flatMap((o) =>
      creditsOf(o, ctx()),
    );
    expect(credits).toContainEqual(
      expect.objectContaining({
        kind: "amount",
        to: "fd2a0d8f8f018b55570fe33c15129a507962d86e90c054d6f0e6c88e3e88045b",
        assetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
        amount: 159_815n,
      }),
    );
  });

  it("block 223270703 parses (multi-token mt_transfer batches)", () => {
    const credits = outcomesOfBlock(NeardataBlock.parse(load("block-223270703.json"))).flatMap((o) =>
      creditsOf(o, ctx([USDC])),
    );
    expect(credits.some((c) => c.assetId.startsWith("nep245:"))).toBe(true);
    expect(credits).toContainEqual(expect.objectContaining({ to: "v2.ref-finance.near", amount: 232_035_480n }));
  });
});

describe("outcome filtering", () => {
  const log = (o: unknown) => `EVENT_JSON:${JSON.stringify(o)}`;
  const mt = log({
    standard: "nep245",
    version: "1.0.0",
    event: "mt_transfer",
    data: [{ old_owner_id: "a.near", new_owner_id: "B.near", token_ids: ["nep141:x.near"], amounts: ["5"] }],
  });

  it("ignores failed receipts, malformed data and other contracts", () => {
    const base = { receiptId: "r", txHash: "t", executor: "intents.near", logs: [mt] };
    expect(creditsOf({ ...base, success: false }, ctx())).toEqual([]);
    expect(creditsOf({ ...base, executor: "other.near", success: true }, ctx())).toEqual([]);
    expect(creditsOf({ ...base, success: true }, ctx())).toEqual([
      expect.objectContaining({ to: "b.near", amount: 5n }),
    ]);
    const junk = [
      "not an event",
      "EVENT_JSON:{oops",
      log({
        standard: "nep245",
        version: "1",
        event: "mt_transfer",
        data: [{ new_owner_id: "x", token_ids: ["a"], amounts: ["1", "2"] }],
      }),
      log({
        standard: "nep245",
        version: "1",
        event: "mt_transfer",
        data: [{ new_owner_id: "x", token_ids: ["a"], amounts: ["-1"] }],
      }),
      log({ standard: "dip4", version: "1", event: "transfer", data: [{ receiver_id: "x", tokens: { a: "1" } }] }),
      log({
        standard: "dip4",
        version: "1",
        event: "transfer",
        data: [{ receiver_id: "x", tokens: { a: 1 }, memo: "np1:x" }],
      }),
      log({ standard: "dip4", version: "1", event: "transfer", data: "nope" }),
      log({ standard: "nep141", version: "1", event: "ft_transfer", data: [{ new_owner_id: "x", amount: "1.5" }] }),
    ];
    expect(creditsOf({ ...base, logs: junk, success: true }, ctx(["intents.near"]))).toEqual([]);
    expect(creditsOf({ ...base, txHash: null, success: true }, ctx())[0]?.txHash).toBe("r");
  });

  it("success statuses", () => {
    expect(outcomeSucceeded({ SuccessValue: "" })).toBe(true);
    expect(outcomeSucceeded({ SuccessReceiptId: "x" })).toBe(true);
    expect(outcomeSucceeded({ Failure: {} })).toBe(false);
  });

  it("sandbox Verifier logs go through the same parser", () => {
    const dip4 = log({
      standard: "dip4",
      version: "0.4.3",
      event: "transfer",
      data: [{ account_id: "p.near", receiver_id: "m.near", tokens: { "nep141:x.near": "10" }, memo: "np1:abc" }],
    });
    expect(sandboxCredits("intents.near", "h", 7, [dip4, mt])).toEqual([
      expect.objectContaining({
        kind: "binding",
        to: "m.near",
        from: "p.near",
        memo: "np1:abc",
        amount: 10n,
        blockRef: "7",
      }),
      expect.objectContaining({ kind: "amount", to: "b.near", from: "a.near", amount: 5n }),
    ]);
  });

  it("a sender the event does not name (or names oddly) is unknown, never guessed", () => {
    const anon = log({
      standard: "nep245",
      version: "1.0.0",
      event: "mt_transfer",
      data: [{ new_owner_id: "b.near", token_ids: ["nep141:x.near"], amounts: ["5"] }],
    });
    const odd = log({
      standard: "nep245",
      version: "1.0.0",
      event: "mt_transfer",
      data: [{ old_owner_id: 42, new_owner_id: "b.near", token_ids: ["nep141:x.near"], amounts: ["5"] }],
    });
    const ft = log({
      standard: "nep141",
      version: "1.0.0",
      event: "ft_transfer",
      data: [{ old_owner_id: "Payer.NEAR", new_owner_id: "m.near", amount: "7" }],
    });
    const base = { receiptId: "r", txHash: "t", success: true };
    expect(creditsOf({ ...base, executor: "intents.near", logs: [anon, odd] }, ctx()).map((c) => c.from)).toEqual([
      null,
      null,
    ]);
    expect(creditsOf({ ...base, executor: "usdc.near", logs: [ft] }, ctx(["usdc.near"]))[0]?.from).toBe("payer.near");
  });
});

describe("recorded EXPERIMENTAL_tx_status", () => {
  it("parses a final intents transfer and a USDC ft_transfer", () => {
    const a = TxStatus.parse(load("tx-intents-transfer.json").result);
    expect(a.final_execution_status).toBe("FINAL");
    const b = TxStatus.parse(load("tx-usdc-ft-transfer.json").result);
    expect(b.receipts_outcome.some((o) => o.outcome.executor_id === USDC)).toBe(true);
    expect(load("tx-unknown.json").error.cause.name).toBe("UNKNOWN_TRANSACTION");
  });
});
