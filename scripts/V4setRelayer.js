// Tells the V4 contracts which wallet the relayer (scripts/relayer.js) runs as, so gasless launches
// stop reverting with "caller is not the relayer". scripts/V4deploy.js already does this when the
// deploying wallet owns the contracts and RELAYER_ADDRESS is set; use this script when ownership
// has since moved, or to rotate the relayer wallet.
//
//   RELAYER_ADDRESS=0x... V4_LAUNCH_RELAY_ADDRESS=0x... V4_TOKEN_FACTORY_ADDRESS=0x... \
//     npx hardhat run scripts/V4setRelayer.js --network robinhoodTestnet
//
// Run it with the OWNER wallet of those contracts (DEPLOYER_PRIVATE_KEY, unless ownership was
// transferred), NOT the relayer's own key; the relayer wallet only ever needs ETH for gas.
//
// Required env: RELAYER_ADDRESS (the relayer wallet's ADDRESS -- never its private key), plus at
// least one of V4_LAUNCH_RELAY_ADDRESS / V4_TOKEN_FACTORY_ADDRESS. Pass the zero address as
// RELAYER_ADDRESS to switch gasless relaying off.
//
// Optional env: MAX_GAS_REIMBURSEMENT_ETH (default 0.01) -- the most a single relayed launch may
// repay the relayer for its gas, taken out of that launch's fee. A cap above zero must be set
// before a relayer can be enabled; this script sets it first when the current cap is zero.
//
// Gasless custom-tax / Quick Launch go through V4LaunchRelay; plain launches (deploy-only and
// liquidity) go through V4TokenFactory's own relay.
const hre = require("hardhat");

const ABI = [
  "function owner() view returns (address)",
  "function relayer() view returns (address)",
  "function maxRelayerGasReimbursementWei() view returns (uint256)",
  "function setRelayer(address newRelayer)",
  "function setMaxRelayerGasReimbursement(uint256 newCapWei)",
];

async function configure(label, address, relayerAddress, capWei, signer) {
  const c = await hre.ethers.getContractAt(ABI, address, signer);
  const owner = await c.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    console.log(`${label}: SKIPPED -- owner is ${owner}, but this script is running as ${signer.address}.`);
    return;
  }
  if (relayerAddress !== hre.ethers.ZeroAddress && (await c.maxRelayerGasReimbursementWei()) === 0n) {
    console.log(`${label}: setting the gas reimbursement cap to ${hre.ethers.formatEther(capWei)} ETH...`);
    await (await c.setMaxRelayerGasReimbursement(capWei)).wait();
  }
  if ((await c.relayer()).toLowerCase() === relayerAddress.toLowerCase()) {
    console.log(`${label}: relayer already ${relayerAddress}.`);
    return;
  }
  console.log(`${label}: setRelayer(${relayerAddress})...`);
  await (await c.setRelayer(relayerAddress)).wait();
  console.log(`${label}: done.`);
}

async function main() {
  const relayerAddress = process.env.RELAYER_ADDRESS;
  if (!relayerAddress || !hre.ethers.isAddress(relayerAddress)) {
    throw new Error("Set RELAYER_ADDRESS to the relayer wallet's address (not its private key).");
  }
  const relay = process.env.V4_LAUNCH_RELAY_ADDRESS;
  const factory = process.env.V4_TOKEN_FACTORY_ADDRESS;
  if (!relay && !factory) throw new Error("Set V4_LAUNCH_RELAY_ADDRESS and/or V4_TOKEN_FACTORY_ADDRESS.");
  for (const [name, v] of [["V4_LAUNCH_RELAY_ADDRESS", relay], ["V4_TOKEN_FACTORY_ADDRESS", factory]]) {
    if (v && !hre.ethers.isAddress(v)) throw new Error(`${name} is not a valid address.`);
  }
  const capWei = hre.ethers.parseEther(process.env.MAX_GAS_REIMBURSEMENT_ETH || "0.01");
  const [signer] = await hre.ethers.getSigners();
  console.log(`Running as ${signer.address} on ${hre.network.name}.`);
  if (relay) await configure("V4LaunchRelay", relay, relayerAddress, capWei, signer);
  if (factory) await configure("V4TokenFactory", factory, relayerAddress, capWei, signer);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
