// Shared base58 decoder (Bitcoin alphabet) for the Solana relayer modules.
const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = new Map([...B58_ALPHABET].map((c, i) => [c, BigInt(i)]));

// Returns a Buffer, or null if `str` isn't valid base58.
function decodeBase58(str) {
  if (typeof str !== "string" || str.length === 0 || str.length > 100) return null;
  let n = 0n;
  for (const ch of str) {
    const v = B58_MAP.get(ch);
    if (v === undefined) return null;
    n = n * 58n + v;
  }
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  let hex = n === 0n ? "" : n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, "hex")]);
}


module.exports = { decodeBase58 };
