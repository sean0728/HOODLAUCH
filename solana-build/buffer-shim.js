// @solana/web3.js expects a global Buffer in the browser.
import { Buffer } from "buffer";
globalThis.Buffer = globalThis.Buffer || Buffer;
export { Buffer };
