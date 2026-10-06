// Seeds the platform token's own DEX pool -- the "separate, later step"
// PlatformToken.sol's own doc comment and scripts/deploy.js's own console
// output both call out explicitly. PlatformToken is deployed with its ENTIRE
// fixed supply sitting in one wallet (PLATFORM_TOKEN_INITIAL_HOLDER at deploy
// time, normally the deployer), and nothing in PlatformToken.sol or
// scripts/deploy.js ever adds liquidity for it automatically -- unlike every
// creator-launched token, which gets its pool seeded as part of TokenFactory/
// BondingCurveFactory's own built-in launch flow. This script does the two
// on-chain calls PlatformToken.sol's own doc comment says to do "directly
// against the DEX router": approve the router for the token amount, then
// call addLiquidityETH with that amount plus the ETH you're sending as
// msg.value.
//
// Reads the router address live off an already-deployed TokenFactory (same
// convention as scripts/deployCreatorRewards.js/deployFeeWalletDistributor.js)
// rather than hardcoding one, since Robinhood Chain testnet has no single
// confirmed router address (see scripts/deploy.js's own KNOWN_ROUTER_ADDRESSES
// comment -- 15 different unverified copies exist there). Whatever router
// your TokenFactory already trades every other token against is the right
// one to use here too, so the platform token ends up tradeable through the
// same DEX as everything else on the platform.
//
// Must be run by whichever wallet actually holds the PlatformToken supply
// (PLATFORM_TOKEN_INITIAL_HOLDER at deploy time) -- the script checks the
// signer's token and ETH balances up front and fails with a plain message
// rather than letting the on-chain call revert with a cryptic "transfer
// amount exceeds balance".
//
// Required env:
//   PLATFORM_TOKEN_ADDRESS - the deployed PlatformToken's address.
//   TOKEN_FACTORY_ADDRESS  - any already-deployed TokenFactory/
//                            CustomTokenFactory on this network, used only
//                            to read its router() -- nothing is ever written
//                            to it.
//   TOKEN_AMOUNT           - how many whole PlatformToken units to seed,
//                            e.g. TOKEN_AMOUNT=500000 for 500,000 tokens.
//                            Human units, not wei -- converted using the
//                            token's own decimals().
//   ETH_AMOUNT             - how much ETH to pair against it, e.g.
//                            ETH_AMOUNT=2.5. Sent as msg.value -- make sure
//                            the signer actually holds this much ETH, plus
//                            gas on top.
//
// Optional env:
//   SLIPPAGE_BPS      - how far the actual pooled amounts are allowed to
//                       fall short of TOKEN_AMOUNT/ETH_AMOUNT before the
//                       transaction reverts, in basis points (default 100 =
//                       1%). Mainly protects a second/later top-up call
//                       against a stale quote -- the very first liquidity
//                       add for a token has no existing price to be
//                       sandwiched against, but it's still a sane floor to
//                       keep in place.
//   LP_RECIPIENT      - who receives the minted LP tokens (default: the
//                       signer running this script).
//   DEADLINE_MINUTES  - how long the transaction stays valid before the
//                       router reverts it (default 20).
//
// Example:
//   PLATFORM_TOKEN_ADDRESS=0x... TOKEN_FACTORY_ADDRESS=0x... \
//   TOKEN_AMOUNT=500000 ETH_AMOUNT=2.5 \
//     npx hardhat run scripts/addPlatformTokenLiquidity.js --network robinhoodTestnet
const hre = require("hardhat");

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const ROUTER_ABI = [
  "function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline) payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)",
  "function factory() view returns (address)",
  "function WETH() view returns (address)",
];

const DEX_FACTORY_ABI = ["function getPair(address tokenA, address tokenB) view returns (address)"];

function applySlippage(amount, slippageBps) {
  return (amount * BigInt(10_000 - slippageBps)) / 10_000n;
}

