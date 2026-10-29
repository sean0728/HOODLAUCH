// IgnitionX — Solana helpers (devnet + mainnet-beta, switchable from Admin → Solana). Built on Meteora's Dynamic Bonding Curve (DBC) program.
// Kept free of `window` so it can be unit-tested in Node (see test/core.test.mjs); entry.js attaches it to the page.
//
// What lives here:
//   - Solana wallet discovery/connect through the Wallet Standard (Phantom, Solflare, Backpack, ... all speak it)
//   - launch (create pool + optional first buy in ONE transaction), buy/sell, quotes, pool info, fee claims
//   - trading: on the bonding curve while a token is on it, and on its Meteora DAMM v2 pool once it has graduated
//     (quote() and trade() pick the right one). Every swap made through the site also pays the platform's swap
//     fee: a SOL transfer to the platform wallet inside the same transaction (see "platform swap fee" below).
//   - createPlatformConfig: the one-time admin transaction that creates the platform's DBC config
//     (curve shape, 1% fee, creator share, migration settings). Every launch then points at that config.
import { Connection, PublicKey, Keypair, ComputeBudgetProgram, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { getWallets } from "@wallet-standard/app";
import * as DBC from "@meteora-ag/dynamic-bonding-curve-sdk";
import { CpAmm, SwapMode as CpSwapMode, getCurrentPoint as cpCurrentPoint, getTokenProgram as cpTokenProgram, getUnClaimLpFee } from "@meteora-ag/cp-amm-sdk";

export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const LAMPORTS_PER_SOL = 1_000_000_000;

import { CURVE_DEFAULTS, CURVE_LIMITS, resolveCurveOpts, buildCurveParams, previewCurve, parseUnits, formatUnits, toNum } from "./curve.js";
export { CURVE_DEFAULTS, CURVE_LIMITS, resolveCurveOpts, buildCurveParams, previewCurve, parseUnits, formatUnits };

// ---- state ------------------------------------------------------------------------------------------
const S = {
  cluster: "devnet",
  rpcUrl: null,
  configAddress: null,
  conn: null,
  client: null,
  cp: null,         // Meteora DAMM v2 (cp-amm) client, for graduated tokens
  feeBps: 30,       // platform swap fee, in basis points of the SOL side of every swap (0.30%)
  feeWallet: null,  // PublicKey the fee is sent to; resolved from the platform config's fee claimer
  dammPools: new Map(), // DBC pool address -> DAMM v2 pool address (a graduated token's pool never changes)
  positions: new Map(), // owner address -> { at, p } a wallet's DAMM v2 positions, cached briefly (one scan serves every token)
  wallet: null,   // Wallet Standard wallet object
  account: null,  // Wallet Standard account
  listeners: new Set(),
  offEvents: null,
};
export function _setClientForTests(conn, client, cp = null) { S.conn = conn; S.client = client; S.cp = cp; S.dammPools = new Map(); S.positions = new Map(); }
export function _setFeeForTests({ feeBps, feeWallet } = {}) {
  if (feeBps !== undefined) S.feeBps = feeBps;
  if (feeWallet !== undefined) S.feeWallet = feeWallet ? new PublicKey(feeWallet) : null;
}
export function _setWalletForTests(wallet, account) { S.wallet = wallet; S.account = account; }

// Wallet Standard names the networks "solana:devnet" / "solana:mainnet" (NOT "mainnet-beta").
export const CLUSTERS = Object.freeze({ "devnet": "solana:devnet", "mainnet-beta": "solana:mainnet" });
const walletChain = () => CLUSTERS[S.cluster];
const clusterLabel = () => (S.cluster === "mainnet-beta" ? "mainnet" : "devnet");

export const DEFAULT_SWAP_FEE_BPS = 30;
export const MAX_SWAP_FEE_BPS = 100; // hard ceiling so a bad value can never charge more than 1%

export function init({ rpcUrl, cluster = "devnet", configAddress = null, swapFeeBps = DEFAULT_SWAP_FEE_BPS, feeWallet = null } = {}) {
  if (!CLUSTERS[cluster]) throw new Error(`Unknown Solana cluster "${cluster}" (expected devnet or mainnet-beta).`);
  if (!rpcUrl) throw new Error("Solana RPC URL missing (Admin → Solana).");
  S.cluster = cluster;
  S.rpcUrl = rpcUrl;
  S.configAddress = configAddress ? new PublicKey(configAddress) : null;
  S.conn = new Connection(rpcUrl, "confirmed");
  S.client = DBC.DynamicBondingCurveClient.create(S.conn, "confirmed");
  S.cp = new CpAmm(S.conn);
  const bps = Number(swapFeeBps);
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_SWAP_FEE_BPS) throw new Error(`The swap fee must be a whole number of basis points from 0 to ${MAX_SWAP_FEE_BPS}.`);
  S.feeBps = bps;
  S.feeWallet = feeWallet ? new PublicKey(feeWallet) : null;
  S.dammPools = new Map();
  S.positions = new Map();
  return { cluster, configAddress, swapFeeBps: bps };
}
function need() {
  if (!S.client) throw new Error("Solana isn't initialised yet.");
  return S;
}
const pk = (v) => (v instanceof PublicKey ? v : new PublicKey(v));
// The on-chain VirtualPool account wraps its fields in `poolState`; tolerate an already-flat object.
const unwrapPool = (p) => (p && p.poolState ? p.poolState : p);

