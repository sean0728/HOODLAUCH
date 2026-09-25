# Hood Launch

Hood Launch is a token-launchpad platform for **Robinhood Chain**. It lets anyone deploy an ERC-20 token in a few different ways — a plain no-frills deploy, a token launched straight into a real DEX pool, a fully configurable "advanced" tax token, or a pump.fun-style bonding curve that graduates into a real pool once it hits a funding target — all from a single-page front end, with an optional gasless relayer so a creator never has to hold ETH just to pay for the launch transaction itself.

The project has three parts that all live in this one repository:

- **`contracts/`** — the Solidity contracts: four launch factories, two token implementations, a liquidity locker, and three optional reward/fee-distribution contracts.
- **`scripts/`** and **`lib/`** — Hardhat deployment/admin scripts, and a small Express service (the "relayer") that powers gasless launches, live price/activity tracking, and the platform's admin API.
- **`public/`** — a single-file front end (`index.html`) served directly by the relayer: the launch flow, token grid, live trade feed, portfolio view, and admin panel.

## Contents

- [How a launch works](#how-a-launch-works)
- [Launch modes](#launch-modes)
- [Smart contracts](#smart-contracts)
- [Fees and reward distribution](#fees-and-reward-distribution)
- [Gasless (relayed) launches](#gasless-relayed-launches)
- [The relayer service](#the-relayer-service)
- [The front end](#the-front-end)
- [Networks](#networks)
- [Project structure](#project-structure)
- [Getting started](#getting-started)
- [Deploying the contracts](#deploying-the-contracts)
- [Running the relayer](#running-the-relayer)
- [Environment variables](#environment-variables)
- [Scripts reference](#scripts-reference)
- [Data storage](#data-storage)
- [Testing](#testing)
- [Security notes](#security-notes)
- [Disclaimer](#disclaimer)
- [License](#license)

## How a launch works

Every launch mode follows the same basic shape: a creator picks a mode on the front end, fills in a name/symbol/supply (and, for the taxed/liquidity modes, an ETH amount), and sends one transaction. Everything else — minting the token, seeding a pool or a bonding curve, locking LP, wiring up the trading tax — happens atomically in that same transaction. There is no multi-step "deploy, then configure, then add liquidity" dance; a launch either fully succeeds or fully reverts.

Two of the four factories (`TokenFactory`, `CustomTokenFactory`) also support an optional **gasless** path: the creator signs a message instead of sending a transaction, and a relayer wallet submits and pays for it. See [Gasless (relayed) launches](#gasless-relayed-launches).

## Launch modes

| Mode | Factory | Token | Upfront ETH? | Trading tax | Graduates? |
|---|---|---|---|---|---|
| **Deploy Token** | `TokenFactory` | `LaunchedToken` | No | None | N/A — no pool |
| **Deploy + Add Liquidity** | `TokenFactory` | `LaunchedToken` | Yes (liquidity + optional buy-in) | Flat %, disables once market cap crosses a USD target | Tax only |
| **Deploy Custom Tax Token** | `CustomTokenFactory` | `CustomToken` | No | None (configured but inert) | N/A — no pool |
| **Deploy + Add Liquidity (custom tax)** | `CustomTokenFactory` | `CustomToken` | Yes | Creator-configured (reflections/marketing/liquidity/burn, buy+sell independently, each capped) plus a platform tax on top | Platform tax only |
| **Quick Launch** | `BondingCurveFactory` | `LaunchedToken` | No | None pre-graduation | Curve → real pool once its ETH raise target is hit; platform tax runs from graduation to a market-cap target, then disables permanently |
| **Quick Launch (custom tax)** | `CustomBondingCurveFactory` | `CustomToken` | No | None pre-graduation | Same graduation, then the creator's configured `CustomToken` tax applies post-graduation |

"Just Launch" tokens mint 100% of supply straight to the creator's wallet — no pool exists, and creating one afterward (anywhere, by any means) is entirely the creator's own responsibility. Every liquidity-bearing mode (including both Quick Launch variants once they graduate) locks the resulting LP tokens for a configurable duration; a Quick Launch's LP goes to the *original* creator, never to whoever happens to trigger graduation.

## Smart contracts

| Contract | Role |
|---|---|
| `TokenFactory.sol` | Entry point for the plain launch path (`createToken`) — deploy-only or deploy-with-liquidity. |
| `LaunchedToken.sol` | The ERC-20 every plain/Quick Launch token is deployed as (EIP-1167 minimal-proxy clone). Carries the flat percentage transfer tax once a pool exists, and permanently disables it once the pool's live market cap (via a Chainlink-style feed) crosses a configured USD target. |
| `CustomTokenFactory.sol` | Entry point for the "advanced" launch path (`createCustomToken`) — same deploy-only/deploy-with-liquidity split, but clones `CustomToken`. |
| `CustomToken.sol` | The configurable ERC-20 `CustomTokenFactory` clones. Buy/sell tax split across up to four independently-toggleable mechanics: reflections (ETH or a named ERC-20), marketing wallet, auto-liquidity, and auto-burn. Rates are locked at launch and can never be raised later — closing off the classic "creator jacks up the tax after launch" rug. |
| `BondingCurveFactory.sol` | The zero-tax Quick Launch path: mints the full supply to itself, trades it against an internal constant-product bonding curve (virtual + real reserves, pump.fun-style), and auto-graduates into a real DEX pool — funded entirely by the curve's own accumulated ETH — once a funding target is hit. |
| `CustomBondingCurveFactory.sol` | Same bonding-curve mechanics as `BondingCurveFactory`, but graduates into a `CustomToken` instead of a `LaunchedToken`, so the creator's own configurable tax applies once trading moves to the real pool. |
| `LiquidityLocker.sol` | A generic, factory-scoped timelock for LP tokens. Each factory gets its own instance, wired to accept `lock()` calls only from that one factory. |
| `CreatorRewardsDistributor.sol` | Optional. Collects a per-token, in-kind slice of every taxed trade, swaps it for ETH, and lets that token's own creator claim it. Pools nothing across tokens — each launch has its own independent claimable balance. |
| `contracts/interfaces/` | Shared interfaces (`IUniswapV2Router02`, `IAggregatorV3`, `IUniswapV2Pair`, plus a couple of small platform-specific ones). |
| `contracts/mocks/` | `MockRouter`, `MockERC20`, `MockAggregatorV3` — used only for local Hardhat-network testing/deploys, never on a real network. |

`contracts/BondingCurve.sol` also exists in this repo as an earlier, per-token-clone bonding-curve design (LP burned at graduation rather than locked, oracle-based USD graduation). It predates the current shared-factory `BondingCurveFactory`/`CustomBondingCurveFactory` design and is not wired into any deploy script or factory — it's kept for reference only.

Two platform-level contracts referenced by the deploy script (`PlatformToken`, `PlatformRewardsDistributor`) back an entirely optional platform-wide buyback/airdrop mechanism, deployed only once, whenever the platform's own token launches (`DEPLOY_PLATFORM_TOKEN=true` — see [Environment variables](#environment-variables)).

## Fees and reward distribution

Every factory has the same three **optional, off-by-default** revenue hooks, each wired in independently by the deployer/owner:

- **`rewardsDistributor`** (`PlatformRewardsDistributor`) — a slice of the platform's own tax/fee revenue, pooled and used for a platform-token buyback + burn/holder-airdrop split.
- **`creatorRewardsDistributor`** (`CreatorRewardsDistributor`) — a slice paid out per-token, in ETH, to that specific token's own creator.
- **`feeWalletDistributor`** (`FeeWalletDistributor`) — converts the platform's remaining fee-wallet cut to ETH automatically instead of leaving it sitting as whatever token it was taxed in.

Leaving any of these unset is always safe: the factories and tokens fall back to their original, simpler behavior (100% of the relevant fee goes straight to a plain wallet address) with no code branch depending on them being configured.

## Gasless (relayed) launches

`TokenFactory` and `CustomTokenFactory` support an EIP-712 voucher pattern so a creator never has to hold ETH to pay gas for the launch transaction itself:

1. The front end has the creator sign a `LaunchVoucher`/`CustomLaunchVoucher` (an off-chain, gas-free signature) and POSTs it to the relayer.
2. The creator sends **one plain ETH transfer** into the factory's own escrow (`depositForRelayedLaunch`) — covering the launch fee/liquidity/buy-in, never a raw gas payment.
3. Once both the voucher and a matching on-chain deposit are on file, the relayer calls `relayedCreateToken`/`relayedCreateCustomToken` from its own wallet and pays that transaction's gas.
4. On success, the relayer verifies the deployed contract(s) where possible and records the launch to the shared, per-network launch ledger that the front end's token grid reads from.

A stolen or leaked relayer key can only waste its own ETH balance or stop relaying — it can never forge a launch or take a creator's funds, since every relay re-checks the creator's own signature and escrowed deposit before doing anything.

`BondingCurveFactory`/`CustomBondingCurveFactory` support the identical voucher pattern for Quick Launch creation, buys, and sells.

## The relayer service

`scripts/relayer.js` is a single long-running Express process (`node scripts/relayer.js`, or `npx hardhat run scripts/relayer.js --network <network>`) that does four jobs at once:

- **Serves the front end** — `public/index.html` and its assets, as plain static files.
- **Relays gasless launches** — the voucher/deposit flow above, for whichever factories it's configured with.
- **Watches the chain** — auto-discovers every token ever launched against a configured factory, tracks live prices/market cap/holder counts, and records buy/sell activity (including bonding-curve trades, read straight off the factory's own events pre-graduation) for the front end's live feed and price charts.
- **Serves the admin/public API** — the platform-wide Demo/Live network switch, the admin-configurable contract-address panel, token metadata sync, and a handful of read-only endpoints the front end polls.

It never holds a creator's or admin's private key — only its own relayer wallet's key (`RELAYER_PRIVATE_KEY`), used purely to pay gas for relayed transactions. Admin actions (switching the active network, editing the platform-config panel) are authenticated by recovering a `personal_sign` signature server-side against a fixed admin wallet — the front end's own admin-panel gate is UI-only convenience, not the actual access control.

Key routes:

| Method | Route | Purpose |
|---|---|---|
| GET | `/health` | Liveness/readiness check |
| GET | `/launches` | The shared, per-network ledger of every launch this relayer has recorded |
| GET | `/failed-launches` | Vouchers that never successfully relayed |
| GET / POST | `/active-network` | Read/switch the platform-wide Demo (testnet) vs. Live (mainnet) setting |
| GET / POST | `/platform-config` | Read/save the admin-configured contract addresses per network |
| POST | `/vouchers/token` \| `/vouchers/custom` \| `/vouchers/curve` \| `/vouchers/custom-curve` | Submit a signed launch voucher for gasless relaying |
| GET | `/status/:voucherHash` | Poll a relayed launch's progress |
| POST | `/track-token` | Register an independently-added token/pool for price/activity tracking |
| POST | `/token-metadata/:tokenAddress` | Creator-signed update to a token's logo/banner/socials |
| GET | `/activity` | Recent real buy/sell events (curve and DEX-pool trades alike) — backs the live feed |
| GET | `/price-history/:tokenAddress` | Sampled price/market-cap history — backs the price charts |
| GET | `/holder-distribution/:tokenAddress` | Holder count/distribution snapshot |

## The front end

`public/index.html` is a single self-contained page (no build step) covering:

- The launch flow for all six modes, wallet connection, and network switching (MetaMask-style injected wallet).
- A token grid with search/status filters, live price sparklines, and a market-cap badge per token.
- A live trade feed, polling the relayer's `/activity` endpoint, tagging bonding-curve trades distinctly from ordinary DEX-pool trades, and posting a banner announcement whenever a brand-new token launches.
- A per-wallet portfolio view (your launches, your holdings, claimable creator rewards, LP unlock status).
- An admin panel (gated by a hardcoded admin wallet address, enforced server-side — see above) for switching the platform-wide active network and editing contract addresses per network.

The page reads its contract addresses from a three-layer precedence chain: a static `public/config.json` shipped with the deploy, overridden by whatever the admin has saved server-side via the admin panel, overridden in turn by anything already in the visitor's own browser `localStorage`.

Demo mode always maps to Robinhood Chain **testnet**; Live mode always maps to **mainnet** — the grid, the header stats, and the live feed all scope to whichever one is currently active, so switching networks never mixes testnet and mainnet tokens together.

## Networks

| | Testnet ("Demo") | Mainnet ("Live") |
|---|---|---|
| Chain ID | 46630 | 4663 |
| Default RPC | `https://rpc.testnet.chain.robinhood.com` | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | `https://explorer.testnet.chain.robinhood.com/` | `https://robinhoodchain.blockscout.com/` |

Robinhood's own docs note the public RPC endpoints are rate-limited and recommend a dedicated endpoint (e.g. Alchemy) for anything beyond light testing — override via `ROBINHOOD_TESTNET_RPC_URL` / `ROBINHOOD_MAINNET_RPC_URL`.

## Project structure

```
contracts/
  TokenFactory.sol            Plain launch factory
  LaunchedToken.sol           Plain/Quick-Launch token implementation
  CustomTokenFactory.sol      Advanced (configurable-tax) launch factory
  CustomToken.sol             Advanced token implementation
  BondingCurveFactory.sol     Quick Launch (zero-tax) factory
  CustomBondingCurveFactory.sol   Quick Launch (custom-tax) factory
  LiquidityLocker.sol         Generic LP timelock
  CreatorRewardsDistributor.sol
  BondingCurve.sol            Legacy/reference design — not wired into any factory
  interfaces/                 Shared external-contract interfaces
  mocks/                      Local-testing-only mocks (router, ERC20, price feed)

scripts/
  deploy.js          Deploys the full stack to a given network
  relayer.js          The Express relayer/admin/API service (see above)
  setRelayer.js       One-time-per-rotation: authorizes the relayer wallet on each factory
  launch.js / customLaunch.js     CLI launch helpers (non-relayed)
  buyToken.js / sellToken.js      CLI trade helpers for pool-based tokens
  curveBuy.js / curveSell.js      CLI trade helpers for bonding-curve tokens

lib/
  networks.js          Robinhood Chain network parameters (chain IDs, RPC/explorer URLs)
  verify.js            Explorer source-verification helpers
  deploymentStore.js    Per-network deployment-address bookkeeping (deployments/<network>/)
  launchStore.js        The shared, public launch ledger GET /launches serves
  trackedTokensStore.js Tokens the relayer watches for price/activity
  activityStore.js       Recorded buy/sell events (backs the live feed)
  priceHistoryStore.js   Sampled price/market-cap history (backs the charts)
  priceMath.js           Price/market-cap/tax-progress math shared across routes
  relayerStore.js        Vouchers, pending deposits, active-network + platform-config state
  platformConfig.js       Canonicalization for the admin-panel config payload
  tokenMetadata.js         Canonicalization for creator-signed metadata updates
  signedMessage.js         Generic personal_sign verification helper
  adminAuth.js             Verifies an admin action's signature against the admin wallet
  vanitySalt.js            CREATE2-style salt search for vanity token addresses
  db.js                    Optional MySQL storage layer (see Data storage)

public/
  index.html      The entire front end (single file, no build step)
  config.json      Per-network contract addresses shipped with the deploy
  assets/          Static assets, plus JSON-file storage fallback for lib/*Store modules

test/               Hardhat/Mocha contract tests
AUDIT-*.md          Internal audit notes for individual contracts
```

## Getting started

Prerequisites: Node.js and npm, and a wallet funded with testnet ETH if you plan to deploy.

```bash
npm install
cp .env.example .env   # if present — otherwise create .env with the variables below
```

## Deploying the contracts

```bash
npx hardhat compile
npx hardhat run scripts/deploy.js --network robinhoodTestnet   # or robinhoodMainnet
```

`deploy.js` deploys `LaunchedToken`, `LiquidityLocker`, and `TokenFactory`; `CustomToken`, its own `LiquidityLocker`, and `CustomTokenFactory`; and both bonding-curve factories with their own dedicated lockers — wiring every locker to its own factory as it goes. It refuses to guess a DEX router or price-feed address on a real network (only Robinhood **mainnet**'s Uniswap V2 router/factory and Chainlink ETH/USD feed are independently confirmed as of this writing — see the constants at the top of `scripts/deploy.js`); set `DEX_ROUTER_ADDRESS`/`PRICE_FEED_ADDRESS` explicitly for testnet or any other network. On the local Hardhat network it deploys mock versions of both instead, so the full flow is runnable end-to-end with no external dependencies.

Every run appends a full address summary to `deployments/<network>/` (current + history) via `lib/deploymentStore.js` — that's the source of truth for "what's live right now" on a given network, not console scrollback.

After deploying (or redeploying) a factory, authorize the relayer wallet on it before gasless launches will work:

```bash
RELAYER_ADDRESS=0x... \
TOKEN_FACTORY_ADDRESS=0x... CUSTOM_TOKEN_FACTORY_ADDRESS=0x... \
BONDING_CURVE_FACTORY_ADDRESS=0x... CUSTOM_BONDING_CURVE_FACTORY_ADDRESS=0x... \
  npx hardhat run scripts/setRelayer.js --network robinhoodTestnet
```

This must be run by each factory's **owner** wallet, never the relayer's own wallet — `RELAYER_ADDRESS` only ever needs the relayer's public address, never its private key.

## Running the relayer

```bash
RELAYER_PRIVATE_KEY=0x... \
TOKEN_FACTORY_ADDRESS=0x... CUSTOM_TOKEN_FACTORY_ADDRESS=0x... \
BONDING_CURVE_FACTORY_ADDRESS=0x... CUSTOM_BONDING_CURVE_FACTORY_ADDRESS=0x... \
  npx hardhat run scripts/relayer.js --network robinhoodTestnet
```

It's a long-lived process — run it under a process manager (or your PaaS's own process supervision) rather than expecting it to exit on its own. It listens on `PORT`/`RELAYER_PORT` (falls back to `8787`), and serves `public/` directly, so pointing a domain at wherever it's running is enough to serve the whole site.

## Environment variables

**Contracts (`.env`, read by `hardhat.config.js` and `scripts/deploy.js`):**

| Variable | Purpose |
|---|---|
| `DEPLOYER_PRIVATE_KEY` | The wallet that deploys every contract and owns every factory afterward |
| `ROBINHOOD_TESTNET_RPC_URL` / `ROBINHOOD_MAINNET_RPC_URL` | Override the public RPC endpoints |
| `EXPLORER_API_KEY` | Blockscout API key for source verification (any non-empty string generally works) |
| `DEX_ROUTER_ADDRESS` / `PRICE_FEED_ADDRESS` | Required on any real network besides the one with confirmed defaults (see above) |
| `FEE_TREASURY_ADDRESS` / `PLATFORM_FEE_WALLET_ADDRESS` | Where flat fees / trading-tax revenue go by default (falls back to the deployer) |
| `DEPLOY_FEE_WEI` / `LAUNCH_FEE_WEI` / `CURVE_LAUNCH_FEE_WEI` | Exact fee amounts; omit to auto-convert from a live USD target |
| `LP_LOCK_DURATION_SECONDS` | LP lock duration for every liquidity-bearing mode (default 15 days) |
| `POOL_SEED_TARGET_WEI` | Real-ETH raise target that triggers Quick Launch graduation |
| `DEPLOY_PLATFORM_TOKEN` / `PLATFORM_TOKEN_*` | One-time platform-token launch (see [Fees and reward distribution](#fees-and-reward-distribution)) |
| `REWARDS_DISTRIBUTOR_ADDRESS` / `DEPLOY_PLATFORM_TOKEN` | Reuse or freshly deploy `PlatformRewardsDistributor` |
| `CREATOR_REWARDS_DISTRIBUTOR_ADDRESS` / `DEPLOY_CREATOR_REWARDS` | Reuse or freshly deploy `CreatorRewardsDistributor` |
| `FEE_WALLET_DISTRIBUTOR_ADDRESS` / `DEPLOY_FEE_WALLET_DISTRIBUTOR` / `FEE_WALLET_ADDRESS` | Reuse or freshly deploy `FeeWalletDistributor` |

**Relayer host (separate from the `.env` above — set wherever `scripts/relayer.js` actually runs):**

| Variable | Purpose |
|---|---|
| `RELAYER_PRIVATE_KEY` | Pays gas for every relayed launch/trade — never a creator's or admin's key |
| `TOKEN_FACTORY_ADDRESS` / `CUSTOM_TOKEN_FACTORY_ADDRESS` / `BONDING_CURVE_FACTORY_ADDRESS` / `CUSTOM_BONDING_CURVE_FACTORY_ADDRESS` | Which factories this instance relays/tracks for (all optional — omit any you don't want gasless relaying for) |
| `FEE_WALLET_DISTRIBUTOR_ADDRESS` / `PLATFORM_REWARDS_DISTRIBUTOR_ADDRESS` | Enables the optional automatic sweep/buyback/airdrop loops |
| `PORT` / `RELAYER_PORT` | HTTP port (default `8787`) |
| `DATABASE_URL` **or** `DB_HOST`+`DB_NAME` (+`DB_PORT`/`DB_USER`/`DB_PASSWORD`) | Switches every store module from JSON files to MySQL (see [Data storage](#data-storage)) |

A missing/misconfigured factory address only ever disables gasless relaying (and tracking) for that one launch type — the site, wallet-paid launches, and every other configured factory all start up normally regardless.

## Scripts reference

| Command | What it does |
|---|---|
| `npx hardhat compile` | Compile all contracts |
| `npx hardhat test` | Run the Mocha/Hardhat test suite |
| `npx hardhat run scripts/deploy.js --network <network>` | Deploy the full contract stack |
| `npx hardhat run scripts/relayer.js --network <network>` | Start the relayer/front-end/admin service |
| `npx hardhat run scripts/setRelayer.js --network <network>` | Authorize (or revoke) the relayer wallet on every configured factory |
| `npx hardhat run scripts/launch.js --network <network>` | CLI: launch a plain token without the front end/relayer |
| `npx hardhat run scripts/customLaunch.js --network <network>` | CLI: launch an advanced (custom-tax) token |
| `npx hardhat run scripts/buyToken.js` / `sellToken.js` | CLI: trade a pool-based token directly against its router |
| `npx hardhat run scripts/curveBuy.js` / `curveSell.js` | CLI: trade a bonding-curve token directly against its curve |

## Data storage

Every stateful module under `lib/` (`launchStore`, `trackedTokensStore`, `relayerStore`, `priceHistoryStore`, `activityStore`, `deploymentStore`) checks a single switch (`lib/db.js`'s `isDbConfigured()`) before doing anything. Leave `DATABASE_URL`/`DB_HOST`+`DB_NAME` unset and everything reads/writes plain JSON files under `public/assets/` and `deployments/` — no database required to run the whole platform. Set them and every store transparently switches to MySQL instead, with no other configuration change needed.

## Testing

```bash
npx hardhat test
```

Covers the bonding-curve math and factory (`test/BondingCurve*.test.js`) and the creator-rewards distributor (`test/CreatorRewardsDistributor.test.js`). See `AUDIT-LaunchedToken.md` and `AUDIT-CustomToken.md` for narrative security notes on the two token implementations.

## Security notes

- Every contract that moves ETH mid-transaction uses `ReentrancyGuard`; `BondingCurveFactory`/`CustomBondingCurveFactory` additionally follow checks-effects-interactions on `sell()`'s payout and flip `graduated` before any external call in graduation.
- All liquidity added at launch time is locked to the creator (or, for a bonding curve, permanently burned at graduation) — never immediately withdrawable.
- `CustomToken`'s buy/sell tax rates are set once at initialization and have no setter afterward; `renounceCreator()` permanently locks out every remaining creator-only operational change.
- A stale price feed (older than a configurable staleness window) never blocks a trade or a graduation check — it's skipped, not reverted, so an oracle outage can't freeze the contract.
- The relayer's own private key can only ever spend its own gas balance; it can never forge a launch or move a creator's escrowed funds, since every relayed call re-verifies the original signed voucher and on-chain deposit.
- Admin-only server routes are authenticated by recovering a `personal_sign` signature against a fixed admin wallet, server-side — the front end's own "is this the admin" check is convenience UI only, not itself a security boundary.

## Disclaimer

This is experimental software interacting with real funds once deployed to mainnet. Nothing here constitutes financial advice, and launching or trading a token carries real risk — review the contracts and audit notes yourself before relying on them with real value.

## License

Every Solidity file in `contracts/` carries an `SPDX-License-Identifier: MIT` header. Add a repository-wide `LICENSE` file with the MIT license text if one isn't already present.
