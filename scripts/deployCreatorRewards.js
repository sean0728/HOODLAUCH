const hre = require("hardhat");
const { verifyContract } = require("../lib/verify");

// ---------------------------------------------------------------------
// Deploys ONLY CreatorRewardsDistributor. Like deployPlatformRewards.js,
// this script does NOT touch TokenFactory or CustomTokenFactory at all —
// it never redeploys them, so the already-live factories (and every token
// already launched through them) are completely unaffected. Wiring the
// resulting distributor address into those existing factories, and
// turning on a nonzero creatorRewardBps, is done afterwards from the
// site's own admin panel (Platform Contracts -> Creator rewards
// distributor -> Update, then "Update tax defaults" for the bps) using
// your connected wallet.
//
// Unlike PlatformRewardsDistributor, CreatorRewardsDistributor needs no
// platform-token reference or "seed a token" step: it swaps whatever
// creatorRewardBps-cut balance it holds of a given launched token for ETH
// on demand (triggerCreatorSwap), and pays that token's own creator()
// on claim (claimCreatorRewards) — both permissionless, both per-token.
//
// Usage (from hoodlaunch-contracts/):
//   TOKEN_FACTORY_ADDRESS="0x6e295099aFA9d88a27131674531A4e6D229e59BE" \
//   npx hardhat run scripts/deployCreatorRewards.js --network robinhoodTestnet
//
// TOKEN_FACTORY_ADDRESS is the only required env var (used only to read
// the already-deployed factory's own router() so the distributor talks to
// the exact same DEX router your launches already use — nothing is
// written to the factory). CREATOR_REWARDS_DISTRIBUTOR_OWNER_ADDRESS
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

  const creatorRewardsDistributorOwner = process.env.CREATOR_REWARDS_DISTRIBUTOR_OWNER_ADDRESS || deployer.address;
  const CreatorRewardsDistributor = await hre.ethers.getContractFactory("CreatorRewardsDistributor");
  const distributor = await CreatorRewardsDistributor.deploy(routerAddress, creatorRewardsDistributorOwner);
  await distributor.waitForDeployment();
  const creatorRewardsDistributorAddress = await distributor.getAddress();
  console.log(
    `CreatorRewardsDistributor deployed at ${creatorRewardsDistributorAddress}, owned by ${creatorRewardsDistributorOwner}.`
  );

  console.log("\nDeployment summary:");
  console.log(
    JSON.stringify(
      {
        creatorRewardsDistributor: creatorRewardsDistributorAddress,
        router: routerAddress,
        existingTokenFactory: tokenFactoryAddress,
      },
      null,
      2
    )
  );

  console.log(
    "\nNeither TokenFactory nor CustomTokenFactory has been touched. To finish wiring this in:\n" +
      "  1. On the site, open the admin panel -> Platform Contracts, paste the CreatorRewardsDistributor\n" +
      `     address above (${creatorRewardsDistributorAddress}) into "Creator rewards distributor" and save.\n` +
      "  2. Still in the admin panel, wire it to TokenFactory and CustomTokenFactory (sends\n" +
      "     setCreatorRewardsDistributor() to both from your connected wallet — it must be the current\n" +
      "     owner of those factories).\n" +
      "  3. Set a creator-reward bps under \"Update tax defaults\" so a slice of the ongoing trading tax\n" +
      "     actually reaches the distributor (0 by default until you set it; recall rewardBps +\n" +
      "     creatorRewardBps must stay <= feeBps).\n"
  );

  if (network === "robinhoodTestnet" || network === "robinhoodMainnet") {
    console.log("Verifying contract on the block explorer (best-effort)...");
    await verifyContract(creatorRewardsDistributorAddress, [routerAddress, creatorRewardsDistributorOwner]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
