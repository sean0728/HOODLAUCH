// Confirms that the PlatformToken deployed on a network is the contract in contracts/PlatformToken.sol.
//
//   PLATFORM_TOKEN_ADDRESS=0x... npx hardhat run scripts/checkPlatformTokenBytecode.js --network robinhoodMainnet
//
// It compares the runtime code on chain with the compiled runtime code of this repository, ignoring the
// compiler's trailing metadata hash (which changes with paths and comments). A match means the executable
// code is the same, so the V4PlatformTokenAudit tests describe the token that is deployed. If it does not
// match, the usual cause is different compiler settings (version, optimizer runs, viaIR, evmVersion): compile
// with the settings the token was deployed with and try again. Immutable values are not used by this contract,
// so none need masking.
const hre = require("hardhat");

// Solidity appends CBOR metadata; its length is the last two bytes of the runtime code.
function stripMetadata(hex) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length < 4) return h;
  const metaLen = parseInt(h.slice(-4), 16);
  const cut = (metaLen + 2) * 2;
  return cut < h.length ? h.slice(0, h.length - cut) : h;
}

function sameRuntime(deployedHex, artifactHex) {
  return stripMetadata(deployedHex).toLowerCase() === stripMetadata(artifactHex).toLowerCase();
}

async function main() {
  const address = process.env.PLATFORM_TOKEN_ADDRESS;
  if (!address || !hre.ethers.isAddress(address)) throw new Error("Set PLATFORM_TOKEN_ADDRESS to the deployed token address.");
  const onChain = await hre.ethers.provider.getCode(address);
  if (onChain === "0x") throw new Error(`No contract at ${address} on ${hre.network.name}.`);
  const artifact = await hre.artifacts.readArtifact("PlatformToken");
  const ok = sameRuntime(onChain, artifact.deployedBytecode);
  console.log(
    ok
      ? `MATCH: the code at ${address} is contracts/PlatformToken.sol as compiled here (metadata ignored).`
      : `NO MATCH: the code at ${address} differs from contracts/PlatformToken.sol as compiled with this project's settings.`
  );
  if (!ok) process.exitCode = 2;
}

module.exports = { stripMetadata, sameRuntime };

if (require.main === module) main().catch((err) => { console.error(err); process.exitCode = 1; });
