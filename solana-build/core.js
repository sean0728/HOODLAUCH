// IgnitionX — Solana helpers (devnet + mainnet-beta, switchable from Admin → Solana). Built on Meteora's Dynamic Bonding Curve (DBC) program.
// Kept free of `window` so it can be unit-tested in Node (see test/core.test.mjs); entry.js attaches it to the page.
//
// What lives here:
//   - Solana wallet discovery/connect through the Wallet Standard (Phantom, Solflare, Backpack, ... all speak it)
//   - launch (create pool + optional first buy in ONE transaction), buy/sell, quotes, pool info, fee claims
//   - createPlatformConfig: the one-time admin transaction that creates the platform's DBC config
//     (curve shape, 1% fee, creator share, migration settings). Every launch then points at that config.
import { Connection, PublicKey, Keypair, ComputeBudgetProgram } from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { getWallets } from "@wallet-standard/app";
import * as DBC from "@meteora-ag/dynamic-bonding-curve-sdk";

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
  wallet: null,   // Wallet Standard wallet object
  account: null,  // Wallet Standard account
  listeners: new Set(),
  offEvents: null,
};
export function _setClientForTests(conn, client) { S.conn = conn; S.client = client; }
export function _setWalletForTests(wallet, account) { S.wallet = wallet; S.account = account; }

// Wallet Standard names the networks "solana:devnet" / "solana:mainnet" (NOT "mainnet-beta").
export const CLUSTERS = Object.freeze({ "devnet": "solana:devnet", "mainnet-beta": "solana:mainnet" });
const walletChain = () => CLUSTERS[S.cluster];
const clusterLabel = () => (S.cluster === "mainnet-beta" ? "mainnet" : "devnet");

