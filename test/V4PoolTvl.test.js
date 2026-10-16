// Checks the relayer's locked-value (TVL) reading against a REAL Uniswap V4 PoolManager: scripts/relayer.js reads a pool's
// in-range liquidity L straight out of PoolManager storage (Pool.State: slot0, feeGrowth0, feeGrowth1, liquidity -> offset
// 3) and turns it into USD with lib/priceMath.js v4TvlUsdFrom (all platform positions are full range, so the pool holds
// twice its ETH side in value).
//
// Independent reference: the test PoolManager holds exactly one pool, so its ETH balance IS that pool's ETH. If the storage
// offset or the formula were wrong, the two would disagree.
//
//     V4_TEST=1 npx hardhat test test/V4PoolTvl.test.js
const { ethers, network } = require("hardhat");
const { expect } = require("chai");
const { mineHookSalt } = require("../scripts/V4mineHookAddress");
const { v4TvlUsdFrom } = require("../lib/priceMath");

const ETH = ethers.parseEther;
const MIN_SQRT = 4295128739n + 1n;
const ETH_USD = 2000;

describe("relayer TVL reading vs a real V4 pool", function () {
  let owner, treasury, feeWallet, creator, trader;
  let pm, router, hook, factory, feed;

  before(async () => {
    [owner, treasury, feeWallet, creator, trader] = await ethers.getSigners();
    pm = await (await ethers.getContractFactory("PoolManager")).deploy(owner.address);
    router = await (await ethers.getContractFactory("PoolSwapTest")).deploy(await pm.getAddress());
    const create2 = await (await ethers.getContractFactory("V4Create2Deployer")).deploy();
    const tokenImpl = await (await ethers.getContractFactory("V4LaunchedToken")).deploy();
    const locker = await (await ethers.getContractFactory("V4LiquidityLocker")).deploy(await pm.getAddress());
    feed = await (await ethers.getContractFactory("V4MockAggregatorV3")).deploy(8, BigInt(ETH_USD) * 10n ** 8n);
    const HookF = await ethers.getContractFactory("V4TaxHook");
    const args = ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [await pm.getAddress(), owner.address]);
    const initCode = ethers.concat([HookF.bytecode, args]);
    const mined = mineHookSalt(await create2.getAddress(), initCode);
    await (await create2.deploy(mined.salt, initCode)).wait();
    hook = HookF.attach(mined.address);
    factory = await (await ethers.getContractFactory("V4TokenFactory")).deploy(
      await tokenImpl.getAddress(), await pm.getAddress(), await locker.getAddress(), await hook.getAddress(),
      ETH("0.02"), treasury.address, 30 * 24 * 3600, feeWallet.address, await feed.getAddress()
    );
    await (await locker.setFactory(await factory.getAddress())).wait();
    await (await hook.setFactory(await factory.getAddress())).wait();
    await network.provider.send("evm_setAutomine", [true]);
  });

  // Exactly what scripts/relayer.js does (readV4Slot0 / readV4Liquidity / v4PoolTvlUsd).
  async function relayerTvl(poolId) {
    const slot0 = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [poolId, 6n]));
    const sqrtPriceX96 = BigInt(await pm["extsload(bytes32)"](slot0)) & ((1n << 160n) - 1n);
    const liqSlot = "0x" + (BigInt(slot0) + 3n).toString(16).padStart(64, "0");
    const liquidity = BigInt(await pm["extsload(bytes32)"](liqSlot));
    return { liquidity, sqrtPriceX96, tvlUsd: v4TvlUsdFrom(liquidity, sqrtPriceX96, ETH_USD) };
  }

  it("matches twice the pool's real ETH, at launch and after trades move the price", async () => {
    const salt = 1n, liqEth = ETH("10");
    await (await factory.connect(creator).createToken("Tvl Token", "TVL", ETH("1000000000"), true, liqEth, 0n, 0n, salt, { value: ETH("0.02") + liqEth })).wait();
    const token = await ethers.getContractAt("V4LaunchedToken", await factory.predictTokenAddress(creator.address, salt));
    const poolId = await factory.poolIdOf(await token.getAddress());
    const key = { currency0: ethers.ZeroAddress, currency1: await token.getAddress(), fee: 3000, tickSpacing: 60, hooks: await hook.getAddress() };

    const check = async (label) => {
      const { liquidity, tvlUsd } = await relayerTvl(poolId);
      const poolEth = Number(ethers.formatEther(await ethers.provider.getBalance(await pm.getAddress())));
      const expected = 2 * poolEth * ETH_USD;
      console.log(`      ${label}: pool holds ${poolEth.toFixed(4)} ETH, relayer reads TVL $${tvlUsd.toFixed(2)} (expected $${expected.toFixed(2)})`);
      expect(liquidity).to.be.gt(0n);
      // The PoolManager's balance also holds LP fees the trade has accrued (0.30% of what went in) that are not part of the
      // pool's liquidity, so allow for that: after the 7 ETH buy the reading is ~0.12% under the raw balance.
      expect(Math.abs(tvlUsd - expected) / expected).to.be.lt(0.003);
    };
    await check("at launch");
    // a buy (ETH in) shifts the price and adds ETH to the pool
    await (await router.connect(trader).swap(key, { zeroForOne: true, amountSpecified: -ETH("7"), sqrtPriceLimitX96: MIN_SQRT }, { takeClaims: false, settleUsingBurn: false }, "0x", { value: ETH("7") })).wait();
    await check("after a 7 ETH buy");
  });
});
