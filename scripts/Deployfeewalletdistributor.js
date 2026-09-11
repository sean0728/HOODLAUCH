const hre = require("hardhat");
const { verifyContract } = require("../lib/verify");

// ---------------------------------------------------------------------
// Deploys ONLY FeeWalletDistributor. Like deployCreatorRewards.js, this
// script does NOT touch TokenFactory or CustomTokenFactory at all — it
// never redeploys them, so the already-live factories (and every token
// already launched through them) are completely unaffected. Wiring the
// resulting distributor address into those existing factories is done
// afterwards from the site's own admin panel (Platform Contracts -> Fee
// wallet distributor -> Update) using your connected wallet.
//
// Unlike CreatorRewardsDistributor (which pays each token's own, possibly
// changing, creator()), FeeWalletDistributor pays every token's fee-wallet
// slice to the SAME single address — its own feeWallet, set at deploy time
// and owner-changeable afterward via setFeeWallet(). Everything else about
// it (in-kind accumulation, permissionless triggerFeeWalletSwap per token,
// permissionless claimFeeWalletRewards per token, swapThreshold/
// maxSwapAmount anti-dust/anti-dump knobs) mirrors CreatorRewardsDistributor
// exactly.
//
// Usage (from hoodlaunch-contracts/):
//   TOKEN_FACTORY_ADDRESS="0x6e295099aFA9d88a27131674531A4e6D229e59BE" \
//   FEE_WALLET_ADDRESS="0x..." \
//   npx hardhat run scripts/deployFeeWalletDistributor.js --network robinhoodTestnet
//
// TOKEN_FACTORY_ADDRESS is used only to read the already-deployed factory's
// own router() so the distributor talks to the exact same DEX router your
// launches already use — nothing is written to the factory. FEE_WALLET_ADDRESS
// is the address every token's fee-wallet slice will ultimately pay out to
// (defaults to your existing TokenFactory.platformFeeWallet() if unset, since
// that's almost always what you want this to match). FEE_WALLET_DISTRIBUTOR_OWNER_ADDRESS
// optionally sets a different owner than the deploying wallet.
async function main() {
  const network = hre.network.name;
  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deploying with account: ${deployer.address}`);
  console.log(`Network: ${network}`);

  const tokenFactoryAddress = process.env.TOKEN_FACTORY_ADDRESS;
  if (!tokenFactoryAddress) {
    throw new Error(
      "Set TOKEN_FACTORY_ADDRESS to your already-deployed TokenFactory's address " +
        "(0x6e295099aFA9d88a27131674531A4e6D229e59BE on testnet) so this script can read " +
        "its router() and deploy the distributor against that same DEX router."
    );
  }
  const tokenFactory = await hre.ethers.getContractAt("TokenFactory", tokenFactoryAddress);
  const routerAddress = await tokenFactory.router();
  console.log(`Read router ${routerAddress} from existing TokenFactory at ${tokenFactoryAddress}.`);

  let feeWalletAddress = process.env.FEE_WALLET_ADDRESS;
  if (!feeWalletAddress) {
    feeWalletAddress = await tokenFactory.platformFeeWallet();
    console.log(`FEE_WALLET_ADDRESS not set — defaulting to TokenFactory.platformFeeWallet() (${feeWalletAddress}).`);
  }
  if (!feeWalletAddress || feeWalletAddress === hre.ethers.ZeroAddress) {
    throw new Error(
      "No usable fee wallet address: set FEE_WALLET_ADDRESS explicitly, or make sure " +
        "TokenFactory.platformFeeWallet() is already configured."
    );
  }

  const feeWalletDistributorOwner = process.env.FEE_WALLET_DISTRIBUTOR_OWNER_ADDRESS || deployer.address;
  const FeeWalletDistributor = await hre.ethers.getContractFactory("FeeWalletDistributor");
  const distributor = await FeeWalletDistributor.deploy(routerAddress, feeWalletDistributorOwner, feeWalletAddress);
  await distributor.waitForDeployment();
  const feeWalletDistributorAddress = await distributor.getAddress();
  console.log(
    `FeeWalletDistributor deployed at ${feeWalletDistributorAddress}, owned by ${feeWalletDistributorOwner}, ` +
      `paying out to ${feeWalletAddress}.`
  );

  console.log("\nDeployment summary:");
  console.log(
    JSON.stringify(
      {
        feeWalletDistributor: feeWalletDistributorAddress,
        feeWallet: feeWalletAddress,
        router: routerAddress,
        existingTokenFactory: tokenFactoryAddress,
      },
      null,
      2
    )
  );

  console.log(
    "\nNeither TokenFactory nor CustomTokenFactory has been touched. To finish wiring this in:\n" +
      "  1. On the site, open the admin panel -> Platform Contracts, paste the FeeWalletDistributor\n" +
      `     address above (${feeWalletDistributorAddress}) into "Fee wallet distributor" and save.\n` +
      "  2. Still in the admin panel, wire it to TokenFactory and CustomTokenFactory (sends\n" +
      "     setFeeWalletDistributor() to both from your connected wallet — it must be the current owner\n" +
      "     of those factories).\n" +
      "  3. Set FEE_WALLET_DISTRIBUTOR_ADDRESS on the relayer's environment (see scripts/relayer.js's\n" +
      "     module comment) so it starts auto-sweeping every launched token's accumulated balance into\n" +
      "     ETH on a schedule — without it, triggerFeeWalletSwap still works, it just needs someone to\n" +
      "     call it manually.\n" +
      "  4. This only ever affects tokens launched AFTER step 2 — every already-launched token keeps\n" +
      "     sending its fee-wallet slice straight to the plain feeWallet address it was configured with,\n" +
      "     exactly as before (see LaunchedToken.configureTax / CustomToken.configurePlatformTax).\n"
  );

  if (network === "robinhoodTestnet" || network === "robinhoodMainnet") {
    console.log("Verifying contract on the block explorer (best-effort)...");
    await verifyContract(feeWalletDistributorAddress, [routerAddress, feeWalletDistributorOwner, feeWalletAddress]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});