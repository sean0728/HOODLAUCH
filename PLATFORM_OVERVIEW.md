# Hood Launch — platform overview

Hood Launch is a token-launch platform for Robinhood Chain: anyone can
deploy an ERC20 token, optionally pair it with real liquidity and a
self-graduating trading tax, trade it, and — if the creator opted in — earn
an ongoing share of that trading tax for as long as they hold the token's
creator role. This document is the map of the whole system: what each piece
is, how they talk to each other, and where to look for more depth on any
one part. The contract-level deep dive already lives in `README.md`
(fee math, tax mechanics, slippage protection, gasless voucher trust model,
verification, storage layout) — this document sits a level above that and
covers the pieces `README.md` doesn't: the relayer's live-data API, the
front end, the admin panel, creator rewards, and what actually running this
in production has taught us.

## The three layers

**Smart contracts** (Solidity, Hardhat, `contracts/`) are the source of
truth for everything that matters: token identity, supply, tax rates, pool
addresses, ownership, and reward diversions. Nothing about the platform can
override what's on-chain — the relayer and front end are both just clients
of it.

**The relayer** (`scripts/relayer.js`, Node/Express) is the platform's own
always-on service. It does two unrelated jobs under one process: it lets
creators launch **without paying gas themselves** (see "Gasless relayed
launches" in `README.md`), and it's the read API the front end calls for
everything that would otherwise require the browser to independently
re-scan the chain — every launch that's ever happened, live trade activity,
price/market-cap history, holder distribution, and platform-wide config.

**The front end** (`index.html`) is a single self-contained page: the
launch wizard, the explore/detail views, the creator's own portfolio, and
an admin panel. It talks to the chain directly for wallet actions (signing,
sending transactions) and to the relayer for everything read-only or
gasless.

Two networks exist side by side throughout — Robinhood Chain's testnet and
mainnet, referred to as "Demo" and "Live" in the front end. Each network
has its own factories, its own relayer instance, and its own on-disk data —
nothing about a testnet launch, price history, or config ever mixes with
mainnet's.

## What a creator can actually do

**Launch a token**, choosing two independent things: whether it's a plain
token (`TokenFactory` / `LaunchedToken`, fixed 0.25% tax) or a Custom Tax
Token (`CustomTokenFactory` / `CustomToken`, creator-configurable
reflections/marketing/auto-liquidity/burn splits), and whether it's
"Deploy Token" (create + verify only, 100% of supply straight to the
creator's wallet, no pool) or "Deploy and Add Liquidity" (mints into a real
pool atomically, LP locked to the creator, trading tax active until the
pool graduates past a fixed market-cap target). A liquidity launch can also
include a same-transaction creator buy-in, capped well below a rug-pull
share of supply. Every launch can go through gaslessly — sign a voucher,
send one small deposit, the relayer submits the real deploy transaction and
pays its gas — or directly, paying gas yourself. See `README.md` for the
full mechanics of all of this; it hasn't changed.

**Earn creator rewards.** At launch time, if the platform's
`CreatorRewardsDistributor` was configured on the factory, a small
bps-of-trading-tax diversion (`creatorRewardBps`, default 5 = 0.05%) gets
permanently snapshotted onto that specific token — this is fixed forever
per token, the same way the tax rate itself is. As the token trades, that
share accumulates on the distributor contract. It reaches the creator two
ways: the relayer can auto-sweep it (converting the in-kind balance and
sending it out) once it crosses a threshold, or the creator can trigger it
themselves at any time straight from their wallet via the portfolio UI's
"Claim"/"Convert to ETH" actions — those are ordinary, permissionless calls
directly against the distributor contract and work regardless of whether
the relayer's auto-sweep is currently enabled.

**Trade.** Buys/sells against a launched pool are ordinary DEX swaps —
Hood Launch doesn't sit in the middle of a trade, it only comes into play
at launch time and through the token's own tax logic. The front end's
explore/detail pages show live price, market cap, tax-graduation progress,
and holder distribution, all sourced from the relayer (see below) rather
than re-deriving everything client-side.

**Administer the platform**, if you hold the one hardcoded admin wallet —
see "The admin panel" below.

## The relayer's live-data API

Beyond the gasless-launch endpoints already covered in `README.md`
(`POST /vouchers/token`, `POST /vouchers/custom`, `GET /status/:voucherHash`),
the relayer exposes the read endpoints the front end depends on for
anything that isn't a direct wallet-to-contract call:

- **`GET /launches`** — every launch ever recorded on this relayer's
  network, public fields only.
- **`GET /activity`** — real trade activity (buy/sell, wallet, USD value),
  backed by a background loop watching `Swap` events on every tracked
  token's pool.
- **`GET /price-history/:tokenAddress`** — sampled price/market-cap/tax-
  progress/holder-count points over time, backed by a background loop that
  reads a pool's live reserves plus the token's on-chain price feed every
  ~45 seconds.
- **`GET /holder-distribution/:tokenAddress`** — top-holder breakdown
  (address + percentage of supply), computed on demand from the network's
  Blockscout-compatible explorer API cross-referenced against the token's
  real on-chain `totalSupply()`.
- **`GET /active-network`** / **`POST /active-network`** and
  **`GET /platform-config`** / **`POST /platform-config`** — the off-chain
  config layer behind the admin panel's "Platform contracts" section (see
  below); the `POST` routes require a fresh, signed message from the admin
  wallet, verified server-side (`lib/adminAuth.js`) — the front end's own
  "is this the admin wallet" check is a UI convenience only, never the real
  access control.
