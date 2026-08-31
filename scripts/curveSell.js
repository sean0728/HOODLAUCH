// Sells tokens back to a bonding curve. Requires the seller to have
// approved the curve contract for at least TOKEN_AMOUNT first.
//
// Required env: CURVE_ADDRESS, TOKEN_ADDRESS, TOKEN_AMOUNT (whole tokens).
// Optional env: MIN_ETH_OUT (defaults to 0 — no slippage protection; don't
// leave it at 0 in anything resembling production use).
const hre = require("hardhat");

async function main() {
  const curveAddress = process.env.CURVE_ADDRESS;
  const tokenAddress = process.env.TOKEN_ADDRESS;
  const tokenAmount = process.env.TOKEN_AMOUNT;
  if (!curveAddress) throw new Error("Set CURVE_ADDRESS.");
  if (!tokenAddress) throw new Error("Set TOKEN_ADDRESS.");
  if (!tokenAmount) throw new Error("Set TOKEN_AMOUNT.");

  const minEthOut = process.env.MIN_ETH_OUT ? hre.ethers.parseEther(process.env.MIN_ETH_OUT) : 0n;
  const amountWei = hre.ethers.parseEther(tokenAmount);

  const [signer] = await hre.ethers.getSigners();
  const curve = await hre.ethers.getContractAt("BondingCurve", curveAddress, signer);
  const token = await hre.ethers.getContractAt("LaunchedToken", tokenAddress, signer);

  if (await curve.graduated()) throw new Error("This curve has already graduated — trade on the DEX pool instead.");

  const allowance = await token.allowance(signer.address, curveAddress);
  if (allowance < amountWei) {
    console.log(`Approving curve to spend ${tokenAmount} tokens...`);
    await (await token.approve(curveAddress, amountWei)).wait();
  }

  const tx = await curve.sell(amountWei, minEthOut);
  const receipt = await tx.wait();

  const event = receipt.logs
    .map((log) => {
      try {
        return curve.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed && parsed.name === "Sell");

  console.log(`Tx: ${receipt.hash}`);
  if (event) {
    console.log(`Sold ${tokenAmount} tokens for ${hre.ethers.formatEther(event.args.ethOut)} ETH (fee: ${hre.ethers.formatEther(event.args.fee)} ETH)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
