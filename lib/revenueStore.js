// Revenue ledger for the admin Revenue tab. Three kinds of rows, all scoped by network:
//   gas     : what the relayer wallet paid in gas for a fee job (flush, fee-wallet swap/claim, buyback, airdrop),
//             read from the transaction receipt (gasUsed x effective gas price), one row per tx hash.
//   events  : the fee-wallet distributor's own accounting events (fees in, conversions, buybacks, claims, ...),
//             indexed by the relayer so a period can be summed without scanning the chain on every page view.
//   cursors : how far the event indexer has read, per network + distributor address.
// Storage follows the other stores: MySQL when configured (tables created by lib/db.js), else one JSON file under the
// relayer data root. Wei amounts are kept as decimal strings (they exceed Number precision); callers use BigInt.
const fs = require("fs");
const path = require("path");
const db = require("./db");
const { RELAYER_DATA_ROOT } = require("./relayerStore");

const LEDGER_PATH = path.join(RELAYER_DATA_ROOT, "revenue-ledger.json");
const MAX_FS_ROWS = 20000; // the JSON fallback keeps the newest rows of each kind

function readFs() {
  try {
    if (!fs.existsSync(LEDGER_PATH)) return { gas: [], events: [], cursors: {} };
    const d = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
    return { gas: Array.isArray(d.gas) ? d.gas : [], events: Array.isArray(d.events) ? d.events : [], cursors: d.cursors && typeof d.cursors === "object" ? d.cursors : {} };
  } catch (err) {
    console.warn(`revenue-ledger.json could not be read (${err.message}) — treating it as empty.`);
    return { gas: [], events: [], cursors: {} };
  }
}
function writeFs(d) {
  d.gas = d.gas.slice(-MAX_FS_ROWS);
  d.events = d.events.slice(-MAX_FS_ROWS);
  fs.mkdirSync(RELAYER_DATA_ROOT, { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(d));
}

// entry: { txHash, category, gasUsed, gasPriceWei, costWei, t }   (idempotent per network + txHash)
async function addGas(network, entry) {
  const row = {
    network, txHash: String(entry.txHash).toLowerCase(), category: String(entry.category),
    gasUsed: String(entry.gasUsed), gasPriceWei: String(entry.gasPriceWei), costWei: String(entry.costWei), t: Number(entry.t) || Date.now(),
  };
  if (db.isDbConfigured()) {
    await db.query(
      "INSERT IGNORE INTO revenue_gas (network, tx_hash, category, gas_used, gas_price_wei, cost_wei, t) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [row.network, row.txHash, row.category, row.gasUsed, row.gasPriceWei, row.costWei, row.t]
    );
    return;
  }
  const d = readFs();
  if (d.gas.some((g) => g.network === network && g.txHash === row.txHash)) return;
  d.gas.push(row);
  writeFs(d);
}

// Rows with t >= sinceMs (0 = all), oldest first.
async function listGas(network, sinceMs = 0) {
  if (db.isDbConfigured()) {
    const rows = await db.query(
      "SELECT tx_hash, category, gas_used, gas_price_wei, cost_wei, t FROM revenue_gas WHERE network = ? AND t >= ? ORDER BY t ASC",
      [network, sinceMs]
    );
    return rows.map((r) => ({ txHash: r.tx_hash, category: r.category, gasUsed: String(r.gas_used), gasPriceWei: String(r.gas_price_wei), costWei: String(r.cost_wei), t: Number(r.t) }));
  }
  return readFs().gas.filter((g) => g.network === network && g.t >= sinceMs).sort((a, b) => a.t - b.t);
}

// ev: { distributor, txHash, logIndex, blockNumber, t, kind, data }  (idempotent per network + txHash + logIndex)
async function addEvents(network, list) {
  if (!list.length) return;
  if (db.isDbConfigured()) {
    for (const e of list) {
      await db.query(
        "INSERT IGNORE INTO revenue_events (network, distributor, tx_hash, log_index, block_number, t, kind, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [network, e.distributor.toLowerCase(), e.txHash.toLowerCase(), e.logIndex, e.blockNumber, e.t, e.kind, JSON.stringify(e.data || {})]
      );
    }
    return;
  }
  const d = readFs();
  const have = new Set(d.events.map((x) => `${x.network}:${x.txHash}:${x.logIndex}`));
  for (const e of list) {
    const key = `${network}:${e.txHash.toLowerCase()}:${e.logIndex}`;
    if (have.has(key)) continue;
    have.add(key);
    d.events.push({ network, distributor: e.distributor.toLowerCase(), txHash: e.txHash.toLowerCase(), logIndex: e.logIndex, blockNumber: e.blockNumber, t: e.t, kind: e.kind, data: e.data || {} });
  }
  writeFs(d);
}

// Events of one distributor with t >= sinceMs (0 = all), oldest first.
async function listEvents(network, distributor, sinceMs = 0) {
  const dist = String(distributor).toLowerCase();
  if (db.isDbConfigured()) {
    const rows = await db.query(
      "SELECT tx_hash, log_index, block_number, t, kind, data FROM revenue_events WHERE network = ? AND distributor = ? AND t >= ? ORDER BY block_number ASC, log_index ASC",
      [network, dist, sinceMs]
    );
    return rows.map((r) => ({
      txHash: r.tx_hash, logIndex: Number(r.log_index), blockNumber: Number(r.block_number), t: Number(r.t), kind: r.kind,
      data: typeof r.data === "string" ? JSON.parse(r.data) : r.data || {},
    }));
  }
  return readFs().events
    .filter((e) => e.network === network && e.distributor === dist && e.t >= sinceMs)
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

async function getEventCursor(network, distributor) {
  const key = `${network}:${String(distributor).toLowerCase()}`;
  if (db.isDbConfigured()) {
    const rows = await db.query("SELECT last_block FROM revenue_cursor WHERE cursor_key = ?", [key]);
    return rows.length ? Number(rows[0].last_block) : null;
  }
  const v = readFs().cursors[key];
  return typeof v === "number" ? v : null;
}
async function setEventCursor(network, distributor, block) {
  const key = `${network}:${String(distributor).toLowerCase()}`;
  if (db.isDbConfigured()) {
    await db.query("INSERT INTO revenue_cursor (cursor_key, last_block) VALUES (?, ?) ON DUPLICATE KEY UPDATE last_block = VALUES(last_block)", [key, block]);
    return;
  }
  const d = readFs();
  d.cursors[key] = block;
  writeFs(d);
}

module.exports = { addGas, listGas, addEvents, listEvents, getEventCursor, setEventCursor };
