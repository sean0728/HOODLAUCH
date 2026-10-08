// Decides whether a TokenCreated-style event found by discoverLaunchedTokens
// (scripts/relayer.js) should be announced on Telegram, and whether it is a
// genuinely first-time discovery (which also controls activityFromBlock).
//
// WHY "discoveredAt" AND NOT "is it in tracked-tokens":
// POST /token-metadata/:tokenAddress (and a few other routes) write a partial
// tracked-tokens row — e.g. just { creator } — the moment a creator saves a
// logo, which the front end does immediately after the launch tx confirms,
// usually BEFORE the discovery poll has scanned that block. If "already
// tracked" meant "any row exists", that early partial row made every such
// launch look like a re-scan and the announcement was silently skipped.
// discoverLaunchedTokens is the only code that ever writes discoveredAt, so
// its presence is the one reliable "discovery already processed this token"
// marker. It is still written by the same upsert that precedes the announce
// call, so a crash/restart re-scan of the same block never double-posts.
function hasBeenDiscovered(existingEntry) {
  return Boolean(existingEntry && existingEntry.discoveredAt);
}

// Returns { firstDiscovery, announce, reason }.
//  - firstDiscovery: discovery has never processed this token before.
//  - announce: post to the public launches channel.
//  - reason: human-readable why-not (null when announcing), for the log line.
function classifyDiscoveredLaunch({ isV4, isNeverRunOrStuck, existingEntry }) {
  const firstDiscovery = !hasBeenDiscovered(existingEntry);
  if (isV4) {
    return { firstDiscovery, announce: false, reason: "V4 launches are never announced publicly (admin-only)" };
  }
  if (isNeverRunOrStuck) {
    return {
      firstDiscovery,
      announce: false,
      reason: "found on a catch-up scan (first run, or the saved scan position was reset)",
    };
  }
  if (!firstDiscovery) {
    return { firstDiscovery, announce: false, reason: "discovery already processed this token (re-scanned block)" };
  }
  return { firstDiscovery, announce: true, reason: null };
}

module.exports = { hasBeenDiscovered, classifyDiscoveredLaunch };
