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

// ---- V4 tests --------------------------------------------------------
// Uniswap's real PoolManager (which test/V4TokenFactory.test.js deploys)
// needs solc 0.8.26 and the cancun EVM (transient storage). Everything else —
// V2 and the production V4 contracts — stays on the 0.8.24 / shanghai
// settings below, so a normal build is unchanged. Tests run in a separate
// mode that compiles the whole project with 0.8.26 / cancun into its own
// cache + artifacts folders, so it never overwrites your real artifacts:
//
//     npm run test:v4        (= V4_TEST=1 npx hardhat test test/V4TokenFactory.test.js)
//
const V4_TEST = process.env.V4_TEST === "1";
{
  // contracts/mocks/V4TestImports.sol only exists to pull Uniswap's test
  // contracts into the V4 test build. Keep it out of every normal compile.
  const { subtask } = require("hardhat/config");
  const { TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS } = require("hardhat/builtin-tasks/task-names");
  subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS).setAction(async (_args, _hre, runSuper) => {
    const paths = await runSuper();
    return V4_TEST ? paths : paths.filter((p) => !p.endsWith("V4TestImports.sol"));
  });
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: V4_TEST
    ? {
        version: "0.8.26",
        settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "cancun" },
      }
    : {
        version: "0.8.24",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          viaIR: true,
          evmVersion: "shanghai",
        },
      },
  paths: V4_TEST ? { cache: "./cache-v4test", artifacts: "./artifacts-v4test" } : {},
  networks: {
    // In-process test network. Zero gas price keeps ETH balance assertions in
    // the V4 tests exact; cancun is required by the V4 PoolManager.
    hardhat: { hardfork: "cancun", gasPrice: 0, initialBaseFeePerGas: 0 },
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