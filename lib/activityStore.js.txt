// A minimal, dependency-free store for real trade activity — the
// server-side source of truth behind index.html's live feed, replacing what
// used to be an entirely fabricated random-line generator (feedLine() in
// index.html: a random token, a random flavor-text verb, a random fake
// short address, on a fixed timer — none of it real). scripts/relayer.js's
// own Swap-event watcher (see pollTokenActivity there) is what actually
// populates this; this module just holds the result.
//
// Same one-file-per-network convention as launchStore.js/
// priceHistoryStore.js: a single capped, newest-last array per network,
// under deployed-contracts/<network>/activity.json.
const fs = require("fs");
const path = require("path");
const { dirForNetwork } = require("./launchStore");

// Generous enough to back a feed of the last several hours of activity on a
// platform this size without the file growing unbounded.
const MAX_ENTRIES = 500;

function pathForNetwork(network) {
  const dir = dirForNetwork(network);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "activity.json");
}

function readActivity(network) {
  const filePath = pathForNetwork(network);
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    console.warn(
      `activity.json for network "${network}" exists but could not be parsed (${err.message}) — treating it as empty rather than overwriting a possibly-recoverable file.`
    );
    return [];
  }
}

// Appends one real trade record. Expected shape: { t, txHash, logIndex,
// tokenAddress, symbol, side: "buy"|"sell", wallet, tokenAmount }. `txHash`
// + `logIndex` together are what callers should dedupe on (a single
// transaction can contain more than one Swap, and a poll tick can overlap
// the previous one's block range) — this module itself doesn't dedupe, so
// see pollTokenActivity in relayer.js for that check.
function appendActivity(network, entry) {
  const filePath = pathForNetwork(network);
  const activity = readActivity(network);
  activity.push(entry);
  if (activity.length > MAX_ENTRIES) activity.splice(0, activity.length - MAX_ENTRIES);
  fs.writeFileSync(filePath, JSON.stringify(activity));
}

module.exports = {
  readActivity,
  appendActivity,
  MAX_ENTRIES,
};