- **`GET /health`** — liveness, plus the actual factory/distributor
  addresses this *running* process resolved at startup. This exists
  because a hosting dashboard showing a value as "saved" is not proof the
  live process is actually using it — see "Operating this in production"
  below.
- **`GET /debug/token/:tokenAddress`** — ground-truth diagnostic for one
  specific token: has it been discovered yet, does it have a pool on file,
  how many price points have been sampled, and how far behind each
  factory's discovery scan is from the current chain tip.

None of the `GET` endpoints above require authentication — there's nothing
sensitive in them, and the on-chain state they read is public anyway. Only
the config-mutating `POST` routes are admin-signature-gated.

### The three background loops

Independently of serving HTTP requests, the relayer runs three polling
loops for as long as it's up:

1. **Deposit watcher** — the core gasless-launch mechanism from
   `README.md`: watches `LaunchDeposited` events and relays matching signed
   vouchers.
2. **Token discovery** — scans both factories' `TokenCreated`/
   `CustomTokenCreated` events forward from a stored cursor, recording every
   token that's ever launched (whether or not it went through this
   relayer) into a local registry. Activity and price sampling both depend
   on a token showing up here first.
3. **Activity + price sampling** — for every token discovery has found with
   a pool, watches `Swap` events (activity) and periodically reads pool
   reserves plus the token's price feed (price/market-cap/tax-progress/
   holder-count).

A fourth, optional loop — **creator-reward auto-sweep** — walks every
launched token, checks its accumulated balance on `CreatorRewardsDistributor`
against that token's swap threshold, and triggers the swap-and-payout
itself, at the relayer's own gas cost, once the threshold is crossed. This
loop is disabled automatically (not a crash) if the distributor's contract
artifact isn't available at startup — see "Known operational issue" below.

## The admin panel

The front end's admin section has two genuinely different parts, easy to
conflate:

**Platform contracts** (and "Platform rewards") — purely off-chain
configuration: which factory/distributor/price-feed addresses the front
end should treat as "current" for Demo vs Live. "Save (this browser)"
writes to `localStorage`; "Save (all visitors)" signs a message with the
admin wallet and calls `POST /platform-config`, persisting it server-side
for everyone. The front end's actual config at any moment is a layered
merge — `config.json` (lowest priority, effectively a bootstrap default) <
the server config < this browser's own `localStorage` override (highest
priority) — which matters operationally: a stale `localStorage` override
on one browser can make that one browser behave as if a correct server-side
save never happened, even though every other visitor sees it fine.

**Contract admin** — real on-chain owner actions against whichever factory
is currently configured: updating deploy/launch fees, the fee treasury,
LP lock duration, max creator buy-in, tax defaults (fee bps, platform fee
wallet, price feed, graduation target, oracle staleness, reward bps,
creator reward bps), the rewards distributor and creator rewards
distributor addresses, and two-step ownership transfer. Each field has its
own "Update" button and sends its own transaction — nothing here is saved
by the "Platform contracts" Save buttons above, and nothing here takes
effect anywhere else until that specific transaction confirms.

Every admin action — on-chain or the off-chain config saves — is gated the
same way: `window.ethereum.request({ method: "personal_sign" })` over a
message that embeds exactly what's being changed and a timestamp, verified
server-side (for the two `POST` config routes) against a single hardcoded
`ADMIN_WALLET`. There's no separate login system and no session state; the
signature itself, freshly made each time, is the credential.

## Storage: files, not a database

Nothing here runs a database. Every piece of server-side state is a JSON
file (or a small set of them) under a per-network subdirectory, following
the same convention throughout:

- `deployed-contracts/<network>/` — the launch ledger (`lib/launchStore.js`),
  the token-discovery registry (`lib/trackedTokensStore.js`), sampled
  activity (`lib/activityStore.js`) and price history
  (`lib/priceHistoryStore.js`).
- `relayer-data/<network>/` — voucher lifecycle state and block-scan
  cursors (`lib/relayerStore.js`), plus the active-network/platform-config
  values the admin panel manages.
