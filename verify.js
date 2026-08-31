// Contract verification helpers, split into two genuinely different cases:
//
// 1. verifyContract() — normal source verification for a contract with its
//    own real bytecode (TokenFactory, LiquidityLocker, and the shared
//    LaunchedToken implementation). This only needs to run once per
//    contract, ever — it's safe to call on every launch anyway, since it
//    just detects "already verified" and returns.
//
// 2. verifyProxyClone() — every individual launched token is an EIP-1167
//    minimal proxy clone of the LaunchedToken implementation, which means
//    its on-chain bytecode is ~45 bytes of proxy code, NOT LaunchedToken's
//    bytecode. Submitting LaunchedToken's source against a clone's address
//    the normal way will always fail ("bytecode doesn't match"), because
//    it isn't LaunchedToken's bytecode — it's a pointer to it. That's not a
//    bug to work around; it's what a minimal proxy is.
//
//    What actually happens on most explorers (Etherscan, Blockscout) is
//    automatic: once the *implementation* is verified, the explorer
//    recognizes the standard EIP-1167 pattern in the clone's bytecode and
//    shows the implementation's verified source/ABI at the clone's address
//    automatically, no extra call required. Etherscan additionally exposes
//    a `verifyproxycontract` API action for cases it doesn't auto-detect;
//    this file calls that best-effort. Blockscout's equivalent differs by
//    version and isn't wired in here — if Robinhood Chain turns out to run
//    Blockscout, check its docs for the current proxy-verification route
//    and adjust verifyProxyClone() accordingly.
const hre = require("hardhat");

function explorerConfigured() {
  return Boolean(process.env.EXPLORER_API_URL);
}

async function verifyContract(address, constructorArguments = []) {
  if (!explorerConfigured()) {
    console.warn(`Skipping verification of ${address}: EXPLORER_API_URL is not set yet (see .env.example).`);
    return { verified: false, reason: "explorer not configured" };
  }
  try {
    await hre.run("verify:verify", { address, constructorArguments });
    return { verified: true };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (/already verified/i.test(message)) {
      return { verified: true, reason: "already verified" };
    }
    console.warn(`Verification failed for ${address}: ${message}`);
    return { verified: false, reason: message };
  }
}

async function verifyProxyClone(cloneAddress, implementationAddress) {
  if (!explorerConfigured()) {
    console.warn(`Skipping proxy verification of ${cloneAddress}: EXPLORER_API_URL is not set yet.`);
    return { verified: false, reason: "explorer not configured" };
  }

  const apiUrl = process.env.EXPLORER_API_URL;
  const apiKey = process.env.EXPLORER_API_KEY || "";

  try {
    const body = new URLSearchParams({
      module: "contract",
      action: "verifyproxycontract",
      address: cloneAddress,
      expectedimplementation: implementationAddress,
      apikey: apiKey,
    });
    const response = await fetch(apiUrl, { method: "POST", body });
    const data = await response.json().catch(() => null);
    if (data && data.status === "1") {
      return { verified: true, guid: data.result };
    }
    console.warn(
      `Proxy verification call for ${cloneAddress} did not confirm success (this is expected on explorers ` +
        `that auto-detect EIP-1167 clones without needing this call, or on non-Etherscan-API explorers): ` +
        `${data ? JSON.stringify(data) : "no response body"}`
    );
    return { verified: false, reason: data ? JSON.stringify(data) : "no response body" };
  } catch (err) {
    console.warn(`Proxy verification request failed for ${cloneAddress}: ${err.message}`);
    return { verified: false, reason: err.message };
  }
}

module.exports = { verifyContract, verifyProxyClone };
