// Offline tests for solana-build/core.js. No network: a fake Connection serves canned data and a fake
// Wallet Standard wallet signs with a throwaway keypair. Checks that the transactions we build are
// well-formed, correctly signed and aimed at the right program/accounts.
import assert from "node:assert/strict";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import bs58 from "bs58";
import BN from "bn.js";
import * as DBC from "@meteora-ag/dynamic-bonding-curve-sdk";
import * as core from "../core.js";

let pass = 0, fail = 0;
const results = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log("PASS " + name); } catch (e) { fail++; console.log("FAIL " + name + " — " + (e && e.message)); results.push(e); }
}

// ---- fakes ----
class FakeConn extends Connection {
  constructor() { super("http://127.0.0.1:1"); this.sent = []; this.statusErr = null; this._rpcRequest = async (method) => { throw new Error('UNSTUBBED RPC: ' + method); }; }
  async getAccountInfo(key) {
    if (key.toBase58() === "So11111111111111111111111111111111111111112") {
      const data = Buffer.alloc(82); data.writeUInt8(9, 44); data.writeUInt8(1, 45); // SPL mint layout: decimals + is_initialized
      return { data, executable: false, lamports: 1_000_000_000, owner: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") };
    }
    return null;
  }
  async getMultipleAccountsInfo(keys) { return keys.map(() => null); }
  async getLatestBlockhash() { return { blockhash: bs58.encode(new Uint8Array(32).fill(7)), lastValidBlockHeight: 5000 }; }
  async getBlockHeight() { return 100; }
  async getSlot() { return 12345; }
  async getBlockTime() { return 1_790_000_000; }
  async getMinimumBalanceForRentExemption() { return 2_039_280; }
  async sendRawTransaction(raw) { this.sent.push(Buffer.from(raw)); return bs58.encode(Transaction.from(raw).signature); }
  async getSignatureStatuses() { return { value: [this.statusErr ? { err: this.statusErr } : { confirmationStatus: "confirmed", err: null }] }; }
  async getBalance() { return 5_000_000_000; }
  async getParsedTokenAccountsByOwner() { return { value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: 1234.5 } } } } } }] }; }
}
let EXPECT_CHAIN = "solana:devnet";
function fakeWallet(kp, { feature = "solana:signTransaction" } = {}) {
  const account = { address: kp.publicKey.toBase58(), publicKey: kp.publicKey.toBytes() };
  const features = {
    "standard:connect": { connect: async () => ({ accounts: [account] }) },
    "standard:events": { on: () => () => {} },
  };
  if (feature === "solana:signTransaction") {
    features[feature] = { signTransaction: async ({ transaction, chain }) => {
      assert.equal(chain, EXPECT_CHAIN);
      const tx = Transaction.from(transaction); tx.partialSign(kp);
      return [{ signedTransaction: tx.serialize({ requireAllSignatures: false }) }];
    } };
  }
  return { name: "Fake", chains: ["solana:devnet", "solana:mainnet"], features, accounts: [account] };
}

// ---- config + fabricated on-chain state ----
const params = core.buildCurveParams({});
const WSOL = core.WSOL_MINT;
const user = Keypair.generate();
const feeClaimer = Keypair.generate().publicKey;
const CONFIG = Keypair.generate().publicKey;

