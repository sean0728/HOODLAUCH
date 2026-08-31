// Buys tokens from a bonding curve. Mostly useful for local testing/demos —
// a real front end would call BondingCurve.buy() directly from the buyer's
// own wallet.
//
// Required env: CURVE_ADDRESS, ETH_AMOUNT (ETH to spend).
// Optional env: MIN_TOKENS_OUT (defaults to 0 — no slippage protection;
// don't leave it at 0 in anything resembling production use).
const hre = require("hardhat");

async function main() {
  const curveAddress = process.env.CURVE_ADDRESS;
  const ethAmount = process.env.ETH_AMOUNT;
  if (!curveAddress) throw new Error("Set CURVE_ADDRESS.");
  if (!ethAmount) throw new Error("Set ETH_AMOUNT.");

  const minTokensOut = process.env.MIN_TOKENS_OUT ? hre.ethers.parseEther(process.env.MIN_TOKENS_OUT) : 0n;

  const [signer] = await hre.ethers.getSigners();
  const curve = await hre.ethers.getContractAt("BondingCurve", curveAddress, signer);

  const graduated = await curve.graduated();
  if (graduated) throw new Error("This curve has already graduated — trade on the DEX pool instead.");

  const tx = await curve.buy(minTokensOut, { value: hre.ethers.parseEther(ethAmount) });
  const receipt = await tx.wait();

  const event = receipt.logs
    .map((log) => {
      try {
        return curve.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed && (parsed.name === "Buy" || parsed.name === "Graduated"));

  console.log(`Tx: ${receipt.hash}`);
  if (event && event.name === "Buy") {
    console.log(`Bought ${hre.ethers.formatEther(event.args.tokensOut)} tokens for ${ethAmount} ETH (fee: ${hre.ethers.formatEther(event.args.fee)} ETH)`);
  }
  const graduatedNow = await curve.graduated();
  if (graduatedNow && !graduated) {
    console.log("This buy crossed the graduation threshold — liquidity was just added to the DEX pool automatically.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
