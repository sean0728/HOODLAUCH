// Pulls the voucherHash back out of an already-sent depositForRelayedLaunch
// transaction, by reading the LaunchDeposited event it emits on-chain.
//
// Why this is needed: GET /failed-launches only lists vouchers the relayer
// itself wrote a status record for. If the relevant factory's watcher never
// loaded in the relayer process (e.g. the HH700 "Artifact for contract not
// found" errors seen in your startup logs), handleVoucherSubmission() in
// scripts/relayer.js throws before it ever calls upsertVoucher() -- so NO
// record is created at all, not "received", not "failed", nothing. The
// deposit itself still happened on-chain (it's a separate transaction, sent
// straight to the factory, before the voucher is ever POSTed to the
// relayer) -- it's just that the server has no idea it exists. That's why
// /failed-launches came back empty even though real ETH was deposited.
//
// This script reads the deposit transaction's own receipt directly off the
// chain and decodes its LaunchDeposited(bytes32 indexed voucherHash, address
// indexed creator, uint256 amount, uint256 deadline) event -- giving you the
// exact voucherHash to pass into scripts/reclaimDeposit.js, with no
// dependency on the relayer's bookkeeping at all.
//
// How to find the deposit transaction hash in the first place: it's the
// "small, ordinary transfer" transaction index.html prompts for right after
// you sign the voucher (NOT the token-deploy transaction itself -- that one
// never happened). Check your wallet's activity list (e.g. MetaMask) for a
// transaction sent TO the V4LaunchRelay (or V4TokenFactory) address, for the deposit
// amount, around the time of the failed launch -- or look it up on your
// network's block explorer under your wallet's transaction history.
//
// Required env:
//   DEPOSIT_TX_HASH   - the deposit transaction's hash (0x + 64 hex chars).
//   FACTORY_CONTRACT  - V4TokenFactory or V4LaunchRelay -- whichever one this
//                       deposit was sent to (custom-tax and Quick Launch
//                       deposits go to V4LaunchRelay).
//
// Example:
//   DEPOSIT_TX_HASH=0x... FACTORY_CONTRACT=V4LaunchRelay \
//     npx hardhat run scripts/getVoucherHashFromDeposit.js --network robinhoodTestnet
const hre = require("hardhat");

// V4TokenFactory holds the escrow for plain launches (deploy-only and liquidity); V4LaunchRelay holds it for
// custom-tax, Quick Launch and custom-tax Quick Launch.
const VALID_CONTRACTS = ["V4TokenFactory", "V4LaunchRelay"];

async function main() {
  const depositTxHash = process.env.DEPOSIT_TX_HASH;
  const factoryContract = process.env.FACTORY_CONTRACT;

  if (!depositTxHash || !/^0x[0-9a-fA-F]{64}$/.test(depositTxHash)) {
    throw new Error("Set DEPOSIT_TX_HASH to the deposit transaction's hash (0x + 64 hex chars).");
  }
  if (!factoryContract || !VALID_CONTRACTS.includes(factoryContract)) {
    throw new Error(`Set FACTORY_CONTRACT to one of: ${VALID_CONTRACTS.join(", ")}.`);
  }

  const receipt = await hre.ethers.provider.getTransactionReceipt(depositTxHash);
  if (!receipt) {
    throw new Error(
      "No receipt found for that hash on this network -- double check DEPOSIT_TX_HASH and that --network points at " +
        "the same chain the deposit was actually sent on."
    );
  }
  if (receipt.status !== 1) {
    console.log(
      "This transaction REVERTED (status=0) -- per index.html's own check, that means nothing was ever deposited " +
        "and no fee was collected. There is nothing to reclaim here; whatever ETH you think you lost on this " +
        "specific tx was never actually taken (only the gas for the revert itself was spent)."
    );
    return;
  }

  // We don't need the full factory ABI/bytecode here (that's what HH700 was
  // breaking in the first place) -- just the one event's interface, decoded
  // directly off the raw logs.
  const iface = new hre.ethers.Interface([
    "event LaunchDeposited(bytes32 indexed voucherHash, address indexed creator, uint256 amount, uint256 deadline)",
  ]);

  let found = null;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed && parsed.name === "LaunchDeposited") {
        found = parsed;
        break;
      }
    } catch (e) {
      // Not this event -- a receipt can contain other logs too, skip it.
    }
  }

  if (!found) {
    throw new Error(
      "No LaunchDeposited event found in this transaction's logs. Either this wasn't a depositForRelayedLaunch " +
        "call, or it was sent to a different contract than FACTORY_CONTRACT -- double check both."
    );
  }

  const { voucherHash, creator, amount, deadline } = found.args;
  const deadlineDate = new Date(Number(deadline) * 1000);
  const nowSeconds = Math.floor(Date.now() / 1000);

  console.log(`voucherHash: ${voucherHash}`);
  console.log(`creator:     ${creator}`);
  console.log(`amount:      ${hre.ethers.formatEther(amount)} ETH`);
  console.log(`deadline:    ${deadlineDate.toISOString()}`);
  console.log(
    nowSeconds > Number(deadline)
      ? "\nDeadline has already passed -- you can reclaim this now with scripts/reclaimDeposit.js."
      : `\nDeadline hasn't passed yet -- wait until ${deadlineDate.toISOString()} before running scripts/reclaimDeposit.js.`
  );
  console.log(
    `\nNext step:\n  FACTORY_ADDRESS=<${factoryContract} address> FACTORY_CONTRACT=${factoryContract} ` +
      `VOUCHER_HASH=${voucherHash} \\\n    npx hardhat run scripts/reclaimDeposit.js --network robinhoodTestnet`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
