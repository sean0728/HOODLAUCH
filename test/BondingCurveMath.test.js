const { expect } = require("chai");
const { ethers } = require("hardhat");

// Pure-math coverage for BondingCurveFactory's constant-product pricing.
// _quoteBuy/_quoteSell are private, so these tests go through the public
// quoteBuy()/quoteSell() views on a freshly-created curve -- lightweight
// relative to BondingCurveFactory.test.js's own deployStack(), since nothing
// here needs a router, a price feed, or a locker to actually be exercised.
describe("BondingCurveFactory math", function () {
  const CURVE_LAUNCH_FEE = ethers.parseEther("0.02");
  const LP_LOCK_DURATION = 180 * 24 * 60 * 60;
  const TOTAL_SUPPLY = ethers.parseEther("1000000000");
  const ETH_USD_PRICE = 3000n * 10n ** 8n;
  const CURVE_FEE_BPS = 100n;

  function expectedBuy(virtualEth, realEth, virtualToken, tokensRemaining, ethIn, feeBps) {
    const feeAmount = (ethIn * feeBps) / 10_000n;
    const netEthIn = ethIn - feeAmount;
    const effEth = virtualEth + realEth;
    const effToken = virtualToken + tokensRemaining;
    const tokensOut = (netEthIn * effToken) / (effEth + netEthIn);
    return { feeAmount, netEthIn, tokensOut, effEth, effToken };
  }

  function expectedSell(virtualEth, realEth, virtualToken, tokensRemaining, tokenAmountIn, feeBps) {
    const effEth = virtualEth + realEth;
    const effToken = virtualToken + tokensRemaining;
    const ethOutGross = (tokenAmountIn * effEth) / (effToken + tokenAmountIn);
    const feeAmount = (ethOutGross * feeBps) / 10_000n;
    const netEthOut = ethOutGross - feeAmount;
    return { ethOutGross, feeAmount, netEthOut, effEth, effToken };
  }

  async function deployFreshCurve() {
    const [deployer, creator] = await ethers.getSigners();

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

    const BondingCurveFactory = await ethers.getContractFactory("BondingCurveFactory");
    const factory = await BondingCurveFactory.deploy(
      await tokenImplementation.getAddress(),
      await router.getAddress(),
      await locker.getAddress(),
      CURVE_LAUNCH_FEE,
      deployer.address,
      LP_LOCK_DURATION,
      deployer.address,
      await priceFeed.getAddress()
    );
    await locker.setFactory(await factory.getAddress());

    const tx = await factory
      .connect(creator)
      .createCurveToken("Aurora Ledger", "AURA", TOTAL_SUPPLY, 0, 0, 1, { value: CURVE_LAUNCH_FEE });
    const receipt = await tx.wait();
    const event = receipt.logs
      .map((log) => {
        try {
          return factory.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((parsed) => parsed && parsed.name === "CurveTokenCreated");

    const tokenAddress = event.args.token;
    return { factory, tokenAddress, creator };
  }

  it("quoteBuy matches the hand-computed constant-product formula", async function () {
    const { factory, tokenAddress } = await deployFreshCurve();
    const state = await factory.curveState(tokenAddress);
    const ethIn = ethers.parseEther("0.37");

    const expected = expectedBuy(
      state.virtualEthReserve,
      state.realEthReserve,
      state.virtualTokenReserve,
      state.tokensRemaining,
      ethIn,
      CURVE_FEE_BPS
    );
    const [tokensOut, feeAmount] = await factory.quoteBuy(tokenAddress, ethIn);
    expect(tokensOut).to.equal(expected.tokensOut);
    expect(feeAmount).to.equal(expected.feeAmount);
  });

  it("quoteSell matches the hand-computed constant-product formula", async function () {
    const { factory, tokenAddress } = await deployFreshCurve();
    const state = await factory.curveState(tokenAddress);
    const tokenAmountIn = state.tokensRemaining / 20n; // an arbitrary slice of the curve's supply

    const expected = expectedSell(
      state.virtualEthReserve,
      state.realEthReserve,
      state.virtualTokenReserve,
      state.tokensRemaining,
      tokenAmountIn,
      CURVE_FEE_BPS
    );
    const [ethOut, feeAmount] = await factory.quoteSell(tokenAddress, tokenAmountIn);
    expect(ethOut).to.equal(expected.netEthOut);
    expect(feeAmount).to.equal(expected.feeAmount);
  });

  it("computes feeAmount as an exact floor (integer division), never rounding up", async function () {
    const { factory, tokenAddress } = await deployFreshCurve();
    // 1 wei short of a multiple of 100 (curveFeeBps) so the floor division
    // actually has a remainder to drop -- proves the contract truncates
    // rather than rounding.
    const ethIn = 10_000_000_099n;
    const [, feeAmount] = await factory.quoteBuy(tokenAddress, ethIn);
    expect(feeAmount).to.equal((ethIn * CURVE_FEE_BPS) / 10_000n);
    expect(feeAmount).to.equal(1_000_000_009n); // floor(10_000_000_099 * 100 / 10_000), not 1_000_000_009.9
  });

  it("quoteBuy is monotonically increasing in ethIn", async function () {
    const { factory, tokenAddress } = await deployFreshCurve();
    const amounts = [
      ethers.parseEther("0.01"),
      ethers.parseEther("0.05"),
      ethers.parseEther("0.1"),
      ethers.parseEther("0.5"),
      ethers.parseEther("1"),
    ];
    let previous = 0n;
    for (const ethIn of amounts) {
      const [tokensOut] = await factory.quoteBuy(tokenAddress, ethIn);
      expect(tokensOut).to.be.greaterThan(previous);
      previous = tokensOut;
    }
  });

  it("quoteSell is monotonically increasing in tokenAmountIn", async function () {
    const { factory, tokenAddress } = await deployFreshCurve();
    const state = await factory.curveState(tokenAddress);
    const fractions = [200n, 100n, 50n, 20n, 10n]; // curveSupply / fraction, increasing amounts
    let previous = 0n;
    for (const f of fractions) {
      const amountIn = state.tokensRemaining / f;
      const [ethOut] = await factory.quoteSell(tokenAddress, amountIn);
      expect(ethOut).to.be.greaterThan(previous);
      previous = ethOut;
    }
  });

  it("gives diminishing marginal tokensOut per additional ETH (convexity of the curve)", async function () {
    const { factory, tokenAddress } = await deployFreshCurve();
    const step = ethers.parseEther("0.2");

    const [out1] = await factory.quoteBuy(tokenAddress, step);
    const [out2] = await factory.quoteBuy(tokenAddress, step * 2n);
    const [out3] = await factory.quoteBuy(tokenAddress, step * 3n);

    const firstMarginal = out2 - out1;
    const secondMarginal = out3 - out2;
    expect(secondMarginal).to.be.lessThan(firstMarginal);
  });

  it("never quotes more tokens out than the curve's effective token reserve", async function () {
    const { factory, tokenAddress } = await deployFreshCurve();
    const state = await factory.curveState(tokenAddress);
    const effToken = state.virtualTokenReserve + state.tokensRemaining;

    // An enormous ETH amount pushes tokensOut arbitrarily close to, but
    // never past, the asymptotic bound implied by the constant-product
    // formula (tokensOut < effToken as ethIn -> infinity).
    const [tokensOut] = await factory.quoteBuy(tokenAddress, ethers.parseEther("1000000"));
    expect(tokensOut).to.be.lessThan(effToken);
  });

  it("has no free lunch: buying then immediately selling the same tokens back never returns more ETH than was spent", async function () {
    const { factory, tokenAddress } = await deployFreshCurve();
    const ethIn = ethers.parseEther("0.4");
    const [tokensOut] = await factory.quoteBuy(tokenAddress, ethIn);

    // Simulate the post-buy state by hand (quoteSell is a view against
    // CURRENT state, so to check the round trip we recompute what the
    // curve's state would be after the buy and quote a sell against that).
    const stateBefore = await factory.curveState(tokenAddress);
    const buyExpected = expectedBuy(
      stateBefore.virtualEthReserve,
      stateBefore.realEthReserve,
      stateBefore.virtualTokenReserve,
      stateBefore.tokensRemaining,
      ethIn,
      CURVE_FEE_BPS
    );
    const sellExpected = expectedSell(
      stateBefore.virtualEthReserve,
      stateBefore.realEthReserve + buyExpected.netEthIn,
      stateBefore.virtualTokenReserve,
      stateBefore.tokensRemaining - buyExpected.tokensOut,
      tokensOut,
      CURVE_FEE_BPS
    );

    expect(sellExpected.netEthOut).to.be.lessThan(ethIn);
  });

  it("treats a zero-amount quote as a no-op rather than reverting", async function () {
    const { factory, tokenAddress } = await deployFreshCurve();
    const [tokensOut, buyFee] = await factory.quoteBuy(tokenAddress, 0);
    expect(tokensOut).to.equal(0n);
    expect(buyFee).to.equal(0n);

    const [ethOut, sellFee] = await factory.quoteSell(tokenAddress, 0);
    expect(ethOut).to.equal(0n);
    expect(sellFee).to.equal(0n);
  });
});
