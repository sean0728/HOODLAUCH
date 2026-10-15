// @meteora-ag/cp-amm-sdk imports `bs58` from Anchor's Node-only build path
// (@coral-xyz/anchor/dist/cjs/utils/bytes), which calls require("util") and can't be bundled for the browser.
// The build aliases that path to this file, which exports the same `bs58` (encode/decode) from the bs58 package.
import bs58 from "bs58";
export { bs58 };
