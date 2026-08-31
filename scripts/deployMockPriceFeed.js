// Deploys MockAggregatorV3 as a stand-in Chainlink ETH/USD feed, for use
// ONLY where no real Chainlink feed exists yet — currently that's
// robinhoodTestnet (chain 46630). See .env.example's PRICE_FEED_ADDRESS
// comment and the README for the full "why": Robinhood's own docs point at
// Chainlink's official address directory rather than hardcoding a testnet
// feed themselves, and nothing there is confirmed for testnet the way the
// mainnet ETH/USD Standard Proxy is.
//
// This intentionally refuses to run against robinhoodMainnet (or any
// network not explicitly allowed below) — a mock, unauthenticated price
// feed must never end up backing a real deployment. See the WARNING in the
// deployment summary below for exactly what "unauthenticated" means here.
//
// Usage:
//   npx hardhat run scripts/deployMockPriceFeed.js --network robinhoodTestnet
//
// Optional env var:
//   MOCK_PRICE_FEED_USD=3000   # the fixed ETH/USD price to report, defaults to 3000
//
// Once deployed, put its address in PRICE_FEED_ADDRESS in your .env before
// running scripts/deploy.js against the same network.
const hre = require("hardhat");
const { verifyContract } = require("../lib/verify");

// Networks a mock price feed is allowed to be deployed to. Deliberately an
// allowlist (not "anything but mainnet") so a typo'd or future network name
// doesn't accidentally sail through — add to this list only for networks
// that are genuinely test/staging environments.
const ALLOWED_NETWORKS = ["robinhoodTestnet", "hardhat", "localhost"];

async function main() {
  const network = hre.network.name;
  if (!ALLOWED_NETWORKS.includes(network)) {
    throw new Error(
      `Refusing to deploy MockAggregatorV3 to "${network}". This is a fixed-price, unauthenticated stand-in ` +
        `for a real Chainlink feed — it must never be used anywhere real money is at stake. Allowed networks: ` +
        `${ALLOWED_NETWORKS.join(", ")}. If robinhoodMainnet ever needs this for some reason, that's a sign ` +
        "something else is wrong — a real feed already exists for mainnet (see KNOWN_PRICE_FEED_ADDRESSES in " +
        "scripts/deploy.js), so this script should never be the answer there."
    );
  }

  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deploying with account: ${deployer.address}`);
  console.log(`Network: ${network}`);

  const priceUsd = Number(process.env.MOCK_PRICE_FEED_USD || 3000);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new Error(`MOCK_PRICE_FEED_USD must be a positive number if set (got "${process.env.MOCK_PRICE_FEED_USD}").`);
  }
  const decimals = 8; // matches every real Chainlink USD feed's convention
  const initialAnswer = BigInt(Math.round(priceUsd * 10 ** decimals));

  const MockAggregatorV3 = await hre.ethers.getContractFactory("MockAggregatorV3");
  const constructorArgs = [decimals, initialAnswer];
  const feed = await MockAggregatorV3.deploy(...constructorArgs);
  await feed.waitForDeployment();
  const feedAddress = await feed.getAddress();

  console.log(`MockAggregatorV3 deployed at ${feedAddress}, reporting a fixed $${priceUsd.toFixed(2)}/ETH.`);

  const verification = await verifyContract(feedAddress, constructorArgs);

  console.log("\nDeployment summary:");
  console.log({
    priceFeed: feedAddress,
    network,
    decimals,
    initialPriceUsd: priceUsd,
    verified: verification.verified,
  });
  console.log(
    "\nWARNING — read before relying on this: MockAggregatorV3.setAnswer(int256) has no access control at " +
      "all (see contracts/mocks/MockAggregatorV3.sol) — literally anyone can call it and change the reported " +
      "price at any time, which would shift exactly when this platform's transfer tax auto-disables (the " +
      "$80,000 graduation check reads straight from this feed). Completely fine for testnet, where that's " +
      "nobody's real money — but this is exactly why this script refuses to run on mainnet, and why you " +
      "should never reuse this specific deployed address for anything beyond testing.\n" +
      `\nNext step: set PRICE_FEED_ADDRESS=${feedAddress} in your .env, then run ` +
      "scripts/deploy.js against this same network."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
