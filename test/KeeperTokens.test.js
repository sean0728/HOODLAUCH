const assert = require("assert");
const { mergeV2KeeperTokens } = require("../lib/keeperTokens");

describe("V2 keeper token list", () => {
  const A = "0xAaaa000000000000000000000000000000000001";
  const B = "0xBbbb000000000000000000000000000000000002";
  const C = "0xCccc000000000000000000000000000000000003";
  it("includes relayed (ledger) launches", () => {
    assert.deepStrictEqual(mergeV2KeeperTokens([{ tokenAddress: A }], {}), [A]);
  });
  it("REGRESSION: includes direct launches that only discovery tracked", () => {
    const tracked = { [B.toLowerCase()]: { tokenAddress: B, kind: "token", protocol: "v2" } };
    assert.deepStrictEqual(mergeV2KeeperTokens([{ tokenAddress: A }], tracked), [A, B]);
  });
  it("dedupes an address present in both, case-insensitively", () => {
    const tracked = { [A.toLowerCase()]: { tokenAddress: A.toLowerCase(), kind: "custom" } };
    assert.strictEqual(mergeV2KeeperTokens([{ tokenAddress: A }], tracked).length, 1);
  });
  it("covers all four V2 kinds", () => {
    const kinds = ["token", "custom", "curve", "custom-curve"];
    const tracked = {};
    kinds.forEach((k, i) => (tracked["0x" + String(i + 1).padStart(40, "0")] = { tokenAddress: "0x" + String(i + 1).padStart(40, "0"), kind: k }));
    assert.strictEqual(mergeV2KeeperTokens([], tracked).length, 4);
  });
  it("skips V4 tokens (tracked or in the ledger) and the manually tracked platform token", () => {
    const tracked = {
      [B.toLowerCase()]: { tokenAddress: B, kind: "v4token", protocol: "v4" },
      [C.toLowerCase()]: { tokenAddress: C, kind: "platform", manuallyTracked: true },
    };
    assert.deepStrictEqual(mergeV2KeeperTokens([{ tokenAddress: A, protocol: "v4" }], tracked), []);
  });
  it("tolerates empty or missing inputs", () => {
    assert.deepStrictEqual(mergeV2KeeperTokens(undefined, undefined), []);
    assert.deepStrictEqual(mergeV2KeeperTokens([null, {}], { x: null }), []);
  });
  it("skips Solana launches that share the ledger (chain solana / Meteora protocol)", () => {
    const sol = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    assert.deepStrictEqual(mergeV2KeeperTokens([{ tokenAddress: sol, chain: "solana" }, { tokenAddress: sol, protocol: "meteora-dbc" }, { tokenAddress: A, chain: "robinhood" }], {}), [A]);
  });
});
