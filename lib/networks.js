// Robinhood Chain network parameters — confirmed via official docs
// (https://docs.robinhood.com/chain/connecting and
// https://docs.robinhood.com/chain/deploy-smart-contracts) as of 2026-08-26.
// Chain ID and the public RPC/explorer hosts are fixed protocol facts, so
// they're hardcoded here rather than left as blank env vars.
//
// Pulled out into its own module so both hardhat.config.js (network/explorer
// config) and lib/verify.js (resolving the right explorer API URL for
// whatever network a script is running against) share one definition
// instead of hardcoding it twice and risking the two drifting apart.
const ROBINHOOD_NETWORKS = {
  robinhoodTestnet: {
    chainId: 46630,
    defaultRpcUrl: "https://rpc.testnet.chain.robinhood.com",
    explorerApiUrl: "https://explorer.testnet.chain.robinhood.com/api",
    explorerBrowserUrl: "https://explorer.testnet.chain.robinhood.com/",
  },
  robinhoodMainnet: {
    chainId: 4663,
    defaultRpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    explorerApiUrl: "https://robinhoodchain.blockscout.com/api",
    explorerBrowserUrl: "https://robinhoodchain.blockscout.com/",
  },
};

module.exports = { ROBINHOOD_NETWORKS };
