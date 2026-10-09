// Self-hosted WalletConnect bundle for HoodLaunch. Exposes window.HoodWC.
// No Web3Modal / no remote UI: HoodLaunch renders its own QR + wallet picker,
// so the only network traffic is the WalletConnect relay itself.
import { EthereumProvider } from "@walletconnect/ethereum-provider";
import QRCode from "qrcode";

const REQUIRED_METHODS = ["eth_sendTransaction", "personal_sign"];
const OPTIONAL_METHODS = [
  "eth_signTypedData_v4", "eth_signTypedData", "eth_sign",
  "wallet_switchEthereumChain", "wallet_addEthereumChain",
  "eth_accounts", "eth_requestAccounts", "eth_getBalance", "eth_call",
];
const EVENTS = ["chainChanged", "accountsChanged"];

window.HoodWC = {
  version: "1",
  // opts: { projectId, chainIds:[number,...] (first = preferred), rpcMap:{ "<id>": url }, metadata }
  async init(opts) {
    if (!opts || !opts.projectId) throw new Error("WalletConnect project ID missing");
    return EthereumProvider.init({
      projectId: opts.projectId,
      optionalChains: opts.chainIds,
      rpcMap: opts.rpcMap || {},
      showQrModal: false,
      methods: REQUIRED_METHODS,
      optionalMethods: OPTIONAL_METHODS,
      events: EVENTS,
      metadata: opts.metadata,
    });
  },
  // Returns an SVG string (no external images, no canvas).
  qrSvg(uri) {
    let svg = "";
    QRCode.create; // keep tree-shaker honest
    QRCode.toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" }, (err, out) => { if (!err) svg = out; });
    return svg;
  },
};
