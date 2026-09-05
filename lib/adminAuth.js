// Verifies that a personal_sign signature over an admin-authored message
// actually came from the platform's single admin wallet — the server-side
// half of index.html's isAdminWallet()/personal_sign flow (see
// requestActiveNetworkChange/requestPlatformConfigSave there). index.html's
// own admin-panel gate is deliberately UI-only, not real access control
// (anyone can edit the page's JS and flip isAdminWallet() to return true
// for themselves) — recovering the real signer from the signature and
// checking it against this address, server-side, before writing anything
// is what actually is the access control for the two admin-only routes
// this backs (POST /active-network, POST /platform-config).
//
// ADMIN_WALLET must be kept in sync BY HAND with index.html's own
// ADMIN_WALLET constant — same "kept in sync by hand" convention
// CONFIG_KEYS/canonicalizePlatformConfig already documents in
// lib/platformConfig.js. If the two ever drift, admin actions here simply
// start failing signature verification (never silently accepting the
// wrong wallet), which is the safe direction to fail in.
const { verifyMessage } = require("ethers");

const ADMIN_WALLET = "0x64dEAAfEa8F9a7238bf3a8Af54863dC1C08386A3";

// A signed admin action embeds its own client-side Date.now() timestamp
// into the signed message (see platformConfigMessage / the
// "set active network to X at TIMESTAMP" message index.html builds) —
// this bounds how long a captured signature stays replayable if it ever
// leaked (a browser extension, a proxy log, a shared screen), without
// needing any server-side nonce or session state.
const MAX_ADMIN_SIGNATURE_AGE_MS = 5 * 60 * 1000; // 5 minutes

function isFreshTimestamp(timestamp) {
  const n = Number(timestamp);
  return Number.isFinite(n) && Math.abs(Date.now() - n) <= MAX_ADMIN_SIGNATURE_AGE_MS;
}

// Returns true only if `signature` is a valid personal_sign signature of
// `message` recovering to ADMIN_WALLET. Never throws — a malformed
// signature (wrong length, wrong hex, anything ethers.verifyMessage can't
// parse) is just treated as "not the admin", same as a wrong-wallet
// signature.
function verifyAdminSignature(message, signature) {
  if (typeof signature !== "string" || !signature) return false;
  let recovered;
  try {
    recovered = verifyMessage(message, signature);
  } catch (err) {
    return false;
  }
  return recovered.toLowerCase() === ADMIN_WALLET.toLowerCase();
}

module.exports = { ADMIN_WALLET, MAX_ADMIN_SIGNATURE_AGE_MS, isFreshTimestamp, verifyAdminSignature };
