const hre = require("hardhat");
const { verifyContract } = require("../lib/verify");

// ---------------------------------------------------------------------
// Deploys ONLY PlatformToken + PlatformRewardsDistributor. Unlike
// deploy.js's DEPLOY_PLATFORM_TOKEN branch, this script does NOT touch
// TokenFactory or CustomTokenFactory at all — it never redeploys them,
// so the already-live factories (and every token already launched
// through them) are completely unaffected. Wiring the resulting
// distributor address into those existing factories, and turning on
// reward diversion, is done afterwards from the site's own admin panel
// (Platform Contracts -> Rewards distributor -> Update, then the
// "Reward diversion" toggle) using your connected wallet — that panel
// already sends the exact setRewardsDistributor()/tax-defaults
// transactions needed, no script required for that half.
//
// Usage (from hoodlaunch-contracts/):
//   PLATFORM_TOKEN_NAME="Hood Launch" \
//   PLATFORM_TOKEN_SYMBOL="HOOD" \
//   PLATFORM_TOKEN_SUPPLY="1000000000" \
//   TOKEN_FACTORY_ADDRESS="0x6e295099aFA9d88a27131674531A4e6D229e59BE" \
//   npx hardhat run scripts/deployPlatformRewards.js --network robinhoodTestnet
//
// Every env var above is optional except TOKEN_FACTORY_ADDRESS (only used
// to read the already-deployed factory's own router() so the distributor
// talks to the exact same DEX router your launches already use — nothing
// is written to the factory). Defaults: name "Hood Launch", symbol "HOOD",
// supply 1,000,000,000 (18 decimals applied automatically), initial
// holder and distributor owner both default to the deploying wallet.
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

  const platformTokenAddressEnv = process.env.PLATFORM_TOKEN_ADDRESS || null;
  let platformTokenAddress = platformTokenAddressEnv;

  if (!platformTokenAddress) {
    const platformTokenName = process.env.PLATFORM_TOKEN_NAME || "Hood Launch";
    const platformTokenSymbol = process.env.PLATFORM_TOKEN_SYMBOL || "HOOD";
    const platformTokenSupply = hre.ethers.parseEther(process.env.PLATFORM_TOKEN_SUPPLY || "1000000000");
    const platformTokenInitialHolder = process.env.PLATFORM_TOKEN_INITIAL_HOLDER || deployer.address;

    const PlatformToken = await hre.ethers.getContractFactory("PlatformToken");
    const platformToken = await PlatformToken.deploy(
      platformTokenName,
      platformTokenSymbol,
      platformTokenSupply,
      platformTokenInitialHolder
    );
    await platformToken.waitForDeployment();
    platformTokenAddress = await platformToken.getAddress();
    console.log(
      `PlatformToken (${platformTokenName} / ${platformTokenSymbol}) deployed at ${platformTokenAddress}, ` +
        `full supply minted to ${platformTokenInitialHolder}.`
    );
  } else {
    console.log(`Reusing already-deployed PlatformToken at ${platformTokenAddress}.`);
  }

  const rewardsDistributorOwner = process.env.REWARDS_DISTRIBUTOR_OWNER_ADDRESS || deployer.address;
  const PlatformRewardsDistributor = await hre.ethers.getContractFactory("PlatformRewardsDistributor");
  const distributor = await PlatformRewardsDistributor.deploy(routerAddress, rewardsDistributorOwner);
  await distributor.waitForDeployment();
  const rewardsDistributorAddress = await distributor.getAddress();
  console.log(`PlatformRewardsDistributor deployed at ${rewardsDistributorAddress}, owned by ${rewardsDistributorOwner}.`);

  const setPlatformTokenTx = await distributor.connect(deployer).setPlatformToken(platformTokenAddress);
  await setPlatformTokenTx.wait();
  console.log(`PlatformRewardsDistributor.setPlatformToken(${platformTokenAddress}) confirmed.`);
  if (rewardsDistributorOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    console.log(
      "Note: REWARDS_DISTRIBUTOR_OWNER_ADDRESS differs from the deploying account — setPlatformToken() " +
        "above was still sent by the deployer, which only works because ownership hadn't transferred yet " +
        "at the moment of deployment. Any further admin calls must come from the owner address itself."
    );
  }

  console.log("\nDeployment summary:");
  console.log(
    JSON.stringify(
      {
        platformToken: platformTokenAddress,
        platformRewardsDistributor: rewardsDistributorAddress,
        router: routerAddress,
        existingTokenFactory: tokenFactoryAddress,
      },
      null,
      2
    )
  );

  console.log(
    "\nNeither TokenFactory nor CustomTokenFactory has been touched. To finish wiring this in:\n" +
      "  1. On the site, open the admin panel -> Platform Contracts, paste the PlatformRewardsDistributor\n" +
      `     address above (${rewardsDistributorAddress}) into "Rewards distributor" and save.\n` +
      "  2. Still in the admin panel, use the \"Reward diversion\" toggle to switch it on for TokenFactory\n" +
      "     and CustomTokenFactory (sends setRewardsDistributor() to both from your connected wallet — it\n" +
      "     must be the current owner of those factories).\n" +
      "  3. Optionally set a reward-diversion bps under \"Update tax defaults\" so a slice of the ongoing\n" +
      "     trading tax actually reaches the distributor (0 by default until you set it).\n"
  );

  if (network === "robinhoodTestnet" || network === "robinhoodMainnet") {
    console.log("Verifying contracts on the block explorer (best-effort)...");
    if (!platformTokenAddressEnv) {
      await verifyContract(platformTokenAddress, [
        process.env.PLATFORM_TOKEN_NAME || "Hood Launch",
        process.env.PLATFORM_TOKEN_SYMBOL || "HOOD",
        hre.ethers.parseEther(process.env.PLATFORM_TOKEN_SUPPLY || "1000000000"),
        process.env.PLATFORM_TOKEN_INITIAL_HOLDER || deployer.address,
      ]);
    }
    await verifyContract(rewardsDistributorAddress, [routerAddress, rewardsDistributorOwner]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
