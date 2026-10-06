// Mines a CREATE2 salt that places V4TaxHook at an address whose low 14 bits
// equal the hook's permission flags (0x20CC). Uniswap V4 reads a hook's
// permissions straight from its address, so this is mandatory, not cosmetic.
//
//   BEFORE_INITIALIZE (1<<13) | BEFORE_SWAP (1<<7) | AFTER_SWAP (1<<6)
//   | BEFORE_SWAP_RETURNS_DELTA (1<<3) | AFTER_SWAP_RETURNS_DELTA (1<<2) = 0x20CC
//
// Roughly 1 salt in 16,384 qualifies, so this finishes in well under a second.
//
// Library use (see test/V4TokenFactory.test.js):
//   const { mineHookSalt } = require("./scripts/V4mineHookAddress");
//   const { salt, address } = mineHookSalt(create2DeployerAddress, hookInitCode);
// where hookInitCode = V4TaxHook creation bytecode ++ abi.encode(poolManager, deployer).
// Any change to the constructor args or the compiled bytecode changes the init
// code hash, so mine AFTER the final build, with the final arguments.
const { getCreate2Address, keccak256, toBeHex, zeroPadValue } = require("ethers");

const HOOK_FLAG_MASK = 0x3fffn; // low 14 bits
const REQUIRED_FLAGS = 0x20ccn;

function mineHookSalt(create2DeployerAddress, initCode, { startAt = 0n, maxIterations = 5_000_000n } = {}) {
  const initCodeHash = keccak256(initCode);
  for (let i = startAt; i < startAt + maxIterations; i++) {
    const salt = zeroPadValue(toBeHex(i), 32);
    const address = getCreate2Address(create2DeployerAddress, salt, initCodeHash);
    if ((BigInt(address) & HOOK_FLAG_MASK) === REQUIRED_FLAGS) {
      return { salt, address, iterations: i - startAt + 1n };
    }
  }
  throw new Error("V4mineHookAddress: no salt found in range");
}

module.exports = { mineHookSalt, REQUIRED_FLAGS, HOOK_FLAG_MASK };