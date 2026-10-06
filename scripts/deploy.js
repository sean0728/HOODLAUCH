const hre = require("hardhat");
const { verifyContract } = require("../lib/verify");
const { recordDeployment } = require("../lib/deploymentStore");

// Uniswap V2 addresses that are independently confirmed for Robinhood Chain
// MAINNET (chain 4663) as of 2026-08-26 — cross-checked three ways: (1)
// Uniswap Labs' own official npm package (@uniswap/sdk-core, published by
// the uniswap-labs-service-account, repo github.com/Uniswap/sdks) hardcodes
// these under ChainId.ROBINHOOD; (2) Robinhood Chain's own block explorer
// (robinhoodchain.blockscout.com) shows both as verified contracts named
// exactly "UniswapV2Factory"/"UniswapV2Router02", compiled with the same
// legacy compiler versions (v0.5.16/v0.6.6) as the real, original Uniswap
// V2 deployment; (3) the router's verified source explicitly documents
// "support for fee-on-transfer tokens", which is the exact behavior this
// project's tax mechanism depends on. No equivalent confirmation exists for
// TESTNET (chain 46630) — the testnet explorer turns up 15 different
// contracts all separately verified under the name "UniswapV2Router02"
// (anyone can deploy and verify a copy of the public V2 source), with no
// way from here to tell which one, if any, real liquidity is actually
// routed through. Leave DEX_ROUTER_ADDRESS unset for testnet until you can
// confirm the real one directly (e.g. from Uniswap's own app/interface
// pointed at Robinhood Chain testnet).
const KNOWN_ROUTER_ADDRESSES = {
  robinhoodMainnet: "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba", // UniswapV2Router02
};
const KNOWN_FACTORY_ADDRESSES = {
  robinhoodMainnet: "0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f", // UniswapV2Factory — informational only, not passed to TokenFactory (the router exposes factory() itself)
};

// Chainlink ETH/USD feed, confirmed for Robinhood Chain MAINNET (chain 4663)
// as of 2026-08-26 — the user read this address directly off Chainlink's own
// address directory (docs.chain.link/data-feeds/price-feeds/addresses?
// network=robinhood), which Robinhood's own docs name as the source of
// truth for these. This is the "Standard Proxy" address, the conventional
// AggregatorV3Interface-compatible feed (latestRoundData()/decimals()) —
// not the separate "SVR Proxy" address the same page also lists, which is a
// distinct Smart Value Recapture feed meant for MEV-aware integrations, not
// a plain price read like this project's graduation check does. No
// equivalent has been confirmed for TESTNET (chain 46630) — leave
// PRICE_FEED_ADDRESS unset there until you've pulled the real one the same
// way.
const KNOWN_PRICE_FEED_ADDRESSES = {
  robinhoodMainnet: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9", // Chainlink ETH/USD, Standard Proxy
};

// USD targets for the two launch modes — kept here as the single source of
// truth for what deployFee/launchFee are *meant* to track. The contract
// itself only stores a fixed wei amount (see the NatSpec on TokenFactory),
// so this script converts these USD targets to wei using a live ETH price
// fetched right before deploying. DEPLOY_FEE_WEI/LAUNCH_FEE_WEI in .env
// override this conversion entirely, for anyone who'd rather set an exact
// wei amount directly.
const DEPLOY_FEE_USD = 25;
const LAUNCH_FEE_USD = 25;

// Quick Launch (bonding curve) pricing target — no pool exists yet at
// curve-creation time, same "deploy only" situation deployFeeWei prices for
// the plain/custom-tax paths, but priced independently at its own USD target
// rather than reusing DEPLOY_FEE_USD, since the business decision here is a
// flat $25 launch fee for both bonding-curve modes (BondingCurveFactory and
// CustomBondingCurveFactory share this same target — see curveLaunchFeeWei
// below). CURVE_LAUNCH_FEE_WEI in .env overrides this conversion entirely,
// same convention as DEPLOY_FEE_WEI/LAUNCH_FEE_WEI above.
const CURVE_LAUNCH_FEE_USD = 25;

// Node's script context has no CSP restriction (that only applies to the
// published front-end page — see index.html's own price-fetch logic),
// so a plain public API call works fine here.
async function fetchEthUsdPrice() {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    if (!res.ok) return null;
    const data = await res.json();
    const price = data && data.ethereum && data.ethereum.usd;
    return typeof price === "number" && price > 0 ? price : null;
  } catch (err) {
    return null;
  }
}

