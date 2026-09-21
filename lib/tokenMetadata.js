// Server-side mirror of index.html's token-metadata canonicalization and
// signed-message building — the same "kept in sync by hand" convention
// lib/platformConfig.js documents for canonicalizePlatformConfig/
// platformConfigMessage, applied here to a per-token logo/banner/socials
// edit instead of the platform-wide config. MUST be kept byte-identical to
// index.html's own copy (search it for "function canonicalizeTokenMetadata")
// — if the two ever drift, a client-signed metadata save will recompute a
// different message server-side than what was actually signed, and
// verifySignatureFrom (see lib/signedMessage.js) will simply fail to verify
// it (never silently accept a mismatched payload), which is the safe
// direction to fail in.
//
// Unlike platform config, this isn't admin-gated — it's gated per-token
// against that token's own on-chain creator (see POST
// /token-metadata/:tokenAddress in scripts/relayer.js for why, and
// lib/signedMessage.js for the generalized signature-verification helpers
// this and lib/adminAuth.js both now share).

// Normalizes an arbitrary incoming { logo, banner, socials } object into the
// exact shape/order that gets embedded in the signed message and persisted.
// Falsy/missing values are defaulted to null (never undefined, which
// JSON.stringify would drop and silently change the signed message's
// shape) — same reasoning canonicalizePlatformConfig documents for
// CONFIG_KEYS.
function canonicalizeTokenMetadata(metadata) {
  const socials = (metadata && metadata.socials) || {};
  return {
    logo: (metadata && metadata.logo) || null,
    banner: (metadata && metadata.banner) || null,
    socials: {
      website: socials.website || null,
      twitter: socials.twitter || null,
      telegram: socials.telegram || null,
      discord: socials.discord || null,
    },
  };
}

// The exact string a token's creator wallet signs (via personal_sign) to
// authorize updating that token's logo/banner/socials. timestamp must be
// the same value sent alongside the signature so the server can recompute
// this identically.
function tokenMetadataMessage(tokenAddress, metadata, timestamp) {
  return `Hood Launch: update token metadata for ${tokenAddress} to ${JSON.stringify(canonicalizeTokenMetadata(metadata))} at ${timestamp}`;
}

module.exports = { canonicalizeTokenMetadata, tokenMetadataMessage };
