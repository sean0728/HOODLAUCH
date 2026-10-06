// Server-side mirror of index.html's platform-config canonicalization and
// signed-message building. MUST be kept byte-identical to index.html's own
// CONFIG_KEYS / canonicalizePlatformConfig / the message string built by
// requestPlatformConfigSave() there — this is the "kept in sync by hand"
// convention referenced in lib/adminAuth.js. If the two ever drift, a
// client-signed save will recompute a different message server-side than
// what was actually signed, and verifyAdminSignature will simply fail
// (never silently accept a mismatched config), which is the safe direction.
// FIX: bondingCurveFactory/customBondingCurveFactory (the two Quick Launch
// curve factories) were added to index.html's own CONFIG_KEYS when that
// feature shipped, but this server-side mirror never got the matching
// update — exactly the drift the comment above warns about. Left as-is,
// EVERY "Save (all visitors)" platform-config save was silently broken
// (not just for these two contracts): the client always signs a message
// built from its own 8-key canonicalization, the server always recomputed
// the signed message from this stale 6-key list, the two JSON strings never
// matched, and verifyAdminSignature failed every single time with "does not
// match the admin wallet" — regardless of which fields an admin was
// actually changing. Order matches index.html's CONFIG_KEYS exactly (order
// affects the JSON key order embedded in the signed message).
//
// platformTaxDistributor was added afterward, the same way
// bondingCurveFactory/customBondingCurveFactory originally were — appended
// at the END so this list and index.html's CONFIG_KEYS were changed
// together in the same relative position, avoiding a repeat of the drift
// documented above.
//
// FIX: feeWalletDistributor was added to index.html's CONFIG_KEYS (a
// purely informational reference address — see CONFIG_HELP.feeWalletDistributor
// there — mirroring creatorRewardsDistributor's own entry) and this mirror
// was NOT updated at the same time, reproducing the exact bondingCurveFactory/
// customBondingCurveFactory drift documented above. With only 9 keys here
// against index.html's 10, EVERY "Save (all visitors)" save was broken again
// — not just ones touching feeWalletDistributor, since the signed message
// embeds the full canonicalized object and a 9-key vs 10-key JSON.stringify
// output can never match. Appended at the END, same convention as every
// other key added here after the original set.
//
// v4TokenFactory/v4TaxHook/v4LiquidityLocker (the admin-only Uniswap V4
// contract set) and later v4SwapRouter (the V4 trading router) were added to index.html's CONFIG_KEYS and this list in the
// same change, appended at the END of both, to avoid repeating that drift.
const CONFIG_KEYS = [
  "tokenFactory",
  "customTokenFactory",
  "bondingCurveFactory",
  "customBondingCurveFactory",
  "rewardsDistributor",
  "creatorRewardsDistributor",
  "priceFeed",
  "relayerApiUrl",
  "platformTaxDistributor",
  "feeWalletDistributor",
  "v4TokenFactory",
  "v4TaxHook",
  "v4LiquidityLocker",
  "v4SwapRouter",
  "v4CustomTokenFactory",
  "v4CurveFactory",
  "v4LiquidityCompounder",
];

// v4CustomTokenFactory/v4CurveFactory/v4LiquidityCompounder (the V4 custom-tax
// and bonding-curve contracts) were appended at the END of both lists together.

// Normalizes an arbitrary incoming config object into the exact shape/order
// that gets embedded in the signed message and persisted — every key from
// CONFIG_KEYS, each with exactly a {demo, live} pair, missing/falsy values
// defaulted to null (never undefined, which JSON.stringify would drop and
// silently change the signed message's shape).
function canonicalizePlatformConfig(cfg) {
  const out = {};
  for (const key of CONFIG_KEYS) {
    const entry = (cfg && cfg[key]) || {};
    out[key] = {
      demo: entry.demo || null,
      live: entry.live || null,
    };
  }
  return out;
}

// The exact string an admin's wallet signs (via personal_sign) to authorize
// a platform-config update. timestamp must be the same value sent alongside
// the signature so the server can recompute this identically.
function platformConfigMessage(cfg, timestamp) {
  return `Hood Launch admin: update platform config to ${JSON.stringify(canonicalizePlatformConfig(cfg))} at ${timestamp}`;
}

module.exports = { CONFIG_KEYS, canonicalizePlatformConfig, platformConfigMessage };