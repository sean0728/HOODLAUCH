// Pushes new platform trading-tax defaults (feeBps, graduationTargetUsd,
// rewardBps, creatorRewardBps) to an already-deployed TokenFactory and/or
// CustomTokenFactory via setTaxDefaults(). This is the scriptable
// alternative to filling out the admin-panel UI's "tax defaults" form by
// hand — same underlying owner-only call, just driven from env vars so it
// can be run repeatably/from CI instead of clicked through.
//
// setTaxDefaults() takes seven parameters, but only four of them are what
// this script is actually changing: feeBps_, graduationTargetUsd_,
// rewardBps_, and creatorRewardBps_. The other three — platformFeeWallet_,
// priceFeed_, and maxOracleStaleness_ — are NOT being touched by this
// script at all, so it always reads each factory's CURRENT on-chain value
// for those three and echoes them straight back into the call unchanged.
// This matters: the admin-panel UI's own version of this form has a known
// bug where leaving its wallet/price-feed fields blank submits address(0),
// which would permanently disable the platform tax on that factory. This
// script must never make that mistake.
//
// Works on either or both factories in a single run, and is idempotent —
// if a factory's on-chain values already exactly match the requested
// targets, it skips sending a transaction for that factory rather than
// wasting gas on a no-op.
//
// Required env (at least one of):
//   TOKEN_FACTORY_ADDRESS         deployed TokenFactory address
//   CUSTOM_TOKEN_FACTORY_ADDRESS  deployed CustomTokenFactory address
// Optional env (new tax-default targets, applied to every factory given
// above):
//   TAX_FEE_BPS                   default 100  (1.00%)
//   TAX_REWARD_BPS                default 45   (0.45%)
//   TAX_CREATOR_REWARD_BPS        default 10   (0.10%)
//   TAX_GRADUATION_TARGET_USD     default 50000
//
// Example (both factories in one run):
//   TOKEN_FACTORY_ADDRESS=0x... CUSTOM_TOKEN_FACTORY_ADDRESS=0x... \
//     npx hardhat run scripts/updateTaxDefaults.js --network robinhoodMainnet
const hre = require("hardhat");

async function updateFactoryTaxDefaults(contractName, address, targets, signer) {
  const factory = await hre.ethers.getContractAt(contractName, address, signer);

  const [
    currentFeeBps,
    currentGraduationTargetUsd,
    currentRewardBps,
    currentCreatorRewardBps,
    platformFeeWallet,
    priceFeed,
    maxOracleStaleness,
  ] = await Promise.all([
    factory.feeBps(),
    factory.graduationTargetUsd(),
    factory.rewardBps(),
    factory.creatorRewardBps(),
    factory.platformFeeWallet(),
    factory.priceFeed(),
    factory.maxOracleStaleness(),
  ]);

  console.log(`\n${contractName} (${address})`);
  console.log(
    `  current — feeBps: ${currentFeeBps}, graduationTargetUsd: ${currentGraduationTargetUsd}, ` +
      `rewardBps: ${currentRewardBps}, creatorRewardBps: ${currentCreatorRewardBps}`
  );
  console.log(
    `  current (unchanged by this script) — platformFeeWallet: ${platformFeeWallet}, ` +
      `priceFeed: ${priceFeed}, maxOracleStaleness: ${maxOracleStaleness}`
  );

  if (platformFeeWallet === hre.ethers.ZeroAddress) {
    console.log(`  WARNING: ${contractName}.platformFeeWallet is the zero address — platform tax is currently unconfigured.`);
  }
  if (priceFeed === hre.ethers.ZeroAddress) {
    console.log(`  WARNING: ${contractName}.priceFeed is the zero address — platform tax is currently unconfigured.`);
  }

  console.log(
    `  target — feeBps: ${targets.feeBps}, graduationTargetUsd: ${targets.graduationTargetUsd}, ` +
      `rewardBps: ${targets.rewardBps}, creatorRewardBps: ${targets.creatorRewardBps}`
  );

  const alreadyUpToDate =
    currentFeeBps === targets.feeBps &&
    currentGraduationTargetUsd === targets.graduationTargetUsd &&
    currentRewardBps === targets.rewardBps &&
    currentCreatorRewardBps === targets.creatorRewardBps;

  if (alreadyUpToDate) {
    console.log(`  ${contractName} already up to date — no transaction sent.`);
    return;
  }

  const tx = await factory.setTaxDefaults(
    platformFeeWallet,
    targets.feeBps,
    priceFeed,
    targets.graduationTargetUsd,
    maxOracleStaleness,
    targets.rewardBps,
    targets.creatorRewardBps
  );
  await tx.wait();
  console.log(`  setTaxDefaults(...) confirmed on ${contractName}.`);
}

async function main() {
  const tokenFactoryAddress = process.env.TOKEN_FACTORY_ADDRESS;
  const customTokenFactoryAddress = process.env.CUSTOM_TOKEN_FACTORY_ADDRESS;

  if (!tokenFactoryAddress && !customTokenFactoryAddress) {
    throw new Error(
      "Set at least one of TOKEN_FACTORY_ADDRESS / CUSTOM_TOKEN_FACTORY_ADDRESS to the deployed factory address(es)."
    );
  }

  const targets = {
    feeBps: BigInt(process.env.TAX_FEE_BPS || 100),
    rewardBps: BigInt(process.env.TAX_REWARD_BPS || 45),
    creatorRewardBps: BigInt(process.env.TAX_CREATOR_REWARD_BPS || 10),
    graduationTargetUsd: BigInt(process.env.TAX_GRADUATION_TARGET_USD || 50_000),
  };

  const [signer] = await hre.ethers.getSigners();

  if (tokenFactoryAddress) {
    await updateFactoryTaxDefaults("TokenFactory", tokenFactoryAddress, targets, signer);
  }
  if (customTokenFactoryAddress) {
    await updateFactoryTaxDefaults("CustomTokenFactory", customTokenFactoryAddress, targets, signer);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
