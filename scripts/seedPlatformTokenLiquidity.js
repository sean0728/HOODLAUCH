const hre = require("hardhat");

// ---------------------------------------------------------------------
// Seeds an initial ETH/HOOD liquidity pool directly against the same DEX
// router TokenFactory already uses, for the standalone PlatformToken
// deployed by deployPlatformRewards.js. PlatformToken isn't created
// through TokenFactory/CustomTokenFactory, so it never gets a pool
// through this site's own "Launch a token" flow — that's expected (see
// deployPlatformRewards.js's own log output) and this script is exactly
// the "separate, later step" that comment refers to: a plain
// approve() + router.addLiquidityETH(), the same thing any token
// creator would do independently, outside the platform.
//
// This has nothing to do with wiring the rewards distributor — it just
// gives PlatformRewardsDistributor.triggerEthBuyback() something real to
// swap ETH for, since a buyback is just an ordinary swap against
// whatever pool exists for the token.
//
// Usage (from hoodlaunch-contracts/):
//   TOKEN_FACTORY_ADDRESS=0x6e295099aFA9d88a27131674531A4e6D229e59BE \
//   PLATFORM_TOKEN_ADDRESS=0x9D931Ef9D5873c8288192A30F9778689D0796b5E \
//   PLATFORM_TOKEN_LIQUIDITY_AMOUNT=1000000000 \
//   PLATFORM_TOKEN_LIQUIDITY_ETH=0.0005 \
//   npx hardhat run scripts/seedPlatformTokenLiquidity.js --network robinhoodTestnet
//
// TOKEN_FACTORY_ADDRESS and PLATFORM_TOKEN_ADDRESS are required (the
// former only to read router() off it, same as deployPlatformRewards.js
// — nothing is written to the factory). PLATFORM_TOKEN_LIQUIDITY_AMOUNT
// defaults to 10,000,000 HOOD (1% of the 1B default supply) and
// PLATFORM_TOKEN_LIQUIDITY_ETH defaults to 0.05 ETH — deliberately small
// testnet amounts, just enough for a later buyback to have something
// real to swap against. Both must actually be sitting in the deploying
// wallet already (the full HOOD supply landed on whichever wallet you
// passed as PLATFORM_TOKEN_INITIAL_HOLDER when you ran
// deployPlatformRewards.js — by default, the deployer itself).
async function main() {
  const network = hre.network.name;
  const [deployer] = await hre.ethers.getSigners();
  console.log(`Running with account: ${deployer.address}`);
  console.log(`Network: ${network}`);

  const tokenFactoryAddress = process.env.TOKEN_FACTORY_ADDRESS;
  const platformTokenAddress = process.env.PLATFORM_TOKEN_ADDRESS;
  if (!tokenFactoryAddress) throw new Error("Set TOKEN_FACTORY_ADDRESS (used only to read its router()).");
  if (!platformTokenAddress) throw new Error("Set PLATFORM_TOKEN_ADDRESS (the PlatformToken/HOOD address to seed a pool for).");

  const tokenFactory = await hre.ethers.getContractAt("TokenFactory", tokenFactoryAddress);
  const routerAddress = await tokenFactory.router();
  console.log(`Read router ${routerAddress} from existing TokenFactory at ${tokenFactoryAddress}.`);

  const router = await hre.ethers.getContractAt("IUniswapV2Router02", routerAddress);
  const platformToken = await hre.ethers.getContractAt("PlatformToken", platformTokenAddress);

  const liquidityTokenAmount = hre.ethers.parseEther(process.env.PLATFORM_TOKEN_LIQUIDITY_AMOUNT || "1000000000");
  const liquidityEthAmount = hre.ethers.parseEther(process.env.PLATFORM_TOKEN_LIQUIDITY_ETH || "0.005");

  const balance = await platformToken.balanceOf(deployer.address);
  if (balance < liquidityTokenAmount) {
    throw new Error(
      `Deployer only holds ${hre.ethers.formatEther(balance)} HOOD, which is less than the ` +
        `${hre.ethers.formatEther(liquidityTokenAmount)} HOOD this script wants to seed. Lower ` +
        "PLATFORM_TOKEN_LIQUIDITY_AMOUNT or use the wallet that actually holds the supply."
    );
  }

  console.log(
    `Approving router to spend ${hre.ethers.formatEther(liquidityTokenAmount)} HOOD...`
  );
  const approveTx = await platformToken.approve(routerAddress, liquidityTokenAmount);
  await approveTx.wait();
  console.log("Approval confirmed.");

  const deadline = Math.floor(Date.now() / 1000) + 20 * 60; // 20 minutes out
  console.log(
    `Adding liquidity: ${hre.ethers.formatEther(liquidityTokenAmount)} HOOD + ` +
      `${hre.ethers.formatEther(liquidityEthAmount)} ETH...`
  );
  const addLiqTx = await router.addLiquidityETH(
    platformTokenAddress,
    liquidityTokenAmount,
    0, // amountTokenMin — 0 is fine for a brand-new pool with no existing price to slip against
    0, // amountETHMin
    deployer.address, // LP tokens land here — no lock, this is just a test pool
    deadline,
    { value: liquidityEthAmount }
  );
  const receipt = await addLiqTx.wait();
  console.log(`Liquidity added. Tx: ${receipt.hash}`);

  const dexFactoryAddress = await router.factory();
  const dexFactory = await hre.ethers.getContractAt(
    ["function getPair(address,address) external view returns (address)"],
    dexFactoryAddress
  );
  const weth = await router.WETH();
  const pairAddress = await dexFactory.getPair(platformTokenAddress, weth);
  console.log(`\nHOOD/WETH pair: ${pairAddress}`);
  console.log(
    "\nPlatformRewardsDistributor.triggerEthBuyback() now has a real pool to swap against. " +
      "This pool isn't tracked or locked by Hood Launch's own platform (it wasn't created through " +
      "TokenFactory/CustomTokenFactory) — that's expected for PlatformToken."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
