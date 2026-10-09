// The network families a launched token can live on. Stored on every launch record as `chain`
// and sent to the front end, which picks the badge shown next to the token's name from it.
// Add a new network here first (then add its badge file under public/brand/chains/).
const CHAINS = Object.freeze({ ROBINHOOD: "robinhood", SOLANA: "solana" });
const KNOWN = new Set(Object.values(CHAINS));

// Anything unrecognised / missing -> "robinhood": every row written before this field existed
// came from the Robinhood Chain relayer.
function normalizeChain(value) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return KNOWN.has(v) ? v : CHAINS.ROBINHOOD;
}

module.exports = { CHAINS, normalizeChain };
