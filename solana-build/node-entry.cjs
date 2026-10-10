// Bundled for the RELAYER (Node), so the host needs no `npm install` for the Solana price tracker:
// lib/solanaTracker.js falls back to lib/vendor/solana-node.js when the packages aren't installed.
module.exports = {
  sdk: require("@meteora-ag/dynamic-bonding-curve-sdk"),
  web3: require("@solana/web3.js"),
};
