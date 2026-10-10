// Bundled for the RELAYER (Node), so the host needs no `npm install` for the Solana price tracker and the public-launch verifier:
// lib/solanaTracker.js falls back to lib/vendor/solana-node.js when the packages aren't installed.
// `curve` is the same curve maths the browser uses (solana-build/curve.js), so the relayer can recompute exactly
// what a creator's platform config must look like.
module.exports = {
  sdk: require("@meteora-ag/dynamic-bonding-curve-sdk"),
  web3: require("@solana/web3.js"),
  curve: require("./curve.js"),
};
