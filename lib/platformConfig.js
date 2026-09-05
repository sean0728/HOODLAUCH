// Server-side mirror of index.html's platform-config canonicalization and
// signed-message building. MUST be kept byte-identical to index.html's own
// CONFIG_KEYS / canonicalizePlatformConfig / the message string built by
// requestPlatformConfigSave() there — this is the "kept in sync by hand"
// convention referenced in lib/adminAuth.js. If the two ever drift, a
// client-signed save will recompute a different message server-side than
// what was actually signed, and verifyAdminSignature will simply fail
// (never silently accept a mismatched config), which is the safe direction.
const CONFIG_KEYS = [
  "tokenFactory",
  "customTokenFactory",
  "rewardsDistributor",
  "creatorRewardsDistributor",
  "priceFeed",
  "relayerApiUrl",
];

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
