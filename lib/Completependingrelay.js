// One-off remediation script: manually completes a gasless launch whose
// deposit already landed on-chain and whose voucher IS on file (in
// relayer-data/<network>/vouchers.json), but which the relayer's own poller
// already scanned past without relaying it — the voucher-vs-deposit race
// condition fixed in scripts/relayer.js's handleDeposit()/
// retryPendingDeposits(). Restarting the relayer with that fix deployed will
// NOT pick this specific one back up: its block is already behind the
// poller's cursor, and it never entered the new pending-deposits queue
// either, since that queue didn't exist yet when this deposit was scanned.
// This script does exactly what the relayer would have done, using the
// voucher that's already sitting in vouchers.json.
//
// Usage (for the currently-stuck launch, voucherHash
// 0x76e26a23214ee5cb27861f34a81473c37c36aade48b5c301a6af6d03d5fe9653):
//   VOUCHER_HASH=0x76e26a23214ee5cb27861f34a81473c37c36aade48b5c301a6af6d03d5fe9653 \
//     RELAYER_PRIVATE_KEY=0x... TOKEN_FACTORY_ADDRESS=0xdb58b8277D4Db96297376AdfC75f03680EC03699 \
//     npx hardhat run scripts/completePendingRelay.js --network robinhoodTestnet
//
// Use CUSTOM_TOKEN_FACTORY_ADDRESS instead of TOKEN_FACTORY_ADDRESS if the
// stuck voucher's stored `kind` is "custom" (the script checks and tells you
// which one it needs).
//
// RELAYER_PRIVATE_KEY must be the same key already set as this factory's
// relayer() (the same one scripts/relayer.js itself uses) — this script
// doesn't bypass any on-chain access control, it just performs the exact
// relayedCreateToken/relayedCreateCustomToken call the relayer would have.
const path = require("path");
const hre = require("hardhat");
const { getVoucher, upsertVoucher } = require("../lib/relayerStore");
const { recordLaunch } = require("../lib/launchStore");
const { verifyContract, verifyProxyClone } = require("../lib/verify");

function normalizeVoucher(rawVoucher, fields, uintFields) {
  const voucher = {};
  for (const field of fields) {
    if (rawVoucher[field] === undefined) throw new Error(`voucher is missing field "${field}"`);
    voucher[field] = rawVoucher[field];
  }
  for (const field of uintFields) {
    voucher[field] = BigInt(voucher[field]);
  }
  if (voucher.buyFees) voucher.buyFees = normalizeFeeSet(voucher.buyFees);
  if (voucher.sellFees) voucher.sellFees = normalizeFeeSet(voucher.sellFees);
  return voucher;
}

function normalizeFeeSet(feeSet) {
  return {
    reflectionBps: Number(feeSet.reflectionBps),
    marketingBps: Number(feeSet.marketingBps),
    liquidityBps: Number(feeSet.liquidityBps),
    burnBps: Number(feeSet.burnBps),
  };
}

const LAUNCH_VOUCHER_FIELDS = [
  "creator", "name", "symbol", "totalSupply", "addLiquidityAtLaunch",
  "liquidityEthAmount", "creatorBuyEthAmount", "minCreatorTokensOut", "fee", "salt", "deadline",
];
const LAUNCH_VOUCHER_UINT_FIELDS = [
  "totalSupply", "liquidityEthAmount", "creatorBuyEthAmount", "minCreatorTokensOut", "fee", "salt", "deadline",
];
const CUSTOM_LAUNCH_VOUCHER_FIELDS = [
  "creator", "name", "symbol", "totalSupply", "addLiquidity", "liquidityEthAmount", "buyFees", "sellFees",
  "reflectionAsset", "marketingWallet", "creatorBuyEthAmount", "minCreatorTokensOut", "fee", "salt", "deadline",
];
const CUSTOM_LAUNCH_VOUCHER_UINT_FIELDS = [
  "totalSupply", "liquidityEthAmount", "creatorBuyEthAmount", "minCreatorTokensOut", "fee", "salt", "deadline",
];

// Same shape as relayer.js's own postLaunchPipeline() — verifies the
// implementation + attempts proxy-linking, archives flattened source
// best-effort, and records the launch so it shows up in GET /launches like
// any other successful relay.
async function postLaunchPipeline({ kind, tokenAddress, pairAddress, implementationAddress, creator, name, symbol, totalSupply, network, txHash, extra }) {
  const implVerification = await verifyContract(implementationAddress, []);
  const proxyVerification = await verifyProxyClone(tokenAddress, implementationAddress);

  let flattenedSource = null;
  try {
    const contractFile = kind === "custom" ? "CustomToken.sol" : "LaunchedToken.sol";
    const absPath = path.join(hre.config.paths.root, "contracts", contractFile);
    flattenedSource = await hre.run("flatten:get-flattened-sources", { files: [absPath] });
  } catch (err) {
    console.warn(`Could not generate a flattened source archive: ${err.message}`);
  }

  const record = {
    name,
    symbol,
    mode: `relayed-${kind}`,
    tokenAddress,
    pairAddress: pairAddress && pairAddress !== hre.ethers.ZeroAddress ? pairAddress : null,
    creator,
    implementationAddress,
    totalSupply: totalSupply.toString(),
    network,
    deploymentTxHash: txHash,
    verified: implVerification.verified,
    proxyVerified: proxyVerification.verified,
    explorerUrl: process.env.EXPLORER_BROWSER_URL
      ? `${process.env.EXPLORER_BROWSER_URL.replace(/\/$/, "")}/address/${tokenAddress}`
      : null,
    flattenedSource: flattenedSource
      ? [
          `// Deployment record for ${name} ($${symbol}) — relayed gasless launch`,
          `// (completed manually via scripts/completePendingRelay.js after the relayer's poller missed it)`,
          `// Token address (EIP-1167 proxy clone): ${tokenAddress}`,
          `// Implementation address (this is what's actually verified on-chain): ${implementationAddress}`,
          `// Creator: ${creator}`,
          `// Network: ${network}`,
          `// Relayed deployment tx: ${txHash}`,
          `// Recorded: ${new Date().toISOString()}`,
          "",
          flattenedSource,
        ].join("\n")
      : null,
    createdAt: new Date().toISOString(),
    ...extra,
  };

  const paths = recordLaunch(record);
  console.log(`  recorded: ${paths.metaPath}`);
  return { implVerification, proxyVerification };
}

