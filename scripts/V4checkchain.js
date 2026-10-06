// Pre-flight check for the V4 pilot: does the connected chain actually execute
// the Cancun transient-storage opcodes (TSTORE/TLOAD) that Uniswap's V4
// PoolManager is built on, and is a PoolManager really deployed there?
//
//   npx hardhat run scripts/V4checkChain.js --network robinhoodMainnet
//   POOL_MANAGER=0x... npx hardhat run scripts/V4checkChain.js --network robinhoodTestnet
//
// Nothing is sent on-chain: both checks are read-only eth_calls.
const hre = require("hardhat");

// Address reported for Robinhood Chain mainnet (chain 4663) by Bitquery's
// pools.trade docs and a third-party article; Uniswap's own deployments
// feed is the authority, so verify it there before relying on it.
const DEFAULT_POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";

async function main() {
  const { ethers, network } = hre;
  const chainId = (await ethers.provider.getNetwork()).chainId;
  console.log(`network: ${network.name}  chainId: ${chainId}`);

  // 1) Run init code that does TSTORE then TLOAD and returns the loaded word.
  //    PUSH1 7 PUSH1 0 TSTORE | PUSH1 0 TLOAD PUSH1 0 MSTORE | PUSH1 32 PUSH1 0 RETURN
  const initCode = "0x60076000" + "5d" + "60005c" + "600052" + "60206000f3";
  let transient;
  try {
    const out = await ethers.provider.send("eth_call", [{ data: initCode }, "latest"]);
    transient = BigInt(out) === 7n;
    console.log(transient ? "TSTORE/TLOAD: SUPPORTED" : `TSTORE/TLOAD: unexpected result ${out}`);
  } catch (e) {
    transient = false;
    console.log("TSTORE/TLOAD: NOT SUPPORTED (" + (e.shortMessage || e.message).slice(0, 120) + ")");
  }

  // 2) Is there a PoolManager at the expected address, and does it use the opcodes?
  const pm = process.env.POOL_MANAGER || DEFAULT_POOL_MANAGER;
  const code = await ethers.provider.getCode(pm);
  if (code === "0x") {
    console.log(`PoolManager ${pm}: NO CODE on this chain`);
  } else {
    const hasT = /5d/.test(code) && /5c/.test(code); // rough: opcode bytes present
    console.log(`PoolManager ${pm}: ${(code.length - 2) / 2} bytes of code, transient opcodes present (rough): ${hasT}`);
  }

  console.log(
    transient
      ? "\nOK: this chain can run the V4 PoolManager and the V4 pilot contracts."
      : "\nBLOCKER: this chain rejects transient-storage opcodes, so the V4 PoolManager cannot run here."
  );
}

main().catch((e) => { console.error(e); process.exit(1); });