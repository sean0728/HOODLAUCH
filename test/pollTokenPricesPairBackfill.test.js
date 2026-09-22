const { expect } = require("chai");
const { ethers } = require("hardhat");

// scripts/relayer.js's pollTokenPrices() is a private closure inside
// main() (not exported — it needs a live funded relayer wallet and real
// watchers, all bootstrapped together), so — same convention already used
// by test/relayerLaunchesEndpoint.test.js and
// test/relayerActivityAndPriceEndpoints.test.js for other routes/loops in
// this same file — this test exercises the exact backfill logic under test
// against real, deployed contracts, rather than the whole poll loop.
//
// FIX under test: pollTokenPrices' "no pairAddress yet" backfill for a
// "token"/"custom" kind tracked entry used to call
// `watcher.factory.pairOf(entry.tokenAddress)` to look for a pool. But
// TokenFactory/CustomTokenFactory's `pairOf` mapping is ONLY ever written
// from inside the atomic "Launch + Add Liquidity" codepath — a "Deploy
// Only" token's `pairOf` entry stays address(0) forever, no matter how or
// when a pool later shows up for it (including via LaunchedToken's own
// _maybeAutoActivateTax(), which sets the TOKEN's own `pair` state variable
// directly and never touches the factory at all). So the old backfill could
// never notice this transition for such a token. The fix instead queries
// the DEX factory's own getPair() directly — the same real on-chain source
// of truth the "platform" branch of pollTokenPrices and index.html's
// checkPendingLiquidity already use.
describe("pollTokenPrices' no-pairAddress backfill (on-chain DEX factory vs. TokenFactory.pairOf)", function () {
  const DEPLOY_FEE = ethers.parseEther("0.02");
  const LAUNCH_FEE = ethers.parseEther("0.04");
  const LP_LOCK_DURATION = 15 * 24 * 60 * 60;
  const TOTAL_SUPPLY = ethers.parseEther("1000000000");
  const ETH_USD_PRICE = 3000n * 10n ** 8n;
  const TOKEN_STATUS = { DEPLOYED: 0, LAUNCHED: 1, GRADUATED: 2 }; // mirrors scripts/relayer.js's TOKEN_STATUS

  // Same minimal read-only ABIs scripts/relayer.js itself uses (see
  // UNIV2_ROUTER_QUOTE_ABI / UNIV2_FACTORY_ABI there) — reused verbatim
  // here so this test calls the exact same shape of on-chain functions the
  // real fixed code does, against MockRouter acting as both router and DEX
  // factory (see contracts/mocks/MockRouter.sol: factory() returns
  // address(this), and it implements getPair()).
  const UNIV2_ROUTER_QUOTE_ABI = [
    "function WETH() view returns (address)",
    "function factory() view returns (address)",
  ];
  const UNIV2_FACTORY_ABI = ["function getPair(address tokenA, address tokenB) view returns (address pair)"];

  async function deployStack() {
    const [deployer, creator, otherAccount, treasury, platformFeeWallet] = await ethers.getSigners();

    const LaunchedToken = await ethers.getContractFactory("LaunchedToken");
    const tokenImplementation = await LaunchedToken.deploy();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const mockWeth = await MockERC20.deploy("Mock WETH", "mWETH", ethers.parseEther("1"));

    const MockRouter = await ethers.getContractFactory("MockRouter");
    const router = await MockRouter.deploy(await mockWeth.getAddress());

    const MockAggregatorV3 = await ethers.getContractFactory("MockAggregatorV3");
    const priceFeed = await MockAggregatorV3.deploy(8, ETH_USD_PRICE);

    const LiquidityLocker = await ethers.getContractFactory("LiquidityLocker");
    const locker = await LiquidityLocker.deploy();

    const TokenFactory = await ethers.getContractFactory("TokenFactory");
    const factory = await TokenFactory.deploy(
      await tokenImplementation.getAddress(),
      await router.getAddress(),
      await locker.getAddress(),
      DEPLOY_FEE,
      LAUNCH_FEE,
      treasury.address,
      LP_LOCK_DURATION,
      platformFeeWallet.address,
      await priceFeed.getAddress()
    );
    await locker.setFactory(await factory.getAddress());

    return { factory, router, mockWeth, deployer, creator, otherAccount };
  }

  async function directDeployOnlyLaunch(factory, creator, salt) {
    const tx = await factory
      .connect(creator)
      .createToken("Aurora Ledger", "AURA", TOTAL_SUPPLY, false, 0, 0, 0, salt, { value: DEPLOY_FEE });
    const receipt = await tx.wait();
    const event = receipt.logs
      .map((log) => {
        try {
          return factory.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed && parsed.name === "TokenCreated");
    const token = await ethers.getContractAt("LaunchedToken", event.args.token);
    return { token, tokenAddress: event.args.token };
  }

  // Mirrors the FIXED backfill block in pollTokenPrices exactly: resolve the
  // watcher's own router, then that router's WETH/factory, then ask the DEX
  // factory for the pair — never touches TokenFactory.pairOf.
  async function backfillPairViaDexFactory(factory, tokenAddress) {
    const routerAddress = await factory.router();
    const router = await ethers.getContractAt(UNIV2_ROUTER_QUOTE_ABI, routerAddress);
    const [wethAddress, dexFactoryAddress] = await Promise.all([router.WETH(), router.factory()]);
    const univ2Factory = await ethers.getContractAt(UNIV2_FACTORY_ABI, dexFactoryAddress);
    return univ2Factory.getPair(tokenAddress, wethAddress);
  }

  it("independently-added liquidity that auto-activates a Deploy Token's tax never shows up in TokenFactory.pairOf (reproduces the bug the old code relied on)", async function () {
    const { factory, router, creator } = await deployStack();
    const { token, tokenAddress } = await directDeployOnlyLaunch(factory, creator, 201n);

    expect(await factory.pairOf(tokenAddress)).to.equal(ethers.ZeroAddress);
    expect(await token.pair()).to.equal(ethers.ZeroAddress);
    expect(await token.taxConfigured()).to.equal(false);

    // Creator adds liquidity themselves, straight against the router —
    // entirely independent of TokenFactory, exactly like a real "add it on
    // Uniswap yourself" flow.
    await token.connect(creator).approve(await router.getAddress(), TOTAL_SUPPLY);
    await router
      .connect(creator)
      .addLiquidityETH(tokenAddress, TOTAL_SUPPLY, 0, 0, creator.address, Math.floor(Date.now() / 1000) + 3600, {
        value: ethers.parseEther("1"),
      });

    // The token auto-activated its own tax against the pool it just
    // detected mid-transfer (LaunchedToken._maybeAutoActivateTax) ...
    expect(await token.taxConfigured()).to.equal(true);
    expect(await token.pair()).to.not.equal(ethers.ZeroAddress);
    expect(await token.taxActive()).to.equal(true);
    // ... but TokenFactory itself was never involved, so its own pairOf
    // mapping never learns about it. A backfill that queries pairOf() (the
    // old, buggy code) would poll this forever and never find a pool.
    expect(await factory.pairOf(tokenAddress)).to.equal(ethers.ZeroAddress);
  });

  it("the fixed backfill (DEX factory getPair) finds the pool and matches the token's own auto-activated pair", async function () {
    const { factory, router, creator } = await deployStack();
    const { token, tokenAddress } = await directDeployOnlyLaunch(factory, creator, 202n);

    await token.connect(creator).approve(await router.getAddress(), TOTAL_SUPPLY);
    await router
      .connect(creator)
      .addLiquidityETH(tokenAddress, TOTAL_SUPPLY, 0, 0, creator.address, Math.floor(Date.now() / 1000) + 3600, {
        value: ethers.parseEther("1"),
      });

    const discoveredPair = await backfillPairViaDexFactory(factory, tokenAddress);
    expect(discoveredPair).to.not.equal(ethers.ZeroAddress);
    expect(discoveredPair.toLowerCase()).to.equal((await token.pair()).toLowerCase());

    // Same guard pollTokenPrices applies once a pair is discovered: a
    // DEPLOYED token advances to LAUNCHED (never clobbering GRADUATED).
    let tokenStatus = TOKEN_STATUS.DEPLOYED;
    if (discoveredPair !== ethers.ZeroAddress && tokenStatus !== TOKEN_STATUS.GRADUATED) {
      tokenStatus = TOKEN_STATUS.LAUNCHED;
    }
    expect(tokenStatus).to.equal(TOKEN_STATUS.LAUNCHED);

    // Also confirms the graduation check reads correctly once pairAddress
    // is backfilled: taxActive() (what pollTokenPrices reads right after
    // this same backfill, in the same tick) is true immediately after
    // auto-activation, so this never misfires straight to GRADUATED.
    expect(await token.taxActive()).to.equal(true);
    expect(await token.graduationTargetUsd()).to.be.greaterThan(0n);
  });

  it("still finds nothing for a Deploy Token that genuinely has no pool yet", async function () {
    const { factory, creator } = await deployStack();
    const { tokenAddress } = await directDeployOnlyLaunch(factory, creator, 203n);

    const discoveredPair = await backfillPairViaDexFactory(factory, tokenAddress);
    expect(discoveredPair).to.equal(ethers.ZeroAddress);
  });
});
