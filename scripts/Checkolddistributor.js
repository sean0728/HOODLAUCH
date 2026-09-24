const hre = require("hardhat");

// One-off diagnostic: confirms what a given address actually is before you
// trust it as either a PlatformRewardsDistributor or a platform token.
// Usage (from hoodlaunch-contracts/, Windows cmd — no quotes around the value):
//   set CHECK_ADDRESS=0x9d931ef9d5873c8288192a30f9778689d0796b5e
//   npx hardhat run scripts/checkOldDistributor.js --network robinhoodTestnet
async function main() {
  const addr = process.env.CHECK_ADDRESS;
  if (!addr) {
    throw new Error("Set CHECK_ADDRESS to the address you want to identify.");
  }

  const code = await hre.ethers.provider.getCode(addr);
  if (code === "0x") {
    console.log(`${addr} has no contract code at all on this network (it's just a plain wallet address, or nothing was ever deployed there).`);
    return;
  }
  console.log(`${addr} has contract code (${(code.length - 2) / 2} bytes). Checking what kind of contract it looks like...`);

  // Try it as a PlatformRewardsDistributor first.
  try {
    const distributor = await hre.ethers.getContractAt("PlatformRewardsDistributor", addr);
    const platformToken = await distributor.platformToken();
    const owner = await distributor.owner();
    const router = await distributor.router();
    console.log("\n--- Looks like a PlatformRewardsDistributor ---");
    console.log("platformToken():", platformToken);
    console.log("owner():", owner);
    console.log("router():", router);
    if (platformToken === hre.ethers.ZeroAddress) {
      console.log("\nNote: platformToken() is the zero address — setPlatformToken() was never called on this distributor, so it has no token wired up yet.");
    } else {
      console.log(`\nYour real platform token address is: ${platformToken}`);
    }
    return;
  } catch (err) {
    console.log("Does not respond like a PlatformRewardsDistributor:", err.message.slice(0, 200));
  }

  // Fall back to checking if it's a plain ERC20 (or PlatformToken/LaunchedToken/CustomToken).
  try {
    const erc20 = await hre.ethers.getContractAt("IERC20Metadata", addr);
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      erc20.name(),
      erc20.symbol(),
      erc20.decimals(),
      erc20.totalSupply(),
    ]);
    console.log("\n--- Looks like an ERC20 token ---");
    console.log("name:", name);
    console.log("symbol:", symbol);
    console.log("decimals:", decimals);
    console.log("totalSupply:", totalSupply.toString());
  } catch (err) {
    console.log("Does not respond like a standard ERC20 either:", err.message.slice(0, 200));
    console.log("\nCould not identify this contract automatically — check it on the block explorer instead:");
    console.log(`https://explorer.testnet.chain.robinhood.com/address/${addr}#code`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});