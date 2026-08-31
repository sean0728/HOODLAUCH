// Sells a token back into its live DEX pool. Requires the seller to have
// approved the router for at least TOKEN_AMOUNT first (this script does
// that automatically if the allowance is too low). Only works for a token
// launched with LAUNCH_MODE=liquidity.
//
// Required env: ROUTER_ADDRESS, TOKEN_ADDRESS, TOKEN_AMOUNT (whole tokens).
// Optional env: MIN_ETH_OUT (defaults to 0 — no slippage protection; don't
// leave it at 0 in anything resembling production use).
const hre = require("hardhat");

async function main() {
  const routerAddress = process.env.ROUTER_ADDRESS;
  const tokenAddress = process.env.TOKEN_ADDRESS;
  const tokenAmount = process.env.TOKEN_AMOUNT;
  if (!routerAddress) throw new Error("Set ROUTER_ADDRESS.");
  if (!tokenAddress) throw new Error("Set TOKEN_ADDRESS.");
  if (!tokenAmount) throw new Error("Set TOKEN_AMOUNT.");

  const minEthOut = process.env.MIN_ETH_OUT ? hre.ethers.parseEther(process.env.MIN_ETH_OUT) : 0n;
  const amountWei = hre.ethers.parseEther(tokenAmount);

  const [signer] = await hre.ethers.getSigners();
  const router = await hre.ethers.getContractAt("IUniswapV2Router02", routerAddress, signer);
  const token = await hre.ethers.getContractAt("LaunchedToken", tokenAddress, signer);
  const weth = await router.WETH();

  const allowance = await token.allowance(signer.address, routerAddress);
  if (allowance < amountWei) {
    console.log(`Approving router to spend ${tokenAmount} tokens...`);
    await (await token.approve(routerAddress, amountWei)).wait();
  }

  const balBefore = await hre.ethers.provider.getBalance(signer.address);
  const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
    amountWei,
    minEthOut,
    [tokenAddress, weth],
    signer.address,
    Math.floor(Date.now() / 1000) + 15 * 60
  );
  const receipt = await tx.wait();
  const gasCost = receipt.gasUsed * receipt.gasPrice;
  const balAfter = await hre.ethers.provider.getBalance(signer.address);
  const ethReceived = balAfter - balBefore + gasCost;

  console.log(`Tx: ${receipt.hash}`);
  console.log(`Sold ${tokenAmount} tokens for ~${hre.ethers.formatEther(ethReceived)} ETH (net of any active 0.25% tax, before gas).`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
