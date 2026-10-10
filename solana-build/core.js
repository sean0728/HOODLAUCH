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

// ---- platform curve defaults (pump.fun-style) -------------------------------------------------------
// All market caps are in SOL. 1B supply, 6 decimals. A flat 1% trading fee; 10% of the post-protocol fee goes
// to the creator, the rest to the platform's fee claimer (partner). On graduation the pool migrates to a
// Meteora DAMM v2 pool; 90% of the LP is permanently locked to the platform and 10% to the creator.
export const CURVE_DEFAULTS = Object.freeze({
  totalSupply: 1_000_000_000,
  tokenDecimals: 6,
  initialMarketCapSol: 30,
  migrationMarketCapSol: 300,
  tradingFeeBps: 100,
  creatorFeePercent: 10,
  partnerLockedLpPercent: 90,
  creatorLockedLpPercent: 10,
});

export function buildCurveParams(opts = {}) {
  const o = { ...CURVE_DEFAULTS, ...opts };
  return DBC.buildCurveWithMarketCap({
    token: {
      tokenType: DBC.TokenType.SPLToken,
      tokenBaseDecimal: o.tokenDecimals === 9 ? DBC.TokenDecimal.NINE : DBC.TokenDecimal.SIX,
      tokenQuoteDecimal: 9,
      tokenAuthorityOption: DBC.TokenAuthorityOption.Immutable,
      totalTokenSupply: o.totalSupply,
      leftover: 0,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: DBC.BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: o.tradingFeeBps, endingFeeBps: o.tradingFeeBps, numberOfPeriod: 0, totalDuration: 0 },
      },
      dynamicFeeEnabled: false,
      collectFeeMode: DBC.CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: o.creatorFeePercent,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: DBC.MigrationOption.MET_DAMM_V2,
      migrationFeeOption: DBC.MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: o.partnerLockedLpPercent,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: o.creatorLockedLpPercent,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: { totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    activationType: DBC.ActivationType.Timestamp,
    initialMarketCap: o.initialMarketCapSol,
    migrationMarketCap: o.migrationMarketCapSol,
  });
}

// ---- small helpers ----------------------------------------------------------------------------------
// Decimal string -> BN in base units, without floating point.
export function parseUnits(text, decimals) {
  const s = String(text).trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") throw new Error("Enter a valid amount.");
  const [whole, frac = ""] = s.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return new BN((whole || "0") + fracPadded, 10);
}
export function formatUnits(bn, decimals, maxFrac = 6) {
  const neg = bn.isNeg();
  let s = (neg ? bn.neg() : bn).toString(10).padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  let frac = s.slice(s.length - decimals).slice(0, maxFrac).replace(/0+$/, "");
  return (neg ? "-" : "") + whole + (frac ? "." + frac : "");
}
const toNum = (bn, decimals) => Number(formatUnits(bn, decimals, decimals));

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

// ---- launch -----------------------------------------------------------------------------------------
// Creates the token mint + bonding-curve pool, and (optionally) the creator's first buy, in ONE transaction.
export async function launch({ name, symbol, uri, firstBuySol = "0", slippageBps = 1000 }) {
  const { client, configAddress } = need();
  if (!configAddress) throw new Error("The Solana launch config isn't set yet (public/solana-config.json → dbcConfig).");
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
