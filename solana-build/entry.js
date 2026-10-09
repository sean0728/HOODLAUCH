// Self-hosted Solana bundle for IgnitionX (devnet prototype). Exposes window.IgnitionSol.
// Only downloaded when an admin opens the Solana launch flow — see public/index.html.
import * as core from "./core.js";

window.IgnitionSol = {
  version: "1",
  init: core.init,
  curveDefaults: core.CURVE_DEFAULTS,
  listWallets: core.listWallets,
  onWalletsChange: core.onWalletsChange,
  onAccountChange: core.onAccountChange,
  currentWallet: core.currentWallet,
  connect: core.connect,
  disconnect: core.disconnect,
  createPlatformConfig: core.createPlatformConfig,
  launch: core.launch,
  getPoolInfo: core.getPoolInfo,
  getBalances: core.getBalances,
  quote: core.quote,
  trade: core.trade,
  getFeeBreakdown: core.getFeeBreakdown,
  claimFees: core.claimFees,
};