function makeState(conn) {
  const client = DBC.DynamicBondingCurveClient.create(conn, "confirmed");
  const norm = client.pool.normalizeQuoteConfig(params); // gives migrationSqrtPrice etc., like the real on-chain config
  const config = {
    ...norm,
    quoteMint: WSOL, feeClaimer, leftoverReceiver: feeClaimer,
    tokenType: DBC.TokenType.SPLToken, tokenDecimal: 6, activationType: DBC.ActivationType.Timestamp,
    collectFeeMode: DBC.CollectFeeMode.QuoteToken,
    preMigrationTokenSupply: new BN("1000000000000000"), postMigrationTokenSupply: new BN("1000000000000000"),
    migrationQuoteThreshold: params.migrationQuoteThreshold,
    sqrtStartPrice: params.sqrtStartPrice,
    tokenUpdateAuthority: 1,
  };
  const mint = Keypair.generate().publicKey;
  const poolAddr = DBC.deriveDbcPoolAddress(WSOL, mint, CONFIG);
  const mkPoolState = (over = {}) => ({
    config: CONFIG, creator: user.publicKey, baseMint: mint, baseVault: Keypair.generate().publicKey, quoteVault: Keypair.generate().publicKey,
    baseReserve: new BN("900000000000000"), quoteReserve: new BN(0), sqrtPrice: params.sqrtStartPrice, activationPoint: new BN(0),
    isMigrated: 0, volatilityTracker: { lastUpdateTimestamp: new BN(0), sqrtPriceReference: new BN(0), volatilityAccumulator: new BN(0), volatilityReference: new BN(0), padding: [] },
    ...over,
  });
  let pool = { poolState: mkPoolState() }; // the real VirtualPool account wraps its fields in `poolState`
  // Each SDK service owns its own StateService, so stub the prototype (not client.state).
  DBC.StateService.prototype.getPool = async () => pool;
  DBC.StateService.prototype.getPoolConfig = async () => config;
  DBC.StateService.prototype.getPoolFeeBreakdown = async () => ({
    creator: { unclaimedBaseFee: new BN(0), unclaimedQuoteFee: new BN(5_000_000), claimedBaseFee: new BN(0), claimedQuoteFee: new BN(0), totalBaseFee: new BN(0), totalQuoteFee: new BN(5_000_000) },
    partner: { unclaimedBaseFee: new BN(0), unclaimedQuoteFee: new BN(45_000_000), claimedBaseFee: new BN(0), claimedQuoteFee: new BN(0), totalBaseFee: new BN(0), totalQuoteFee: new BN(45_000_000) },
  });
  // A pool that has already taken a 5 SOL buy, so there is something to sell back.
  const afterBuy = () => {
    const amountIn = new BN(5_000_000_000);
    const q = client.pool.swapQuote2({ virtualPool: { poolState: mkPoolState() }, config, swapBaseForQuote: false, hasReferral: false,
      eligibleForFirstSwapWithMinFee: false, currentPoint: new BN(1), slippageBps: 0, swapMode: DBC.SwapMode.ExactIn, amountIn });
    return { poolState: mkPoolState({ sqrtPrice: q.nextSqrtPrice, quoteReserve: amountIn.sub(q.tradingFee).sub(q.protocolFee), baseReserve: new BN("900000000000000").sub(q.outputAmount) }) };
  };
  return { client, config, mint, poolAddr, setPool: (p) => { pool = p; }, mkPoolState, afterBuy };
}

await t("curve defaults build: ~72 SOL migration threshold, 1B supply", () => {
  const sol = Number(core.formatUnits(params.migrationQuoteThreshold, 9, 9));
  assert.ok(sol > 60 && sol < 90, "threshold " + sol);
  assert.equal(params.creatorTradingFeePercentage, 10);
  assert.equal(params.tokenDecimal, 6);
});
await t("parseUnits / formatUnits are exact", () => {
  assert.equal(core.parseUnits("1.5", 9).toString(), "1500000000");
  assert.equal(core.parseUnits("0.000000001", 9).toString(), "1");
  assert.equal(core.parseUnits("2", 6).toString(), "2000000");
  assert.equal(core.parseUnits("0.1234567891", 9).toString(), "123456789"); // extra digits truncated, never rounded up
  assert.throws(() => core.parseUnits("abc", 9));
  assert.throws(() => core.parseUnits("", 9));
  assert.equal(core.formatUnits(new BN("1500000000"), 9), "1.5");
  assert.equal(core.formatUnits(new BN("1"), 9, 9), "0.000000001");
});

const conn = new FakeConn();
const st = makeState(conn);
core._setClientForTests(conn, st.client);
core.init({ rpcUrl: "http://127.0.0.1:1", cluster: "devnet", configAddress: CONFIG.toBase58() });
core._setClientForTests(conn, st.client); // init() creates its own; put ours back

await t("init() accepts devnet and mainnet-beta, rejects anything else", () => {
  assert.throws(() => core.init({ rpcUrl: "http://x", cluster: "testnet" }), /Unknown Solana cluster/);
  assert.throws(() => core.init({ rpcUrl: "http://x", cluster: "mainnet" }), /Unknown Solana cluster/);
  assert.throws(() => core.init({ rpcUrl: "", cluster: "devnet" }), /RPC URL missing/);
  core.init({ rpcUrl: "http://x", cluster: "mainnet-beta" });
  core.init({ rpcUrl: "http://127.0.0.1:1", cluster: "devnet", configAddress: CONFIG.toBase58() });
  core._setClientForTests(conn, st.client);
});
await t("actions refuse to run without a connected wallet", async () => {
  await assert.rejects(core.launch({ name: "A", symbol: "A", uri: "https://x/y.json" }), /Connect a Solana wallet/);
});

core._setWalletForTests(fakeWallet(user), { address: user.publicKey.toBase58(), publicKey: user.publicKey.toBytes() });

