// Generalized personal_sign verification helpers — factored out of what
// used to be lib/adminAuth.js's own private isFreshTimestamp/
// verifyAdminSignature, so the same "sign a message embedding a timestamp,
// recover the signer, compare to an expected address" pattern can back a
// signature check against ANY expected address, not just the platform's
// single ADMIN_WALLET. lib/adminAuth.js now implements its own exports as
// thin wrappers over these (see that file), and POST
// /token-metadata/:tokenAddress in scripts/relayer.js uses these directly
// to verify against a per-token creator address instead of an admin wallet.
const { verifyMessage } = require("ethers");

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes

// Bounds how long a captured signature stays replayable if it ever leaked
// (a browser extension, a proxy log, a shared screen), without needing any
// server-side nonce or session state — same reasoning lib/adminAuth.js
// originally documented for its own MAX_ADMIN_SIGNATURE_AGE_MS, generalized
// here to an explicit maxAgeMs so callers other than the admin routes can
// use (or override) it too.
function isFreshTimestamp(timestamp, maxAgeMs) {
  const max = maxAgeMs == null ? DEFAULT_MAX_AGE_MS : maxAgeMs;
  const n = Number(timestamp);
  return Number.isFinite(n) && Math.abs(Date.now() - n) <= max;
}

// Returns true only if `signature` is a valid personal_sign signature of
// `message` recovering to expectedAddress. Never throws — a malformed
// signature (wrong length, wrong hex, anything ethers.verifyMessage can't
// parse) is just treated as "not a match", same as a wrong-wallet
// signature.
function verifySignatureFrom(message, signature, expectedAddress) {
  if (typeof signature !== "string" || !signature) return false;
  if (typeof expectedAddress !== "string" || !expectedAddress) return false;
  let recovered;
  try {
    recovered = verifyMessage(message, signature);
  } catch (err) {
    return false;
  }
  return recovered.toLowerCase() === expectedAddress.toLowerCase();
}

module.exports = { DEFAULT_MAX_AGE_MS, isFreshTimestamp, verifySignatureFrom };
