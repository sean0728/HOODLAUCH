// One-time (or one-time-per-factory-redeploy) admin action: points an
// already-deployed TokenFactory and/or CustomTokenFactory at an existing
// FeeWalletDistributor. Without this, every taxed transfer's fee-wallet
// remainder — whatever's left of feeBps after rewardBps/creatorRewardBps
// are carved out — keeps going straight to the plain platformFeeWallet
// address as whatever token it was taxed in, spendable only by manually
// swapping it out later, on no particular schedule:
//
//   toFeeWallet = fee - rewardCut - creatorCut
//   super._update(from, feeWalletDistributor != address(0) ? feeWalletDistributor : feeWallet, toFeeWallet)
//
// This is the exact same "feature defaults to silently off until wired"
// pattern setRelayer.js documents for relayer()/maxRelayerGasReimbursementWei
// and setCreatorRewardsDistributor.js documents for creatorRewardsDistributor
// — except unlike creator rewards, scripts/deploy.js had NO opt-in env var
// path for this at all until it was added alongside this script. Every
// token launched from either factory before this has been run keeps
// feeWalletDistributor permanently unset — LaunchedToken/CustomToken
// snapshot it once, at creation time, via TokenFactory._finalizeLaunch/
// CustomTokenFactory's equivalent, with no setter to change it after the
// fact. Running this only affects launches made FROM NOW ON.
//
// Must be run by the factory's OWNER wallet (DEPLOYER_PRIVATE_KEY, unless
// ownership has since been transferred) — NOT the relayer's own wallet.
// Same owner-vs-relayer key split as setRelayer.js/
// setCreatorRewardsDistributor.js, for the same reason: this is a
// platform-configuration action, not something the relayer's own
// gas-paying wallet should ever need privilege to do.
//
// Required env: FEE_WALLET_DISTRIBUTOR_ADDRESS (the already-deployed
//   FeeWalletDistributor's address — see scripts/deployFeeWalletDistributor.js
//   if one doesn't exist yet), plus at least one of TOKEN_FACTORY_ADDRESS /
//   CUSTOM_TOKEN_FACTORY_ADDRESS.
//
// Example:
//   FEE_WALLET_DISTRIBUTOR_ADDRESS=0x... TOKEN_FACTORY_ADDRESS=0x... CUSTOM_TOKEN_FACTORY_ADDRESS=0x... \
//     npx hardhat run scripts/setFeeWalletDistributor.js --network robinhoodTestnet
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

  const currentDistributor = await factory.feeWalletDistributor();
  if (currentDistributor.toLowerCase() === distributorAddress.toLowerCase()) {
    console.log(`${contractName}: feeWalletDistributor is already ${distributorAddress} — nothing to do.`);
    return;
  }

  console.log(
    `${contractName}: setting feeWalletDistributor ${currentDistributor} -> ${distributorAddress} ` +
      "(every taxed transfer's fee-wallet remainder on launches FROM NOW ON will route here for automatic " +
      "ETH conversion instead of straight to the plain platformFeeWallet address)..."
  );
  const tx = await factory.setFeeWalletDistributor(distributorAddress);
  await tx.wait();
  console.log(`${contractName}: setFeeWalletDistributor(${distributorAddress}) confirmed (tx ${tx.hash}).`);
}

async function main() {
  const distributorAddress = process.env.FEE_WALLET_DISTRIBUTOR_ADDRESS;
  if (!distributorAddress) {
    throw new Error(
      "Set FEE_WALLET_DISTRIBUTOR_ADDRESS to the already-deployed FeeWalletDistributor's address " +
        "(the same one scripts/relayer.js's own FEE_WALLET_DISTRIBUTOR_ADDRESS env var already points at, " +
        "if the off-chain sweep is already running against it)."
    );
  }
  if (!hre.ethers.isAddress(distributorAddress)) {
    throw new Error(`FEE_WALLET_DISTRIBUTOR_ADDRESS (${distributorAddress}) is not a valid address.`);
  }

  const tokenFactoryAddress = process.env.TOKEN_FACTORY_ADDRESS || null;
  const customTokenFactoryAddress = process.env.CUSTOM_TOKEN_FACTORY_ADDRESS || null;
  if (!tokenFactoryAddress && !customTokenFactoryAddress) {
    throw new Error("Set at least one of TOKEN_FACTORY_ADDRESS / CUSTOM_TOKEN_FACTORY_ADDRESS.");
  }

  const [ownerSigner] = await hre.ethers.getSigners();
  console.log(`Running as: ${ownerSigner.address}`);
  console.log(`Wiring feeWalletDistributor to: ${distributorAddress}`);

  if (tokenFactoryAddress) await setDistributorOn("TokenFactory", tokenFactoryAddress, distributorAddress, ownerSigner);
  if (customTokenFactoryAddress)
    await setDistributorOn("CustomTokenFactory", customTokenFactoryAddress, distributorAddress, ownerSigner);

  console.log(
    "\nDone. This only affects launches made FROM NOW ON — any token already launched against these factories " +
      "keeps sending its fee-wallet remainder straight to the plain platformFeeWallet address, permanently " +
      "(there's no setter on an already-launched LaunchedToken/CustomToken to point it at a distributor after " +
      "the fact). No relayer.js restart needed for this one: postLaunchPipeline reads fee-wallet state fresh " +
      "from each token's own contract at launch time, not from anything relayer.js caches at startup."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