// ---- wallets (Wallet Standard) ----------------------------------------------------------------------
const SIGN_FEATURES = ["solana:signTransaction", "solana:signAndSendTransaction"];
export function listWallets() {
  let all = [];
  try { all = getWallets().get(); } catch (e) { all = []; }
  return all
    .filter((w) => w.features && "standard:connect" in w.features && SIGN_FEATURES.some((f) => f in w.features))
    .map((w) => ({ name: w.name, icon: w.icon || "", chains: w.chains || [] }));
}
export function onWalletsChange(cb) {
  try {
    const api = getWallets();
    const offA = api.on("register", cb);
    const offB = api.on("unregister", cb);
    return () => { try { offA(); offB(); } catch (e) {} };
  } catch (e) { return () => {}; }
}
export function onAccountChange(cb) { S.listeners.add(cb); return () => S.listeners.delete(cb); }
function emit() { const info = currentWallet(); S.listeners.forEach((cb) => { try { cb(info); } catch (e) {} }); }
export function currentWallet() {
  return S.account ? { name: S.wallet && S.wallet.name, address: S.account.address } : null;
}
// `silent: true` re-attaches a wallet the user already approved for this site, without a popup. It resolves to
// null (instead of throwing) when the wallet wants the user to approve again.
export async function connect(walletName, { silent = false } = {}) {
  const w = getWallets().get().find((x) => x.name === walletName);
  if (!w) throw new Error("That wallet isn't available in this browser.");
  const chain = walletChain();
  if (w.chains && w.chains.length && !w.chains.includes(chain)) {
    throw new Error(`${w.name} doesn't list Solana ${clusterLabel()}. Switch the wallet to ${clusterLabel()} (Settings → Developer settings) and try again.`);
  }
  let res;
  try {
    res = await w.features["standard:connect"].connect(silent ? { silent: true } : undefined);
  } catch (e) {
    if (silent) return null;
    throw e;
  }
  const account = (res && res.accounts && res.accounts[0]) || (silent ? null : (w.accounts && w.accounts[0]));
  if (!account) {
    if (silent) return null;
    throw new Error("The wallet didn't share an account.");
  }
  if (S.offEvents) { try { S.offEvents(); } catch (e) {} S.offEvents = null; }
  S.wallet = w; S.account = account;
  const ev = w.features["standard:events"];
  if (ev) {
    S.offEvents = ev.on("change", ({ accounts }) => {
      if (accounts) {
        if (!accounts.length) { S.account = null; S.wallet = null; } else S.account = accounts[0];
        emit();
      }
    });
  }
  emit();
  return currentWallet();
}
export async function disconnect() {
  try { if (S.wallet && S.wallet.features["standard:disconnect"]) await S.wallet.features["standard:disconnect"].disconnect(); } catch (e) {}
  if (S.offEvents) { try { S.offEvents(); } catch (e) {} S.offEvents = null; }
  S.wallet = null; S.account = null; emit();
}
function owner() {
  if (!S.account) throw new Error("Connect a Solana wallet first.");
  return new PublicKey(S.account.address);
}

// Signs a short text message with the connected Solana wallet (free, no transaction). Used by the public
// launch flow: the relayer verifies the ed25519 signature instead of an admin's EVM signature.
export async function signMessage(text) {
  if (!S.account || !S.wallet) throw new Error("Connect a Solana wallet first.");
  const f = S.wallet.features["solana:signMessage"];
  if (!f) throw new Error(`${S.wallet.name} can't sign messages. Try Phantom, Solflare or Backpack.`);
  const out = await f.signMessage({ account: S.account, message: new TextEncoder().encode(String(text)) });
  const sig = Array.isArray(out) ? out[0].signature : out.signature;
  return bs58.encode(sig);
}

