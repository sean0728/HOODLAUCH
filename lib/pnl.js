// Profit-and-loss maths for wallet trading (pure functions — no I/O, so they
// are easy to test). Everything is in USD, using the USD value the relayer
// recorded for each trade at the moment it happened.
//
// Method: average cost basis, per wallet per token.
//   buy  : position grows by the tokens bought; its cost grows by the USD paid.
//   sell : the tokens sold are taken out of the position at the position's
//          average cost; realized PNL = USD received - that cost.
//   held : unrealized PNL = tokens still held x current price - remaining cost.
//   overall PNL = realized + unrealized.
//
// Only tokens the ledger saw being bought can have a cost basis. If a wallet
// sells more than it was seen buying (tokens it already held before tracking
// began, or got by transfer), the excess is NOT counted as profit — its cost
// is unknown, and counting it as pure gain would hand out fake PNL. It is
// reported as `untrackedSellUsd` instead.

const TOKEN_DECIMALS = 18;

// tokenAmount arrives as a wei-style integer string; convert to a plain number
// of tokens (precision loss is fine for display-grade PNL).
function tokensFromWei(str) {
  if (str === null || str === undefined) return 0;
  const s = String(str);
  if (!/^\d+$/.test(s)) return Number(s) || 0;
  if (s.length <= TOKEN_DECIMALS) return Number("0." + s.padStart(TOKEN_DECIMALS, "0"));
  return Number(s.slice(0, s.length - TOKEN_DECIMALS) + "." + s.slice(s.length - TOKEN_DECIMALS));
}

function emptyPosition(token, symbol) {
  return {
    token, symbol: symbol || null,
    qty: 0, costUsd: 0,
    buys: 0, sells: 0, buyUsd: 0, sellUsd: 0,
    realizedUsd: 0, untrackedSellUsd: 0,
    firstTradeAt: null, lastTradeAt: null, lastTradePrice: null,
  };
}

function applyTrade(pos, trade) {
  const qty = tokensFromWei(trade.tokenAmount);
  const usd = Number(trade.usdValue) || 0;
  if (!(qty > 0)) return;
  if (trade.symbol && !pos.symbol) pos.symbol = trade.symbol;
  if (pos.firstTradeAt === null || trade.t < pos.firstTradeAt) pos.firstTradeAt = trade.t;
  if (pos.lastTradeAt === null || trade.t >= pos.lastTradeAt) { pos.lastTradeAt = trade.t; pos.lastTradePrice = usd / qty; }
  if (trade.side === "buy") {
    pos.qty += qty; pos.costUsd += usd;
    pos.buys += 1; pos.buyUsd += usd;
  } else {
    pos.sells += 1; pos.sellUsd += usd;
    const sellQty = Math.min(qty, pos.qty);
    if (sellQty > 0) {
      const avg = pos.costUsd / pos.qty;
      const proceeds = usd * (sellQty / qty);
      pos.realizedUsd += proceeds - avg * sellQty;
      pos.qty -= sellQty; pos.costUsd -= avg * sellQty;
      if (pos.qty < 1e-9) { pos.qty = 0; pos.costUsd = 0; }
    }
    if (qty > sellQty) pos.untrackedSellUsd += usd * ((qty - sellQty) / qty);
  }
}

// trades: array of { t, side, wallet, token (or tokenAddress), symbol, tokenAmount, usdValue }, any order.
// priceOf(tokenLower) -> current USD price or null/undefined.
// Returns Map(walletLower -> { wallet, positions: Map(tokenLower -> position) })
function buildPositions(trades) {
  const wallets = new Map();
  const ordered = trades.slice().sort((a, b) => (a.t - b.t) || ((a.logIndex || 0) - (b.logIndex || 0)));
  for (const tr of ordered) {
    const w = String(tr.wallet || "").toLowerCase();
    const tok = String(tr.tokenAddress || tr.token || "").toLowerCase();
    if (!w || !tok) continue;
    let entry = wallets.get(w);
    if (!entry) { entry = { wallet: w, positions: new Map() }; wallets.set(w, entry); }
    let pos = entry.positions.get(tok);
    if (!pos) { pos = emptyPosition(tok, tr.symbol); entry.positions.set(tok, pos); }
    applyTrade(pos, tr);
  }
  return wallets;
}

// Turns one wallet's positions into the per-token rows and overall totals.
function summarizeWallet(entry, priceOf) {
  const tokens = [];
  const overall = { realizedUsd: 0, unrealizedUsd: 0, totalUsd: 0, buys: 0, sells: 0, buyUsd: 0, sellUsd: 0, tokens: 0, openTokens: 0 };
  for (const pos of entry.positions.values()) {
    let price = priceOf ? priceOf(pos.token) : null;
    if (!(price > 0)) price = pos.lastTradePrice > 0 ? pos.lastTradePrice : 0;
    const valueUsd = pos.qty * price;
    const unrealizedUsd = pos.qty > 0 ? valueUsd - pos.costUsd : 0;
    const row = {
      token: pos.token, symbol: pos.symbol,
      qty: pos.qty, avgCostUsd: pos.qty > 0 ? pos.costUsd / pos.qty : null,
      currentPriceUsd: price || null, valueUsd,
      buys: pos.buys, sells: pos.sells, buyUsd: pos.buyUsd, sellUsd: pos.sellUsd,
      realizedUsd: pos.realizedUsd, unrealizedUsd, totalUsd: pos.realizedUsd + unrealizedUsd,
      firstTradeAt: pos.firstTradeAt, lastTradeAt: pos.lastTradeAt,
    };
    tokens.push(row);
    overall.realizedUsd += row.realizedUsd; overall.unrealizedUsd += row.unrealizedUsd;
    overall.buys += row.buys; overall.sells += row.sells; overall.buyUsd += row.buyUsd; overall.sellUsd += row.sellUsd;
    overall.tokens += 1; if (pos.qty > 0) overall.openTokens += 1;
  }
  overall.totalUsd = overall.realizedUsd + overall.unrealizedUsd;
  tokens.sort((a, b) => (b.lastTradeAt || 0) - (a.lastTradeAt || 0));
  return { wallet: entry.wallet, overall, tokens };
}

module.exports = { tokensFromWei, applyTrade, buildPositions, summarizeWallet, emptyPosition };