- `deployments/<network>/` — the platform's own infrastructure deployment
  record (`lib/deploymentStore.js`) — which factory/distributor/etc.
  addresses exist for a given network, separate from any individual token
  launch.

This is deliberate — see each store module's own comments — but it has a
real consequence in production: **whichever directory these live under
must actually survive a restart or redeploy**, or every cursor, every
sampled price point, and the discovery registry all reset to empty the
next time the process starts. This bit us directly — see below.

## Operating this in production: what we actually learned

A few things only became clear after running this on a real managed
Node.js host (GoDaddy), worth recording so they don't get rediscovered the
hard way again:

**A host's "saved" env var/secret is not the same as the running process
using it.** More than once, a value shown as correctly configured in the
dashboard did not match what the live process had actually resolved at its
own startup. `GET /health` and `GET /debug/token/:tokenAddress` exist
specifically to answer "what is this process *actually* running with right
now" without guessing from the dashboard — when something behaves as if an
env var never changed, check one of these before assuming the dashboard is
lying or the code is wrong.

**A "Restart" and a full "Republish" are not equally reliable.** On this
host, the standalone restart action failed outright more than once, while a
full republish reliably picked up new env vars/secrets. When an env var
change doesn't seem to take effect, republish before concluding it's a
deeper problem.

**A build step can silently reuse a stale cached build.** This host's logs
showed `"node_modules and build output present from preview - serving
directly"` on every deploy — meaning `hardhat compile` wasn't necessarily
re-running, so a freshly-added contract's compiled artifact could be
missing from what's actually served (`HardhatError: HH700: Artifact for
contract "X" not found`). This caused a real production outage once: code
that loaded `CreatorRewardsDistributor` at startup threw before the server
ever reached `app.listen()`, taking the entire site down over one optional
feature. The fix generalizes: **any optional/non-core startup dependency
must be wrapped in its own try/catch**, so its failure degrades that one
feature rather than crashing the whole process. `scripts/relayer.js` now
does this for `CreatorRewardsDistributor` specifically — its absence just
disables auto-sweep and logs why; vouchers, deposits, the API, the site,
and manual claim/convert (which never goes through the relayer at all) all
keep working regardless.

**A brand-new contract's event history starts at its own deployment
block, not genesis** — but the token-discovery loop's default backfill
behavior doesn't know that. On a chain with a very high block count, the
default scan rate (20,000 blocks per tick) can leave discovery hours or
days behind the chain tip after cutting over to newly-deployed factories,
during which nothing new gets tracked and every price/chart/mcap value for
a brand-new token reads as zero. `TOKEN_DISCOVERY_MAX_BLOCK_RANGE` is an
env var specifically so this is tunable without a code change — set it high
enough that `fromBlock + range` exceeds the current tip and discovery
catches up in one tick rather than crawling. `GET /debug/token/:tokenAddress`
shows `discoveryCursor` vs `latestBlock` directly, so this is something to
check rather than assume.

**Deploying the relayer at all** — the practical checklist (runtime deps
in `dependencies` not `devDependencies`, listening on `process.env.PORT`,
permissive CORS, redirectable data directories via `RELAYER_DATA_DIR`/
`DEPLOYED_CONTRACTS_DIR`/`DEPLOYMENTS_DIR`) is covered in full in
`README.md`'s "Deploying the relayer on a managed Node.js host" section —
still accurate, not repeated here.

## Testing

`npx hardhat test` runs the full suite — contract-level tests (tax
mechanics, slippage, gasless vouchers, reflections, admin access control —
see `README.md` and the two `AUDIT-*.md` files for what's covered and why)
alongside relayer-level tests for every HTTP route described above. A few
of those routes can't be exercised by booting the actual relayer process in
a test (`scripts/relayer.js`'s `main()` isn't structured for import), so
those tests instead mount the exact same route logic against a real
Hardhat network and a scratch data directory — each such test file says so
in its own header comment, and any change to the real route needs its
mirrored test logic updated to match, or the two can silently drift apart.

## What's still open

- **Creator-reward auto-sweep depends on a clean build reaching
  production** — see "A build step can silently reuse a stale cached
  build" above. Manual claim/convert is unaffected either way, but this
  should eventually get resolved so auto-sweep can run again.
- **No security audit** — see `README.md`'s own note; do not deploy this
  with real value at stake without one.
- **The off-chain identity/dashboard backend** (socials, Sign-In With
  Ethereum, creator profile editing) doesn't exist yet — the relayer's
  read API is real live-chain data, but there's no separate indexer/DB
  service beyond what's described here.
- **Testnet still lacks a confirmed real DEX router and Chainlink price
  feed** — see `README.md`'s deployment notes; this affects testnet only,
  mainnet has both confirmed.
