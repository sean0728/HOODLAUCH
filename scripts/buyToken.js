// Buys a token against its live DEX pool. Only works for a token launched
// with LAUNCH_MODE=liquidity — a "Deploy Token" token has no pool at all, so
// there's nothing here to trade against until its creator sets one up
// somewhere themselves. Mostly useful for local testing/demos; a real front
// end would call the router directly from the buyer's own wallet.
//
// Required env: ROUTER_ADDRESS, TOKEN_ADDRESS, ETH_AMOUNT.
// Optional env: MIN_TOKENS_OUT (defaults to 0 — no slippage protection;
// don't leave it at 0 in anything resembling production use).
const hre = require("hardhat");

async function main() {
  const routerAddress = process.env.ROUTER_ADDRESS;
  const tokenAddress = process.env.TOKEN_ADDRESS;
  const ethAmount = process.env.ETH_AMOUNT;
  if (!routerAddress) throw new Error("Set ROUTER_ADDRESS.");
  if (!tokenAddress) throw new Error("Set TOKEN_ADDRESS.");
  if (!ethAmount) throw new Error("Set ETH_AMOUNT.");

  const minTokensOut = process.env.MIN_TOKENS_OUT ? hre.ethers.parseEther(process.env.MIN_TOKENS_OUT) : 0n;

  const [signer] = await hre.ethers.getSigners();
  const router = await hre.ethers.getContractAt("IUniswapV2Router02", routerAddress, signer);
  const token = await hre.ethers.getContractAt("LaunchedToken", tokenAddress, signer);
  const weth = await router.WETH();

  const balBefore = await token.balanceOf(signer.address);
  const tx = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
    minTokensOut,
    [weth, tokenAddress],
    signer.address,
    Math.floor(Date.now() / 1000) + 15 * 60,
    { value: hre.ethers.parseEther(ethAmount) }
  );
  const receipt = await tx.wait();
  const balAfter = await token.balanceOf(signer.address);
  const received = balAfter - balBefore;

  if (received < minTokensOut) {
    throw new Error("Swap confirmed but received less than MIN_TOKENS_OUT — check the router's revert reason.");
  }

  console.log(`Tx: ${receipt.hash}`);
  console.log(`Bought ${hre.ethers.formatEther(received)} tokens for ${ethAmount} ETH (net of any active 0.25% tax).`);

  const [, taxActive] = [null, await token.taxActive()];
  if (taxActive) {
    console.log("This pool's transfer tax is still active — it disables permanently once market cap crosses the target.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
