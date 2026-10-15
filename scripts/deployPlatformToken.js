// Deploys the platform's own token (contracts/PlatformToken.sol) -- the one Uniswap V2 token
// left on the platform. Everything else on Robinhood Chain launches on Uniswap V4.
//
// Why it is not V4: the V4 distributors (V4PlatformRewardsDistributor, V4FeeWalletDistributor,
// V4CreatorRewardsDistributor, V4PlatformTaxDistributor) buy the platform token back through a
// Uniswap V2 router and need the token's holder registry for the 50/50 burn/airdrop rounds.
// This token is a plain fixed-supply ERC20 with that registry; the pool you seed for it
// (scripts/addPlatformTokenLiquidity.js) is a V2 pool.
//
//   npx hardhat run scripts/deployPlatformToken.js --network robinhoodTestnet
//   npx hardhat run scripts/deployPlatformToken.js --network robinhoodMainnet
//
// The token keeps an append-only holder registry and balance snapshots (see contracts/PlatformToken.sol). Its
// owner (the deployer) must authorise each distributor as a snapshotter before setPlatformToken works on it:
// run scripts/authorizePlatformTokenSnapshotters.js with the owner's wallet.
//
// Settings (all optional, set in .env or the shell):
//   PLATFORM_TOKEN_NAME            default "Hood Launch"
//   PLATFORM_TOKEN_SYMBOL          default "HOOD"
//   PLATFORM_TOKEN_SUPPLY          whole tokens, 18 decimals (default 1000000000)
//   PLATFORM_TOKEN_INITIAL_HOLDER  who receives the whole supply (default: the deployer)
//
// The deployer becomes the token's owner (Ownable2Step). Afterwards, as the owner of the
// V4PlatformRewardsDistributor call setPlatformToken(token) (its V2 router was fixed at deploy
// time via DEX_ROUTER_ADDRESS), and on the V4PlatformTaxDistributor call setRouter(v2Router) then
// setPlatformToken(token). See V4_README.md.
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const name = process.env.PLATFORM_TOKEN_NAME || "Hood Launch";
  const symbol = process.env.PLATFORM_TOKEN_SYMBOL || "HOOD";
  const supply = hre.ethers.parseEther(process.env.PLATFORM_TOKEN_SUPPLY || "1000000000");
  const initialHolder = process.env.PLATFORM_TOKEN_INITIAL_HOLDER || deployer.address;
  if (!hre.ethers.isAddress(initialHolder)) throw new Error("PLATFORM_TOKEN_INITIAL_HOLDER is not a valid address.");

  console.log(`Deploying PlatformToken (${name} / ${symbol}) on ${hre.network.name} from ${deployer.address}...`);
  const args = [name, symbol, supply, initialHolder];
  const Token = await hre.ethers.getContractFactory("PlatformToken");
  const token = await Token.deploy(...args);
  await token.waitForDeployment();
  const address = await token.getAddress();
  console.log(`PlatformToken deployed at ${address}; the full supply was minted to ${initialHolder}.`);

  const dir = path.join(__dirname, "..", "deployments", hre.network.name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "platform-token.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ address, name, symbol, supply: supply.toString(), initialHolder, deployer: deployer.address, deployedAt: new Date().toISOString() }, null, 2)
  );
  console.log(`Saved ${file}`);

  try {
    const { verifyContract } = require("../lib/verify");
    const r = await verifyContract(address, args);
    console.log(r && r.verified ? "Verified on the explorer." : "Not verified automatically -- run `npx hardhat verify` with the constructor arguments above.");
  } catch (err) {
    console.log(`Explorer verification skipped (${err.message}).`);
  }

  console.log(
    "\nNext steps:\n" +
      "  1. Seed its Uniswap V2 pool:  PLATFORM_TOKEN_ADDRESS=" + address + " PLATFORM_ROUTER_ADDRESS=<v2 router> TOKEN_AMOUNT=... ETH_AMOUNT=... \\\n" +
      "       npx hardhat run scripts/addPlatformTokenLiquidity.js --network " + hre.network.name + "\n" +
      "  2. Token owner (this wallet): npx hardhat run scripts/authorizePlatformTokenSnapshotters.js --network " + hre.network.name + "\n" +
      "     (authorises the distributors as snapshotters; setPlatformToken refuses until then).\n" +
      "     V4PlatformRewardsDistributor (owner wallet): setPlatformToken(" + address + ").\n" +
      "     V4PlatformTaxDistributor (owner wallet): setRouter(<v2 router>) then setPlatformToken(" + address + ").\n" +
      "  3. Exclude the V2 pair (and any other non-holder address such as the router) from airdrops: setAirdropExcluded(<pair>, true) on the distributor(s) from step 2."
  );
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