// Deploys the full stack: LaunchedToken implementation -> LiquidityLocker ->
// TokenFactory -> wires the locker to only accept locks from that factory.
//
// On the local Hardhat network this also deploys MockRouter and a
// MockAggregatorV3 (standing in for a Chainlink ETH/USD feed) so the whole
// flow — both "Deploy Token" and "Deploy and Add Liquidity (Launch)" — is
// runnable end to end locally. On any real network, DEX_ROUTER_ADDRESS and
// PRICE_FEED_ADDRESS must both resolve to something — this script refuses
// to guess either one where no confirmed default exists (see
// KNOWN_ROUTER_ADDRESSES above for exactly what is and isn't confirmed).
async function main() {
  const network = hre.network.name;
  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deploying with account: ${deployer.address}`);
  console.log(`Network: ${network}`);

  const feeTreasury = process.env.FEE_TREASURY_ADDRESS || deployer.address;

  let deployFeeWei = process.env.DEPLOY_FEE_WEI ? BigInt(process.env.DEPLOY_FEE_WEI) : null;
  let launchFeeWei = process.env.LAUNCH_FEE_WEI ? BigInt(process.env.LAUNCH_FEE_WEI) : null;
  let curveLaunchFeeWei = process.env.CURVE_LAUNCH_FEE_WEI ? BigInt(process.env.CURVE_LAUNCH_FEE_WEI) : null;
  if (deployFeeWei == null || launchFeeWei == null || curveLaunchFeeWei == null) {
    const ethUsdPrice = await fetchEthUsdPrice();
    if (ethUsdPrice != null) {
      console.log(
        `Live ETH price: $${ethUsdPrice} — converting $${DEPLOY_FEE_USD}/$${LAUNCH_FEE_USD}/$${CURVE_LAUNCH_FEE_USD} ` +
          "fee targets to wei."
      );
      if (deployFeeWei == null) deployFeeWei = hre.ethers.parseEther((DEPLOY_FEE_USD / ethUsdPrice).toFixed(18));
      if (launchFeeWei == null) launchFeeWei = hre.ethers.parseEther((LAUNCH_FEE_USD / ethUsdPrice).toFixed(18));
      if (curveLaunchFeeWei == null)
        curveLaunchFeeWei = hre.ethers.parseEther((CURVE_LAUNCH_FEE_USD / ethUsdPrice).toFixed(18));
    } else {
      console.log("Couldn't fetch a live ETH price — falling back to a rough $3000/ETH estimate for the initial fee. " +
        "Update it for real once deployed: factory.setDeployFee()/setLaunchFee()/setCurveLaunchFee() (see scripts/updateFees.js).");
      const FALLBACK_ETH_USD = 3000;
      if (deployFeeWei == null) deployFeeWei = hre.ethers.parseEther((DEPLOY_FEE_USD / FALLBACK_ETH_USD).toFixed(18));
      if (launchFeeWei == null) launchFeeWei = hre.ethers.parseEther((LAUNCH_FEE_USD / FALLBACK_ETH_USD).toFixed(18));
      if (curveLaunchFeeWei == null)
        curveLaunchFeeWei = hre.ethers.parseEther((CURVE_LAUNCH_FEE_USD / FALLBACK_ETH_USD).toFixed(18));
    }
  }
  const lpLockDurationSeconds = process.env.LP_LOCK_DURATION_SECONDS || 15 * 24 * 60 * 60; // 15 days
  const platformFeeWallet = process.env.PLATFORM_FEE_WALLET_ADDRESS || deployer.address;
  const isLocal = network === "hardhat" || network === "localhost";

  let routerAddress = process.env.DEX_ROUTER_ADDRESS || KNOWN_ROUTER_ADDRESSES[network];
  if (routerAddress && !process.env.DEX_ROUTER_ADDRESS) {
    console.log(`Using confirmed Uniswap V2 Router02 for ${network}: ${routerAddress}`);
  }
  let priceFeedAddress = process.env.PRICE_FEED_ADDRESS || KNOWN_PRICE_FEED_ADDRESSES[network];
  if (priceFeedAddress && !process.env.PRICE_FEED_ADDRESS) {
    console.log(`Using confirmed Chainlink ETH/USD feed for ${network}: ${priceFeedAddress}`);
  }

  if (!routerAddress) {
    if (isLocal) {
      console.log("No DEX_ROUTER_ADDRESS set — deploying MockRouter for local testing only.");
      const MockERC20 = await hre.ethers.getContractFactory("MockERC20");
      const mockWeth = await MockERC20.deploy("Mock Wrapped ETH", "mWETH", hre.ethers.parseEther("1000000"));
      await mockWeth.waitForDeployment();

      const MockRouter = await hre.ethers.getContractFactory("MockRouter");
      const mockRouter = await MockRouter.deploy(await mockWeth.getAddress());
      await mockRouter.waitForDeployment();
      routerAddress = await mockRouter.getAddress();
      console.log(`MockRouter deployed at ${routerAddress}`);
    } else {
      throw new Error(
        "DEX_ROUTER_ADDRESS is not set. Refusing to deploy to a real network without a real, " +
          "verified DEX router address for Robinhood Chain. Set it in your .env and re-run."
      );
    }
  }

  if (!priceFeedAddress) {
    if (isLocal) {
      console.log("No PRICE_FEED_ADDRESS set — deploying MockAggregatorV3 (fixed at $3000/ETH) for local testing only.");
      const MockAggregatorV3 = await hre.ethers.getContractFactory("MockAggregatorV3");
      // 8 decimals, matching typical Chainlink USD feeds: 3000.00000000
      const mockFeed = await MockAggregatorV3.deploy(8, 3000n * 10n ** 8n);
      await mockFeed.waitForDeployment();
      priceFeedAddress = await mockFeed.getAddress();
      console.log(`MockAggregatorV3 deployed at ${priceFeedAddress}`);
    } else {
      throw new Error(
        "PRICE_FEED_ADDRESS is not set and no confirmed default exists for this network. Refusing to " +
          "deploy without a real ETH/USD price feed address — the transfer-tax's graduation check " +
          "depends on it. A confirmed feed exists for robinhoodMainnet (see KNOWN_PRICE_FEED_ADDRESSES " +
          "above); for testnet, copy the current ETH/USD Standard Proxy address from " +
          "https://docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood (it's JS-rendered, " +
          "so open it in a real browser), set PRICE_FEED_ADDRESS in your .env, and re-run."
      );
    }
  }

  // Live on-chain sanity check, independent of any web-sourced address:
  // whatever DEX_ROUTER_ADDRESS resolved to, confirm it actually behaves
  // like a Uniswap V2 router by calling its own factory() view function,
  // and — where a confirmed factory address exists for this network — that
  // it reports the expected one. This catches a wrong/stale address before
  // any gas gets spent deploying real infrastructure against it, rather
  // than trusting a hardcoded or user-supplied value on faith.
  if (!isLocal && routerAddress) {
    let onChainFactory;
    try {
      const router = new hre.ethers.Contract(routerAddress, ["function factory() view returns (address)"], deployer);
      onChainFactory = await router.factory();
    } catch (err) {
      throw new Error(
        `DEX_ROUTER_ADDRESS (${routerAddress}) does not behave like a Uniswap V2 router — calling ` +
          `factory() failed (${err.message}). Refusing to deploy against it.`
      );
    }
    console.log(`Router at ${routerAddress} reports its factory as ${onChainFactory}.`);
    const knownFactory = KNOWN_FACTORY_ADDRESSES[network];
    if (knownFactory && onChainFactory.toLowerCase() !== knownFactory.toLowerCase()) {
      throw new Error(
        `Router at ${routerAddress} reports factory ${onChainFactory}, which does not match the ` +
          `independently confirmed Uniswap V2 Factory for ${network} (${knownFactory}). Refusing to ` +
          "continue — double-check DEX_ROUTER_ADDRESS before retrying."
      );
    }
  }

  // Same idea for the price feed: confirm whatever PRICE_FEED_ADDRESS
  // resolved to actually behaves like a Chainlink AggregatorV3Interface feed
  // (decimals() returns a plausible value, latestRoundData() returns a
  // positive, non-stale answer) before trusting it for the tax's graduation
  // check. This doesn't prove it's the *right* feed — only a browser-verified
  // read of Chainlink's own directory can do that — but it catches a
  // mistyped or dead address before any gas is spent.
  if (!isLocal && priceFeedAddress) {
    try {
      const feed = new hre.ethers.Contract(
        priceFeedAddress,
        [
          "function decimals() view returns (uint8)",
          "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
        ],
        deployer
      );
      const feedDecimals = await feed.decimals();
      const [, answer, , updatedAt] = await feed.latestRoundData();
      if (answer <= 0n) {
        throw new Error(`latestRoundData() returned a non-positive answer (${answer})`);
      }
      const ageSeconds = Math.floor(Date.now() / 1000) - Number(updatedAt);
      console.log(
        `Price feed at ${priceFeedAddress} reports ${feedDecimals} decimals, ` +
          `answer ${answer}, last updated ${ageSeconds}s ago.`
      );
      if (ageSeconds > 24 * 60 * 60) {
        console.log(
          "Warning: that feed's last update is over 24h old — double-check this is the address " +
            "you intended before relying on it in production."
        );
      }
    } catch (err) {
      throw new Error(
        `PRICE_FEED_ADDRESS (${priceFeedAddress}) does not behave like a Chainlink AggregatorV3Interface ` +
          `feed (${err.message}). Refusing to deploy against it.`
      );
    }
  }

  const LaunchedToken = await hre.ethers.getContractFactory("LaunchedToken");
  const tokenImplementation = await LaunchedToken.deploy();
  await tokenImplementation.waitForDeployment();
  console.log(`LaunchedToken implementation deployed at ${await tokenImplementation.getAddress()}`);
  // Real, unique bytecode (not a clone target reached the normal way, since
  // every LAUNCHED token's own bytecode is just the ~45-byte EIP-1167 proxy
  // pointing at this address) -- this is the address explorers and holders
  // actually need verified source for. Was never verified by any earlier
  // version of this script; fixed here rather than left as a standing gap.
  const tokenImplementationVerification = await verifyContract(await tokenImplementation.getAddress(), []);

  const LiquidityLocker = await hre.ethers.getContractFactory("LiquidityLocker");
  const locker = await LiquidityLocker.deploy();
  await locker.waitForDeployment();
  console.log(`LiquidityLocker deployed at ${await locker.getAddress()}`);
  const lockerVerification = await verifyContract(await locker.getAddress(), []);

  const tokenFactoryConstructorArgs = [
    await tokenImplementation.getAddress(),
    routerAddress,
    await locker.getAddress(),
    deployFeeWei,
    launchFeeWei,
    feeTreasury,
    lpLockDurationSeconds,
    platformFeeWallet,
    priceFeedAddress,
  ];
  const TokenFactory = await hre.ethers.getContractFactory("TokenFactory");
  const factory = await TokenFactory.deploy(...tokenFactoryConstructorArgs);
  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log(`TokenFactory deployed at ${factoryAddress}`);

  const setFactoryTx = await locker.setFactory(factoryAddress);
  await setFactoryTx.wait();
  console.log("LiquidityLocker wired to TokenFactory.");

  // TokenFactory has real, unique bytecode (it's not a clone of anything),
  // so it gets normal source verification, exactly like the shared
  // LaunchedToken implementation does. This is the contract creators and
  // holders actually look up on the explorer to confirm platform terms
  // (fees, tax defaults, admin controls) — worth getting verified the
  // moment it exists, not just whenever the first token happens to launch.
  const tokenFactoryVerification = await verifyContract(factoryAddress, tokenFactoryConstructorArgs);

  // ---- CustomTokenFactory: the "advanced" launch path (creator-configured
  // reflections/marketing/liquidity/burn taxes). Uses its own
  // LiquidityLocker instance — a locker only ever accepts lock() calls
  // from the one factory address it's wired to (see LiquidityLocker.sol),
  // so TokenFactory's locker above can't be shared with it. Reuses the
  // same router/price feed/fee treasury/platform fee wallet and the same
  // deployFeeWei/launchFeeWei this script already computed above; retune
  // them independently later via CustomTokenFactory's own
  // setDeployFee()/setLaunchFee() if the two paths should ever diverge.
  const CustomToken = await hre.ethers.getContractFactory("CustomToken");
  const customTokenImplementation = await CustomToken.deploy();
  await customTokenImplementation.waitForDeployment();
  console.log(`CustomToken implementation deployed at ${await customTokenImplementation.getAddress()}`);
  const customTokenImplementationVerification = await verifyContract(await customTokenImplementation.getAddress(), []);

  const customLocker = await LiquidityLocker.deploy();
  await customLocker.waitForDeployment();
  console.log(`LiquidityLocker (custom) deployed at ${await customLocker.getAddress()}`);
  const customLockerVerification = await verifyContract(await customLocker.getAddress(), []);

  const customTokenFactoryConstructorArgs = [
    await customTokenImplementation.getAddress(),
    routerAddress,
    await customLocker.getAddress(),
    deployFeeWei,
    launchFeeWei,
    feeTreasury,
    lpLockDurationSeconds,
    platformFeeWallet,
    priceFeedAddress,
  ];
  const CustomTokenFactory = await hre.ethers.getContractFactory("CustomTokenFactory");
  const customFactory = await CustomTokenFactory.deploy(...customTokenFactoryConstructorArgs);
  await customFactory.waitForDeployment();
  const customFactoryAddress = await customFactory.getAddress();
  console.log(`CustomTokenFactory deployed at ${customFactoryAddress}`);

  const setCustomFactoryTx = await customLocker.setFactory(customFactoryAddress);
  await setCustomFactoryTx.wait();
  console.log("LiquidityLocker (custom) wired to CustomTokenFactory.");

  // Same reasoning as TokenFactory above — real, unique bytecode, worth
  // verifying right away rather than waiting on the first custom launch.
  const customTokenFactoryVerification = await verifyContract(customFactoryAddress, customTokenFactoryConstructorArgs);

  // ---- BondingCurveFactory: the zero-tax bonding-curve launch mode (5th
  // mode — deploy first, trade against an internal curve, graduate to a
  // real DEX pool once poolSeedTargetWei is crossed). Reuses the SAME
  // LaunchedToken implementation TokenFactory clones above — the
  // implementation contract itself can never be initialized directly (see
  // LaunchedToken's own guard, and its "cannot be initialized twice" test),
  // so sharing one implementation across every factory that clones
  // LaunchedToken is safe, and avoids deploying + verifying a redundant
  // duplicate. Still needs its OWN LiquidityLocker instance though —
  // LiquidityLocker.setFactory() is a permanent, one-time wiring, so it can
  // never be shared with TokenFactory's locker above.
  const bondingCurveLocker = await LiquidityLocker.deploy();
  await bondingCurveLocker.waitForDeployment();
  console.log(`LiquidityLocker (bonding curve) deployed at ${await bondingCurveLocker.getAddress()}`);
  const bondingCurveLockerVerification = await verifyContract(await bondingCurveLocker.getAddress(), []);

  // curveLaunchFee: flat fee to create a curve token, priced at its own
  // $25 target (CURVE_LAUNCH_FEE_USD above) — computed from the live ETH
  // price alongside deployFeeWei/launchFeeWei earlier in this script.
  // Shared by both bonding-curve factories below.
  const bondingCurveFactoryConstructorArgs = [
    await tokenImplementation.getAddress(),
    routerAddress,
    await bondingCurveLocker.getAddress(),
    curveLaunchFeeWei,
    feeTreasury,
    lpLockDurationSeconds,
    platformFeeWallet,
    priceFeedAddress,
  ];
  const BondingCurveFactory = await hre.ethers.getContractFactory("BondingCurveFactory");
  const bondingCurveFactory = await BondingCurveFactory.deploy(...bondingCurveFactoryConstructorArgs);
  await bondingCurveFactory.waitForDeployment();
  const bondingCurveFactoryAddress = await bondingCurveFactory.getAddress();
  console.log(`BondingCurveFactory deployed at ${bondingCurveFactoryAddress}`);

  const setBondingCurveFactoryTx = await bondingCurveLocker.setFactory(bondingCurveFactoryAddress);
  await setBondingCurveFactoryTx.wait();
  console.log("LiquidityLocker (bonding curve) wired to BondingCurveFactory.");

  // poolSeedTargetWei defaults to 1.5 ETH in the contract itself — only
  // touched here if POOL_SEED_TARGET_WEI is explicitly set. Applied to both
  // bonding curve factories identically (see CustomBondingCurveFactory
  // below), so "how much real ETH graduates a curve" means the same thing
  // regardless of which curve variant a creator picks.
  if (process.env.POOL_SEED_TARGET_WEI) {
    const poolSeedTargetWei = BigInt(process.env.POOL_SEED_TARGET_WEI);
    const setPoolSeedTx = await bondingCurveFactory.setPoolSeedTargetWei(poolSeedTargetWei);
    await setPoolSeedTx.wait();
    console.log(`BondingCurveFactory.poolSeedTargetWei set to ${poolSeedTargetWei} wei.`);
  }

  const bondingCurveFactoryVerification = await verifyContract(
    bondingCurveFactoryAddress,
    bondingCurveFactoryConstructorArgs
  );

  // ---- CustomBondingCurveFactory: the creator-configurable-tax bonding-
  // curve variant (custom tax equivalent of the mode above). Reuses the SAME
  // CustomToken implementation CustomTokenFactory clones above, for the
  // identical sharing-is-safe reason, and gets its own third LiquidityLocker
  // instance, for the identical one-locker-per-factory reason.
  const customBondingCurveLocker = await LiquidityLocker.deploy();
  await customBondingCurveLocker.waitForDeployment();
  console.log(`LiquidityLocker (custom bonding curve) deployed at ${await customBondingCurveLocker.getAddress()}`);
  const customBondingCurveLockerVerification = await verifyContract(await customBondingCurveLocker.getAddress(), []);

  const customBondingCurveFactoryConstructorArgs = [
    await customTokenImplementation.getAddress(),
    routerAddress,
    await customBondingCurveLocker.getAddress(),
    curveLaunchFeeWei,
    feeTreasury,
    lpLockDurationSeconds,
    platformFeeWallet,
    priceFeedAddress,
  ];
  const CustomBondingCurveFactory = await hre.ethers.getContractFactory("CustomBondingCurveFactory");
  const customBondingCurveFactory = await CustomBondingCurveFactory.deploy(...customBondingCurveFactoryConstructorArgs);
  await customBondingCurveFactory.waitForDeployment();
  const customBondingCurveFactoryAddress = await customBondingCurveFactory.getAddress();
  console.log(`CustomBondingCurveFactory deployed at ${customBondingCurveFactoryAddress}`);

  const setCustomBondingCurveFactoryTx = await customBondingCurveLocker.setFactory(customBondingCurveFactoryAddress);
  await setCustomBondingCurveFactoryTx.wait();
  console.log("LiquidityLocker (custom bonding curve) wired to CustomBondingCurveFactory.");

  if (process.env.POOL_SEED_TARGET_WEI) {
    const poolSeedTargetWei = BigInt(process.env.POOL_SEED_TARGET_WEI);
    const setCustomPoolSeedTx = await customBondingCurveFactory.setPoolSeedTargetWei(poolSeedTargetWei);
    await setCustomPoolSeedTx.wait();
    console.log(`CustomBondingCurveFactory.poolSeedTargetWei set to ${poolSeedTargetWei} wei.`);
  }

  const customBondingCurveFactoryVerification = await verifyContract(
    customBondingCurveFactoryAddress,
    customBondingCurveFactoryConstructorArgs
  );

  // ---- Platform rewards (buyback/burn/holder-airdrop) — entirely
  // optional, and off by default. Leaving DEPLOY_PLATFORM_TOKEN unset
  // deploys everything above exactly as it's always behaved:
  // rewardsDistributor stays unset on both factories, so deployFee/
  // launchFee revenue and the ongoing trading tax are both 100% unchanged
  // from before this feature existed.
  //
  // Set DEPLOY_PLATFORM_TOKEN=true only once — whenever the platform's own
  // token actually launches "in conjunction with the launch of the
  // platform" (the owner's own words) — to deploy PlatformToken and
  // PlatformRewardsDistributor and wire the distributor into both
  // factories. REWARDS_DISTRIBUTOR_ADDRESS lets a LATER run of this
  // script (e.g. redeploying just the factories) point at an
  // already-deployed distributor instead of deploying a second one.
  let rewardsDistributorAddress = process.env.REWARDS_DISTRIBUTOR_ADDRESS || null;
  let platformTokenAddress = process.env.PLATFORM_TOKEN_ADDRESS || null;
  let platformTokenVerified = null;
  let rewardsDistributorVerified = null;

  if (!rewardsDistributorAddress && process.env.DEPLOY_PLATFORM_TOKEN === "true") {
    const rewardsDistributorOwner = process.env.REWARDS_DISTRIBUTOR_OWNER_ADDRESS || deployer.address;

    if (!platformTokenAddress) {
      const platformTokenName = process.env.PLATFORM_TOKEN_NAME || "Hood Launch";
      const platformTokenSymbol = process.env.PLATFORM_TOKEN_SYMBOL || "HOOD";
      const platformTokenSupply = hre.ethers.parseEther(process.env.PLATFORM_TOKEN_SUPPLY || "1000000000"); // 1B, 18 decimals, by default
      const platformTokenInitialHolder = process.env.PLATFORM_TOKEN_INITIAL_HOLDER || deployer.address;
      const platformTokenConstructorArgs = [
        platformTokenName,
        platformTokenSymbol,
        platformTokenSupply,
        platformTokenInitialHolder,
      ];

      const PlatformToken = await hre.ethers.getContractFactory("PlatformToken");
      const platformToken = await PlatformToken.deploy(...platformTokenConstructorArgs);
      await platformToken.waitForDeployment();
      platformTokenAddress = await platformToken.getAddress();
      console.log(
        `PlatformToken (${platformTokenName} / ${platformTokenSymbol}) deployed at ${platformTokenAddress}, ` +
          `full supply minted to ${platformTokenInitialHolder}. Seeding its own DEX pool and adding real ` +
          "liquidity is a separate, later step from this deployment."
      );

      // Real, unique bytecode — never verified by any earlier version of
      // this script. Fixed here.
      const platformTokenVerification = await verifyContract(platformTokenAddress, platformTokenConstructorArgs);
      platformTokenVerified = platformTokenVerification.verified;
    } else {
      console.log(`Reusing already-deployed PlatformToken at ${platformTokenAddress}.`);
    }

    const rewardsDistributorConstructorArgs = [routerAddress, rewardsDistributorOwner];
    const PlatformRewardsDistributor = await hre.ethers.getContractFactory("PlatformRewardsDistributor");
    const distributor = await PlatformRewardsDistributor.deploy(...rewardsDistributorConstructorArgs);
    await distributor.waitForDeployment();
    rewardsDistributorAddress = await distributor.getAddress();
    console.log(`PlatformRewardsDistributor deployed at ${rewardsDistributorAddress}, owned by ${rewardsDistributorOwner}.`);

    // Real, unique bytecode — never verified by any earlier version of this
    // script. Fixed here.
    const rewardsDistributorVerification = await verifyContract(
      rewardsDistributorAddress,
      rewardsDistributorConstructorArgs
    );
    rewardsDistributorVerified = rewardsDistributorVerification.verified;

    const setPlatformTokenTx = await distributor.connect(deployer).setPlatformToken(platformTokenAddress);
    await setPlatformTokenTx.wait();
    console.log(`PlatformRewardsDistributor.setPlatformToken(${platformTokenAddress}) confirmed.`);
    if (rewardsDistributorOwner.toLowerCase() !== deployer.address.toLowerCase()) {
      console.log(
        "Note: REWARDS_DISTRIBUTOR_OWNER_ADDRESS differs from the deploying account — setPlatformToken() " +
          "above was still sent by the deployer, which only works because ownership hadn't transferred yet " +
          "at the moment of deployment. Any further admin calls (thresholds, a future platformToken change) " +
          "must come from the owner address itself."
      );
    }
  } else if (rewardsDistributorAddress) {
    console.log(`Reusing already-deployed PlatformRewardsDistributor at ${rewardsDistributorAddress}.`);
  }

  if (rewardsDistributorAddress) {
    const setRewardsTx1 = await factory.setRewardsDistributor(rewardsDistributorAddress);
    await setRewardsTx1.wait();
    const setRewardsTx2 = await customFactory.setRewardsDistributor(rewardsDistributorAddress);
    await setRewardsTx2.wait();
    const setRewardsTx3 = await bondingCurveFactory.setRewardsDistributor(rewardsDistributorAddress);
    await setRewardsTx3.wait();
    const setRewardsTx4 = await customBondingCurveFactory.setRewardsDistributor(rewardsDistributorAddress);
    await setRewardsTx4.wait();
    console.log(
      "TokenFactory, CustomTokenFactory, BondingCurveFactory, and CustomBondingCurveFactory all wired to " +
        `PlatformRewardsDistributor at ${rewardsDistributorAddress}.`
    );
  }

  // ---- Creator rewards (per-token ETH, claimable by the token's own
  // creator) — ALWAYS deployed and wired into all four factories as of this
  // version of the script. This used to be gated behind
  // DEPLOY_CREATOR_REWARDS=true and off by default; that exact opt-in flag
  // is what let creatorRewardBps sit silently inactive on every token
  // launched after the Sept 2026 redeploy until someone noticed and patched
  // it in after the fact (see scripts/setCreatorRewardsDistributor.js's own
  // comment for that incident). Making this unconditional removes the
  // "forgot to flip the flag" failure mode entirely. Set
  // CREATOR_REWARDS_DISTRIBUTOR_ADDRESS to reuse an already-deployed
  // instance instead of deploying a new one (e.g. when redeploying just the
  // factories). Unlike PlatformRewardsDistributor, this one pools nothing
  // across holders — it swaps each token's own accumulated cut for ETH and
  // lets that token's creator claim it individually, so it needs no
  // PlatformToken reference and no separate "seed a token" step.
  let creatorRewardsDistributorAddress = process.env.CREATOR_REWARDS_DISTRIBUTOR_ADDRESS || null;
  let creatorRewardsDistributorVerified = null;

  if (!creatorRewardsDistributorAddress) {
    const creatorRewardsDistributorOwner = process.env.CREATOR_REWARDS_DISTRIBUTOR_OWNER_ADDRESS || deployer.address;
    const creatorRewardsDistributorConstructorArgs = [routerAddress, creatorRewardsDistributorOwner];

    const CreatorRewardsDistributor = await hre.ethers.getContractFactory("CreatorRewardsDistributor");
    const creatorDistributor = await CreatorRewardsDistributor.deploy(...creatorRewardsDistributorConstructorArgs);
    await creatorDistributor.waitForDeployment();
    creatorRewardsDistributorAddress = await creatorDistributor.getAddress();
    console.log(
      `CreatorRewardsDistributor deployed at ${creatorRewardsDistributorAddress}, owned by ${creatorRewardsDistributorOwner}.`
    );

    // Real, unique bytecode — never verified by any earlier version of this
    // script even when DEPLOY_CREATOR_REWARDS=true was set. Fixed here.
    const creatorRewardsDistributorVerification = await verifyContract(
      creatorRewardsDistributorAddress,
      creatorRewardsDistributorConstructorArgs
    );
    creatorRewardsDistributorVerified = creatorRewardsDistributorVerification.verified;
  } else {
    console.log(`Reusing already-deployed CreatorRewardsDistributor at ${creatorRewardsDistributorAddress}.`);
  }

  const setCreatorRewardsTx1 = await factory.setCreatorRewardsDistributor(creatorRewardsDistributorAddress);
  await setCreatorRewardsTx1.wait();
  const setCreatorRewardsTx2 = await customFactory.setCreatorRewardsDistributor(creatorRewardsDistributorAddress);
  await setCreatorRewardsTx2.wait();
  const setCreatorRewardsTx3 = await bondingCurveFactory.setCreatorRewardsDistributor(creatorRewardsDistributorAddress);
  await setCreatorRewardsTx3.wait();
  const setCreatorRewardsTx4 = await customBondingCurveFactory.setCreatorRewardsDistributor(
    creatorRewardsDistributorAddress
  );
  await setCreatorRewardsTx4.wait();
  console.log(
    "TokenFactory, CustomTokenFactory, BondingCurveFactory, and CustomBondingCurveFactory all wired to " +
      `CreatorRewardsDistributor at ${creatorRewardsDistributorAddress}.`
  );

  // ---- Fee-wallet distributor (the platform's own trading-tax remainder —
  // whatever's left of feeBps after rewardBps/creatorRewardBps are carved
  // out — converted to ETH automatically instead of sitting as whatever
  // token it was taxed in) — ALWAYS deployed and wired into all four
  // factories as of this version of the script, for the same reason as
  // CreatorRewardsDistributor above: this used to require
  // DEPLOY_FEE_WALLET_DISTRIBUTOR=true (added after the fact, with no
  // opt-in path at all before that — wiring it onto an already-deployed
  // factory required a manual admin-panel action or a one-off script, and
  // neither happened), which is the exact "silently off until wired" trap
  // that left creatorRewardsDistributor unset on every token launched after
  // the Sept 2026 redeploy (see scripts/setCreatorRewardsDistributor.js's
  // own comment for that incident). Making this unconditional removes that
  // failure mode entirely — every taxed transfer's fee-wallet remainder now
  // always routes through FeeWalletDistributor rather than the plain
  // platformFeeWallet address (see LaunchedToken._update / CustomToken.
  // _update: `super._update(from, feeWalletDistributor != address(0) ?
  // feeWalletDistributor : feeWallet, toFeeWallet)`). Set
  // FEE_WALLET_DISTRIBUTOR_ADDRESS to reuse an already-deployed instance
  // instead of deploying a new one (e.g. when redeploying just the
  // factories with an existing FeeWalletDistributor already live).
  let feeWalletDistributorAddress = process.env.FEE_WALLET_DISTRIBUTOR_ADDRESS || null;
  let feeWalletDistributorVerified = null;

  if (!feeWalletDistributorAddress) {
    const feeWalletDistributorOwner = process.env.FEE_WALLET_DISTRIBUTOR_OWNER_ADDRESS || deployer.address;
    // Defaults to the same platformFeeWallet this deploy already resolved
    // above — almost always what you want FeeWalletDistributor.feeWallet to
    // match, since it's replacing that exact address as the fee-wallet
    // remainder's destination. Override with FEE_WALLET_ADDRESS if the
    // eventual ETH recipient should differ from the plain-token fallback
    // wallet.
    const feeWalletRecipient = process.env.FEE_WALLET_ADDRESS || platformFeeWallet;
    const feeWalletDistributorConstructorArgs = [routerAddress, feeWalletDistributorOwner, feeWalletRecipient];

    const FeeWalletDistributor = await hre.ethers.getContractFactory("FeeWalletDistributor");
    const feeWalletDistributor = await FeeWalletDistributor.deploy(...feeWalletDistributorConstructorArgs);
    await feeWalletDistributor.waitForDeployment();
    feeWalletDistributorAddress = await feeWalletDistributor.getAddress();
    console.log(
      `FeeWalletDistributor deployed at ${feeWalletDistributorAddress}, owned by ${feeWalletDistributorOwner}, ` +
        `paying out to ${feeWalletRecipient}.`
    );

    // Real, unique bytecode — never verified by any earlier version of this
    // script even when DEPLOY_FEE_WALLET_DISTRIBUTOR=true was set. Fixed here.
    const feeWalletDistributorVerification = await verifyContract(
      feeWalletDistributorAddress,
      feeWalletDistributorConstructorArgs
    );
    feeWalletDistributorVerified = feeWalletDistributorVerification.verified;
  } else {
    console.log(`Reusing already-deployed FeeWalletDistributor at ${feeWalletDistributorAddress}.`);
  }

  const setFeeWalletDistributorTx1 = await factory.setFeeWalletDistributor(feeWalletDistributorAddress);
  await setFeeWalletDistributorTx1.wait();
  const setFeeWalletDistributorTx2 = await customFactory.setFeeWalletDistributor(feeWalletDistributorAddress);
  await setFeeWalletDistributorTx2.wait();
  const setFeeWalletDistributorTx3 = await bondingCurveFactory.setFeeWalletDistributor(feeWalletDistributorAddress);
  await setFeeWalletDistributorTx3.wait();
  const setFeeWalletDistributorTx4 = await customBondingCurveFactory.setFeeWalletDistributor(
    feeWalletDistributorAddress
  );
  await setFeeWalletDistributorTx4.wait();
  console.log(
    "TokenFactory, CustomTokenFactory, BondingCurveFactory, and CustomBondingCurveFactory all wired to " +
      `FeeWalletDistributor at ${feeWalletDistributorAddress}.`
  );

  // ---- Platform Tax Distributor — a fully STANDALONE contract, entirely
  // independent of the HoodLaunch platform itself. This is NOT one of the
  // platform's own reward/fee distributors above (PlatformRewardsDistributor/
  // CreatorRewardsDistributor/FeeWalletDistributor): it exists only because
  // the front end's own trading UI (public/index.html) collects an
  // additional 0.30% tax on buys/sells made through this platform's trade
  // panels and forwards it here — no HoodLaunch contract (LaunchedToken,
  // CustomToken, TokenFactory, CustomTokenFactory, BondingCurveFactory,
  // CustomBondingCurveFactory) has been modified for this, and none of them
  // reference this contract's address. Per explicit instruction, this
  // contract is "not associated with the platform and controlled by the
  // deployer wallet" — it is deployed and verified by this script purely as
  // a convenience (same deployer wallet, same run, same script), but unlike
  // the three distributors above it is NEVER wired into any factory's
  // setRewardsDistributor/setCreatorRewardsDistributor/
  // setFeeWalletDistributor, and its ownership is not parameterized by a
  // *_OWNER_ADDRESS env var the way theirs is — it is always owned by
  // whichever account runs this script (Ownable2Step, so the deployer can
  // transfer it later, entirely outside of this script or the platform's
  // own admin panel). Leaving DEPLOY_PLATFORM_TAX_DISTRIBUTOR unset deploys
  // nothing here and changes nothing else in this script.
  let platformTaxDistributorAddress = process.env.PLATFORM_TAX_DISTRIBUTOR_ADDRESS || null;
  let platformTaxDistributorVerified = null;

  if (!platformTaxDistributorAddress && process.env.DEPLOY_PLATFORM_TAX_DISTRIBUTOR === "true") {
    // The platform token to buy back on distribution — defaults to whatever
    // this run already resolved for PlatformToken above (platformTokenAddress,
    // set only when DEPLOY_PLATFORM_TOKEN=true or PLATFORM_TOKEN_ADDRESS was
    // provided), since in practice this will almost always be the same
    // token. Override with PLATFORM_TAX_DISTRIBUTOR_TOKEN_ADDRESS if this
    // distributor should target a different token.
    const platformTaxDistributorTokenAddress =
      process.env.PLATFORM_TAX_DISTRIBUTOR_TOKEN_ADDRESS || platformTokenAddress;
    if (!platformTaxDistributorTokenAddress) {
      throw new Error(
        "DEPLOY_PLATFORM_TAX_DISTRIBUTOR=true but no platform token address is available. Set " +
          "PLATFORM_TAX_DISTRIBUTOR_TOKEN_ADDRESS explicitly, or run with DEPLOY_PLATFORM_TOKEN=true / " +
          "PLATFORM_TOKEN_ADDRESS set so one exists to pass in."
      );
    }
    // Fee-wallet half of the 50/50 split — independent of the platform's own
    // platformFeeWallet/FEE_WALLET_ADDRESS above (this is a separate,
    // standalone contract with its own fee-wallet concept, owner-changeable
    // later via setFeeWallet()), but falls back to the same platformFeeWallet
    // if nothing more specific is set, purely for convenience.
    const platformTaxDistributorFeeWallet =
      process.env.PLATFORM_TAX_DISTRIBUTOR_FEE_WALLET_ADDRESS || platformFeeWallet;

    const platformTaxDistributorConstructorArgs = [
      routerAddress,
      platformTaxDistributorTokenAddress,
      platformTaxDistributorFeeWallet,
    ];
    const PlatformTaxDistributor = await hre.ethers.getContractFactory("PlatformTaxDistributor");
    const platformTaxDistributor = await PlatformTaxDistributor.deploy(...platformTaxDistributorConstructorArgs);
    await platformTaxDistributor.waitForDeployment();
    platformTaxDistributorAddress = await platformTaxDistributor.getAddress();
    console.log(
      `PlatformTaxDistributor deployed at ${platformTaxDistributorAddress}, owned by ${deployer.address} ` +
        "(standalone — not wired into any HoodLaunch factory or the admin/relayer config), platform token " +
        `${platformTaxDistributorTokenAddress}, fee wallet ${platformTaxDistributorFeeWallet}, disburse ` +
        "threshold 0.25 ETH (contract default)."
    );

    // Real, unique bytecode (not a clone of anything) — verified here
    // because it's requested explicitly, unlike PlatformRewardsDistributor/
    // CreatorRewardsDistributor/FeeWalletDistributor above, which this
    // script has never verified.
    const platformTaxDistributorVerification = await verifyContract(
      platformTaxDistributorAddress,
      platformTaxDistributorConstructorArgs
    );
    platformTaxDistributorVerified = platformTaxDistributorVerification.verified;
    console.log(
      "Remember: this address still needs to be filled into PLATFORM_TAX_DISTRIBUTOR in public/index.html " +
        "(per network) before the front end's trade panels will actually forward tax payments to it."
    );
  } else if (platformTaxDistributorAddress) {
    console.log(`Reusing already-deployed PlatformTaxDistributor at ${platformTaxDistributorAddress}.`);
  }

  const deploymentSummary = {
    tokenImplementation: await tokenImplementation.getAddress(),
    tokenImplementationVerified: tokenImplementationVerification.verified,
    liquidityLocker: await locker.getAddress(),
    liquidityLockerVerified: lockerVerification.verified,
    tokenFactory: factoryAddress,
    tokenFactoryVerified: tokenFactoryVerification.verified,
    customTokenImplementation: await customTokenImplementation.getAddress(),
    customTokenImplementationVerified: customTokenImplementationVerification.verified,
    customLiquidityLocker: await customLocker.getAddress(),
    customLiquidityLockerVerified: customLockerVerification.verified,
    customTokenFactory: customFactoryAddress,
    customTokenFactoryVerified: customTokenFactoryVerification.verified,
    // Bonding-curve launch modes (5th mode + its custom-tax variant) — both
    // reuse the LaunchedToken/CustomToken implementations verified above,
    // so there's nothing further to verify there; each gets its own
    // LiquidityLocker instance, verified independently.
    bondingCurveLiquidityLocker: await bondingCurveLocker.getAddress(),
    bondingCurveLiquidityLockerVerified: bondingCurveLockerVerification.verified,
    bondingCurveFactory: bondingCurveFactoryAddress,
    bondingCurveFactoryVerified: bondingCurveFactoryVerification.verified,
    customBondingCurveLiquidityLocker: await customBondingCurveLocker.getAddress(),
    customBondingCurveLiquidityLockerVerified: customBondingCurveLockerVerification.verified,
    customBondingCurveFactory: customBondingCurveFactoryAddress,
    customBondingCurveFactoryVerified: customBondingCurveFactoryVerification.verified,
    curveLaunchFeeWei: curveLaunchFeeWei.toString(),
    router: routerAddress,
    priceFeed: priceFeedAddress,
    deployFeeWei: deployFeeWei.toString(),
    launchFeeWei: launchFeeWei.toString(),
    lpLockDurationSeconds: lpLockDurationSeconds.toString(),
    feeTreasury,
    platformFeeWallet,
    platformToken: platformTokenAddress || "(not deployed — set DEPLOY_PLATFORM_TOKEN=true to launch it)",
    platformTokenVerified,
    rewardsDistributor: rewardsDistributorAddress || "(not deployed — factories keep their pre-existing behavior)",
    rewardsDistributorVerified,
    creatorRewardsDistributor: creatorRewardsDistributorAddress,
    creatorRewardsDistributorVerified,
    feeWalletDistributor: feeWalletDistributorAddress,
    feeWalletDistributorVerified,
    // Standalone — see the big comment above this block. Deliberately NOT
    // wired into tokenFactory/customFactory/bondingCurveFactory/
    // customBondingCurveFactory the way rewardsDistributor/
    // creatorRewardsDistributor/feeWalletDistributor are above.
    platformTaxDistributor:
      platformTaxDistributorAddress ||
      "(not deployed — set DEPLOY_PLATFORM_TAX_DISTRIBUTOR=true to launch it; standalone, never wired into any factory)",
    platformTaxDistributorVerified,
  };

  console.log("\nDeployment summary:");
  console.log(deploymentSummary);

  // Persisted per network under deployments/<network>/ — see
  // lib/deploymentStore.js. This is what a later script, a .env template,
  // or the front end's network config should read to get "the addresses in
  // use right now" for this network, instead of scrolling back through
  // console output.
  const { currentPath, historyPath } = await recordDeployment(network, deploymentSummary);
  console.log(`\nRecorded deployment for network "${network}":`);
  console.log(`  current (latest for this network): ${currentPath}`);
  console.log(`  history (every run, appended):     ${historyPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});