async function main() {
  const voucherHash = process.env.VOUCHER_HASH;
  if (!voucherHash) throw new Error("Set VOUCHER_HASH to the stuck launch's voucher hash (see it in the relayer's own logs).");

  const record = getVoucher(voucherHash);
  if (!record) throw new Error(`No voucher on file for ${voucherHash} — check relayer-data/<network>/vouchers.json on the server.`);
  if (record.status === "relayed") {
    throw new Error(
      `Voucher ${voucherHash} already shows status "relayed" in vouchers.json — the relay itself already happened. ` +
        `If it's still missing from /launches, the problem is specifically recordLaunch() failing (a filesystem ` +
        `issue), not the relay — that needs a different fix, not this script.`
    );
  }

  const relayerPrivateKey = process.env.RELAYER_PRIVATE_KEY;
  if (!relayerPrivateKey) {
    throw new Error("Set RELAYER_PRIVATE_KEY — must be the same key already set as this factory's relayer().");
  }
  const relayerWallet = new hre.ethers.Wallet(relayerPrivateKey, hre.ethers.provider);

  const isCustom = record.kind === "custom";
  const factoryAddress = isCustom ? process.env.CUSTOM_TOKEN_FACTORY_ADDRESS : process.env.TOKEN_FACTORY_ADDRESS;
  if (!factoryAddress) {
    throw new Error(`This voucher's kind is "${record.kind}" — set ${isCustom ? "CUSTOM_TOKEN_FACTORY_ADDRESS" : "TOKEN_FACTORY_ADDRESS"}.`);
  }

  const factory = await hre.ethers.getContractAt(isCustom ? "CustomTokenFactory" : "TokenFactory", factoryAddress, relayerWallet);
  const onChainRelayer = await factory.relayer();
  if (onChainRelayer.toLowerCase() !== relayerWallet.address.toLowerCase()) {
    throw new Error(`This wallet (${relayerWallet.address}) is not the factory's relayer() (${onChainRelayer}) — use the correct RELAYER_PRIVATE_KEY.`);
  }

  const voucherFields = isCustom ? CUSTOM_LAUNCH_VOUCHER_FIELDS : LAUNCH_VOUCHER_FIELDS;
  const voucherUintFields = isCustom ? CUSTOM_LAUNCH_VOUCHER_UINT_FIELDS : LAUNCH_VOUCHER_UINT_FIELDS;
  const voucher = normalizeVoucher(record.voucher, voucherFields, voucherUintFields);

  const deposit = await factory.deposits(record.creator, voucherHash);
  console.log(
    `On-chain deposit for ${voucherHash}: amount=${deposit.amount}, deadline=${deposit.deadline}, ` +
      `settled=${deposit.settled}, reclaimed=${deposit.reclaimed}`
  );
  if (deposit.settled) {
    throw new Error(
      "On-chain deposit is already marked settled — this may have already been relayed by something else. " +
        "Check GET /launches and the token's own explorer page before doing anything further."
    );
  }
  if (deposit.reclaimed) throw new Error("On-chain deposit was already reclaimed by the creator — nothing left to relay.");
  if (deposit.amount === 0n) throw new Error("No on-chain deposit found for this creator/voucherHash pair — nothing to relay.");

  console.log(`Relaying ${voucherHash} for creator ${record.creator}...`);
  upsertVoucher(voucherHash, { status: "deposited" });

  const relayFn = isCustom
    ? (v, sig) => factory.relayedCreateCustomToken(v, sig)
    : (v, sig) => factory.relayedCreateToken(v, sig);
  const createdEventName = isCustom ? "CustomTokenCreated" : "TokenCreated";

  const tx = await relayFn(voucher, record.signature);
  console.log(`Submitted relay tx ${tx.hash}, waiting for confirmation...`);
  const receipt = await tx.wait();

  const parsedLogs = receipt.logs.map((log) => {
    try {
      return factory.interface.parseLog(log);
    } catch {
      return null;
    }
  });
  const created = parsedLogs.find((p) => p && p.name === createdEventName);
  if (!created) throw new Error(`${createdEventName} event not found in relay receipt`);

  const tokenAddress = created.args.token;
  const pairAddress = created.args.pair || hre.ethers.ZeroAddress;
  const implementationAddress = await factory.tokenImplementation();
  const network = hre.network.name;

  upsertVoucher(voucherHash, { status: "relayed", txHash: receipt.hash, tokenAddress, pairAddress });
  console.log(`Relayed ${voucherHash} -> token ${tokenAddress} (tx ${receipt.hash}). Running verification + recordkeeping...`);

  await postLaunchPipeline({
    kind: record.kind,
    tokenAddress,
    pairAddress,
    implementationAddress,
    creator: voucher.creator,
    name: voucher.name,
    symbol: voucher.symbol,
    totalSupply: voucher.totalSupply,
    network,
    txHash: receipt.hash,
    extra: { voucherHash },
  });

  console.log("\nDone — this launch is now complete and recorded, same as if the relayer had caught it automatically.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
