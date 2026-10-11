// Calls reclaimDeposit(voucherHash) on a factory to pull back ETH that was
// deposited for a gasless relayed launch whose relay attempt failed (or
// which was never picked up at all). The deposit is never touched by a
// failed relay -- see scripts/relayer.js's relayMatchedDeposit() own catch
// block, which explicitly leaves it "untouched and reclaimable once its
// deadline passes" -- this script is the missing piece: nothing in
// public/index.html or the admin panel currently calls reclaimDeposit for
// you, so this does it directly.
//
// Must be run by the SAME wallet that made the original deposit (via
// depositForRelayedLaunch) -- reclaimDeposit() is keyed off msg.sender, so
// any other wallet (including the admin/deployer wallet, if that's not who
// actually deposited) will simply find "no such deposit" even though the
// escrow is real.
//
// Only works once the deposit's own deadline has passed (30 minutes after
// it was made, by default -- RELAY_VOUCHER_TTL_SECONDS in index.html). If
// you call this too early it reverts with "deadline has not passed yet" --
// harmless, just means you need to wait a bit longer and try again.
//
// Required env:
//   FACTORY_ADDRESS   - the contract the deposit was sent to (V4TokenFactory
//                       or V4LaunchRelay, depending on the launch mode).
//   FACTORY_CONTRACT  - the contract NAME matching FACTORY_ADDRESS exactly:
//                       V4TokenFactory (plain launches) or V4LaunchRelay
//                       (custom-tax and Quick Launch).
//   VOUCHER_HASH      - the voucherHash for the failed launch, from your
//                       relayer's GET /failed-launches response (the admin
//                       panel's own "Failed Launches" tab doesn't show this
//                       on screen -- hit that URL directly, e.g.
//                       https://yourdomain.com/failed-launches, and find the
//                       matching entry).
//
// Example:
//   FACTORY_ADDRESS=0x... FACTORY_CONTRACT=V4LaunchRelay \
//   VOUCHER_HASH=0x... \
//     npx hardhat run scripts/reclaimDeposit.js --network robinhoodTestnet
const hre = require("hardhat");

// V4TokenFactory holds the escrow for plain launches (deploy-only and liquidity); V4LaunchRelay holds it for
// custom-tax, Quick Launch and custom-tax Quick Launch.
const VALID_CONTRACTS = ["V4TokenFactory", "V4LaunchRelay"];

async function main() {
  const factoryAddress = process.env.FACTORY_ADDRESS;
  const factoryContract = process.env.FACTORY_CONTRACT;
  const voucherHash = process.env.VOUCHER_HASH;

  if (!factoryAddress || !hre.ethers.isAddress(factoryAddress)) {
    throw new Error("Set FACTORY_ADDRESS to the factory this deposit was made against.");
  }
  if (!factoryContract || !VALID_CONTRACTS.includes(factoryContract)) {
    throw new Error(`Set FACTORY_CONTRACT to one of: ${VALID_CONTRACTS.join(", ")}.`);
  }
  if (!voucherHash || !/^0x[0-9a-fA-F]{64}$/.test(voucherHash)) {
    throw new Error("Set VOUCHER_HASH to the failed launch's voucherHash (0x + 64 hex chars), from GET /failed-launches.");
  }

  const [signer] = await hre.ethers.getSigners();
  console.log(`Reclaiming as ${signer.address} -- this MUST be the wallet that made the original deposit.`);

  const factory = await hre.ethers.getContractAt(factoryContract, factoryAddress, signer);

  const deposit = await factory.deposits(signer.address, voucherHash);
  console.log(
    `Deposit found: ${hre.ethers.formatEther(deposit.amount)} ETH, deadline ${new Date(Number(deposit.deadline) * 1000).toISOString()}, ` +
      `settled=${deposit.settled}, reclaimed=${deposit.reclaimed}.`
  );
  if (deposit.amount === 0n) {
    throw new Error(
      "No deposit found for this wallet + voucherHash on this factory. Either this isn't the depositor wallet, " +
        "the voucherHash is wrong, or it was already reclaimed/relayed."
    );
  }
  if (deposit.settled) {
    throw new Error("This voucher was already successfully relayed (settled=true) -- there's nothing to reclaim; the launch actually went through.");
  }
  if (deposit.reclaimed) {
    throw new Error("This deposit was already reclaimed previously -- check your wallet's past transactions, the ETH should already be back.");
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds <= Number(deposit.deadline)) {
    const waitSeconds = Number(deposit.deadline) - nowSeconds;
    throw new Error(`Deadline hasn't passed yet -- wait ${Math.ceil(waitSeconds / 60)} more minute(s) and try again.`);
  }

  console.log("Calling reclaimDeposit...");
  const tx = await factory.reclaimDeposit(voucherHash);
  const receipt = await tx.wait();
  console.log(`Reclaimed ${hre.ethers.formatEther(deposit.amount)} ETH back to ${signer.address} (tx ${receipt.hash}).`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
