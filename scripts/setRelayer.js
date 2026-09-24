// One-time (or one-time-per-relayer-rotation) admin action: tells each
// already-deployed factory which wallet address scripts/relayer.js is
// running as, so its relayedCreateToken/relayedCreateCustomToken/
// relayedCreateCurveToken calls stop reverting. Without this, the relayer
// service starts up fine and will happily accept vouchers and watch for
// deposits, but every actual relay attempt fails on-chain — see the
// "WARNING: TokenFactory.relayer() is ..." message relayer.js itself prints
// at startup if this hasn't been done yet.
//
// Covers all four factories now: TokenFactory/CustomTokenFactory (the
// original two) plus BondingCurveFactory/CustomBondingCurveFactory (Quick
// Launch's own relayedCreateCurveToken, added as a fast-follow — see those
// contracts' own "gasless relayed launches" comment). Same setRelayer/
// setMaxRelayerGasReimbursement shape on all four, so one shared
// setRelayerOn() helper below handles every one of them identically.
//
// Must be run by the factory's OWNER wallet (DEPLOYER_PRIVATE_KEY, unless
// ownership has since been transferred elsewhere via transferOwnership/
// acceptOwnership) — NOT the relayer's own wallet. Those are deliberately
// two different keys: the owner sets who's allowed to relay; the relayer
// itself only ever needs enough ETH to pay gas, never any special
// privilege on the factory.
//
// Required env: RELAYER_ADDRESS (the relayer wallet's address — NOT its
//   private key; this script never needs or wants that), plus at least one
//   of TOKEN_FACTORY_ADDRESS / CUSTOM_TOKEN_FACTORY_ADDRESS /
//   BONDING_CURVE_FACTORY_ADDRESS / CUSTOM_BONDING_CURVE_FACTORY_ADDRESS.
//
// Pass RELAYER_ADDRESS=0x0000000000000000000000000000000000000000 to turn
// gasless relayed launches back OFF for a factory (fully reversible — see
// setRelayer's own NatSpec in TokenFactory.sol) without touching anything
// else.
//
// Every factory now also requires maxRelayerGasReimbursementWei to already
// be a real, non-zero value before setRelayer() will accept a non-zero
// relayer — see Finding E of the original TokenFactory audit ("relayer
// gas-reimbursement cap defaults to uncapped"), which this guard closes. A
// brand-new deployment starts at 0 for both relayer and
// maxRelayerGasReimbursementWei, so this script now sets the cap first
// (only if it's still 0) before calling setRelayer, rather than leaving
// that as a separate manual step. Override the default via
// MAX_RELAYER_GAS_REIMBURSEMENT_WEI (wei) if 0.01 ETH isn't the right cap
// for your gas costs.
//
// Examples:
//   RELAYER_ADDRESS=0x... TOKEN_FACTORY_ADDRESS=0x... CUSTOM_TOKEN_FACTORY_ADDRESS=0x... \
//   BONDING_CURVE_FACTORY_ADDRESS=0x... CUSTOM_BONDING_CURVE_FACTORY_ADDRESS=0x... \
//     npx hardhat run scripts/setRelayer.js --network robinhoodTestnet
const hre = require("hardhat");

const DEFAULT_MAX_RELAYER_GAS_REIMBURSEMENT_WEI = hre.ethers.parseEther("0.01");

