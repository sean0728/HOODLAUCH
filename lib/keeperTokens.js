// Which V2 token addresses the relayer's fee keepers (fee-wallet swap/claim,
// creator-rewards swap/claim, platform-rewards token buyback) should look at.
//
// Before: ledger only. The ledger (lib/launchStore) holds ONLY launches that
// went through this relayer's gasless path AND finished post-launch
// processing, so a token launched from the creator's own wallet (relayer URL
// unset, or a direct contract call) was never swept and its in-kind fees sat
// in the distributors until someone triggered them by hand.
//
// Now: ledger UNION tracked tokens. discoverLaunchedTokens tracks every launch
// event from every factory, relayed or not, so the union covers everything.
// Excluded: V4 tokens (they have their own keepers) and manually tracked
// non-launch tokens such as the platform token (kind "platform"), which never
// had factory fees to sweep and weren't swept before either.
function mergeV2KeeperTokens(ledger, tracked) {
  const out = new Map(); // lowercase -> original-case address (first seen wins)
  const add = (addr) => {
    if (!addr || typeof addr !== "string") return;
    const key = addr.toLowerCase();
    if (!out.has(key)) out.set(key, addr);
  };
  // Ledger rows can include V4 launches (V4TokenFactory relays too); the V2
  // keepers have nothing to sweep for those, so skip them like tracked V4.
  for (const entry of Array.isArray(ledger) ? ledger : []) {
    if (!entry) continue;
    if (entry.protocol === "v4" || (typeof entry.kind === "string" && entry.kind.startsWith("v4"))) continue;
    add(entry.tokenAddress);
  }
  for (const [key, entry] of Object.entries(tracked || {})) {
    if (!entry) continue;
    if (entry.protocol === "v4" || (typeof entry.kind === "string" && entry.kind.startsWith("v4"))) continue;
    if (entry.poolId) continue; // a V4 pool id means a V4 token even if labels are missing
    if (entry.kind === "platform" || entry.manuallyTracked) continue;
    add(entry.tokenAddress || key);
  }
  return [...out.values()];
}

module.exports = { mergeV2KeeperTokens };