await t("launch(): one signed tx — create pool + first buy — correct accounts", async () => {
  const r = await core.launch({ name: "Test Coin", symbol: "TST", uri: "https://example.com/m.json", firstBuySol: "0.5" });
  assert.equal(conn.sent.length, 1);
  const tx = Transaction.from(conn.sent[0]);
  assert.ok(tx.verifySignatures(), "all signatures valid (wallet + new mint)");
  assert.equal(tx.signatures.length, 2);
  const programs = new Set(tx.instructions.map((i) => i.programId.toBase58()));
  assert.ok(programs.has(DBC.DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58()));
  const mint = new PublicKey(r.mint);
  assert.equal(r.pool, DBC.deriveDbcPoolAddress(WSOL, mint, CONFIG).toBase58());
  const dbcIxs = tx.instructions.filter((i) => i.programId.equals(DBC.DYNAMIC_BONDING_CURVE_PROGRAM_ID));
  assert.ok(dbcIxs.length >= 2, "initialize pool + swap");
  assert.ok(tx.signatures.some((s) => s.publicKey.equals(mint)), "mint co-signs");
  assert.equal(tx.feePayer.toBase58(), user.publicKey.toBase58());
});
await t("launch() with no first buy is a single create-pool instruction", async () => {
  conn.sent.length = 0;
  await core.launch({ name: "NoBuy", symbol: "NB", uri: "https://example.com/m.json", firstBuySol: "0" });
  const tx = Transaction.from(conn.sent[0]);
  const dbcIxs = tx.instructions.filter((i) => i.programId.equals(DBC.DYNAMIC_BONDING_CURVE_PROGRAM_ID));
  assert.equal(dbcIxs.length, 1);
});
await t("mainnet-beta: wallet is asked for chain solana:mainnet and a priority fee is added", async () => {
  EXPECT_CHAIN = "solana:mainnet";
  core.init({ rpcUrl: "http://127.0.0.1:1", cluster: "mainnet-beta", configAddress: CONFIG.toBase58() });
  core._setClientForTests(conn, st.client);
  try {
    conn.sent.length = 0;
    await core.launch({ name: "Live", symbol: "LIVE", uri: "https://example.com/m.json", firstBuySol: "0" });
    const tx = Transaction.from(conn.sent[0]);
    const cb = tx.instructions.filter((i) => i.programId.equals(ComputeBudgetProgram.programId));
    assert.equal(cb.length, 1, "exactly one compute-budget instruction");
    assert.equal(tx.instructions[0].programId.toBase58(), ComputeBudgetProgram.programId.toBase58(), "it comes first");
    assert.ok(tx.verifySignatures());
  } finally {
    EXPECT_CHAIN = "solana:devnet";
    core.init({ rpcUrl: "http://127.0.0.1:1", cluster: "devnet", configAddress: CONFIG.toBase58() });
    core._setClientForTests(conn, st.client);
  }
});
await t("devnet transactions get no priority-fee instruction", async () => {
  conn.sent.length = 0;
  await core.launch({ name: "Dev", symbol: "DEV", uri: "https://example.com/m.json", firstBuySol: "0" });
  const tx = Transaction.from(conn.sent[0]);
  assert.equal(tx.instructions.filter((i) => i.programId.equals(ComputeBudgetProgram.programId)).length, 0);
});
await t("launch() needs the platform config address", async () => {
  core.init({ rpcUrl: "http://127.0.0.1:1", cluster: "devnet" }); core._setClientForTests(conn, st.client);
  await assert.rejects(core.launch({ name: "A", symbol: "A", uri: "https://x/y.json" }), /config isn't set/);
  core.init({ rpcUrl: "http://127.0.0.1:1", cluster: "devnet", configAddress: CONFIG.toBase58() }); core._setClientForTests(conn, st.client);
});

await t("getPoolInfo reads poolState: price, progress, supply", async () => {
  st.setPool({ poolState: st.mkPoolState({ quoteReserve: params.migrationQuoteThreshold.divn(4) }) });
  const info = await core.getPoolInfo(st.poolAddr);
  assert.equal(info.mint, st.mint.toBase58());
  assert.ok(info.priceSol > 0 && info.priceSol < 1, "price " + info.priceSol);
  assert.ok(Math.abs(info.progressPct - 25) < 0.5, "progress " + info.progressPct);
  assert.equal(info.migrated, false);
  assert.ok(info.marketCapSol > 25 && info.marketCapSol < 40, "mcap " + info.marketCapSol);
  st.setPool({ poolState: st.mkPoolState({ isMigrated: 1 }) });
  const m = await core.getPoolInfo(st.poolAddr);
  assert.equal(m.migrated, true); assert.equal(m.progressPct, 100);
  st.setPool({ poolState: st.mkPoolState() });
});
await t("quote(): buying 1 SOL returns tokens, min-out respects slippage", async () => {
  const q = await core.quote({ pool: st.poolAddr, side: "buy", amount: "1", slippageBps: 500 });
  assert.ok(q.out > 1000, "tokens out " + q.out);
  assert.ok(q.minOut < q.out && q.minOut >= q.out * 0.94, `min ${q.minOut} vs ${q.out}`);
  assert.ok(q.feeSol > 0.009 && q.feeSol < 0.011, "fee ~1% " + q.feeSol);
  assert.ok(q.impactPct > 0);
});
await t("quote(): selling returns SOL, less than the buy cost", async () => {
  const buy = await core.quote({ pool: st.poolAddr, side: "buy", amount: "1" });
  st.setPool(st.afterBuy());
  const sell = await core.quote({ pool: st.poolAddr, side: "sell", amount: String(Math.floor(buy.out / 2)) });
  assert.ok(sell.out > 0 && sell.out < 5, "sol out " + sell.out);
  st.setPool({ poolState: st.mkPoolState() });
});
await t("quote() rejects zero/invalid amounts and graduated pools", async () => {
  await assert.rejects(core.quote({ pool: st.poolAddr, side: "buy", amount: "0" }), /greater than zero/);
  await assert.rejects(core.quote({ pool: st.poolAddr, side: "buy", amount: "x" }), /valid amount/);
  st.setPool({ poolState: st.mkPoolState({ isMigrated: 1 }) });
  await assert.rejects(core.quote({ pool: st.poolAddr, side: "buy", amount: "1" }), /graduated/);
  st.setPool({ poolState: st.mkPoolState() });
});
await t("trade(buy): signed swap tx aimed at the pool, min-out enforced", async () => {
  conn.sent.length = 0;
  const r = await core.trade({ pool: st.poolAddr, side: "buy", amount: "0.25", slippageBps: 300 });
  assert.ok(r.signature && r.out > 0);
  const tx = Transaction.from(conn.sent[0]);
  assert.ok(tx.verifySignatures());
  const dbcIx = tx.instructions.find((i) => i.programId.equals(DBC.DYNAMIC_BONDING_CURVE_PROGRAM_ID));
  assert.ok(dbcIx, "DBC swap instruction present");
  assert.ok(dbcIx.keys.some((k) => k.pubkey.equals(st.poolAddr)), "pool account referenced");
});
await t("trade(sell) builds a signed tx too", async () => {
  conn.sent.length = 0;
  st.setPool(st.afterBuy());
  await core.trade({ pool: st.poolAddr, side: "sell", amount: "1000", slippageBps: 300 });
  const tx = Transaction.from(conn.sent[0]); assert.ok(tx.verifySignatures());
  st.setPool({ poolState: st.mkPoolState() });
});
await t("claimFees builds partner + creator claim txs", async () => {
  for (const who of ["partner", "creator"]) {
    conn.sent.length = 0;
    const r = await core.claimFees({ pool: st.poolAddr, who });
    assert.ok(r.signature);
    const tx = Transaction.from(conn.sent[0]); assert.ok(tx.verifySignatures());
  }
  const fb = await core.getFeeBreakdown(st.poolAddr);
  assert.equal(fb.partnerUnclaimedSol, 0.045); assert.equal(fb.creatorUnclaimedSol, 0.005);
});
await t("createPlatformConfig builds a signed tx and returns the new config address", async () => {
  conn.sent.length = 0;
    const r = await core.createPlatformConfig({});
  const tx = Transaction.from(conn.sent[0]);
  assert.ok(tx.verifySignatures());
  assert.ok(tx.signatures.some((s) => s.publicKey.toBase58() === r.config), "config keypair co-signs");
  assert.ok(r.migrationQuoteThresholdSol > 60);
});
await t("a failed on-chain tx surfaces its error", async () => {
  conn.statusErr = { InstructionError: [0, "Custom"] };
  await assert.rejects(core.trade({ pool: st.poolAddr, side: "buy", amount: "0.1" }), /failed on-chain/);
  conn.statusErr = null;
});
await t("wallets that only offer signAndSendTransaction still work", async () => {
  const sent = [];
  const w = fakeWallet(user, { feature: "none" });
  w.features["solana:signAndSendTransaction"] = { signAndSendTransaction: async ({ transaction }) => {
    const tx = Transaction.from(transaction); tx.partialSign(user); sent.push(tx);
    return [{ signature: tx.signature }];
  } };
  core._setWalletForTests(w, { address: user.publicKey.toBase58(), publicKey: user.publicKey.toBytes() });
  await core.trade({ pool: st.poolAddr, side: "buy", amount: "0.1" });
  assert.equal(sent.length, 1);
  core._setWalletForTests(fakeWallet(user), { address: user.publicKey.toBase58(), publicKey: user.publicKey.toBytes() });
});

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) { for (const e of results) console.log(e && e.stack); process.exit(1); }
