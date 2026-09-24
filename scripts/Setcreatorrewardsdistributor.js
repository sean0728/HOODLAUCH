// One-time (or one-time-per-factory-redeploy) admin action: points an
// already-deployed TokenFactory and/or CustomTokenFactory at an existing
// CreatorRewardsDistributor. Without this, EVERY launch made against that
// factory permanently records creatorRewardBps as 0 — LaunchedToken.sol/
// CustomToken.sol snapshot the effective bps once, at creation time, via
// TokenFactory._finalizeLaunch/CustomTokenFactory's equivalent:
//
//   uint256 effectiveCreatorRewardBps =
//     creatorRewardsDistributor != address(0) ? creatorRewardBps : 0;
//
// So even though both factories already default creatorRewardBps to a
// nonzero 5 (0.05%) at construction, that value is silently discarded for
// every launch until this exact setter has been called — matching the same
// "feature defaults to silently off until wired" pattern setRelayer.js
// already documents for relayer()/maxRelayerGasReimbursementWei.
//
// This is exactly what happened after the Sept 2026 TokenFactory/
// CustomTokenFactory redeploy: scripts/deploy.js only calls
// setCreatorRewardsDistributor when CREATOR_REWARDS_DISTRIBUTOR_ADDRESS (or
// DEPLOY_CREATOR_REWARDS=true) is set in ITS OWN environment at deploy time.
// It wasn't that run, even though a CreatorRewardsDistributor already
// existed from before (and scripts/relayer.js's own
// CREATOR_REWARDS_DISTRIBUTOR_ADDRESS env var was already pointed at it,
// which is a SEPARATE, off-chain-only setting controlling whether the
// relayer's sweep loop runs at all — it has no effect on whether the
// on-chain factories themselves are wired up). Every token launched against
// the new factories since that redeploy (until this script is run) has
// creator rewards permanently disabled — this can enable it for every
// launch FROM HERE ON, but cannot retroactively fix a token that's already
// been created; LaunchedToken/CustomToken have no "re-snapshot tax config"
// entry point once deployed.
//
// Must be run by the factory's OWNER wallet (DEPLOYER_PRIVATE_KEY, unless
// ownership has since been transferred) — NOT the relayer's own wallet.
// Same owner-vs-relayer key split as setRelayer.js, for the same reason:
// this is a platform-configuration action, not something the relayer's own
// gas-paying wallet should ever need privilege to do.
//
// Required env: CREATOR_REWARDS_DISTRIBUTOR_ADDRESS (the already-deployed
//   CreatorRewardsDistributor's address — see scripts/deployCreatorRewards.js
//   if one doesn't exist yet), plus at least one of TOKEN_FACTORY_ADDRESS /
//   CUSTOM_TOKEN_FACTORY_ADDRESS.
//
// Example:
//   CREATOR_REWARDS_DISTRIBUTOR_ADDRESS=0x... TOKEN_FACTORY_ADDRESS=0x... CUSTOM_TOKEN_FACTORY_ADDRESS=0x... \
//     npx hardhat run scripts/setCreatorRewardsDistributor.js --network robinhoodTestnet
const hre = require("hardhat");

async function setDistributorOn(contractName, factoryAddress, distributorAddress, ownerSigner) {
  const factory = await hre.ethers.getContractAt(contractName, factoryAddress, ownerSigner);

  const onChainOwner = await factory.owner();
  if (onChainOwner.toLowerCase() !== ownerSigner.address.toLowerCase()) {
    throw new Error(
      `${contractName} at ${factoryAddress} is owned by ${onChainOwner}, not the signer running this script ` +
        `(${ownerSigner.address}). Run this with the actual owner's private key, or finish an in-progress ` +
        "transferOwnership/acceptOwnership handoff first."
    );
  }

  const currentDistributor = await factory.creatorRewardsDistributor();
  if (currentDistributor.toLowerCase() === distributorAddress.toLowerCase()) {
    console.log(`${contractName}: creatorRewardsDistributor is already ${distributorAddress} — nothing to do.`);
    return;
  }

  const currentBps = await factory.creatorRewardBps();
  console.log(
    `${contractName}: setting creatorRewardsDistributor ${currentDistributor} -> ${distributorAddress} ` +
      `(creatorRewardBps is already ${currentBps} — no separate setTaxDefaults call needed unless you want a ` +
      "different bps)..."
  );
  const tx = await factory.setCreatorRewardsDistributor(distributorAddress);
  await tx.wait();
  console.log(`${contractName}: setCreatorRewardsDistributor(${distributorAddress}) confirmed (tx ${tx.hash}).`);
}

async function main() {
  const distributorAddress = process.env.CREATOR_REWARDS_DISTRIBUTOR_ADDRESS;
  if (!distributorAddress) {
    throw new Error(
      "Set CREATOR_REWARDS_DISTRIBUTOR_ADDRESS to the already-deployed CreatorRewardsDistributor's address " +
        "(the same one scripts/relayer.js's own CREATOR_REWARDS_DISTRIBUTOR_ADDRESS env var already points at, " +
        "if the off-chain sweep is already running against it)."
    );
  }
  if (!hre.ethers.isAddress(distributorAddress)) {
    throw new Error(`CREATOR_REWARDS_DISTRIBUTOR_ADDRESS (${distributorAddress}) is not a valid address.`);
  }

  const tokenFactoryAddress = process.env.TOKEN_FACTORY_ADDRESS || null;
  const customTokenFactoryAddress = process.env.CUSTOM_TOKEN_FACTORY_ADDRESS || null;
  if (!tokenFactoryAddress && !customTokenFactoryAddress) {
    throw new Error("Set at least one of TOKEN_FACTORY_ADDRESS / CUSTOM_TOKEN_FACTORY_ADDRESS.");
  }

  const [ownerSigner] = await hre.ethers.getSigners();
  console.log(`Running as: ${ownerSigner.address}`);
  console.log(`Wiring creatorRewardsDistributor to: ${distributorAddress}`);

  if (tokenFactoryAddress) await setDistributorOn("TokenFactory", tokenFactoryAddress, distributorAddress, ownerSigner);
  if (customTokenFactoryAddress)
    await setDistributorOn("CustomTokenFactory", customTokenFactoryAddress, distributorAddress, ownerSigner);

  console.log(
    "\nDone. This only affects launches made FROM NOW ON — any token already launched against these factories " +
      "keeps whatever creatorRewardBps was snapshotted at its own creation (0, until this ran) permanently. " +
      "No relayer.js restart needed for this one: postLaunchPipeline reads creator-reward state fresh from each " +
      "token's own contract at launch time, not from anything relayer.js caches at startup."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});