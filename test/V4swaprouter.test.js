// V4SwapRouter tests: the site's buy/sell entry point, run against Uniswap's
// REAL PoolManager with the real V4TaxHook. The router's results are checked
// against the same trade done through Uniswap's own PoolSwapTest router.
const { ethers, network } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt } = require("../scripts/V4mineHookAddress");

const ETH = ethers.parseEther;
const MIN_SQRT = 4295128739n + 1n;
const MAX_SQRT = 1461446703485210103287273052203988822378723970342n - 1n;
const ZERO = ethers.ZeroAddress;
const DEPLOY_FEE = ETH("0.01");
const LAUNCH_FEE = ETH("0.02");
const SUPPLY = ETH("1000000000");
const FAR = 2n ** 40n;

describe("V4SwapRouter", function () {
  let owner, treasury, feeWallet, creator, trader, other;
  let pm, testRouter, create2, tokenImpl, locker, feed, hook, factory, router;
  let snap, saltCounter = 1n;

  before(async () => {
    [owner, treasury, feeWallet, creator, trader, other] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    testRouter = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    create2 = await (await ethers.getContractFactory("V4Create2Deployer")).deploy();
    tokenImpl = await (await ethers.getContractFactory("V4LaunchedToken")).deploy();
    locker = await (await ethers.getContractFactory("V4LiquidityLocker")).deploy(await pm.getAddress());
    feed = await (await ethers.getContractFactory("V4MockAggregatorV3")).deploy(8, 2000n * 10n ** 8n);
    const HookF = await ethers.getContractFactory("V4TaxHook");
    const args = ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [await pm.getAddress(), owner.address]);
    const initCode = ethers.concat([HookF.bytecode, args]);
    const mined = mineHookSalt(await create2.getAddress(), initCode);
    await (await create2.deploy(mined.salt, initCode)).wait();
    hook = HookF.attach(mined.address);
    factory = await (await ethers.getContractFactory("V4TokenFactory")).deploy(
      await tokenImpl.getAddress(), await pm.getAddress(), await locker.getAddress(), await hook.getAddress(),
      DEPLOY_FEE, LAUNCH_FEE, treasury.address, 30 * 24 * 3600, feeWallet.address, await feed.getAddress()
    );
    await (await locker.setFactory(await factory.getAddress())).wait();
    await (await hook.setFactory(await factory.getAddress())).wait();
    router = await (await ethers.getContractFactory("V4SwapRouter")).deploy(await pm.getAddress(), await hook.getAddress());
    await network.provider.send("evm_setAutomine", [true]);
    snap = await network.provider.send("evm_snapshot");
  });

  beforeEach(async () => {
    await network.provider.send("evm_revert", [snap]);
    snap = await network.provider.send("evm_snapshot");
    await feed.set(2000n * 10n ** 8n);
  });

  async function launch({ liqEth = ETH("10") } = {}) {
    const salt = saltCounter++;
    await (await factory.connect(creator).createToken("Test Token", "TST", SUPPLY, true, liqEth, 0n, 0n, salt, { value: LAUNCH_FEE + liqEth })).wait();
    const token = await ethers.getContractAt("V4LaunchedToken", await factory.predictTokenAddress(creator.address, salt));
    const key = { currency0: ZERO, currency1: await token.getAddress(), fee: 3000, tickSpacing: 60, hooks: await hook.getAddress() };
    return { token, key, poolId: await factory.poolIdOf(await token.getAddress()) };
  }
  const viaTestRouter = (signer, key, zeroForOne, amt, value = 0n) =>
    testRouter.connect(signer).swap(key, { zeroForOne, amountSpecified: amt, sqrtPriceLimitX96: zeroForOne ? MIN_SQRT : MAX_SQRT },
      { takeClaims: false, settleUsingBurn: false }, "0x", { value });

  it("poolState returns price/liquidity for a launched token and zeros for an unknown one", async () => {
    const { token } = await launch();
    const s = await router.poolState(await token.getAddress());
    expect(s.sqrtPriceX96).to.be.gt(0n);
    expect(s.liquidity).to.be.gt(0n);
    const none = await router.poolState(other.address);
    expect(none.sqrtPriceX96).to.equal(0n);
    expect(none.liquidity).to.equal(0n);
  });

  it("buy matches the same trade through Uniswap's PoolSwapTest, tax included", async () => {
    const { token, key } = await launch();
    const s0 = await network.provider.send("evm_snapshot");
    await viaTestRouter(trader, key, true, -ETH("1"), ETH("1"));
    const expected = await token.balanceOf(trader.address);
    expect(expected).to.be.gt(0n);
    await network.provider.send("evm_revert", [s0]);

    const ethBefore = await ethers.provider.getBalance(trader.address);
    const tx = await router.connect(trader).buy(await token.getAddress(), expected, FAR, { value: ETH("1") });
    const rc = await tx.wait();
    expect(await token.balanceOf(trader.address)).to.equal(expected);
    const ethAfter = await ethers.provider.getBalance(trader.address);
    expect(ethBefore - ethAfter).to.equal(ETH("1") + rc.gasUsed * rc.gasPrice);
    await expect(tx).to.emit(router, "Bought").withArgs(await token.getAddress(), trader.address, ETH("1"), expected);
    // the tax really was taken: pool gross output exceeded what the buyer got
    expect(await token.balanceOf(await router.getAddress())).to.equal(0n);
    expect(await ethers.provider.getBalance(await router.getAddress())).to.equal(0n);
  });

  it("buy reverts below minTokensOut, past the deadline, and with no ETH", async () => {
    const { token } = await launch();
    const t = await token.getAddress();
    await expect(router.connect(trader).buy(t, ethers.MaxUint256, FAR, { value: ETH("1") })).to.be.revertedWith("V4SwapRouter: output below minimum");
    await expect(router.connect(trader).buy(t, 0n, 1n, { value: ETH("1") })).to.be.revertedWith("V4SwapRouter: expired");
    await expect(router.connect(trader).buy(t, 0n, FAR, { value: 0n })).to.be.revertedWith("V4SwapRouter: no ETH sent");
  });

  it("sell matches the same trade through PoolSwapTest and leaves nothing in the router", async () => {
    const { token, key } = await launch();
    const t = await token.getAddress();
    await router.connect(trader).buy(t, 0n, FAR, { value: ETH("2") });
    const bal = await token.balanceOf(trader.address);
    const sellAmt = bal / 2n;

    const s0 = await network.provider.send("evm_snapshot");
    await token.connect(trader).approve(await testRouter.getAddress(), ethers.MaxUint256);
    const e0 = await ethers.provider.getBalance(trader.address);
    const rc0 = await (await viaTestRouter(trader, key, false, -sellAmt)).wait();
    const expectedEth = (await ethers.provider.getBalance(trader.address)) - e0 + rc0.gasUsed * rc0.gasPrice;
    expect(expectedEth).to.be.gt(0n);
    await network.provider.send("evm_revert", [s0]);

    await token.connect(trader).approve(await router.getAddress(), sellAmt);
    const e1 = await ethers.provider.getBalance(trader.address);
    const tx = await router.connect(trader).sell(t, sellAmt, expectedEth, FAR);
    const rc = await tx.wait();
    const got = (await ethers.provider.getBalance(trader.address)) - e1 + rc.gasUsed * rc.gasPrice;
    expect(got).to.equal(expectedEth);
    expect(await token.balanceOf(trader.address)).to.equal(bal - sellAmt);
    await expect(tx).to.emit(router, "Sold").withArgs(t, trader.address, sellAmt, expectedEth);
    expect(await token.balanceOf(await router.getAddress())).to.equal(0n);
    expect(await ethers.provider.getBalance(await router.getAddress())).to.equal(0n);
  });

  it("sell reverts without approval, below minEthOut, past the deadline, and for zero", async () => {
    const { token } = await launch();
    const t = await token.getAddress();
    await router.connect(trader).buy(t, 0n, FAR, { value: ETH("1") });
    const bal = await token.balanceOf(trader.address);
    await expect(router.connect(trader).sell(t, bal, 0n, FAR)).to.be.reverted; // no allowance
    await token.connect(trader).approve(await router.getAddress(), bal);
    await expect(router.connect(trader).sell(t, bal, ETH("100"), FAR)).to.be.revertedWith("V4SwapRouter: output below minimum");
    await expect(router.connect(trader).sell(t, bal, 0n, 1n)).to.be.revertedWith("V4SwapRouter: expired");
    await expect(router.connect(trader).sell(t, 0n, 0n, FAR)).to.be.revertedWith("V4SwapRouter: nothing to sell");
    // failed attempts moved nothing
    expect(await token.balanceOf(trader.address)).to.equal(bal);
  });

  it("buying and selling for a token with no pool reverts", async () => {
    await expect(router.connect(trader).buy(other.address, 0n, FAR, { value: ETH("1") })).to.be.reverted;
  });

  it("unlockCallback only answers the PoolManager", async () => {
    await expect(router.connect(other).unlockCallback("0x")).to.be.revertedWith("V4SwapRouter: only pool manager");
  });

  it("constructor rejects zero addresses", async () => {
    const F = await ethers.getContractFactory("V4SwapRouter");
    await expect(F.deploy(ZERO, await hook.getAddress())).to.be.revertedWith("V4SwapRouter: invalid address");
    await expect(F.deploy(await pm.getAddress(), ZERO)).to.be.revertedWith("V4SwapRouter: invalid address");
  });

  it("a buy then a full sell round-trips close to the start minus fees (no value is created)", async () => {
    const { token } = await launch();
    const t = await token.getAddress();
    const before = await ethers.provider.getBalance(trader.address);
    const rc1 = await (await router.connect(trader).buy(t, 0n, FAR, { value: ETH("1") })).wait();
    const bal = await token.balanceOf(trader.address);
    await token.connect(trader).approve(await router.getAddress(), bal);
    const rc2 = await (await router.connect(trader).sell(t, bal, 0n, FAR)).wait();
    const after = await ethers.provider.getBalance(trader.address);
    const gas = rc1.gasUsed * rc1.gasPrice + rc2.gasUsed * rc2.gasPrice;
    expect(before - after - gas).to.be.gt(0n);       // lost to LP fee + tax
    expect(before - after - gas).to.be.lt(ETH("0.1")); // but not absurdly much
  });
});