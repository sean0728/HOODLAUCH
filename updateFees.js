// Keeps an already-deployed TokenFactory's deployFee/launchFee tracking
// their USD targets ($50 for "Deploy Token", $100 for "Deploy and Add
// Liquidity (Launch)") as ETH's price moves. The contract itself has no
// live price awareness — it only stores a fixed wei amount (see the
// NatSpec on TokenFactory) — so this script is the off-chain half of that:
// fetch a live ETH/USD price, recompute what $50/$100 is in wei right now,
// and call setDeployFee()/setLaunchFee() if either has drifted past a
// threshold. Run it by hand, or on a schedule (e.g. an hourly cron —
// there's no need to run this every minute just because the price moves
// that often; a modest drift tolerance below avoids spamming transactions
// over noise).
//
// Required env: TOKEN_FACTORY_ADDRESS.
// Optional env:
//   DEPLOY_FEE_USD_TARGET     default 50
//   LAUNCH_FEE_USD_TARGET     default 100
//   FEE_DRIFT_TOLERANCE_PCT   default 3 — only send a tx if the live target
//                             differs from the current on-chain fee by more
//                             than this percentage, to avoid paying gas to
//                             chase every tiny price tick.
//
// Example:
//   TOKEN_FACTORY_ADDRESS=0x... npx hardhat run scripts/updateFees.js --network robinhoodMainnet
const hre = require("hardhat");

async function fetchEthUsdPrice() {
  const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
  if (!res.ok) throw new Error(`Price API returned ${res.status}`);
  const data = await res.json();
  const price = data && data.ethereum && data.ethereum.usd;
  if (typeof price !== "number" || price <= 0) throw new Error("Price API returned an unusable value");
  return price;
}

function pctDiff(a, b) {
  if (a === 0n) return b === 0n ? 0 : Infinity;
  const diff = a > b ? a - b : b - a;
  return (Number(diff) / Number(a)) * 100;
}

async function main() {
  const factoryAddress = process.env.TOKEN_FACTORY_ADDRESS;
  if (!factoryAddress) throw new Error("Set TOKEN_FACTORY_ADDRESS to the deployed TokenFactory address.");

  const deployUsdTarget = Number(process.env.DEPLOY_FEE_USD_TARGET || 50);
  const launchUsdTarget = Number(process.env.LAUNCH_FEE_USD_TARGET || 100);
  const driftTolerancePct = Number(process.env.FEE_DRIFT_TOLERANCE_PCT || 3);

  const ethUsdPrice = await fetchEthUsdPrice();
  console.log(`Live ETH price: $${ethUsdPrice}`);

  const [signer] = await hre.ethers.getSigners();
  const factory = await hre.ethers.getContractAt("TokenFactory", factoryAddress, signer);

  const targetDeployFeeWei = hre.ethers.parseEther((deployUsdTarget / ethUsdPrice).toFixed(18));
  const targetLaunchFeeWei = hre.ethers.parseEther((launchUsdTarget / ethUsdPrice).toFixed(18));

  const currentDeployFeeWei = await factory.deployFee();
  const currentLaunchFeeWei = await factory.launchFee();

  const deployDriftPct = pctDiff(currentDeployFeeWei, targetDeployFeeWei);
  const launchDriftPct = pctDiff(currentLaunchFeeWei, targetLaunchFeeWei);

  console.log(
    `Deploy fee — on-chain: ${hre.ethers.formatEther(currentDeployFeeWei)} ETH, ` +
      `target ($${deployUsdTarget}): ${hre.ethers.formatEther(targetDeployFeeWei)} ETH, drift ${deployDriftPct.toFixed(2)}%`
  );
  console.log(
    `Launch fee — on-chain: ${hre.ethers.formatEther(currentLaunchFeeWei)} ETH, ` +
      `target ($${launchUsdTarget}): ${hre.ethers.formatEther(targetLaunchFeeWei)} ETH, drift ${launchDriftPct.toFixed(2)}%`
  );

  if (deployDriftPct > driftTolerancePct) {
    console.log(`Deploy fee drifted past ${driftTolerancePct}% — updating on-chain.`);
    const tx = await factory.setDeployFee(targetDeployFeeWei);
    await tx.wait();
    console.log(`setDeployFee(${targetDeployFeeWei}) confirmed.`);
  } else {
    console.log("Deploy fee within tolerance — no update needed.");
  }

  if (launchDriftPct > driftTolerancePct) {
    console.log(`Launch fee drifted past ${driftTolerancePct}% — updating on-chain.`);
    const tx = await factory.setLaunchFee(targetLaunchFeeWei);
    await tx.wait();
    console.log(`setLaunchFee(${targetLaunchFeeWei}) confirmed.`);
  } else {
    console.log("Launch fee within tolerance — no update needed.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
