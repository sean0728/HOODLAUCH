// Sells tokens back to a bonding curve created through BondingCurveFactory or
// CustomBondingCurveFactory. Requires the seller to have approved the factory
// (not the token, not a per-token curve contract) to spend at least
// TOKEN_AMOUNT first - this script handles that approval automatically if
// needed.
//
// Required env: FACTORY_ADDRESS, TOKEN_ADDRESS, TOKEN_AMOUNT (whole tokens).
// Optional env:
//   FACTORY_CONTRACT - "BondingCurveFactory" (default, zero-tax) or
//                       "CustomBondingCurveFactory" (creator-configurable tax).
//                       Must match whichever factory actually created the
//                       token, or getContractAt will attach the wrong ABI.
//   MIN_ETH_OUT       - defaults to 0 - no slippage protection; don't leave
//                       it at 0 in anything resembling production use.
const hre = require("hardhat");

async function main() {
  const factoryAddress = process.env.FACTORY_ADDRESS;
  const tokenAddress = process.env.TOKEN_ADDRESS;
  const tokenAmount = process.env.TOKEN_AMOUNT;
  if (!factoryAddress) throw new Error("Set FACTORY_ADDRESS.");
  if (!tokenAddress) throw new Error("Set TOKEN_ADDRESS.");
  if (!tokenAmount) throw new Error("Set TOKEN_AMOUNT.");

  const factoryContract = process.env.FACTORY_CONTRACT || "BondingCurveFactory";
  const minEthOut = process.env.MIN_ETH_OUT ? hre.ethers.parseEther(process.env.MIN_ETH_OUT) : 0n;
  const amountWei = hre.ethers.parseEther(tokenAmount);

  const [signer] = await hre.ethers.getSigners();
  const factory = await hre.ethers.getContractAt(factoryContract, factoryAddress, signer);
  // Generic ERC20 interface - deliberate: this same script works whether the
  // curve token is a LaunchedToken (BondingCurveFactory) or a CustomToken
  // (CustomBondingCurveFactory) clone, since selling only needs the standard
  // balanceOf/allowance/approve surface.
  const token = await hre.ethers.getContractAt("IERC20", tokenAddress, signer);

  const curve = await factory.curveState(tokenAddress);
  if (curve.graduated) {
    throw new Error("This curve has already graduated - trade on the DEX pool instead (see sellToken.js).");
  }

  const allowance = await token.allowance(signer.address, factoryAddress);
  if (allowance < amountWei) {
    console.log(`Approving the factory to spend ${tokenAmount} tokens...`);
    await (await token.approve(factoryAddress, amountWei)).wait();
  }

  const tx = await factory.sell(tokenAddress, amountWei, minEthOut);
  const receipt = await tx.wait();

  const event = receipt.logs
    .map((log) => {
      try {
        return factory.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed && parsed.name === "CurveSold");

  console.log(`Tx: ${receipt.hash}`);
  if (event) {
    console.log(
      `Sold ${tokenAmount} tokens for ${hre.ethers.formatEther(event.args.ethOut)} ETH ` +
        `(fee: ${hre.ethers.formatEther(event.args.feeAmount)} ETH)`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