export function init({ rpcUrl, cluster = "devnet", configAddress = null } = {}) {
  if (!CLUSTERS[cluster]) throw new Error(`Unknown Solana cluster "${cluster}" (expected devnet or mainnet-beta).`);
  if (!rpcUrl) throw new Error("Solana RPC URL missing (Admin → Solana).");
  S.cluster = cluster;
  S.rpcUrl = rpcUrl;
  S.configAddress = configAddress ? new PublicKey(configAddress) : null;
  S.conn = new Connection(rpcUrl, "confirmed");
  S.client = DBC.DynamicBondingCurveClient.create(S.conn, "confirmed");
  return { cluster, configAddress };
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
// On mainnet a transaction with no priority fee can sit unprocessed when the network is busy, so one is added
// (devnet doesn't need it). 50,000 micro-lamports per compute unit is ~0.00002 SOL for a typical launch.
export const MAINNET_PRIORITY_MICROLAMPORTS = 50_000;
export async function signSendConfirm(tx, extraSigners = []) {
  const { conn } = need();
  const payer = owner();
  if (S.cluster === "mainnet-beta" && !tx.instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId))) {
    tx.instructions.unshift(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: MAINNET_PRIORITY_MICROLAMPORTS }));
  }
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.feePayer = payer;
  tx.recentBlockhash = blockhash;
  if (extraSigners.length) tx.partialSign(...extraSigners);
  const chain = walletChain();
  const feats = S.wallet.features;
  let signature;
  if (feats["solana:signTransaction"]) {
    const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const out = await feats["solana:signTransaction"].signTransaction({ transaction: bytes, account: S.account, chain });
    const signed = Array.isArray(out) ? out[0].signedTransaction : out.signedTransaction;
    signature = await conn.sendRawTransaction(signed, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
  } else if (feats["solana:signAndSendTransaction"]) {
    const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    const out = await feats["solana:signAndSendTransaction"].signAndSendTransaction({ transaction: bytes, account: S.account, chain });
    const sig = Array.isArray(out) ? out[0].signature : out.signature;
    signature = bs58.encode(sig);
  } else {
    throw new Error("This wallet can't sign Solana transactions.");
  }
  await confirmSignature(signature, lastValidBlockHeight);
  return signature;
}
async function confirmSignature(signature, lastValidBlockHeight) {
  const { conn } = need();
  const started = Date.now();
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
      if (h && h > lastValidBlockHeight) throw new Error("The transaction expired before it landed. Nothing was spent; try again.");
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
  return {
    pool: pk(poolAddress).toBase58(),
    mint: pool.baseMint.toBase58(),
    creator: pool.creator.toBase58(),
    config: pool.config.toBase58(),
    priceSol: price,
    marketCapSol: supplyWhole ? price * supplyWhole : null,
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

// ---- trade ------------------------------------------------------------------------------------------
async function swapContext(poolAddress) {
  const { client, conn } = need();
  const rawPool = await client.state.getPool(poolAddress);
  if (!rawPool) throw new Error("Pool not found.");
  const pool = unwrapPool(rawPool);
  if (Number(pool.isMigrated) !== 0) throw new Error("This token has graduated — it now trades on Meteora (DAMM v2), not on the bonding curve.");
  const config = await client.state.getPoolConfig(pool.config);
  const currentPoint = await DBC.getCurrentPoint(conn, config.activationType);
  // `virtualPool` (rawPool) is what the SDK's quote/swap functions want; `pool` is the unwrapped poolState.
  return { pool, virtualPool: rawPool, config, currentPoint };
}
// side: "buy" (amount in SOL) | "sell" (amount in whole tokens)
export async function quote({ pool: poolAddress, side, amount, slippageBps = 100 }) {
  const { client } = need();
  const { pool, virtualPool, config, currentPoint } = await swapContext(poolAddress);
  const sell = side === "sell";
  const inDec = sell ? config.tokenDecimal : 9;
  const outDec = sell ? 9 : config.tokenDecimal;
  const amountIn = parseUnits(amount, inDec);
  if (!amountIn.gtn(0)) throw new Error("Enter an amount greater than zero.");
  const q = client.pool.swapQuote2({
    virtualPool, config, swapBaseForQuote: sell, hasReferral: false,
    eligibleForFirstSwapWithMinFee: false, currentPoint, slippageBps,
    swapMode: DBC.SwapMode.ExactIn, amountIn,
  });
  const out = q.outputAmount;
  const minOut = q.minimumAmountOut || out.muln(10000 - slippageBps).divn(10000);
  const cur = Number(pool.sqrtPrice.toString());
  const nxt = Number(q.nextSqrtPrice.toString());
  const impactPct = cur > 0 ? Math.abs((nxt / cur) ** 2 - 1) * 100 : 0;
  return {
    amountIn, amountOut: out, minimumAmountOut: minOut,
    out: toNum(out, outDec), minOut: toNum(minOut, outDec),
    feeSol: sell ? null : toNum(q.tradingFee.add(q.protocolFee), 9),
    impactPct,
  };
}
export async function trade({ pool: poolAddress, side, amount, slippageBps = 100 }) {
  const { client } = need();
  const me = owner();
  const q = await quote({ pool: poolAddress, side, amount, slippageBps });
  const tx = await client.pool.swap2({
    owner: me, pool: pk(poolAddress), swapBaseForQuote: side === "sell", referralTokenAccount: null,
    swapMode: DBC.SwapMode.ExactIn, amountIn: q.amountIn, minimumAmountOut: q.minimumAmountOut,
  });
  const signature = await signSendConfirm(tx);
  return { signature, out: q.out };
}

// ---- fees -------------------------------------------------------------------------------------------
export async function getFeeBreakdown(poolAddress) {
  const { client } = need();
  const f = await client.state.getPoolFeeBreakdown(poolAddress);
  const sol = (b) => toNum(b, 9);
  return {
    creatorUnclaimedSol: sol(f.creator.unclaimedQuoteFee), creatorTotalSol: sol(f.creator.totalQuoteFee),
    partnerUnclaimedSol: sol(f.partner.unclaimedQuoteFee), partnerTotalSol: sol(f.partner.totalQuoteFee),
    _raw: f,
  };
}
export async function claimFees({ pool: poolAddress, who }) {
  const { client } = need();
  const me = owner();
  const f = await client.state.getPoolFeeBreakdown(poolAddress);
  const part = who === "partner";
  const src = part ? f.partner : f.creator;
  const params = { payer: me, pool: pk(poolAddress), maxBaseAmount: src.unclaimedBaseFee, maxQuoteAmount: src.unclaimedQuoteFee };
  const tx = part
    ? await client.partner.claimPartnerTradingFee({ ...params, feeClaimer: me })
    : await client.creator.claimCreatorTradingFee({ ...params, creator: me });
  return { signature: await signSendConfirm(tx) };
}
