// Adds liquidity for a token that was created with LAUNCH_MODE=direct and
// left escrowed (no LAUNCH_LIQUIDITY_ETH given to launch.js at the time).
// Only that token's original creator can call this — enforced on-chain by
// TokenFactory.addLiquidity().
//
// Required env: TOKEN_FACTORY_ADDRESS, TOKEN_ADDRESS, LIQUIDITY_ETH.
// Optional env:
//   TOKEN_AMOUNT          whole tokens; defaults to the token's full escrowed
//                         balance, which is the normal case — you almost
//                         always want the entire supply paired at once.
//   CREATOR_BUY_ETH       extra ETH, on top of LIQUIDITY_ETH, swapped for
//                         tokens sent straight to your wallet in the SAME
//                         transaction as the liquidity add — an ordinary buy
//                         against the pool that was just created, guaranteed
//                         to be the first trade against it. Omit to skip.
//   CREATOR_MIN_TOKENS_OUT  optional slippage floor for that buy-in (whole
//                         tokens). Defaults to 0 — no slippage protection —
//                         since this CLI has no live quote to check against;
//                         a real front end should compute one from the
//                         pool's reserves before submitting.
const hre = require("hardhat");
const { readLedger } = require("../lib/launchStore");

async function main() {
  const factoryAddress = process.env.TOKEN_FACTORY_ADDRESS;
  const tokenAddress = process.env.TOKEN_ADDRESS;
  const liquidityEthTokens = process.env.LIQUIDITY_ETH;
  const creatorBuyEthTokens = process.env.CREATOR_BUY_ETH;
  const creatorMinTokensOutTokens = process.env.CREATOR_MIN_TOKENS_OUT;

  if (!factoryAddress) throw new Error("Set TOKEN_FACTORY_ADDRESS.");
  if (!tokenAddress) throw new Error("Set TOKEN_ADDRESS to the token you're adding liquidity for.");
  if (!liquidityEthTokens) throw new Error("Set LIQUIDITY_ETH to the amount of ETH to pair.");

  const [signer] = await hre.ethers.getSigners();
  const factory = await hre.ethers.getContractAt("TokenFactory", factoryAddress, signer);

  const escrowed = await factory.escrowedSupply(tokenAddress);
  if (escrowed === 0n) {
    throw new Error(
      "This token has no escrowed balance in the factory — either it was launched on a bonding curve " +
        "(which never uses this path), or liquidity has already been added for it."
    );
  }

  const tokenAmount = process.env.TOKEN_AMOUNT ? hre.ethers.parseEther(process.env.TOKEN_AMOUNT) : escrowed;
  const liquidityWei = hre.ethers.parseEther(liquidityEthTokens);
  const creatorBuyWei = creatorBuyEthTokens ? hre.ethers.parseEther(creatorBuyEthTokens) : 0n;
  const minCreatorTokensOut = creatorMinTokensOutTokens ? hre.ethers.parseEther(creatorMinTokensOutTokens) : 0n;
  const totalValue = liquidityWei + creatorBuyWei;

  console.log(
    `Adding ${liquidityEthTokens} ETH of liquidity for ${tokenAddress}, pairing ${hre.ethers.formatEther(tokenAmount)} tokens` +
      (creatorBuyWei > 0n ? `, plus a ${creatorBuyEthTokens} ETH creator buy-in in the same transaction...` : "...")
  );
  const tx = await factory.addLiquidity(tokenAddress, tokenAmount, creatorBuyWei, minCreatorTokensOut, { value: totalValue });
  const receipt = await tx.wait();

  const parsedLogs = receipt.logs.map((log) => {
    try {
      return factory.interface.parseLog(log);
    } catch {
      return null;
    }
  });
  const event = parsedLogs.find((parsed) => parsed && parsed.name === "LiquidityAdded");
  const boughtEvent = parsedLogs.find((parsed) => parsed && parsed.name === "CreatorBought");

  if (!event) throw new Error("LiquidityAdded event not found — check the transaction.");

  console.log(`Liquidity added. LP amount: ${event.args.lpAmount}, locked until ${new Date(Number(event.args.unlockTime) * 1000).toISOString()}`);
  if (boughtEvent) {
    console.log(
      `Creator buy-in filled: ${hre.ethers.formatEther(boughtEvent.args.ethIn)} ETH for ` +
        `${hre.ethers.formatEther(boughtEvent.args.tokensOut)} tokens, sent to ${signer.address}`
    );
  }
  console.log(`Tx: ${receipt.hash}`);

  // Best-effort: if this token has a record in the ledger already, note
  // that liquidity was added later isn't automated here (recordLaunch
  // appends new rows rather than mutating old ones — see README for why),
  // but at minimum point at where the original record lives.
  const ledger = readLedger();
  const existing = ledger.find((entry) => entry.tokenAddress && entry.tokenAddress.toLowerCase() === tokenAddress.toLowerCase());
  if (existing) {
    console.log(`(Original launch record for this token: deployed-contracts/${(existing.symbol || existing.name || "token").replace(/[^a-zA-Z0-9_-]+/g, "-")}.json)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
