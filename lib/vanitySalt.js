// Mines a CREATE2 salt for TokenFactory.createToken()/CustomTokenFactory.
// createCustomToken() so a launched token's EIP-1167 clone address lands
// with a chosen hex suffix — see those contracts' own comments on
// createToken/createCustomToken/predictTokenAddress for the on-chain side
// (both now deploy via Clones.cloneDeterministic(tokenImplementation, salt)
// instead of the old plain Clones.clone(tokenImplementation), specifically
// so the caller can choose which salt — and therefore which address — to
// use).
//
// The platform's own standard is VANITY_SUFFIX below: every hoodlaunch
// token ends in Robinhood Chain's own chain ID (4663 on mainnet, though the
// suffix itself is chain-agnostic — it's just a fixed hex string every
// launch mines for, on whichever network it runs on).
//
// This is the Node/server-side counterpart to the identical (but
// dependency-free, hand-rolled-Keccak) mining logic shipped in the front
// end (index.html's own mineVanitySalt) — both implement the exact same
// EIP-1167-minimal-proxy CREATE2 address formula, and were cross-checked
// against each other, against ethers.js, and against a live Hardhat
// deployment before shipping. Used by scripts/launch.js and
// scripts/customLaunch.js (the direct, self-paid launch paths) — the
// relayed/gasless path doesn't need this module at all, since its salt is
// chosen client-side, before the creator signs their voucher (see the
// front end).
const { ethers } = require("ethers");

// Robinhood Chain's own chain ID (4663 mainnet / 46630 testnet) — see the
// conversation that picked this: distinctly tied to this platform's own
// chain, short enough (4 hex chars) to mine in well under a second even at
// pure-JS hashing speed (~65,536 average attempts for a 4-hex-char suffix).
const VANITY_SUFFIX = "4663";

// The fixed EIP-1167 minimal-proxy bytecode template every clone uses,
// byte-for-byte identical to what OpenZeppelin's Clones.sol embeds in its
// own create/create2 assembly (verified directly against
// node_modules/@openzeppelin/contracts/proxy/Clones.sol at the time this
// was written) — this is NOT something that changes per-project or
// per-implementation beyond the 20 embedded implementation-address bytes.
function minimalProxyInitCode(implementation) {
  return ethers.concat([
    "0x3d602d80600a3d3981f3363d3d373d3d3d363d73",
    implementation,
    "0x5af43d82803e903d91602b57fd5bf3",
  ]);
}

/**
 * Mines a uint256 salt such that the resulting EIP-1167 clone address —
 * Clones.predictDeterministicAddress(implementation, bytes32(salt), deployer)
 * on-chain, or ethers.getCreate2Address(deployer, salt, initCodeHash) here —
 * ends in `suffix` (default: the platform's own VANITY_SUFFIX).
 *
 * Pure off-chain computation, no RPC calls: the CREATE2 formula only
 * depends on (deployer, salt, implementation's init-code hash), all known
 * up front, so this can run entirely locally before ever touching the
 * chain.
 *
 * @param {string} deployer - the factory contract's own address (TokenFactory or CustomTokenFactory) — CREATE2's "deployer" is address(this) inside cloneDeterministic, i.e. the factory, not the caller/creator.
 * @param {string} implementation - the tokenImplementation address (LaunchedToken or CustomToken implementation) this factory clones.
 * @param {{suffix?: string, maxAttempts?: number}} [opts]
 * @returns {{salt: bigint, address: string, attempts: number}}
 */
function mineVanitySalt(deployer, implementation, opts = {}) {
  const suffix = (opts.suffix || VANITY_SUFFIX).toLowerCase();
  const maxAttempts = opts.maxAttempts || 5_000_000;
  const initCodeHash = ethers.keccak256(minimalProxyInitCode(implementation));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const saltBytes = ethers.randomBytes(32);
    const saltHex = ethers.hexlify(saltBytes);
    const address = ethers.getCreate2Address(deployer, saltHex, initCodeHash);
    if (address.toLowerCase().endsWith(suffix)) {
      return { salt: ethers.toBigInt(saltHex), address, attempts: attempt + 1 };
    }
  }
  throw new Error(`mineVanitySalt: could not find a salt ending in "${suffix}" within ${maxAttempts} attempts.`);
}

module.exports = { mineVanitySalt, VANITY_SUFFIX };