async function setRelayerOn(contractName, factoryAddress, relayerAddress, capWei, ownerSigner) {
  const factory = await hre.ethers.getContractAt(contractName, factoryAddress, ownerSigner);

  const onChainOwner = await factory.owner();
  if (onChainOwner.toLowerCase() !== ownerSigner.address.toLowerCase()) {
    throw new Error(
      `${contractName} at ${factoryAddress} is owned by ${onChainOwner}, not the signer running this script ` +
        `(${ownerSigner.address}). Run this with the actual owner's private key, or finish an in-progress ` +
        "transferOwnership/acceptOwnership handoff first."
    );
  }

  // setRelayer() reverts on a non-zero relayerAddress until this is itself
  // non-zero (see CustomTokenFactory.sol / TokenFactory.sol setRelayer) —
  // a fresh deployment starts both at 0, so this has to run first.
  if (relayerAddress !== hre.ethers.ZeroAddress) {
    const currentCap = await factory.maxRelayerGasReimbursementWei();
    if (currentCap === 0n) {
      console.log(`${contractName}: maxRelayerGasReimbursementWei is 0 — setting cap to ${capWei} wei first...`);
      const capTx = await factory.setMaxRelayerGasReimbursement(capWei);
      await capTx.wait();
      console.log(`${contractName}: setMaxRelayerGasReimbursement(${capWei}) confirmed (tx ${capTx.hash}).`);
    }
  }

  const currentRelayer = await factory.relayer();
  if (currentRelayer.toLowerCase() === relayerAddress.toLowerCase()) {
    console.log(`${contractName}: relayer is already ${relayerAddress} — nothing to do.`);
    return;
  }

  console.log(`${contractName}: setting relayer ${currentRelayer} -> ${relayerAddress}...`);
  const tx = await factory.setRelayer(relayerAddress);
  await tx.wait();
  console.log(`${contractName}: setRelayer(${relayerAddress}) confirmed (tx ${tx.hash}).`);
}

async function main() {
  const relayerAddress = process.env.RELAYER_ADDRESS;
  if (!relayerAddress) {
    throw new Error(
      "Set RELAYER_ADDRESS to the relayer wallet's ADDRESS (not its private key) — the same address " +
        "scripts/relayer.js will print as \"Relayer wallet: ...\" when it starts up."
    );
  }
  if (!hre.ethers.isAddress(relayerAddress)) {
    throw new Error(`RELAYER_ADDRESS (${relayerAddress}) is not a valid address.`);
  }

  const tokenFactoryAddress = process.env.TOKEN_FACTORY_ADDRESS || null;
  const customTokenFactoryAddress = process.env.CUSTOM_TOKEN_FACTORY_ADDRESS || null;
  const bondingCurveFactoryAddress = process.env.BONDING_CURVE_FACTORY_ADDRESS || null;
  const customBondingCurveFactoryAddress = process.env.CUSTOM_BONDING_CURVE_FACTORY_ADDRESS || null;
  if (!tokenFactoryAddress && !customTokenFactoryAddress && !bondingCurveFactoryAddress && !customBondingCurveFactoryAddress) {
    throw new Error(
      "Set at least one of TOKEN_FACTORY_ADDRESS / CUSTOM_TOKEN_FACTORY_ADDRESS / " +
        "BONDING_CURVE_FACTORY_ADDRESS / CUSTOM_BONDING_CURVE_FACTORY_ADDRESS."
    );
  }

  const capWei = process.env.MAX_RELAYER_GAS_REIMBURSEMENT_WEI
    ? BigInt(process.env.MAX_RELAYER_GAS_REIMBURSEMENT_WEI)
    : DEFAULT_MAX_RELAYER_GAS_REIMBURSEMENT_WEI;

  const [ownerSigner] = await hre.ethers.getSigners();
  console.log(`Running as: ${ownerSigner.address}`);
  console.log(`Setting relayer to: ${relayerAddress}`);

  if (tokenFactoryAddress) await setRelayerOn("TokenFactory", tokenFactoryAddress, relayerAddress, capWei, ownerSigner);
  if (customTokenFactoryAddress) await setRelayerOn("CustomTokenFactory", customTokenFactoryAddress, relayerAddress, capWei, ownerSigner);
  if (bondingCurveFactoryAddress) await setRelayerOn("BondingCurveFactory", bondingCurveFactoryAddress, relayerAddress, capWei, ownerSigner);
  if (customBondingCurveFactoryAddress) await setRelayerOn("CustomBondingCurveFactory", customBondingCurveFactoryAddress, relayerAddress, capWei, ownerSigner);

  console.log(
    "\nDone. Restart scripts/relayer.js if it's already running — it only checks relayer() once, at startup."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
