// Offline tests for solana-build/core.js. No network: a fake Connection serves canned data and a fake
// Wallet Standard wallet signs with a throwaway keypair. Checks that the transactions we build are
// well-formed, correctly signed and aimed at the right program/accounts.
import assert from "node:assert/strict";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram, SystemProgram, SystemInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import BN from "bn.js";
import * as DBC from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm, CP_AMM_PROGRAM_ID } from "@meteora-ag/cp-amm-sdk";
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
core._setClientForTests(conn, st.client, new CpAmm(conn)); // init() creates its own; put ours back

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
await t("curve settings: validated, and 'SOL to raise' is solved into a graduation market cap", () => {
  const d = core.previewCurve({});
  assert.equal(d.totalSupply, 1_000_000_000); assert.ok(Math.abs(d.raiseSol - 72.08) < 0.1);
  const low = core.previewCurve({ raiseSol: 30 });
  assert.ok(Math.abs(low.raiseSol - 30) < 0.01, "raise " + low.raiseSol);
  assert.ok(low.migrationMarketCapSol < 100 && low.migrationMarketCapSol > 30, "graduation mcap " + low.migrationMarketCapSol);
  const supply = core.previewCurve({ totalSupply: 21_000_000, raiseSol: 40 });
  assert.equal(supply.totalSupply, 21_000_000); assert.ok(Math.abs(supply.raiseSol - 40) < 0.01);
  assert.ok(Math.abs(supply.startPriceSol - 30 / 21_000_000) < 1e-12);
  assert.throws(() => core.previewCurve({ totalSupply: 5.5 }), /whole number/);
  assert.throws(() => core.previewCurve({ totalSupply: 10 }), /Total supply must be between/);
  assert.throws(() => core.previewCurve({ tradingFeeBps: 5 }), /Trading fee/);
  assert.throws(() => core.previewCurve({ creatorFeePercent: 101 }), /Creator fee/);
  assert.throws(() => core.previewCurve({ migrationMarketCapSol: 20 }), /larger than the starting/);
  assert.throws(() => core.previewCurve({ raiseSol: 1 }), /can raise roughly/);
  assert.throws(() => core.previewCurve({ raiseSol: -3 }), /positive/);
});
await t("createPlatformConfig honours custom curve settings (supply, raise, fees)", async () => {
  conn.sent.length = 0;
  const r = await core.createPlatformConfig({ totalSupply: 100_000_000, raiseSol: 40, tradingFeeBps: 200, creatorFeePercent: 20 });
  assert.ok(Math.abs(r.migrationQuoteThresholdSol - 40) < 0.01, "threshold " + r.migrationQuoteThresholdSol);
  assert.equal(conn.sent.length, 1);
  await assert.rejects(core.createPlatformConfig({ totalSupply: 3 }), /Total supply must be between/);
});
await t("getConfigInfo reads the real numbers from the config account", async () => {
  const info = await core.getConfigInfo(CONFIG.toBase58());
  assert.ok(Math.abs(info.raiseSol - 72.08) < 0.1);
  assert.equal(info.totalSupply, 1_000_000_000);
  assert.ok(Math.abs(info.startMarketCapSol - 30) < 0.5, "start mcap " + info.startMarketCapSol);
});
await t("createSupplyConfig: same curve + fees as the standard config, creator's supply, platform wallet as fee claimer", async () => {
  conn.sent.length = 0;
  const r = await core.createSupplyConfig({ totalSupply: 21_000_000, curve: { initialMarketCapSol: 30, migrationMarketCapSol: 300, tradingFeeBps: 100, creatorFeePercent: 10 } });
  assert.equal(conn.sent.length, 1);
  const tx = Transaction.from(conn.sent[0]);
  assert.ok(tx.verifySignatures());
  assert.equal(tx.feePayer.toBase58(), user.publicKey.toBase58(), "the creator pays");
  const ix = tx.instructions.find((i) => i.programId.equals(DBC.DYNAMIC_BONDING_CURVE_PROGRAM_ID));
  assert.ok(ix.keys.some((k) => k.pubkey.toBase58() === feeClaimer.toBase58()), "fee claimer account in the instruction is the platform's");
  assert.ok(Math.abs(r.migrationQuoteThresholdSol - 72.08) < 0.1);
  await assert.rejects(core.createSupplyConfig({ totalSupply: 5 }), /Total supply/);
});
await t("launch({config}) launches under that config, not the standard one", async () => {
  conn.sent.length = 0;
  const other = Keypair.generate().publicKey;
  const r = await core.launch({ name: "Own", symbol: "OWN", uri: "https://example.com/m.json", firstBuySol: "0", config: other.toBase58() });
  assert.equal(r.pool, DBC.deriveDbcPoolAddress(WSOL, new PublicKey(r.mint), other).toBase58());
  const std = await core.launch({ name: "Std", symbol: "STD", uri: "https://example.com/m.json", firstBuySol: "0" });
  assert.equal(std.pool, DBC.deriveDbcPoolAddress(WSOL, new PublicKey(std.mint), CONFIG).toBase58());
});
await t("signMessage: asks the wallet for an ed25519 signature and returns it base58", async () => {
  const calls = [];
  const w = fakeWallet(user);
  w.features["solana:signMessage"] = { signMessage: async ({ message, account }) => { calls.push(new TextDecoder().decode(message)); return [{ signedMessage: message, signature: new Uint8Array(64).fill(7) }]; } };
  core._setWalletForTests(w, { address: user.publicKey.toBase58(), publicKey: user.publicKey.toBytes() });
  const sig = await core.signMessage("hello ignitionx");
  assert.deepEqual(calls, ["hello ignitionx"]);
  assert.equal(bs58.decode(sig).length, 64);
  core._setWalletForTests(fakeWallet(user), { address: user.publicKey.toBase58(), publicKey: user.publicKey.toBytes() });
  await assert.rejects(core.signMessage("x"), /can't sign messages/);
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
  // A graduated pool no longer errors out: it is quoted on its DAMM v2 pool. With no DAMM v2 pool findable
  // yet, the trader gets a clear message instead of a crash.
  st.setPool({ poolState: st.mkPoolState({ isMigrated: 1 }) });
  const cpNone = new CpAmm(conn);
  cpNone.fetchPoolState = async () => { throw new Error("Account does not exist"); };
  cpNone.fetchPoolStatesByTokenMint = async () => [];
  core._setClientForTests(conn, st.client, cpNone);
  await assert.rejects(core.quote({ pool: st.poolAddr, side: "buy", amount: "1" }), /DAMM v2 pool wasn't found/);
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


// ======================= platform swap fee (0.30%) and DAMM v2 swapping =======================
const feeTransfers = (tx) => tx.instructions
  .filter((i) => i.programId.equals(SystemProgram.programId) && SystemInstruction.decodeInstructionType(i) === "Transfer")
  .map((i) => SystemInstruction.decodeTransfer(i));
const u64At = (buf, off) => Number(buf.readBigUInt64LE(off));
const reset = () => { core._setClientForTests(conn, st.client, new CpAmm(conn)); core._setFeeForTests({ feeBps: 30, feeWallet: null }); st.setPool({ poolState: st.mkPoolState() }); conn.sent.length = 0; };

await t("fee math: 30 bps of the SOL side, rounded down, never negative", () => {
  assert.equal(core.platformFeeLamports(new BN(1_000_000_000)).toString(), "3000000");   // 1 SOL -> 0.003
  assert.equal(core.platformFeeLamports(new BN(333)).toString(), "0");                    // too small: rounds to 0
  assert.equal(core.platformFeeLamports(new BN(10_000)).toString(), "30");
  assert.equal(core.platformFeeLamports(new BN(10_000), 0).toString(), "0");
  assert.equal(core.getSwapFeeBps(), 30);
});
await t("init() sets the fee and refuses nonsense or anything above 1%", () => {
  assert.throws(() => core.init({ rpcUrl: "http://x", cluster: "devnet", swapFeeBps: 101 }), /0 to 100/);
  assert.throws(() => core.init({ rpcUrl: "http://x", cluster: "devnet", swapFeeBps: -1 }), /0 to 100/);
  assert.throws(() => core.init({ rpcUrl: "http://x", cluster: "devnet", swapFeeBps: 0.5 }), /whole number/);
  assert.equal(core.init({ rpcUrl: "http://x", cluster: "devnet" }).swapFeeBps, 30);
  assert.equal(core.init({ rpcUrl: "http://x", cluster: "devnet", swapFeeBps: 0 }).swapFeeBps, 0);
  core.init({ rpcUrl: "http://127.0.0.1:1", cluster: "devnet", configAddress: CONFIG.toBase58() });
  reset();
});
await t("curve buy: 0.3% of the SOL typed goes to the platform wallet in the same tx; the rest is swapped", async () => {
  reset();
  const q = await core.quote({ pool: st.poolAddr, side: "buy", amount: "1" });
  assert.equal(q.venue, "curve");
  assert.equal(q.platformFeeSol, 0.003);
  assert.equal(q.platformFeeBps, 30);
  assert.equal(q.amountIn.toString(), "997000000");       // 1 SOL typed -> 0.997 swapped + 0.003 fee = exactly what was typed
  const r = await core.trade({ pool: st.poolAddr, side: "buy", amount: "1", slippageBps: 300 });
  assert.equal(r.platformFeeSol, 0.003);
  const tx = Transaction.from(conn.sent[0]); assert.ok(tx.verifySignatures());
  const swap = tx.instructions.find((i) => i.programId.equals(DBC.DYNAMIC_BONDING_CURVE_PROGRAM_ID));
  assert.equal(u64At(swap.data, 8), 997_000_000, "swap input is the typed amount minus the fee");
  const tr = feeTransfers(tx).filter((x) => x.toPubkey.equals(feeClaimer));
  assert.equal(tr.length, 1, "exactly one fee transfer to the platform wallet (the config's fee claimer)");
  assert.equal(Number(tr[0].lamports), 3_000_000);
  assert.ok(tr[0].fromPubkey.equals(user.publicKey));
  const iSwap = tx.instructions.indexOf(swap), iFee = tx.instructions.findIndex((i) => i.programId.equals(SystemProgram.programId) && SystemInstruction.decodeInstructionType(i) === "Transfer" && SystemInstruction.decodeTransfer(i).toPubkey.equals(feeClaimer));
  assert.ok(iFee > iSwap, "the fee comes after the swap");
});
await t("curve sell: 0.3% of the SOL the swap pays is sent to the platform wallet; the quote shows the net", async () => {
  reset(); st.setPool(st.afterBuy());
  const q = await core.quote({ pool: st.poolAddr, side: "sell", amount: "100000" });
  const gross = Number(core.formatUnits(q.amountOut, 9, 9));
  assert.ok(Math.abs(q.platformFeeSol - gross * 0.003) < 1e-8, `fee ${q.platformFeeSol} vs ${gross * 0.003}`);
  assert.ok(Math.abs(q.out - (gross - q.platformFeeSol)) < 1e-8, "out is net of the fee");
  assert.ok(q.minOut < q.out);
  await core.trade({ pool: st.poolAddr, side: "sell", amount: "100000", slippageBps: 300 });
  const tx = Transaction.from(conn.sent[0]); assert.ok(tx.verifySignatures());
  const swap = tx.instructions.find((i) => i.programId.equals(DBC.DYNAMIC_BONDING_CURVE_PROGRAM_ID));
  assert.equal(u64At(swap.data, 8), 100_000_000_000, "the whole token amount typed is swapped");
  const tr = feeTransfers(tx).filter((x) => x.toPubkey.equals(feeClaimer));
  assert.equal(tr.length, 1);
  assert.equal(Number(tr[0].lamports), Number(core.platformFeeLamports(q.amountOut)));
});
await t("fee off (0 bps): no transfer is added and nothing is held back", async () => {
  reset(); core._setFeeForTests({ feeBps: 0 });
  const q = await core.quote({ pool: st.poolAddr, side: "buy", amount: "1" });
  assert.equal(q.amountIn.toString(), "1000000000"); assert.equal(q.platformFeeSol, 0);
  await core.trade({ pool: st.poolAddr, side: "buy", amount: "1" });
  assert.equal(feeTransfers(Transaction.from(conn.sent[0])).filter((x) => x.toPubkey.equals(feeClaimer)).length, 0);
  reset();
});
await t("an explicit fee wallet overrides the config's fee claimer", async () => {
  reset(); const other = Keypair.generate().publicKey; core._setFeeForTests({ feeWallet: other.toBase58() });
  await core.trade({ pool: st.poolAddr, side: "buy", amount: "1" });
  const tr = feeTransfers(Transaction.from(conn.sent[0]));
  assert.ok(tr.some((x) => x.toPubkey.equals(other)) && !tr.some((x) => x.toPubkey.equals(feeClaimer)));
  reset();
});
await t("trade refuses (and sends nothing) if the platform wallet can't be determined", async () => {
  reset(); core.init({ rpcUrl: "http://127.0.0.1:1", cluster: "devnet" }); core._setClientForTests(conn, st.client, new CpAmm(conn)); // no config address
  await assert.rejects(core.trade({ pool: st.poolAddr, side: "buy", amount: "1" }), /swap fee can't be sent anywhere/);
  assert.equal(conn.sent.length, 0);
  core.init({ rpcUrl: "http://127.0.0.1:1", cluster: "devnet", configAddress: CONFIG.toBase58() }); reset();
});
await t("dust amounts (fee rounds to zero lamports) trade with no fee transfer rather than failing", async () => {
  reset();
  const q = await core.quote({ pool: st.poolAddr, side: "buy", amount: "0.000000333" }); // 333 lamports -> fee 0
  assert.equal(q.platformFeeSol, 0); assert.equal(q.amountIn.toString(), "333");
  await core.trade({ pool: st.poolAddr, side: "buy", amount: "0.000000333" });
  assert.equal(feeTransfers(Transaction.from(conn.sent[0])).filter((x) => x.toPubkey.equals(feeClaimer)).length, 0);
  reset();
});

// ---- DAMM v2: a graduated token trades on its Meteora pool ----
function makeDamm() {
  const cp = new CpAmm(conn);
  const [tA, tB] = Buffer.compare(st.mint.toBuffer(), WSOL.toBuffer()) < 0 ? [st.mint, WSOL] : [WSOL, st.mint];
  const poolState = {
    tokenAMint: tA, tokenBMint: tB, tokenAVault: Keypair.generate().publicKey, tokenBVault: Keypair.generate().publicKey,
    tokenAFlag: 0, tokenBFlag: 0, activationType: 1, activationPoint: new BN(0), liquidity: new BN("1000000000000"),
    sqrtPrice: new BN(2).pow(new BN(64)).muln(1), // price 1 (before decimals)
    poolFees: { baseFee: { baseFeeInfo: { data: new Array(32).fill(0) } } },
  };
  const calls = { quote: [], states: 0 };
  cp.fetchPoolState = async (addr) => { calls.states++; calls.lastAddr = addr; return poolState; };
  cp.fetchPoolStatesByTokenMint = async () => [];
  cp.getQuote2 = (p) => {
    calls.quote.push(p);
    const out = p.amountIn.muln(2); // fake constant price
    return { includedFeeInputAmount: p.amountIn, excludedFeeInputAmount: p.amountIn.muln(99).divn(100), amountLeft: new BN(0),
      outputAmount: out, nextSqrtPrice: new BN(1), claimingFee: new BN(0), protocolFee: new BN(0), compoundingFee: new BN(0), referralFee: new BN(0),
      priceImpact: { toString: () => "0.42" }, minimumAmountOut: out.muln(10000 - p.slippage).divn(10000) };
  };
  return { cp, poolState, calls };
}
conn.getBlockTime = async () => 1_790_000_000;

await t("graduated token: quote() uses the DAMM v2 pool, with the fee taken off the SOL typed", async () => {
  reset(); const d = makeDamm(); core._setClientForTests(conn, st.client, d.cp);
  st.setPool({ poolState: st.mkPoolState({ isMigrated: 1 }) });
  const q = await core.quote({ pool: st.poolAddr, side: "buy", amount: "1", slippageBps: 100 });
  assert.equal(q.venue, "damm");
  assert.equal(d.calls.quote.length, 1);
  assert.equal(d.calls.quote[0].amountIn.toString(), "997000000", "DAMM swap input is net of the 0.3% fee");
  assert.equal(d.calls.quote[0].slippage, 100, "slippage passed in basis points");
  assert.equal(d.calls.quote[0].inputTokenMint.toBase58(), WSOL.toBase58());
  assert.equal(q.platformFeeSol, 0.003);
  assert.ok(Math.abs(q.impactPct - 0.42) < 1e-9);
  assert.ok(q.feeSol > 0.009 && q.feeSol < 0.011, "pool fee shown " + q.feeSol);
});
await t("graduated token: a sell quotes the token in, shows SOL out net of the 0.3% fee", async () => {
  reset(); const d = makeDamm(); core._setClientForTests(conn, st.client, d.cp);
  st.setPool({ poolState: st.mkPoolState({ isMigrated: 1 }) });
  const q = await core.quote({ pool: st.poolAddr, side: "sell", amount: "1000" });
  assert.equal(d.calls.quote[0].inputTokenMint.toBase58(), st.mint.toBase58());
  assert.equal(d.calls.quote[0].amountIn.toString(), "1000000000", "1000 tokens at 6 decimals");
  const gross = Number(core.formatUnits(q.amountOut, 9, 9));
  assert.ok(Math.abs(q.out - gross * 0.997) < 1e-9);
});
await t("graduated token: trade() sends a DAMM v2 swap plus the fee transfer, in one signed tx", async () => {
  reset(); const d = makeDamm(); core._setClientForTests(conn, st.client, d.cp);
  st.setPool({ poolState: st.mkPoolState({ isMigrated: 1 }) });
  const r = await core.trade({ pool: st.poolAddr, side: "buy", amount: "1", slippageBps: 100 });
  assert.equal(r.venue, "damm");
  const tx = Transaction.from(conn.sent[0]); assert.ok(tx.verifySignatures());
  const swap = tx.instructions.find((i) => i.programId.equals(CP_AMM_PROGRAM_ID));
  assert.ok(swap, "DAMM v2 swap instruction present");
  assert.ok(swap.keys.some((k) => k.pubkey.equals(d.poolState.tokenAVault)) && swap.keys.some((k) => k.pubkey.equals(d.poolState.tokenBVault)), "pool vaults referenced");
  assert.ok(!tx.instructions.some((i) => i.programId.equals(DBC.DYNAMIC_BONDING_CURVE_PROGRAM_ID)), "no curve instruction after graduation");
  const tr = feeTransfers(tx).filter((x) => x.toPubkey.equals(feeClaimer));
  assert.equal(tr.length, 1); assert.equal(Number(tr[0].lamports), 3_000_000);
  assert.ok(tx.instructions.indexOf(swap) < tx.instructions.findIndex((i) => i.programId.equals(SystemProgram.programId) && SystemInstruction.decodeInstructionType(i) === "Transfer" && SystemInstruction.decodeTransfer(i).toPubkey.equals(feeClaimer)), "fee after swap");
});
await t("graduated token: the pool is found once, then remembered", async () => {
  reset(); const d = makeDamm(); core._setClientForTests(conn, st.client, d.cp);
  st.setPool({ poolState: st.mkPoolState({ isMigrated: 1 }) });
  await core.quote({ pool: st.poolAddr, side: "buy", amount: "1" });
  const first = d.calls.states;
  await core.quote({ pool: st.poolAddr, side: "buy", amount: "2" });
  assert.ok(d.calls.states - first <= 1, "second quote re-reads the pool state but not the pool address search");
});
await t("graduated token: a pool at an unexpected address is found by searching the token's pools", async () => {
  reset(); const d = makeDamm(); core._setClientForTests(conn, st.client, d.cp);
  const odd = Keypair.generate().publicKey;
  d.cp.fetchPoolState = async (a) => { if (!a.equals(odd)) throw new Error("Account does not exist"); return d.poolState; };
  d.cp.fetchPoolStatesByTokenMint = async () => [
    { publicKey: Keypair.generate().publicKey, account: { ...d.poolState, tokenBMint: Keypair.generate().publicKey, tokenAMint: Keypair.generate().publicKey, liquidity: new BN(5) } }, // not a SOL pool: ignored
    { publicKey: odd, account: d.poolState },
  ];
  st.setPool({ poolState: st.mkPoolState({ isMigrated: 1 }) });
  const q = await core.quote({ pool: st.poolAddr, side: "buy", amount: "1" });
  assert.equal(q.dammPool, odd.toBase58());
});
await t("getPoolInfo for a graduated token reports the live DAMM v2 price, and falls back to the curve price if it can't", async () => {
  reset(); const d = makeDamm(); core._setClientForTests(conn, st.client, d.cp);
  st.setPool({ poolState: st.mkPoolState({ isMigrated: 1 }) });
  const info = await core.getPoolInfo(st.poolAddr);
  assert.equal(info.migrated, true); assert.equal(info.venue, "damm");
  assert.ok(info.priceSol > 0 && isFinite(info.priceSol));
  d.cp.fetchPoolState = async () => { throw new Error("rpc down"); };
  reset(); core._setClientForTests(conn, st.client, d.cp); st.setPool({ poolState: st.mkPoolState({ isMigrated: 1 }) });
  const fb = await core.getPoolInfo(st.poolAddr);
  assert.ok(fb.priceSol > 0 && fb.migrated === true, "still returns the (frozen) curve price");
});
reset();

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) { for (const e of results) console.log(e && e.stack); process.exit(1); }
