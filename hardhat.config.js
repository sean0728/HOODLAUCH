require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");

// See lib/networks.js for why this lives in its own module — the RPC URL
// itself is still overridable via env var below; Robinhood's docs note the
// public endpoints are rate-limited and recommend a dedicated Alchemy
// endpoint (https://robinhood-{mainnet|testnet}.g.alchemy.com/v2/{API_KEY})
// for anything beyond light testing.
const { ROBINHOOD_NETWORKS } = require("./lib/networks");

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";

// Blockscout's Etherscan-compatible API generally accepts any non-empty
// string as the API key (per Robinhood's own verification example, which
// uses the literal string "empty") — still overridable via env var in case
// that changes.
const EXPLORER_API_KEY = process.env.EXPLORER_API_KEY || "empty";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // TokenFactory.createToken() and its helpers pass enough
      // parameters/return values around (name/symbol/supply/mode/ETH
      // splits/pair/lpAmount/lockId/creatorTokensBought) to blow the EVM's
      // 16-slot local stack under the legacy codegen even after splitting
      // the function up. The IR pipeline doesn't have that limit.
      viaIR: true,
    },
  },
  networks: {
    hardhat: {},
    robinhoodTestnet: {
      url: process.env.ROBINHOOD_TESTNET_RPC_URL || ROBINHOOD_NETWORKS.robinhoodTestnet.defaultRpcUrl,
      chainId: ROBINHOOD_NETWORKS.robinhoodTestnet.chainId,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
    // Real funds. Double-check DEPLOYER_PRIVATE_KEY, DEX_ROUTER_ADDRESS, and
    // PRICE_FEED_ADDRESS before ever running a script against this network —
    // deploy.js refuses to guess the latter two (see scripts/deploy.js).
    robinhoodMainnet: {
      url: process.env.ROBINHOOD_MAINNET_RPC_URL || ROBINHOOD_NETWORKS.robinhoodMainnet.defaultRpcUrl,
      chainId: ROBINHOOD_NETWORKS.robinhoodMainnet.chainId,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: {
      robinhoodTestnet: EXPLORER_API_KEY,
      robinhoodMainnet: EXPLORER_API_KEY,
    },
    customChains: [
      {
        network: "robinhoodTestnet",
        chainId: ROBINHOOD_NETWORKS.robinhoodTestnet.chainId,
        urls: {
          apiURL: ROBINHOOD_NETWORKS.robinhoodTestnet.explorerApiUrl,
          browserURL: ROBINHOOD_NETWORKS.robinhoodTestnet.explorerBrowserUrl,
        },
      },
      {
        network: "robinhoodMainnet",
        chainId: ROBINHOOD_NETWORKS.robinhoodMainnet.chainId,
        urls: {
          apiURL: ROBINHOOD_NETWORKS.robinhoodMainnet.explorerApiUrl,
          browserURL: ROBINHOOD_NETWORKS.robinhoodMainnet.explorerBrowserUrl,
        },
      },
    ],
  },
};
