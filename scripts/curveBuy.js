// Buys tokens from a bonding curve created through BondingCurveFactory or
// CustomBondingCurveFactory. The curve logic lives on the factory itself (not
// a per-token contract), so this script calls factory.buy(token, ...) rather
// than a standalone curve contract. Mostly useful for local testing/demos; a
// real front end would call the factory directly from the buyer's own wallet.
//
// Required env: FACTORY_ADDRESS, TOKEN_ADDRESS, ETH_AMOUNT (ETH to spend).
// Optional env:
//   FACTORY_CONTRACT - "BondingCurveFactory" (default, zero-tax) or
//                       "CustomBondingCurveFactory" (creator-configurable tax).
//                       Must match whichever factory actually created the
//                       token, or getContractAt will attach the wrong ABI.
//   MIN_TOKENS_OUT    - defaults to 0 - no slippage protection; don't leave
//                       it at 0 in anything resembling production use.
const hre = require("hardhat");

async function main() {
  const factoryAddress = process.env.FACTORY_ADDRESS;
  const tokenAddress = process.env.TOKEN_ADDRESS;
  const ethAmount = process.env.ETH_AMOUNT;
  if (!factoryAddress) throw new Error("Set FACTORY_ADDRESS.");
  if (!tokenAddress) throw new Error("Set TOKEN_ADDRESS.");
  if (!ethAmount) throw new Error("Set ETH_AMOUNT.");

  const factoryContract = process.env.FACTORY_CONTRACT || "BondingCurveFactory";
  const minTokensOut = process.env.MIN_TOKENS_OUT ? hre.ethers.parseEther(process.env.MIN_TOKENS_OUT) : 0n;

  const [signer] = await hre.ethers.getSigners();
  const factory = await hre.ethers.getContractAt(factoryContract, factoryAddress, signer);

  const curveBefore = await factory.curveState(tokenAddress);
  if (curveBefore.graduated) {
    throw new Error("This curve has already graduated - trade on the DEX pool instead (see buyToken.js).");
  }

  const tx = await factory.buy(tokenAddress, minTokensOut, { value: hre.ethers.parseEther(ethAmount) });
  const receipt = await tx.wait();

  const parsedEvents = receipt.logs
    .map((log) => {
      try {
        return factory.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .filter((parsed) => parsed && (parsed.name === "CurveBought" || parsed.name === "CurveGraduated"));

  console.log(`Tx: ${receipt.hash}`);

  const bought = parsedEvents.find((e) => e.name === "CurveBought");
  if (bought) {
    console.log(
      `Bought ${hre.ethers.formatEther(bought.args.tokensOut)} tokens for ${ethAmount} ETH ` +
        `(fee: ${hre.ethers.formatEther(bought.args.feeAmount)} ETH)`
    );
  }

  const graduated = parsedEvents.find((e) => e.name === "CurveGraduated");
  if (graduated) {
    console.log(
      "This buy crossed the graduation threshold - liquidity was just added to the DEX pool " +
        `automatically (pair: ${graduated.args.pair}). LP tokens are locked until ` +
        `${new Date(Number(graduated.args.unlockTime) * 1000).toISOString()}.`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
