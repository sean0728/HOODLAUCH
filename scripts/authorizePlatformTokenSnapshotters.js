// Lets the distributors run airdrop rounds: the PlatformToken's OWNER authorises each distributor as a
// snapshotter (rounds pay holders from a balance snapshot taken when the round starts). Run it with the
// token owner's wallet when V4deploy.js and deployPlatformToken.js did not already do it (both do, when the
// other side already exists and their wallet is the token's owner), and always after redeploying a distributor.
//
//   npx hardhat run scripts/authorizePlatformTokenSnapshotters.js --network robinhoodTestnet
//
// Addresses come from deployments/<network>/platform-token.json and v4-deploy.json, or from
// PLATFORM_TOKEN_ADDRESS, V4_FEE_WALLET_DISTRIBUTOR_ADDRESS, V4_PLATFORM_REWARDS_DISTRIBUTOR_ADDRESS and
// V4_PLATFORM_TAX_DISTRIBUTOR_ADDRESS. Safe to re-run.
const hre = require("hardhat");
const { distributorTargets, platformTokenAddress, authoriseSnapshotters } = require("../lib/platformTokenSnapshotters");

async function main() {
  const tokenAddress = platformTokenAddress(hre.network.name);
  if (!tokenAddress || !hre.ethers.isAddress(tokenAddress)) throw new Error("No platform token address: set PLATFORM_TOKEN_ADDRESS or deploy it with scripts/deployPlatformToken.js.");
  const targets = distributorTargets(hre.network.name);
  if (targets.length === 0) throw new Error("No distributor addresses found (deployments/<network>/v4-deploy.json or the V4_*_DISTRIBUTOR_ADDRESS settings).");
  const [signer] = await hre.ethers.getSigners();
  const r = await authoriseSnapshotters({ ethers: hre.ethers, signer, tokenAddress, targets });
  if (r.reason) throw new Error(`Cannot authorise: ${r.reason}. Run this with the token owner's wallet.`);
  for (const [name, address, why] of r.skipped) console.log(`! ${name} ${address} skipped: ${why}.`);
  console.log("Next: on each distributor (owner wallet) call setPlatformToken(" + tokenAddress + ") (on the tax distributor, setRouter first).");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
