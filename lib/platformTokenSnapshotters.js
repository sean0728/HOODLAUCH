// Lets the platform's reward distributors run airdrop rounds: the PlatformToken's OWNER authorises each
// distributor as a snapshotter (rounds pay holders from a balance snapshot taken when the round starts).
// Shared by scripts/V4deploy.js, scripts/deployPlatformToken.js and scripts/authorizePlatformTokenSnapshotters.js,
// so whichever of the token and the distributors is deployed last does the authorisation.
//
// Idempotent and safe to re-run. It never throws because of who the signer is: if the signer is not the token's
// owner it reports that, so a deploy script can print the one command the owner has to run instead of failing.
const fs = require("fs");
const path = require("path");

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; }
}

// The three contracts that run holder rounds (they inherit V4PlatformTokenRewards or carry its round loop).
// The creator-rewards distributor does not: it never touches the platform token.
const DISTRIBUTOR_KEYS = [
  ["V4FeeWalletDistributor", "feeWalletDistributor", "V4_FEE_WALLET_DISTRIBUTOR_ADDRESS"],
  ["V4PlatformRewardsDistributor", "platformRewardsDistributor", "V4_PLATFORM_REWARDS_DISTRIBUTOR_ADDRESS"],
  ["V4PlatformTaxDistributor", "platformTaxDistributor", "V4_PLATFORM_TAX_DISTRIBUTOR_ADDRESS"],
];

// Distributor addresses for a network: the environment settings win, then deployments/<network>/v4-deploy.json
// (top-level keys, then its summary). Returns [[name, address], ...] for the ones that are known.
function distributorTargets(network, env = process.env, root = path.join(__dirname, "..")) {
  const v4 = readJson(path.join(root, "deployments", network, "v4-deploy.json"));
  const out = [];
  for (const [name, key, envName] of DISTRIBUTOR_KEYS) {
    const address = env[envName] || v4[key] || (v4.summary && v4.summary[key]);
    if (address) out.push([name, address]);
  }
  return out;
}

// The token address for a network: PLATFORM_TOKEN_ADDRESS, else deployments/<network>/platform-token.json.
function platformTokenAddress(network, env = process.env, root = path.join(__dirname, "..")) {
  return env.PLATFORM_TOKEN_ADDRESS || readJson(path.join(root, "deployments", network, "platform-token.json")).address || null;
}

// Authorises every target that is not yet a snapshotter. `ethers` is hre.ethers; `signer` sends the transactions.
// Returns { authorised: [[name, address, txHash]], already: [[name, address]], skipped: [[name, address, reason]], reason }
// where `reason` is set (and nothing is sent) when the token cannot be used at all.
async function authoriseSnapshotters({ ethers, signer, tokenAddress, targets, log = console.log }) {
  const result = { authorised: [], already: [], skipped: [], reason: null };
  if (!tokenAddress || !ethers.isAddress(tokenAddress)) { result.reason = "no platform token address"; return result; }
  if ((await ethers.provider.getCode(tokenAddress)) === "0x") { result.reason = `no contract at the platform token address ${tokenAddress}`; return result; }
  const token = await ethers.getContractAt("PlatformToken", tokenAddress, signer);
  let owner;
  try { owner = await token.owner(); } catch { result.reason = `${tokenAddress} is not a PlatformToken (no owner())`; return result; }
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    result.reason = `the signer ${signer.address} is not the token's owner (${owner})`;
    return result;
  }
  try { await token.isSnapshotter(owner); } catch {
    result.reason = `${tokenAddress} has no snapshots (an older PlatformToken?); deploy the current contracts/PlatformToken.sol`;
    return result;
  }
  for (const [name, address] of targets) {
    if (!ethers.isAddress(address) || (await ethers.provider.getCode(address)) === "0x") {
      result.skipped.push([name, address, "no contract at that address"]);
      continue;
    }
    if (await token.isSnapshotter(address)) { result.already.push([name, address]); log(`  = ${name} ${address} is already a snapshotter.`); continue; }
    const tx = await token.setSnapshotter(address, true);
    await tx.wait();
    result.authorised.push([name, address, tx.hash]);
    log(`  + ${name} ${address} authorised as a snapshotter (tx ${tx.hash}).`);
  }
  return result;
}

module.exports = { distributorTargets, platformTokenAddress, authoriseSnapshotters, DISTRIBUTOR_KEYS };