// Signs `tx` (legacy Transaction from the SDK) with the wallet, sends it, and waits for confirmation.
// `extraSigners` are Keypairs that must co-sign (a new mint, a new config key).
// On mainnet a transaction with a low priority fee can sit unprocessed when the network is busy, so one is added
// (devnet doesn't need it). The price follows what recent blocks have been paying (75th percentile), never below
// MAINNET_PRIORITY_MICROLAMPORTS and never above MAX_PRIORITY_MICROLAMPORTS: ~0.00008 SOL at the floor and
// ~0.0004 SOL at the cap for a typical launch.
export const MAINNET_PRIORITY_MICROLAMPORTS = 200_000;
const MAX_PRIORITY_MICROLAMPORTS = 1_000_000;
async function priorityFeeMicroLamports(conn) {
  try {
    const fees = (await conn.getRecentPrioritizationFees()).map((f) => f.prioritizationFee).filter((f) => f > 0).sort((a, b) => a - b);
    if (fees.length) return Math.max(MAINNET_PRIORITY_MICROLAMPORTS, Math.min(MAX_PRIORITY_MICROLAMPORTS, fees[Math.floor(fees.length * 0.75)]));
  } catch (e) { /* RPC doesn't serve fee history: use the floor */ }
  return MAINNET_PRIORITY_MICROLAMPORTS;
}
export async function signSendConfirm(tx, extraSigners = []) {
  const { conn } = need();
  const payer = owner();
  if (S.cluster === "mainnet-beta" && !tx.instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId))) {
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: await priorityFeeMicroLamports(conn) }));
  }
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.feePayer = payer;
  tx.recentBlockhash = blockhash;
  if (extraSigners.length) tx.partialSign(...extraSigners);
  const chain = walletChain();
  const feats = S.wallet.features;
  let signature, rawTx = null;
  if (feats["solana:signTransaction"]) {
    const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const out = await feats["solana:signTransaction"].signTransaction({ transaction: bytes, account: S.account, chain });
    const signed = Array.isArray(out) ? out[0].signedTransaction : out.signedTransaction;
    rawTx = signed;
    signature = await conn.sendRawTransaction(signed, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
  } else if (feats["solana:signAndSendTransaction"]) {
    const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const out = await feats["solana:signAndSendTransaction"].signAndSendTransaction({ transaction: bytes, account: S.account, chain });
    const sig = Array.isArray(out) ? out[0].signature : out.signature;
    signature = bs58.encode(sig);
  } else {
    throw new Error("This wallet can't sign Solana transactions.");
  }
  await confirmSignature(signature, lastValidBlockHeight, rawTx);
  return signature;
}
// While waiting, the same signed transaction is re-sent every couple of seconds (re-sending is harmless: the network
// ignores a transaction it has already processed). A single send is easily dropped by a busy or rate-limited RPC node,
// which is what used to end in "expired before it landed".
async function confirmSignature(signature, lastValidBlockHeight, rawTx) {
  const { conn } = need();
  const started = Date.now();
  let lastSend = Date.now();
  for (;;) {
    const { value } = await conn.getSignatureStatuses([signature], { searchTransactionHistory: false });
    const st = value && value[0];
    if (st) {
      if (st.err) throw new Error("The transaction failed on-chain: " + JSON.stringify(st.err));
      if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return;
    }
    if (Date.now() - started > 90_000) throw new Error("Timed out waiting for confirmation. Check the explorer for signature " + signature + ".");
    if (lastValidBlockHeight) {
      const h = await conn.getBlockHeight("confirmed").catch(() => 0);
      if (h && h > lastValidBlockHeight) {
        // one last look, including history, in case it landed right at the deadline
        const fin = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true }).catch(() => null);
        const fs = fin && fin.value && fin.value[0];
        if (fs && !fs.err && (fs.confirmationStatus === "confirmed" || fs.confirmationStatus === "finalized")) return;
        throw new Error("The transaction expired before it landed (the network was busy or the RPC dropped it). Nothing was spent; try again.");
      }
    }
    if (rawTx && Date.now() - lastSend >= 2000) {
      lastSend = Date.now();
      conn.sendRawTransaction(rawTx, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// ---- admin: create the platform config --------------------------------------------------------------
export async function createPlatformConfig(opts = {}) {
  const { client } = need();
  const me = owner();
  const params = buildCurveParams(opts);
  const configKp = Keypair.generate();
  const tx = await client.partner.createConfig({
    config: configKp.publicKey,
    feeClaimer: opts.feeClaimer ? pk(opts.feeClaimer) : me,
    leftoverReceiver: opts.leftoverReceiver ? pk(opts.leftoverReceiver) : me,
    quoteMint: WSOL_MINT,
    payer: me,
    ...params,
  });
  const signature = await signSendConfirm(tx, [configKp]);
  return {
    config: configKp.publicKey.toBase58(),
    signature,
    migrationQuoteThresholdSol: toNum(params.migrationQuoteThreshold, 9),
  };
}

// A creator who wants their own total supply pays for a platform config of their own: the SAME curve and fee
// settings as the site's standard config (`curve` = { initialMarketCapSol, migrationMarketCapSol, tradingFeeBps,
// creatorFeePercent }, which the relayer publishes), only with their supply, and with the PLATFORM's wallet as
// the fee claimer (read from the standard config). The relayer re-checks all of that on-chain before it lists
// the token, so a creator can't quietly change the fees.
export async function createSupplyConfig({ totalSupply, curve = {} }) {
  const { client, configAddress } = need();
  if (!configAddress) throw new Error("The platform's standard config isn't set yet (Admin → Solana).");
  const tmpl = await client.state.getPoolConfig(configAddress);
  if (!tmpl) throw new Error("The platform's standard config wasn't found on this network.");
  return createPlatformConfig({ ...curve, totalSupply, feeClaimer: tmpl.feeClaimer, leftoverReceiver: tmpl.leftoverReceiver });
}

// ---- launch -----------------------------------------------------------------------------------------
// Creates the token mint + bonding-curve pool, and (optionally) the creator's first buy, in ONE transaction.
// `config` (optional) launches under a different platform config than the site's standard one — used for tokens
// with a creator-chosen supply (see createSupplyConfig).
export async function launch({ name, symbol, uri, firstBuySol = "0", slippageBps = 1000, config = null }) {
  const { client, configAddress: standardConfig } = need();
  const configAddress = config ? pk(config) : standardConfig;
  if (!configAddress) throw new Error("The Solana launch config isn't set yet (Admin → Solana → platform config address).");
  const me = owner();
  if (!name || !symbol || !uri) throw new Error("Name, symbol and metadata URL are required.");
  const baseMint = Keypair.generate();
  const buy = parseUnits(firstBuySol || "0", 9);
  const createPoolParam = { name, symbol, uri, payer: me, poolCreator: me, config: configAddress, baseMint: baseMint.publicKey };
  const tx = await client.creator.createPoolWithFirstBuy({
    createPoolParam,
    firstBuyParam: buy.gtn(0)
      ? { buyer: me, buyAmount: buy, minimumAmountOut: new BN(0), referralTokenAccount: null }
      : undefined,
  });
  const pool = DBC.deriveDbcPoolAddress(WSOL_MINT, baseMint.publicKey, configAddress);
  const signature = await signSendConfirm(tx, [baseMint]);
  return { signature, mint: baseMint.publicKey.toBase58(), pool: pool.toBase58(), creator: me.toBase58() };
}

// ---- config reads -----------------------------------------------------------------------------------
// The real numbers of a platform config on-chain (so the UI describes what a launch will actually do).
export async function getConfigInfo(configAddress) {
  const { client } = need();
  const config = await client.state.getPoolConfig(pk(configAddress));
  if (!config) throw new Error("That platform config wasn't found on this network.");
  const dec = config.tokenDecimal;
  const supplyRaw = config.preMigrationTokenSupply || config.postMigrationTokenSupply;
  const supply = supplyRaw ? Number(formatUnits(new BN(supplyRaw.toString()), dec, 0)) : null;
  const startPrice = DBC.getPriceFromSqrtPrice(config.sqrtStartPrice, dec, 9).toNumber();
  const out = {
    config: pk(configAddress).toBase58(),
    totalSupply: supply,
    startPriceSol: startPrice,
    startMarketCapSol: supply ? startPrice * supply : null,
    raiseSol: toNum(config.migrationQuoteThreshold, 9),
    tokenDecimals: dec,
    feeClaimer: config.feeClaimer ? config.feeClaimer.toBase58() : null,
  };
  try { // cliff fee numerator is out of 1e9 (1% = 10,000,000)
    const num = config.poolFees.baseFee.cliffFeeNumerator;
    out.tradingFeeBps = Number(num.toString()) / 100_000;
  } catch (e) { /* older/odd config shape: leave unset */ }
  if (config.creatorTradingFeePercentage !== undefined) out.creatorFeePercent = Number(config.creatorTradingFeePercentage);
  if (config.migrationSqrtPrice && supply) {
    out.graduationMarketCapSol = DBC.getPriceFromSqrtPrice(config.migrationSqrtPrice, dec, 9).toNumber() * supply;
  }
  return out;
}

// ---- pool reads -------------------------------------------------------------------------------------
export async function getPoolInfo(poolAddress) {
  const { client } = need();
  const pool = unwrapPool(await client.state.getPool(poolAddress));
  if (!pool) throw new Error("Pool not found on this cluster.");
  const config = await client.state.getPoolConfig(pool.config);
  const dec = config.tokenDecimal;
  const price = DBC.getPriceFromSqrtPrice(pool.sqrtPrice, dec, 9).toNumber(); // SOL per whole token
  const threshold = config.migrationQuoteThreshold;
  const raised = pool.quoteReserve;
  let progressPct = threshold.gtn(0) ? Number(raised.muln(10000).div(threshold).toString()) / 100 : 0;
  progressPct = Math.max(0, Math.min(100, progressPct));
  const migrated = Number(pool.isMigrated) !== 0;
  if (migrated) progressPct = 100;
  const supplyRaw = config.preMigrationTokenSupply || config.postMigrationTokenSupply;
  const supplyWhole = supplyRaw ? Number(formatUnits(new BN(supplyRaw.toString()), dec, 0)) : null;
  // After graduation the curve's price is frozen; the live price is the DAMM v2 pool's. If that pool can't be read
  // (not found yet, RPC hiccup) fall back to the last curve price rather than failing the whole token.
  let livePrice = price;
  let venue = migrated ? "damm" : "curve";
  if (migrated && S.cp) {
    try {
      const ctx = { pool, config };
      const addr = await resolveDammPool(poolAddress, ctx);
      const st = await S.cp.fetchPoolState(addr);
      const tokenIsA = st.tokenAMint.equals(pool.baseMint);
      const p = dammPriceSol({ poolState: st, tokenIsA, decA: tokenIsA ? dec : 9, decB: tokenIsA ? 9 : dec });
      if (p > 0 && isFinite(p)) livePrice = p;
    } catch (e) { /* keep the curve price */ }
  }
  return {
    pool: pk(poolAddress).toBase58(),
    mint: pool.baseMint.toBase58(),
    creator: pool.creator.toBase58(),
    config: pool.config.toBase58(),
    venue,
    priceSol: livePrice,
    marketCapSol: supplyWhole ? livePrice * supplyWhole : null,
    raisedSol: toNum(raised, 9),
    thresholdSol: toNum(threshold, 9),
    progressPct,
    migrated,
    tokenDecimals: dec,
  };
}
export async function getBalances(mint) {
  const { conn } = need();
  const me = owner();
  const lamports = await conn.getBalance(me, "confirmed");
  let token = 0;
  if (mint) {
    const res = await conn.getParsedTokenAccountsByOwner(me, { mint: pk(mint) }, "confirmed");
    token = res.value.reduce((a, v) => a + (v.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
  }
  return { sol: lamports / LAMPORTS_PER_SOL, token };
}

// ---- platform swap fee --------------------------------------------------------------------------------
// Every swap made through the site (curve or DAMM v2) pays the platform S.feeBps (30 = 0.30%) of the SOL side of the
// trade: a plain SOL transfer to the platform wallet, added to the SAME transaction, so it either happens with the
// swap or not at all. On a buy it is taken from the SOL the trader enters (the rest goes into the swap, so the trader
// never spends more than they typed); on a sell it is taken from the SOL the swap pays out (quoted amount).
// It is a front-end fee: trades made elsewhere (Meteora, Jupiter, another app) don't pay it. The platform wallet is
// the platform config's fee claimer, so curve fees and swap fees land in the same place.
export function getSwapFeeBps() { return S.feeBps; }
export function platformFeeLamports(lamports, bps = S.feeBps) {
  const l = BN.isBN(lamports) ? lamports : new BN(String(lamports));
  return l.muln(bps).divn(10_000); // rounds down
}
async function platformFeeWallet() {
  if (S.feeWallet) return S.feeWallet;
  if (S.feeBps === 0) return null;
  const { client, configAddress } = need();
  if (!configAddress) throw new Error("The platform's Solana config isn't set (Admin → Solana), so the swap fee can't be sent anywhere.");
  const cfg = await client.state.getPoolConfig(configAddress);
  if (!cfg || !cfg.feeClaimer) throw new Error("Couldn't read the platform wallet from the platform config.");
  S.feeWallet = cfg.feeClaimer;
  return S.feeWallet;
}
function addFeeTransfer(tx, from, to, lamports) {
  if (!to || !lamports || lamports.lten(0) || to.equals(from)) return;
  tx.add(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: BigInt(lamports.toString()) }));
}

// ---- trade ------------------------------------------------------------------------------------------
async function loadPool(poolAddress) {
  const { client } = need();
  const rawPool = await client.state.getPool(poolAddress);
  if (!rawPool) throw new Error("Pool not found.");
  const pool = unwrapPool(rawPool);
  const config = await client.state.getPoolConfig(pool.config);
  return { rawPool, pool, config, migrated: Number(pool.isMigrated) !== 0 };
}
async function curveContext(ctx) {
  const { conn } = need();
  const currentPoint = await DBC.getCurrentPoint(conn, ctx.config.activationType);
  // `virtualPool` (rawPool) is what the SDK's quote/swap functions want; `pool` is the unwrapped poolState.
  return { pool: ctx.pool, virtualPool: ctx.rawPool, config: ctx.config, currentPoint };
}

// A graduated token trades in a Meteora DAMM v2 pool. Its address is derived from the migration settings the
// platform config was created with; a pool made some other way is found by searching for the token's pools.
function needCp() {
  if (!S.cp) throw new Error("Solana isn't initialised yet.");
  return S.cp;
}
async function resolveDammPool(poolAddress, ctx) {
  const key = pk(poolAddress).toBase58();
  if (S.dammPools.has(key)) return S.dammPools.get(key);
  const cp = needCp();
  const baseMint = ctx.pool.baseMint, quoteMint = ctx.config.quoteMint;
  let found = null;
  const dammConfig = DBC.DAMM_V2_MIGRATION_FEE_ADDRESS[Number(ctx.config.migrationFeeOption)];
  if (Number(ctx.config.migrationOption) === DBC.MigrationOption.MET_DAMM_V2 && dammConfig) {
    const addr = DBC.deriveDammV2PoolAddress(dammConfig, baseMint, quoteMint);
    try { await cp.fetchPoolState(addr); found = addr; } catch (e) { /* not at the derived address: search below */ }
  }
  if (!found) {
    let all = [];
    try { all = await cp.fetchPoolStatesByTokenMint(baseMint); } catch (e) { all = []; }
    all = all.filter((x) => x.account.tokenAMint.equals(quoteMint) || x.account.tokenBMint.equals(quoteMint));
    all.sort((x, y) => (y.account.liquidity.gt(x.account.liquidity) ? 1 : -1)); // deepest pool first
    if (all.length) found = all[0].publicKey;
  }
  if (!found) throw new Error("This token has graduated, but its Meteora DAMM v2 pool wasn't found yet. Try again in a minute.");
  S.dammPools.set(key, found);
  return found;
}
async function dammContext(poolAddress, ctx) {
  const cp = needCp();
  const { conn } = need();
  const addr = await resolveDammPool(poolAddress, ctx);
  const poolState = await cp.fetchPoolState(addr);
  const currentPoint = await cpCurrentPoint(conn, poolState.activationType);
  const tokenIsA = poolState.tokenAMint.equals(ctx.pool.baseMint);
  const tokenDec = ctx.config.tokenDecimal;
  return { addr, poolState, currentPoint, tokenIsA, decA: tokenIsA ? tokenDec : 9, decB: tokenIsA ? 9 : tokenDec };
}
// SOL per whole token in a DAMM v2 pool (price of token A in token B is (sqrtPrice / 2^64)^2, scaled by decimals).
function dammPriceSol(d) {
  const sq = Number(d.poolState.sqrtPrice.toString()) / 2 ** 64;
  const aInB = sq * sq * 10 ** (d.decA - d.decB);
  return d.tokenIsA ? aInB : (aInB > 0 ? 1 / aInB : 0);
}

// side: "buy" (amount in SOL) | "sell" (amount in whole tokens). Works on the curve and, once the token has
// graduated, on its DAMM v2 pool. `out` / `minOut` are what the trader actually receives AFTER the platform fee.
export async function quote({ pool: poolAddress, side, amount, slippageBps = 100 }) {
  const ctx = await loadPool(poolAddress);
  const sell = side === "sell";
  const tokenDec = ctx.config.tokenDecimal;
  const typed = parseUnits(amount, sell ? tokenDec : 9);
  if (!typed.gtn(0)) throw new Error("Enter an amount greater than zero.");
  // On a buy the fee comes out of the SOL typed, and the rest is swapped.
  const buyFee = sell ? new BN(0) : platformFeeLamports(typed);
  const amountIn = sell ? typed : typed.sub(buyFee);
  if (!amountIn.gtn(0)) throw new Error("That amount is too small to trade.");
  let grossOut, minOut, impactPct, poolFeeSol = null, venue, poolInfo = {};
  if (!ctx.migrated) {
    venue = "curve";
    const { client } = need();
    const c = await curveContext(ctx);
    const q = client.pool.swapQuote2({
      virtualPool: c.virtualPool, config: c.config, swapBaseForQuote: sell, hasReferral: false,
      eligibleForFirstSwapWithMinFee: false, currentPoint: c.currentPoint, slippageBps,
      swapMode: DBC.SwapMode.ExactIn, amountIn,
    });
    grossOut = q.outputAmount;
    minOut = q.minimumAmountOut || grossOut.muln(10000 - slippageBps).divn(10000);
    const cur = Number(ctx.pool.sqrtPrice.toString());
    const nxt = Number(q.nextSqrtPrice.toString());
    impactPct = cur > 0 ? Math.abs((nxt / cur) ** 2 - 1) * 100 : 0;
    if (!sell) poolFeeSol = toNum(q.tradingFee.add(q.protocolFee), 9);
  } else {
    venue = "damm";
    const cp = needCp();
    const d = await dammContext(poolAddress, ctx);
    const inputTokenMint = sell ? ctx.pool.baseMint : WSOL_MINT;
    const q = cp.getQuote2({
      inputTokenMint, slippage: slippageBps, currentPoint: d.currentPoint, poolState: d.poolState,
      tokenADecimal: d.decA, tokenBDecimal: d.decB, hasReferral: false,
      swapMode: CpSwapMode.ExactIn, amountIn,
    });
    grossOut = q.outputAmount;
    minOut = q.minimumAmountOut || grossOut.muln(10000 - slippageBps).divn(10000);
    impactPct = Number(q.priceImpact.toString());
    if (!sell) poolFeeSol = toNum(q.includedFeeInputAmount.sub(q.excludedFeeInputAmount), 9);
    poolInfo = { dammPool: d.addr.toBase58() };
  }
  // On a sell the fee comes out of the SOL the swap pays.
  const sellFee = sell ? platformFeeLamports(grossOut) : new BN(0);
  const sellFeeAtMin = sell ? platformFeeLamports(minOut) : new BN(0);
  const out = sell ? grossOut.sub(sellFee) : grossOut;
  const netMin = sell ? minOut.sub(sellFeeAtMin) : minOut;
  const outDec = sell ? 9 : tokenDec;
  const feeLamports = sell ? sellFee : buyFee;
  return {
    venue, ...poolInfo,
    amountIn, amountOut: grossOut, minimumAmountOut: minOut, platformFeeLamports: feeLamports,
    out: toNum(out, outDec), minOut: toNum(netMin, outDec),
    feeSol: poolFeeSol,                                  // the pool's own fee (buys only; shown for information)
    platformFeeSol: toNum(feeLamports, 9), platformFeeBps: S.feeBps,
    impactPct,
  };
}
export async function trade({ pool: poolAddress, side, amount, slippageBps = 100 }) {
  const me = owner();
  const sell = side === "sell";
  const feeTo = S.feeBps > 0 ? await platformFeeWallet() : null; // resolved BEFORE the swap is built: no fee wallet, no trade
  const q = await quote({ pool: poolAddress, side, amount, slippageBps });
  let tx;
  if (q.venue === "curve") {
    const { client } = need();
    tx = await client.pool.swap2({
      owner: me, pool: pk(poolAddress), swapBaseForQuote: sell, referralTokenAccount: null,
      swapMode: DBC.SwapMode.ExactIn, amountIn: q.amountIn, minimumAmountOut: q.minimumAmountOut,
    });
  } else {
    const cp = needCp();
    const ctx = await loadPool(poolAddress);
    const d = await dammContext(poolAddress, ctx);
    const st = d.poolState;
    tx = await cp.swap2({
      payer: me, pool: d.addr,
      inputTokenMint: sell ? ctx.pool.baseMint : WSOL_MINT,
      outputTokenMint: sell ? WSOL_MINT : ctx.pool.baseMint,
      tokenAMint: st.tokenAMint, tokenBMint: st.tokenBMint,
      tokenAVault: st.tokenAVault, tokenBVault: st.tokenBVault,
      tokenAProgram: cpTokenProgram(st.tokenAFlag), tokenBProgram: cpTokenProgram(st.tokenBFlag),
      referralTokenAccount: null,
      swapMode: CpSwapMode.ExactIn, amountIn: q.amountIn, minimumAmountOut: q.minimumAmountOut,
    });
  }
  // The platform fee rides in the same transaction, after the swap (so on a sell the SOL has already arrived).
  addFeeTransfer(tx, me, feeTo, q.platformFeeLamports);
  const signature = await signSendConfirm(tx);
  return { signature, out: q.out, platformFeeSol: q.platformFeeSol, venue: q.venue };
}

// ---- fees -------------------------------------------------------------------------------------------
// While a token is on the curve, trading fees accrue inside the curve pool and are claimed there (creator and
// platform ("partner") shares). After graduation the pool is a Meteora DAMM v2 pool whose trading fees accrue to
// LIQUIDITY POSITIONS: the platform's position is owned by the platform config's fee claimer and the creator's by the
// token's creator wallet. Fees earned on the curve stay claimable on the curve pool afterwards. getFeeBreakdown() and
// claimFees() cover both, so one balance and one button work before and after graduation.
const POSITIONS_TTL_MS = 20_000;
function positionsOf(ownerPk, force = false) {
  const key = ownerPk.toBase58();
  const hit = S.positions.get(key);
  if (!force && hit && Date.now() - hit.at < POSITIONS_TTL_MS) return hit.p;
  const p = needCp().getPositionsByUser(ownerPk);
  S.positions.set(key, { at: Date.now(), p });
  p.catch(() => S.positions.delete(key));
  return p;
}
// What `ownerPk` has earned in this graduated token's DAMM v2 pool: unclaimed (claimable now) and already claimed.
async function dammFeesFor(poolAddress, ctx, ownerPk, force = false) {
  const addr = await resolveDammPool(poolAddress, ctx);
  const poolState = await needCp().fetchPoolState(addr);
  const mine = (await positionsOf(ownerPk, force)).filter((x) => x.positionState.pool.equals(addr));
  const solIsA = poolState.tokenAMint.equals(WSOL_MINT);
  const zero = () => new BN(0);
  const t = { unSol: zero(), unTok: zero(), clSol: zero(), clTok: zero() };
  const claimable = [];
  for (const x of mine) {
    const f = getUnClaimLpFee(poolState, x.positionState);
    const m = x.positionState.metrics || {};
    const fA = f.feeTokenA, fB = f.feeTokenB;
    const cA = m.totalClaimedAFee || zero(), cB = m.totalClaimedBFee || zero();
    t.unSol = t.unSol.add(solIsA ? fA : fB); t.unTok = t.unTok.add(solIsA ? fB : fA);
    t.clSol = t.clSol.add(solIsA ? cA : cB); t.clTok = t.clTok.add(solIsA ? cB : cA);
    if (fA.gtn(0) || fB.gtn(0)) claimable.push(x);
  }
  const dec = ctx.config.tokenDecimal;
  return {
    addr, poolState, positions: mine, claimable,
    unclaimedSol: toNum(t.unSol, 9), unclaimedToken: toNum(t.unTok, dec),
    claimedSol: toNum(t.clSol, 9), claimedToken: toNum(t.clTok, dec),
  };
}
export async function getFeeBreakdown(poolAddress, { force = false } = {}) {
  const { client } = need();
  const ctx = await loadPool(poolAddress);
  const sol = (b) => toNum(b, 9);
  let f = null;
  try { f = await client.state.getPoolFeeBreakdown(poolAddress); }
  catch (e) { if (!ctx.migrated) throw e; /* a graduated curve may no longer report; the DAMM v2 side below still can */ }
  const out = {
    creatorUnclaimedSol: f ? sol(f.creator.unclaimedQuoteFee) : 0, creatorTotalSol: f ? sol(f.creator.totalQuoteFee) : 0,
    partnerUnclaimedSol: f ? sol(f.partner.unclaimedQuoteFee) : 0, partnerTotalSol: f ? sol(f.partner.totalQuoteFee) : 0,
    creatorUnclaimedToken: 0, partnerUnclaimedToken: 0,
    venue: ctx.migrated ? "damm" : "curve",
    _raw: f,
  };
  if (ctx.migrated && S.cp) {
    try {
      const platform = ctx.config.feeClaimer, creator = ctx.pool.creator;
      const pf = await dammFeesFor(poolAddress, ctx, platform, force);
      out.dammPool = pf.addr.toBase58();
      out.partnerUnclaimedSol += pf.unclaimedSol; out.partnerTotalSol += pf.unclaimedSol + pf.claimedSol;
      out.partnerUnclaimedToken += pf.unclaimedToken;
      // If the platform wallet is also the token's creator, one wallet owns both positions and they can't be told
      // apart, so everything is shown on the platform line only (never counted twice).
      if (!creator.equals(platform)) {
        const cf = await dammFeesFor(poolAddress, ctx, creator, force);
        out.creatorUnclaimedSol += cf.unclaimedSol; out.creatorTotalSol += cf.unclaimedSol + cf.claimedSol;
        out.creatorUnclaimedToken += cf.unclaimedToken;
      }
    } catch (e) {
      out.dammError = (e && e.message) || String(e); // curve figures are still returned
    }
  }
  return out;
}
export async function claimFees({ pool: poolAddress, who }) {
  const { client } = need();
  const me = owner();
  const ctx = await loadPool(poolAddress);
  const part = who === "partner";
  const signatures = [];
  // Only the wallet that owns this share can claim it; say so before anything is built or signed.
  const expected = part ? ctx.config.feeClaimer : ctx.pool.creator;
  if (ctx.migrated && !me.equals(expected)) {
    throw new Error(`Only the ${part ? "platform fee-claimer" : "token creator"} wallet (${expected.toBase58().slice(0, 4)}…${expected.toBase58().slice(-4)}) can claim this share.`);
  }
  // 1) Fees earned on the curve (always attempted before graduation, as before; after it only if some remain).
  let f = null;
  try { f = await client.state.getPoolFeeBreakdown(poolAddress); } catch (e) { if (!ctx.migrated) throw e; }
  if (f) {
    const src = part ? f.partner : f.creator;
    if (!ctx.migrated || src.unclaimedBaseFee.gtn(0) || src.unclaimedQuoteFee.gtn(0)) {
      const params = { payer: me, pool: pk(poolAddress), maxBaseAmount: src.unclaimedBaseFee, maxQuoteAmount: src.unclaimedQuoteFee };
      const tx = part
        ? await client.partner.claimPartnerTradingFee({ ...params, feeClaimer: me })
        : await client.creator.claimCreatorTradingFee({ ...params, creator: me });
      signatures.push(await signSendConfirm(tx));
    }
  }
  // 2) After graduation: the fees sitting in this wallet's DAMM v2 position(s). One transaction per position (each
  //    sets up its own token accounts, so they can't be merged safely).
  if (ctx.migrated) {
    const d = await dammFeesFor(poolAddress, ctx, me, true);
    const st = d.poolState;
    for (const x of d.claimable) {
      const tx = await needCp().claimPositionFee2({
        owner: me, receiver: me, pool: d.addr, position: x.position, positionNftAccount: x.positionNftAccount,
        tokenAMint: st.tokenAMint, tokenBMint: st.tokenBMint, tokenAVault: st.tokenAVault, tokenBVault: st.tokenBVault,
        tokenAProgram: cpTokenProgram(st.tokenAFlag), tokenBProgram: cpTokenProgram(st.tokenBFlag),
      });
      signatures.push(await signSendConfirm(tx));
    }
    S.positions.delete(me.toBase58());
  }
  if (!signatures.length) throw new Error("There are no unclaimed fees for this token.");
  return { signature: signatures[signatures.length - 1], signatures };
}