async function main() {
  const platformTokenAddress = process.env.PLATFORM_TOKEN_ADDRESS;
  const tokenFactoryAddress = process.env.TOKEN_FACTORY_ADDRESS;
  const tokenAmountInput = process.env.TOKEN_AMOUNT;
  const ethAmountInput = process.env.ETH_AMOUNT;

  if (!platformTokenAddress || !hre.ethers.isAddress(platformTokenAddress)) {
    throw new Error("Set PLATFORM_TOKEN_ADDRESS to the deployed PlatformToken's address.");
  }
  if (!tokenFactoryAddress || !hre.ethers.isAddress(tokenFactoryAddress)) {
    throw new Error(
      "Set TOKEN_FACTORY_ADDRESS to any already-deployed TokenFactory/CustomTokenFactory on this network -- " +
        "only its router() getter is read, nothing is written to it."
    );
  }
  if (!tokenAmountInput || Number(tokenAmountInput) <= 0) {
    throw new Error("Set TOKEN_AMOUNT to how many whole PlatformToken units to seed, e.g. TOKEN_AMOUNT=500000.");
  }
  if (!ethAmountInput || Number(ethAmountInput) <= 0) {
    throw new Error("Set ETH_AMOUNT to how much ETH to pair against it, e.g. ETH_AMOUNT=2.5.");
  }
  const slippageBps = process.env.SLIPPAGE_BPS != null ? Number(process.env.SLIPPAGE_BPS) : 100;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error("SLIPPAGE_BPS must be an integer between 0 and 9999.");
  }
  const deadlineMinutes = process.env.DEADLINE_MINUTES != null ? Number(process.env.DEADLINE_MINUTES) : 20;
  if (process.env.LP_RECIPIENT && !hre.ethers.isAddress(process.env.LP_RECIPIENT)) {
    throw new Error(`LP_RECIPIENT (${process.env.LP_RECIPIENT}) is not a valid address.`);
  }

  const [signer] = await hre.ethers.getSigners();
  const lpRecipient = process.env.LP_RECIPIENT || signer.address;

  const tokenFactory = await hre.ethers.getContractAt("TokenFactory", tokenFactoryAddress, signer);
  const routerAddress = await tokenFactory.router();
  console.log(`Using router ${routerAddress} (read live off TokenFactory ${tokenFactoryAddress}).`);

  const platformToken = await hre.ethers.getContractAt(ERC20_ABI, platformTokenAddress, signer);
  const router = await hre.ethers.getContractAt(ROUTER_ABI, routerAddress, signer);
  const dexFactoryAddress = await router.factory();
  const dexFactory = await hre.ethers.getContractAt(DEX_FACTORY_ABI, dexFactoryAddress, signer);
  const weth = await router.WETH();

  const existingPair = await dexFactory.getPair(platformTokenAddress, weth);
  if (existingPair !== hre.ethers.ZeroAddress) {
    console.log(
      `Heads up: a pool for this token already exists at ${existingPair}. addLiquidityETH will add to it, not ` +
        "create a new one -- if that pool's current price doesn't match what TOKEN_AMOUNT/ETH_AMOUNT implies, the " +
        "router only pulls in amounts matching the EXISTING ratio and leaves the rest in your wallet, which is " +
        "exactly what the slippage check below exists to catch rather than silently accept a lopsided ratio."
    );
  }

  const decimals = await platformToken.decimals();
  const symbol = await platformToken.symbol().catch(() => "PLATFORM");
  const tokenAmountWei = hre.ethers.parseUnits(tokenAmountInput, decimals);
  const ethAmountWei = hre.ethers.parseEther(ethAmountInput);

  const balance = await platformToken.balanceOf(signer.address);
  if (balance < tokenAmountWei) {
    throw new Error(
      `Signer ${signer.address} only holds ${hre.ethers.formatUnits(balance, decimals)} ${symbol}, less than the ` +
        `${tokenAmountInput} ${symbol} you asked to seed. Run this as whichever wallet actually holds the ` +
        "PlatformToken supply (PLATFORM_TOKEN_INITIAL_HOLDER at deploy time)."
    );
  }
  const signerEthBalance = await hre.ethers.provider.getBalance(signer.address);
  if (signerEthBalance < ethAmountWei) {
    throw new Error(
      `Signer ${signer.address} only holds ${hre.ethers.formatEther(signerEthBalance)} ETH, less than the ` +
        `${ethAmountInput} ETH you asked to pair (plus gas on top of that).`
    );
  }

  const currentAllowance = await platformToken.allowance(signer.address, routerAddress);
  if (currentAllowance < tokenAmountWei) {
    console.log(`Approving router to spend ${tokenAmountInput} ${symbol}...`);
    const approveTx = await platformToken.approve(routerAddress, tokenAmountWei);
    await approveTx.wait();
    console.log(`Approved (tx ${approveTx.hash}).`);
  } else {
    console.log("Router already has sufficient allowance -- skipping approve.");
  }

  const amountTokenMin = applySlippage(tokenAmountWei, slippageBps);
  const amountEthMin = applySlippage(ethAmountWei, slippageBps);
  const deadline = Math.floor(Date.now() / 1000) + deadlineMinutes * 60;

  console.log(
    `Adding liquidity: ${tokenAmountInput} ${symbol} + ${ethAmountInput} ETH (min accepted ` +
      `${hre.ethers.formatUnits(amountTokenMin, decimals)} ${symbol} / ${hre.ethers.formatEther(amountEthMin)} ETH, ` +
      `${slippageBps / 100}% slippage), LP tokens to ${lpRecipient}...`
  );
  const tx = await router.addLiquidityETH(
    platformTokenAddress,
    tokenAmountWei,
    amountTokenMin,
    amountEthMin,
    lpRecipient,
    deadline,
    { value: ethAmountWei }
  );
  const receipt = await tx.wait();
  console.log(`Liquidity added (tx ${tx.hash}, block ${receipt.blockNumber}).`);

  const pairAddress = await dexFactory.getPair(platformTokenAddress, weth);
  console.log(`Pool address: ${pairAddress}`);
  console.log(
    "\nNothing here locks this liquidity -- it's plain LP tokens sitting in the recipient wallet, unlike every " +
      "creator-launched token's pool (which LiquidityLocker.sol time-locks automatically as part of the normal " +
      "launch flow). If you want the same lock behavior for the platform token's own pool, that's a separate, " +
      "manual step: send the LP tokens this just minted into LiquidityLocker.sol yourself. Leaving them unlocked " +
      "in your own wallet means you personally retain the ability to pull this liquidity back out at any time -- " +
      "worth deciding deliberately rather than by default, especially before telling anyone this pool is live."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});