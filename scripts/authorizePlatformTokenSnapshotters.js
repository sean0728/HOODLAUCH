// Lets the distributors run airdrop rounds: the PlatformToken's OWNER authorises each distributor as a
// snapshotter (rounds pay holders from a balance snapshot taken when the round starts). Run it with the
// token owner's wallet, after V4deploy.js and before setPlatformToken on the distributors (which refuses
// until this has been done).
//
//   npx hardhat run scripts/authorizePlatformTokenSnapshotters.js --network robinhoodTestnet
//
// Addresses come from deployments/<network>/platform-token.json and v4-deploy.json, or from
// PLATFORM_TOKEN_ADDRESS, V4_FEE_WALLET_DISTRIBUTOR_ADDRESS and V4_PLATFORM_REWARDS_DISTRIBUTOR_ADDRESS.
// Add V4PlatformTaxDistributor here once it pays from snapshots. Safe to re-run.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
}

async function main() {
  const dir = path.join(__dirname, "..", "deployments", hre.network.name);
  const tokenState = readJson(path.join(dir, "platform-token.json"));
  const v4 = readJson(path.join(dir, "v4-deploy.json"));
  const tokenAddress = process.env.PLATFORM_TOKEN_ADDRESS || tokenState.address;
  if (!tokenAddress || !hre.ethers.isAddress(tokenAddress)) throw new Error("No platform token address: set PLATFORM_TOKEN_ADDRESS or deploy it with scripts/deployPlatformToken.js.");
  const targets = [
    ["V4FeeWalletDistributor", process.env.V4_FEE_WALLET_DISTRIBUTOR_ADDRESS || v4.feeWalletDistributor],
    ["V4PlatformRewardsDistributor", process.env.V4_PLATFORM_REWARDS_DISTRIBUTOR_ADDRESS || v4.platformRewardsDistributor],
  ].filter(([, a]) => a && hre.ethers.isAddress(a));
  if (targets.length === 0) throw new Error("No distributor addresses found (deployments/<network>/v4-deploy.json or the V4_*_DISTRIBUTOR_ADDRESS settings).");

  const [signer] = await hre.ethers.getSigners();
  const token = await hre.ethers.getContractAt("PlatformToken", tokenAddress, signer);
  const owner = await token.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`The signer ${signer.address} is not the token's owner (${owner}). Run this with the owner's wallet.`);
  }
  for (const [name, address] of targets) {
    if (await token.isSnapshotter(address)) { console.log(`= ${name} ${address} is already a snapshotter.`); continue; }
    const tx = await token.setSnapshotter(address, true);
    await tx.wait();
    console.log(`+ ${name} ${address} authorised as a snapshotter (tx ${tx.hash}).`);
  }
  console.log("Next: on each distributor (owner wallet) call setPlatformToken(" + tokenAddress + ").");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
