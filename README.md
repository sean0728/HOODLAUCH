# IgnitionX

IgnitionX (formerly Hood Launch) is a token-launchpad platform for **Robinhood Chain**. Every EVM launch runs on **Uniswap V4** and carries a **V4** tag: a token launched straight into a real V4 pool, a fully configurable custom-tax token, or a pump.fun-style bonding curve that graduates into a V4 pool once it hits a funding target. Launches are **gasless**: the creator signs a message and pays only the launch fee and liquidity, and the platform's relayer pays the gas. Solana quick launches (Meteora DBC) sit alongside, unchanged.

The platform is V4-only. The older Uniswap V2 contracts were removed. The one remaining V2 piece is the **platform token** (a V2 pool; the V4 distributors buy it back through a V2 router). See [V4_README.md](V4_README.md) for the contract-level detail.

**What's new**

- **Every V4 contract has been audited**, one at a time, with a proof-of-concept test against the unmodified contract first and a fixed version after. The per-contract PDF reports are in the repository root (see [Audits](#audits)).
- **Snapshot-based airdrop rounds.** The platform token now keeps balance snapshots, and the three round-running distributors pay holders from a snapshot taken when the round starts. Buying or moving tokens mid-round can no longer change a payout (see [Platform token and airdrop rounds](#platform-token-and-airdrop-rounds)).
- **Redesigned `PlatformToken`.** Append-only holder registry, packed snapshots, and an owner whose only power is authorising snapshotters. This version has to be redeployed and its V2 pool re-seeded.
- **One-step authorisation at deploy time.** `V4deploy.js` and `deployPlatformToken.js` authorise the distributors as snapshotters automatically, in whichever order the token and the V4 set are deployed (see [Deploying the contracts](#deploying-the-contracts)).
- **A much larger test suite:** 686 contract tests (681 V4 plus 5 platform-token).

The project has three parts that all live in this one repository:

- **`contracts/`** — the Solidity contracts: three V4 launch factories, a gasless launch relay, two token implementations, the V4 tax hook, the liquidity locker, swap router, compounder, and the reward/fee distributors.
- **`scripts/`** and **`lib/`** — Hardhat deployment/admin scripts, and a small Express service (the "relayer") that powers gasless launches, live price/activity tracking, Telegram launch posts, and the platform's admin API.
- **`public/`** — a single-file front end (`index.html`) served directly by the relayer: the launch flow, token grid, live trade feed, portfolio view, and admin panel.

## Contents

- [How a launch works](#how-a-launch-works)
- [Launch modes](#launch-modes)
- [Smart contracts](#smart-contracts)
- [Fees and reward distribution](#fees-and-reward-distribution)
- [Platform token and airdrop rounds](#platform-token-and-airdrop-rounds)
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
- [Audits](#audits)
- [Disclaimer](#disclaimer)
- [License](#license)

## How a launch works

A creator picks a mode on the front end, fills in a name/symbol/supply (and, for the liquidity modes, an ETH amount) and signs. Everything else — minting the token, creating the V4 pool or bonding curve, locking the LP position, wiring up the trading-tax hook — happens atomically in one transaction. A launch either fully succeeds or fully reverts. The creator owns the token and the locked LP position; the platform never owns a launched token.

By default the transaction is sent by the platform relayer (see [Gasless (relayed) launches](#gasless-relayed-launches)). If the relayer is not ready, the page says so and falls back to a normal wallet transaction where the creator pays gas.

## Launch modes

| Mode | Factory | Token | Upfront ETH? | Trading tax | Graduates? |
|---|---|---|---|---|---|
| **Deploy + Add Liquidity** | `V4TokenFactory` | `V4LaunchedToken` | Yes (liquidity + optional buy-in) | Flat %, collected by the hook at the pool; disables once market cap crosses a USD target | Tax only |
| **Deploy + Add Liquidity (custom tax)** | `V4CustomTokenFactory` | `V4CustomToken` | Yes | Creator-configured (reflections, marketing, liquidity, burn; buy and sell independently, each capped) plus a platform tax | Platform tax only |
| **Quick Launch** | `V4CurveFactory` | `V4LaunchedToken` | No (fee + optional buy-in) | None pre-graduation | Curve → V4 pool once its ETH raise target is hit; platform tax runs until a market-cap target, then disables |
| **Quick Launch (custom tax)** | `V4CurveFactory` | `V4CustomToken` | No | None pre-graduation | Same graduation, then the creator's configured tax applies |

The wizard no longer offers a deploy-only mode (a token with no pool), because Quick Launch covers that need; `V4TokenFactory` no longer contains it (no deploy-only path and no deploy fee; `createToken` and the voucher keep an `addLiquidityAtLaunch` flag that must be true, so signatures and integrations are unchanged), and any deploy-only tokens launched earlier still display. Every liquidity-bearing mode locks the full-range LP position in `V4LiquidityLocker` for a configurable duration; a Quick Launch's position is locked for the *original* creator, never for whoever triggers graduation. 

## Smart contracts

| Contract | Role |
|---|---|
| `V4TokenFactory.sol` | Plain launch path (`createToken`): deploy a token with a locked V4 pool. Has its own voucher/escrow relay for gasless launches and is the source of the platform tax settings. |
| `V4CustomTokenFactory.sol` | Custom-tax launch with liquidity. |
| `V4CurveFactory.sol` | Bonding-curve Quick Launch (plain or custom-tax token) that graduates into a V4 pool. |
| `V4PoolLauncher.sol` | Abstract base shared by the custom and curve factories: pool initialization, locked full-range seeding, and the `launchRelay` hook that lets `V4LaunchRelay` launch on a creator's behalf. |
| `V4LaunchRelay.sol` | EIP-712 voucher + ETH-deposit relay for the custom and curve factories (they are too close to the contract size limit to hold the code themselves). |
| `V4LaunchedToken.sol` / `V4CustomToken.sol` | The ERC-20 clones (EIP-1167). The plain token has no tax logic; the custom token handles reflections, marketing, and burn with rates that are locked at launch and can never be raised. Reflections can be paid to holders in the token itself, in ETH, or in another token chosen at launch; ETH / token payouts are converted by `V4ReflectionConverter` and sent to holders automatically in batches by the relayer keeper (see `V4_README.md`, "Reflection payout choice"). |
| `V4TaxHook.sol` | The Uniswap V4 hook. Takes the platform fee (and a custom token's marketing share) in ETH from the ETH side of each swap, books it per pool, pays it out through a permissionless `flush` (the relayer runs it on a timer), and runs the graduation check that switches the platform fee off at the market-cap target. See `V4_README.md`, "ETH fees: how they are taken and paid". |
| `V4LiquidityLocker.sol` | Owns every full-range V4 position and enforces the creator's lock; pays principal and LP fees at unlock. |
| `V4LiquidityCompounder.sol` | Receives the custom tokens' "liquidity" share and turns it into permanent LP. |
| `V4SwapRouter.sol`, `V4Create2Deployer.sol` | Trade router used by the page and the relayer; CREATE2 deployer used to place the hook at its required address. |
| `V4PlatformRewardsDistributor.sol`, `V4PlatformTaxDistributor.sol`, `V4PlatformTokenRewards.sol` | Platform revenue: swap collected tax to ETH, buy back the platform token, burn part of it, airdrop part to holders in snapshot-based rounds. `V4PlatformTokenRewards` is the shared round logic the other two build on. |
| `V4CreatorRewardsDistributor.sol` | Per-token slice of the platform fee, received as ETH from the hook (`depositFor(token)`) and claimable by that token's own creator. Pools from before the ETH-fee hook still feed it in-kind tokens that it converts. |
| `V4FeeWalletDistributor.sol` | Receives the platform fee-wallet cut as ETH from the hook (`depositFee()`): half claimable by the fee wallet, half for the platform-token buyback, whose airdrop share is paid in snapshot rounds. Keeps on-chain revenue counters (`accounting()`); the relayer adds keeper-gas accounting, shown in Admin → Revenue (see `V4_README.md`). (Still converts in-kind tokens for pools from before the ETH-fee hook.) |
| `PlatformToken.sol` | The platform's own fixed-supply ERC-20 with an append-only holder registry, balance snapshots (`snapshot`, `balanceOfAt`, `totalSupplyAt`) and `burn`. Lives in a Uniswap V2 pool. The owner can only authorise snapshotters (and hand over ownership in two steps). |
| `contracts/interfaces/`, `contracts/mocks/` | Shared interfaces and test-only mocks, never deployed to a real network. |

## Fees and reward distribution

The distributors are optional and off by default on each factory; leaving any unset is always safe (the fee goes to a plain wallet instead):

- **Platform rewards / tax distributors** — a slice of the platform's own tax and fee revenue, pooled and used for a platform-token buyback plus a burn / holder-airdrop split. They buy the token through the V2 router fixed at their deployment.
- **Creator rewards distributor** — a slice paid per token, in ETH, to that token's own creator.
- **Fee wallet distributor** — converts the platform's remaining fee-wallet cut to ETH instead of leaving it in the taxed token.

Conversions can only be started by the owner, owner-approved keepers (the relayer wallet) and, for creator rewards, the token's own creator; claiming stays permissionless.

Fee flow in short: the hook takes the platform fee in ETH on each swap (1% until the token reaches a $50K market cap), books it per pool, and a permissionless `flush` (run by the relayer on a timer) pays it out. The launch fee is split 50/50 between the treasury and the rewards distributor. A short, per-factory **snipe protection** surcharge applies to buys right after launch and decays to zero (defaults 2500 bps over 180 s, set with `setSnipeProtection`). The on-chain revenue counters and the relayer's keeper-gas accounting feed **Admin → Revenue**. Details are in [V4_README.md](V4_README.md).

## Platform token and airdrop rounds

The platform token's holders share part of the platform's revenue through **airdrop rounds**. A round pays each holder in proportion to what they held at the moment the round started, so nobody can inflate a payout by buying, splitting wallets or moving tokens while the round is running.

**How a round works**

1. The distributor buys the platform token back through its V2 router and splits it 50/50: half is burned, half goes to the holder airdrop.
2. It starts a round: the platform token takes a **snapshot**, and the distributor records how many holders there were (`roundHolderCountAtStart`) and the eligible supply (total supply, minus the distributor's own balance, minus the balances of excluded addresses). The owner excludes the V2 pair, the PoolManager and other contracts with `setAirdropExcluded` (up to 16, not during a round), so a pool never collects airdrops; add the platform token's V2 pair before the first round.
3. The round is paid out in **batches**. Each holder receives `roundAmount × balanceOfAt(holder, snapshotId) / eligibleSupply`. Batches cost roughly 65–68k gas per holder, so keep them to 200 holders or fewer (the relayer's default is 200 per batch, up to 10 batches per tick).
4. The pot cap is only a backstop. Because payouts are exact shares of the snapshot, only rounding dust is ever left over.

**The token side (`PlatformToken`)**

- **Append-only holder registry.** An address joins the registry on its first non-zero balance and is never removed, so a round can walk a fixed list.
- **Packed checkpoints.** Each account's snapshot value is written once per snapshot (the first transfer after a snapshot costs about 129k gas; later ones about 48k; a plain transfer is about 39k).
- **Restricted snapshots.** Only addresses the owner has authorised with `setSnapshotter` can call `snapshot()`. The owner has no other privileges: no mint, no pause, no blacklist, no fee.
- **Supply cap.** Total supply is capped at 2¹²⁸−1 so checkpoints can stay packed.

**Who can run a round**

- Rounds and conversions are **owner and keeper only** (the relayer wallet is the keeper). Claiming is permissionless.
- `V4PlatformTaxDistributor` starts a round from inside its own distribute step. If the snapshot cannot be taken (for example the token has not authorised it yet), it **defers** instead of reverting: the fee wallet is still paid, the tokens are still bought, and the bought tokens wait in `pendingDisburseTokens` (event `DisburseRoundDeferred`) until a round can start. Manual `startDisburseRound` / `runDisburseRound` revert with the token's own reason instead.
- `setPlatformToken` on a distributor checks that the token has a holder registry and snapshots, and that the distributor is already authorised as a snapshotter, and fails with a clear message if not.
- Automatic processing (`autoDistribute`) defaults to off and `autoProcessBatchSize` to 0 (ceiling 50, runs inside the trader's tax transfer), so the default behaviour adds no gas to trades.

**Authorising the distributors.** The three distributors that run rounds (fee wallet, platform rewards, platform tax) must each be authorised on the token by its owner. The creator-rewards distributor does not run rounds and is not authorised. The deploy scripts do this for you (see [Deploying the contracts](#deploying-the-contracts)); `scripts/authorizePlatformTokenSnapshotters.js` does it on its own.

> **Redeploy note.** The snapshot token is a new contract. Deploy it with `deployPlatformToken.js`, re-seed its V2 pool with `addPlatformTokenLiquidity.js`, then point each distributor at it with `setPlatformToken`. The fee-wallet and creator-rewards distributors are deployed without a buyback router, so the fee-wallet distributor cannot use `setPlatformToken` unless it is redeployed with one. On the tax distributor, call `setRouter` before `setPlatformToken`.

## Gasless (relayed) launches

All four launch modes are gasless, in two flavors:

- **Plain mode** (`V4TokenFactory`): the creator signs a voucher and sends one ETH deposit into the factory's own escrow (`depositForRelayedLaunch`); the relayer calls `relayedCreateToken`.
- **Custom and curve modes**: the creator signs a voucher (domain `HoodLaunchV4Relay`) and sends one ETH deposit to **`V4LaunchRelay`**; the relayer calls the relay, which forwards to the factory, which launches as the signing creator.

In both flavors the deposit covers only the launch fee, liquidity and buy-in — never a raw gas payment — and the relayer's gas is repaid from the launch fee up to an owner-set cap. A leaked relayer key can only waste its own gas or stop relaying; it can never forge a launch or take a creator's funds, because the contracts re-check the creator's signature and deposit. Unclaimed deposits can be reclaimed by the creator after the deadline.

## The relayer service

`scripts/relayer.js` is a single long-running Express process (`node scripts/relayer.js`, or `npx hardhat run scripts/relayer.js --network <network>`) that does four jobs at once:

- **Serves the front end** — `public/index.html` and its assets, as plain static files.
- **Relays gasless launches** — the voucher/deposit flow above, for whichever V4 contracts it is configured with.
- **Watches the chain** — auto-discovers every token launched against a configured factory, tracks live prices/market cap/holder counts, records buy/sell activity for the live feed and charts, and posts new launches (and the two curve milestones) to Telegram when a bot is configured.
- **Serves the admin/public API** — the Demo/Live network switch, the admin-configurable contract-address panel, token metadata sync, and the read-only endpoints the front end polls.

It never holds a creator's or admin's private key — only its own relayer wallet's key (`RELAYER_PRIVATE_KEY`), used purely to pay gas. Admin actions are authenticated by recovering a `personal_sign` signature server-side against a fixed admin wallet; the front end's admin gate is UI-only convenience.

Key routes:

| Method | Route | Purpose |
|---|---|---|
| GET | `/health` | Liveness/readiness; reports which V4 contracts are loaded (`v4TokenFactoryAddress`, `v4CustomTokenFactoryAddress`, `v4CurveFactoryAddress`, `v4LaunchRelayAddress`, `v4LaunchRelayLoaded`, `gaslessKinds`) |
| GET | `/launches` | The shared, per-network ledger of every launch; each entry carries `protocol` |
| GET | `/failed-launches` | Vouchers that never successfully relayed |
| GET / POST | `/active-network` | Read/switch the platform-wide Demo (testnet) vs. Live (mainnet) setting |
| GET / POST | `/platform-config` | Read/save the admin-configured contract addresses per network |
| POST | `/vouchers/v4token` \| `/vouchers/v4custom` \| `/vouchers/v4curve` \| `/vouchers/v4custom-curve` | Submit a signed launch voucher for gasless relaying |
| GET | `/status/:voucherHash` | Poll a relayed launch's progress |
| POST | `/track-token` | Register an independently-added token/pool for price/activity tracking |
| POST | `/token-metadata/:tokenAddress` | Creator-signed update to a token's logo/banner/socials |
| GET | `/activity` | Recent real buy/sell events — backs the live feed |
| GET | `/price-history/:tokenAddress` | Sampled price/market-cap history |
| GET | `/holder-distribution/:tokenAddress` | Holder count/distribution snapshot |
| GET / POST | `/profiles`, `/profile`, `/wallet-links`, `/wallet-links/remove` | Names, pictures and linked wallets — Robinhood or Solana (see *Accounts, linked wallets and socials*) |
| GET / POST | `/comments`, `/callouts` (+ `/delete`) | Token comments and callouts — Robinhood tokens and Solana mints |

## The front end

`public/index.html` is a single self-contained page (no build step) covering:

- The launch flow for all four V4 modes (plus Solana quick launch), wallet connection, and network switching. Before each launch the page checks that the relayer and `V4LaunchRelay` are ready and otherwise falls back to a wallet-paid transaction with a notice.
- A token grid showing V4 launches (with a **V4** tag), search/status filters, live price sparklines and a market-cap badge per token. Pre-V4 tokens are hidden, not deleted.
- A live trade feed, polling the relayer's `/activity` endpoint, and a banner whenever a brand-new token launches.
- A per-wallet portfolio view (your launches, holdings, claimable creator rewards, LP unlock status).
- An admin panel (gated by a hardcoded admin wallet, enforced server-side) for the active network, the twelve V4 contract addresses per network, and the V4 contract panels (factories, relay, hook, locker, distributors).

The page reads its contract addresses from a three-layer precedence chain: a static `public/config.json` shipped with the deploy, overridden by whatever the admin has saved server-side, overridden in turn by anything already in the visitor's own browser `localStorage`.

Demo mode always maps to Robinhood Chain **testnet**; Live mode always maps to **mainnet** — the grid, the header stats, and the live feed all scope to whichever is active.

## Wallet connection

The Connect Wallet button opens a picker. It offers:

- **Every wallet installed in the browser**, discovered through EIP-6963 (the standard wallet announcement), so a visitor with two extensions installed chooses which one to use instead of getting whichever claimed `window.ethereum` first. Wallets that predate EIP-6963 still work through `window.ethereum`.
- **WalletConnect** (QR code on desktop, "Open wallet app" link on phones) for mobile wallets such as Rainbow, Trust, Zerion, MetaMask Mobile and Ledger Live. It appears only when a project ID is configured.
- **Open-in-wallet links** (MetaMask, Coinbase Wallet, Trust, Phantom, OKX) for a phone browser that has no wallet injected.

The last wallet used is remembered and restored on reload. Every wallet call in `index.html` goes through one accessor, `getEth()`, which returns the provider the visitor picked.

**Enabling WalletConnect.** Create a free project at dashboard.reown.com, add your site's domain to its allowed domains, and put the project ID in `public/wallet-config.json`:

```json
{ "walletConnectProjectId": "0123456789abcdef0123456789abcdef" }
```

It is a public identifier, not a secret. Blank or missing means the WalletConnect option is simply not shown. WalletConnect support is a self-hosted bundle, `public/vendor/hood-walletconnect.js` (about 2 MB, downloaded only when someone picks WalletConnect); no third-party script is loaded. To rebuild it: `cd walletconnect-build && npm install && npm run build`. The page's Content-Security-Policy allows only the WalletConnect relay and verification hosts.

**Known limits.** WalletConnect sessions need Robinhood Chain to be available in the visitor's mobile wallet (the picker tells them the chain ID to add). Smart-contract wallets (Safe, passkey wallets) cannot sign gasless launches or profile actions, because the server and the factory contracts verify ordinary (EOA) signatures only.

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
  V4TokenFactory.sol            Plain launch factory (deploy with liquidity)
  V4CustomTokenFactory.sol      Custom-tax launch factory
  V4CurveFactory.sol            Bonding-curve Quick Launch factory
  V4PoolLauncher.sol            Shared base for the custom and curve factories
  V4LaunchRelay.sol             Gasless voucher relay for the custom and curve factories
  V4LaunchedToken.sol           Plain token implementation
  V4CustomToken.sol             Custom-tax token implementation
  V4TaxHook.sol                 Uniswap V4 hook (tax + graduation)
  V4LiquidityLocker.sol         LP timelock
  V4LiquidityCompounder.sol     Turns the liquidity share into permanent LP
  V4SwapRouter.sol              Trade router
  V4Create2Deployer.sol         CREATE2 deployer for the hook
  V4PlatformRewardsDistributor.sol, V4PlatformTaxDistributor.sol,
  V4PlatformTokenRewards.sol, V4CreatorRewardsDistributor.sol,
  V4FeeWalletDistributor.sol   Revenue / reward contracts (V4PlatformTokenRewards = shared snapshot-round logic)
  V4TokenSeller.sol             Shared base of the distributors (sells taxed tokens for ETH)
  PlatformToken.sol             The platform's own token (V2 pool, holder registry, snapshots)
  interfaces/                   Shared external-contract interfaces
  mocks/                        Local-testing-only mocks

scripts/
  V4deploy.js               Deploys (or resumes) the whole V4 set, resumable via deployments/<net>/
  V4verify.js               Explorer source verification for the V4 set
  V4setRelayer.js           Sets the relayer (and gas cap) on V4LaunchRelay and/or V4TokenFactory
  V4mineHookAddress.js      Finds the CREATE2 salt for the hook address
  V4checkChain.js           Read-only pre-flight: transient storage + PoolManager present?
  deployPlatformToken.js    Deploys PlatformToken, authorises existing distributors, prints the wiring steps
  authorizePlatformTokenSnapshotters.js   Authorises the distributors as snapshotters (idempotent)
  checkPlatformTokenBytecode.js   Compares a deployed token's bytecode with the compiled source
  addPlatformTokenLiquidity.js   Seeds the platform token's V2 pool
  reclaimDeposit.js / getVoucherHashFromDeposit.js   Recover a stuck gasless deposit
  resetDiscoveryCursor.js   Rescan the chain for launches
  relayer.js                The Express relayer / admin / API service

lib/                         Stores, math, signing helpers, Telegram announcements, Solana API,
                             platformTokenSnapshotters.js (shared snapshotter-authorisation helper)
public/
  index.html                 The entire front end (single file, no build step)
  config.json                Per-network contract addresses shipped with the deploy
  assets/                    Static assets, plus JSON-file storage fallback for lib/*Store modules

test/                        Hardhat/Mocha contract tests (V4*.test.js, PlatformToken, Telegram, Solana)
V4_README.md                 Contract-level V4 documentation
HoodLaunch_*_Audit*.pdf      Per-contract security audit reports (see Audits)
```

## Getting started

Prerequisites: Node.js and npm, and a wallet funded with ETH on the target network if you plan to deploy. See [V4_README.md](V4_README.md) for the extra V4 packages and the test-mode Hardhat setup.

```bash
npm install
cp .env.example .env   # if present — otherwise create .env with the variables below
```

## Deploying the contracts

```bash
npx hardhat run scripts/V4deploy.js --network robinhoodTestnet   # or robinhoodMainnet
```

`V4deploy.js` deploys the hook (mined to a valid CREATE2 address), locker, swap router, compounder, the three launch factories, `V4LaunchRelay`, and the optional distributors. It wires them together, calls `setLaunchRelay` on both factories that need it, and, when `RELAYER_ADDRESS` is set and the deployer owns the contracts, sets the relay's gas-reimbursement cap and then the relayer. It also authorises the three round-running distributors as snapshotters on the platform token (see below). It saves progress under `deployments/<network>/`, so a failed run can be re-run and resumes where it stopped. It will not guess a PoolManager or price feed on an unknown network (set `POOL_MANAGER` / `PRICE_FEED_ADDRESS`), and it skips the platform-rewards distributor unless `DEX_ROUTER_ADDRESS` is set, because that distributor's buyback router is fixed at deployment.

Then:

```bash
npx hardhat run scripts/V4verify.js --network robinhoodTestnet   # explorer verification
```

If contract ownership moved (Ownable2Step) and you need to change the relayer later, use the owner wallet:

```bash
RELAYER_ADDRESS=0x... V4_LAUNCH_RELAY_ADDRESS=0x... V4_TOKEN_FACTORY_ADDRESS=0x... \
  npx hardhat run scripts/V4setRelayer.js --network robinhoodTestnet
```

It sets the gas cap first (the contract refuses a relayer while the cap is zero), then the relayer. `RELAYER_ADDRESS` is only the relayer's public address, never its key.

The platform token is separate: `scripts/deployPlatformToken.js`, then `scripts/addPlatformTokenLiquidity.js`, then the `setPlatformToken` / `setRouter` / `setAirdropExcluded` calls it prints. See [V4_README.md](V4_README.md).

**Authorising airdrops (snapshotters).** Each distributor that runs airdrop rounds must be authorised on the platform token with `setSnapshotter(distributor, true)`, and only the token's owner can do that. The deploy scripts handle it, whichever of the two you deploy second:

- Deploy the V4 set first, then the token: `deployPlatformToken.js` reads `deployments/<network>/v4-deploy.json` and authorises the fee-wallet, platform-rewards and platform-tax distributors it finds.
- Deploy the token first, then the V4 set: `V4deploy.js` reads `deployments/<network>/platform-token.json` and authorises the distributors it just deployed.

It is idempotent (already-authorised distributors are skipped) and never fails the deploy: if the signer is not the token's owner it reports why and prints the exact command to run later. Set `AUTHORIZE_SNAPSHOTTERS=false` to skip it. To run it on its own, as the token owner:

```bash
npx hardhat run scripts/authorizePlatformTokenSnapshotters.js --network robinhoodTestnet
```

Use `scripts/checkPlatformTokenBytecode.js` to confirm that a deployed platform token matches the compiled source.

## Running the relayer

```bash
RELAYER_PRIVATE_KEY=0x... \
V4_TOKEN_FACTORY_ADDRESS=0x... V4_CUSTOM_TOKEN_FACTORY_ADDRESS=0x... \
V4_CURVE_FACTORY_ADDRESS=0x... V4_LAUNCH_RELAY_ADDRESS=0x... \
  npx hardhat run scripts/relayer.js --network robinhoodTestnet
```

It's a long-lived process — run it under a process manager (or your PaaS's own supervision). It listens on `PORT`/`RELAYER_PORT` (default `8787`) and serves `public/` directly, so pointing a domain at it serves the whole site. Each V4 address can instead be saved in the Admin panel; an environment variable wins if both are set. The relayer wallet must also be set as a keeper (`setKeeper(relayer, true)`) on the distributors if you want automatic conversions.

## Environment variables

**Contracts (`.env`, read by `hardhat.config.js` and the deploy scripts):**

| Variable | Purpose |
|---|---|
| `DEPLOYER_PRIVATE_KEY` | The wallet that deploys every contract (and owns the contracts you keep) |
| `ROBINHOOD_TESTNET_RPC_URL` / `ROBINHOOD_MAINNET_RPC_URL` | Override the public RPC endpoints |
| `EXPLORER_API_KEY` | Blockscout API key for source verification (any non-empty string generally works) |
| `POOL_MANAGER` / `PRICE_FEED_ADDRESS` | Uniswap V4 PoolManager and ETH/USD feed on networks without built-in defaults |
| `DEX_ROUTER_ADDRESS` | Uniswap V2 router the platform distributors use to buy the platform token (fixed at deployment) |
| `RELAYER_ADDRESS` | Relayer wallet (public address) to authorize during `V4deploy.js` / `V4setRelayer.js` |
| `RELAY_MAX_GAS_REIMBURSEMENT_WEI` | Cap on the gas repaid to the relayer per launch (`V4deploy.js`) |
| `MAX_GAS_REIMBURSEMENT_ETH` | Same cap for `V4setRelayer.js` (default 0.01) |
| `FEE_TREASURY_ADDRESS` / `PLATFORM_FEE_WALLET_ADDRESS` / `FEE_WALLET_ADDRESS` | Where flat fees and tax revenue go (fall back to the deployer) |
| `LAUNCH_FEE_WEI` / `CURVE_LAUNCH_FEE_WEI` | Exact fee amounts; omit to convert from a live USD target |
| `LP_LOCK_DURATION_SECONDS` | LP lock duration (default 15 days) |
| `DEPLOY_DISTRIBUTORS` / `DEPLOY_PLATFORM_REWARDS` / `DEPLOY_TAX_DISTRIBUTOR` | Turn the optional distributors on or off (default on) |
| `AUTHORIZE_SNAPSHOTTERS` | Set to `false` to skip authorising the distributors as platform-token snapshotters during `V4deploy.js` / `deployPlatformToken.js` (default on) |
| `V4_FEE_WALLET_DISTRIBUTOR_ADDRESS` / `V4_PLATFORM_REWARDS_DISTRIBUTOR_ADDRESS` / `V4_PLATFORM_TAX_DISTRIBUTOR_ADDRESS` | Override the distributor addresses `authorizePlatformTokenSnapshotters.js` authorises (default: read from `deployments/<network>/v4-deploy.json`) |
| `SNIPE_START_BPS` / `SNIPE_DURATION_SECONDS` | Anti-snipe settings |
| `VERIFY` | Verify source on the explorer during the deploy |

**Relayer host (set wherever `scripts/relayer.js` actually runs):**

| Variable | Purpose |
|---|---|
| `RELAYER_PRIVATE_KEY` | Pays gas for every relayed launch — never a creator's or admin's key |
| `V4_TOKEN_FACTORY_ADDRESS` / `V4_CUSTOM_TOKEN_FACTORY_ADDRESS` / `V4_CURVE_FACTORY_ADDRESS` / `V4_LAUNCH_RELAY_ADDRESS` | Which V4 contracts this instance relays/tracks (each optional; omit any to disable gasless for that mode) |
| `PLATFORM_ROUTER_ADDRESS` | Optional V2 router for the platform-token buyback automation |
| `PORT` / `RELAYER_PORT` | HTTP port (default `8787`) |
| `DATABASE_URL` **or** `DB_HOST`+`DB_NAME` (+`DB_PORT`/`DB_USER`/`DB_PASSWORD`) | Switches every store module from JSON files to MySQL (see [Data storage](#data-storage)) |

A missing or misconfigured address only disables gasless relaying and tracking for that one launch type; the site and every other configured contract start normally. The old V2 variables (`TOKEN_FACTORY_ADDRESS`, `CUSTOM_TOKEN_FACTORY_ADDRESS`, `BONDING_CURVE_FACTORY_ADDRESS`, `CUSTOM_BONDING_CURVE_FACTORY_ADDRESS`, `FEE_WALLET_DISTRIBUTOR_ADDRESS`, `CREATOR_REWARDS_DISTRIBUTOR_ADDRESS`, `PLATFORM_REWARDS_DISTRIBUTOR_ADDRESS`) are no longer read.

## Accounts, linked wallets and socials (multi-chain)

An **account is identified by its main wallet** — a Robinhood (EVM) wallet **or a Solana wallet**, whichever the member signs in with first. A Solana wallet on its own is a complete account: it can set a display name and picture, follow members, comment and make callouts, with no Robinhood wallet involved. The header has a **Connect Solana** button next to **Connect Wallet**; the last Solana wallet used is remembered and reconnected quietly on reload. The Solana module (about 1.0 MB) is only downloaded once someone clicks it or has used it before.

**Linking (optional).** Either kind of wallet can be linked to an account (Profile → *Linked wallets*): a Robinhood wallet to a Solana-main account, a Solana wallet to a Robinhood-main account, up to 5 linked wallets per account. From then on everything a linked wallet does — launches ("Created by"), buys and sells in the live feed, comments, callouts, follows — is shown under the account's name and picture, and is stored under the account.

- **Linking** needs a free signature from *both* wallets over the same text (`IgnitionX: link wallet <wallet> to account <owner> at <ts>`), each made in its own wallet's way (EVM `personal_sign`, Solana `signMessage`/ed25519; the server verifies both). A wallet belongs to at most one account and a linked wallet can't itself be an account's main wallet. The main wallet can unlink any wallet; a linked wallet can also detach itself (`IgnitionX: unlink wallet <wallet> from account <owner> at <ts>`). **Links are public** — anyone can see which wallets belong to a name; the profile screen says so before you sign.
- **No merging yet.** A wallet that already has its own profile, follows, comments or callouts can't be linked (the API answers 409). Link wallets that are new to IgnitionX, or pick the account you want as the main one *before* you start using the other wallet.
- **Ids.** EVM addresses are lowercased; Solana addresses are base58 and case-sensitive, kept exactly. `canonId()` in `lib/social.js` (mirrored in `index.html`) is used in every signed message and store key; the EVM message formats are unchanged.
- **Comments and callouts on Solana tokens** use the same routes and code as Robinhood tokens (`/comments`, `/callouts`; the "token" is the mint, case preserved). Posting needs a display name on the account. Callout prices for Solana tokens come from the relayer's own SOL price history and are shown in SOL (Robinhood callouts stay in USD); the "2.4x" multiple works the same on both. One callout per account per token.
- **Scoping.** Solana devnet counts as the platform's testnet and mainnet-beta as mainnet (the pairing the launch ledger uses), so Solana social data sits under the relayer's `--network` (`robinhoodTestnet` / `robinhoodMainnet`).
- **Routes.** `GET /profiles` (returns `profiles` and `links`: wallet → account), `GET /profile/:address` (any wallet; returns the owning `account`), `POST /profile` (`address` = the signing wallet, EVM or Solana; saved under its account), `GET /wallet-links/:account`, `POST /wallet-links` `{wallet, owner, timestamp, ownerSignature, walletSignature}`, `POST /wallet-links/remove` `{wallet, owner, timestamp, signature}`, plus `/follow`, `/follows/:address`, `/comments`, `/callouts` accepting a Solana signer. Storage: `lib/walletLinkStore.js` (`wallet-links.json`, or the `wallet_links` MySQL table, created automatically).
- **Not yet.** Account merging; Solana trades in profit & loss and the leaderboard (they are listed on the profile in SOL, but the PnL/leaderboard are Robinhood-only); Telegram posts don't use account names. Tests: `node --test test/walletLinks.test.js`.

## Solana (open to anyone; devnet, switchable to mainnet)

Setup, front-end wiring and troubleshooting: see [SOLANA_SETUP.md](SOLANA_SETUP.md). Browser module source: `solana-build/` (`npm run build` -> `public/vendor/ignitionx-solana.js`); runtime settings: **Admin → Solana** (`public/solana-config.json` is only a fallback); browser tests: `python3 test/browser/solana_ui_test.py`.

**One platform, one flow, one wallet.** A Solana launch is signed only by the Solana wallet (two free message signatures + the launch transaction); the Robinhood wallet isn't asked to confirm anything. With public launching off, only the platform wallet — the fee claimer of the saved platform config, read on-chain — may launch. Solana tokens are launched through the platform's own four-step wizard (Identity → Deploy mode → Terms → Review, with the live preview card) — switch the *Robinhood / Solana* picker on the Create page and the same wizard changes its content; there is no separate Solana form. Identity has the usual logo **and banner** uploads (the banner is shown on the token's page; stored on the relayer, ≤300 KB). Telegram: new Solana launches and their two milestones (curve filled, graduated to DAMM v2) are posted to the launches channel, each once. Solana tokens are listed in the main **Live launches** grid with the Robinhood ones (same filters: *Recently Launched*/*Launched* while on the curve, *Graduated* after migration, never *Deployed*; there is no separate Solana section), and also appear in the home page's **New launches** window and Solana buys/sells in the **Live feed**, next to the Robinhood ones.

**Same ledger, labelled by chain.** Every Solana launch is written to the platform's own launch ledger (`launched-tokens.json/.csv`, or the `launched_tokens` table when MySQL is configured) and every detected trade to the activity store (`activity.json` / `activity` table) — the same stores the Robinhood relayer uses, with `chain: "solana"` (Robinhood rows are `chain: "robinhood"`). While the platform is on testnet, Solana **devnet** counts as testnet, so the rows sit under the `robinhoodTestnet` network key; Solana **mainnet-beta** counts as mainnet (`robinhoodMainnet`). The EVM fee keepers skip Solana rows, and the page keeps them out of the Robinhood token cards. (Solana's own settings, metadata, launch map and price history stay in `deployed-contracts/solana-devnet/`.) Trades are detected by the price tracker from the pool's vault balance changes, so buys show up in the live feed within about one sampling interval (default 60 s) and only while the tracker has an RPC.

A prototype of Solana quick launches (open to anyone with a Solana wallet; there is no longer an admin-only setting. To restrict it in an emergency, set `SOLANA_ADMIN_ONLY=true` in the relayer's environment and restart) on Meteora's Dynamic Bonding Curve. The browser builds and signs the launch transactions with the user's Solana wallet; the relayer only hosts token metadata, registers launches, and samples pool prices into the existing price-history store (network key `solana-devnet`) so the chart works. Code: `lib/solanaApi.js`, `lib/solanaStore.js`, `lib/solanaTracker.js`; tests: `node --test test/solanaApi.test.js`. Solana mainnet is rejected (403).

**Trading and the swap fee.** The token page's buy/sell panel trades on the bonding curve while a token is on it and, once the token has graduated, on its Meteora **DAMM v2** pool (the pool is found from the token's migration settings, or by searching the token's pools). Every swap made through the site also pays the platform **0.30%** of the SOL side of the trade: a plain SOL transfer to the platform wallet (the platform config's fee claimer) inside the same transaction as the swap. On a buy it comes out of the SOL typed (the rest is swapped, so the trader never spends more than they entered); on a sell it comes out of the SOL the swap pays, based on the quoted amount. The quote shows the pool fee and the platform fee separately. This is a front-end fee: trades made on Meteora, Jupiter or another app do not pay it, and the curve's own 1% fee is separate and unchanged. The rate is `swapFeeBps` in `solana-build/core.js` (default 30, capped at 100) and can be set per site with `init({ swapFeeBps })`. If the platform wallet can't be determined the trade is refused before anything is signed. Tests: `cd solana-build && npm test` (includes fee math and DAMM v2 swap cases using a mocked Meteora client; **not yet run against a real pool**). After you change anything under `solana-build/`, rebuild with `npm run build`.

**Packages:** none to install. Price tracking falls back to `lib/vendor/solana-node.js`, a bundled build of `@meteora-ag/dynamic-bonding-curve-sdk` + `@solana/web3.js` (rebuild with `cd solana-build && npm run build:node`). Installing the real packages also works and takes precedence.

**Environment variables:**

| Variable | Purpose |
|---|---|
| `SOLANA_RPC_URL` | Default devnet RPC endpoint (Admin → Solana overrides it). Unset = price tracking is off until an RPC is saved (the routes still work) |
| `SOLANA_POLL_MS` | Default pool sampling interval in ms (`60000`; Admin → Solana overrides it; minimum `15000`) |
| `PUBLIC_BASE_URL` | Default public origin used in metadata/image URLs (e.g. `https://ignitionx.example`; Admin → Solana overrides it); if unset it is derived from `X-Forwarded-Proto`/`X-Forwarded-Host`/`Host` |

`SOLANA_CLUSTER` is no longer read: the devnet/mainnet switch lives in **Admin → Solana** (saved on the relayer, admin-signed, typed confirmation to go live) and a fresh install is always on devnet.

**Routes** (JSON). Admin routes need `timestamp` (ms, within 5 minutes) and an EVM `signature` (`personal_sign`, admin wallet) over the quoted message:

| Route | Auth / signed message |
|---|---|
| `POST /solana/metadata` `{id, name, symbol, description?, image?, banner?, website?, twitter?, telegram?}` -> `{id, uri}` | the launch page signs with the Solana wallet (see **Public mode**; the platform wallet may also do so while public launching is off, unrationed); the older admin form `IgnitionX admin: solana metadata ${id} at ${timestamp}` (EVM signature) is still accepted by the API. **Public mode** (body has `wallet`, `walletSignature`, `timestamp`): Solana wallet signature over `IgnitionX launch: solana metadata ${id} by ${wallet} at ${timestamp}`; only when public launching is on; rate-limited; the record remembers the uploader |
| `GET /solana/metadata/:id.json` | public (Metaplex-style JSON) |
| `GET /solana/metadata/:id.png` | public (image bytes) |
| `GET /solana/metadata/:id/banner.png` | public (banner bytes; 404 when none) |
| `GET /solana/activity` | public — recent Solana buys/sells (`chain: "solana"`) from the shared activity store |
| `POST /solana/launches` `{mint, pool, creator, name, symbol, metadataId?, cluster?, txSignature?}` (upsert by mint) | admin: `IgnitionX admin: register solana launch ${mint} at ${timestamp}`. **Public mode** (`wallet` + `walletSignature`): signature over `IgnitionX launch: register solana launch ${mint} by ${wallet} at ${timestamp}`; the creator must be the signing wallet, the metadata must have been uploaded by it, name/symbol come from that metadata, the pool is verified on-chain (real pool, that mint, that creator, under the platform config — or a creator-made config that exactly matches the platform's curve/fees), an already-listed mint is never changed, rate-limited |
| `GET /solana/launches` | public (prototype only) |
| `GET /solana/price-history/:mint` | public |
| `GET /solana/settings` | public; secret server-RPC URLs are redacted (only "is set" + host) |
| `POST /solana/settings` `{settings}` (all or some of cluster, enabled, publicLaunch, customSupply, supplyMin, supplyMax, curveStartMcapSol, curveGraduationMcapSol, curveFeeBps, curveCreatorFeePercent, rpcUrl, serverRpcUrl, dbcConfig, mainnetRpcUrl, mainnetServerRpcUrl, mainnetDbcConfig, publicBaseUrl, pollSeconds, mainnetConfirm) | `IgnitionX admin: update solana settings to ${canonicalJSON} at ${timestamp}` (see `lib/solanaSettings.js`). Going to mainnet also needs `mainnetConfirm: "GO LIVE ON MAINNET"` and a saved mainnet RPC + config + public base URL |
| `POST /solana/launches/delete` `{mint}` (keeps price history; **always admin-only**) | `IgnitionX admin: delete solana launch ${mint} at ${timestamp}` |

Metadata `id` is client-generated (`/^[a-f0-9]{16,32}$/`), images are png/jpeg/webp/gif data URLs of at most 200 KB (banner: 300 KB), and a metadata id is write-once. Settings are saved in `solana-settings.json` beside them. Launch records and price history are kept per network (`solana-devnet` / `solana-mainnet`), and each launch is mirrored into the main ledger as described above; metadata is shared so on-chain token URIs always resolve. Records live under `deployed-contracts/solana-devnet/` (`solana-metadata/`, `solana-launches.json`, `price-history/`).

## Scripts reference

| Command | What it does |
|---|---|
| `npx hardhat compile` | Compile all contracts |
| `V4_TEST=1 npx hardhat test test/V4*.test.js test/PlatformToken.test.js` | Run the contract test suite (686 tests) |
| `npx hardhat run scripts/V4deploy.js --network <network>` | Deploy / resume the V4 contract set |
| `npx hardhat run scripts/V4verify.js --network <network>` | Verify the V4 set on the explorer |
| `npx hardhat run scripts/V4setRelayer.js --network <network>` | Set the gas cap, then the relayer, on `V4LaunchRelay` / `V4TokenFactory` |
| `npx hardhat run scripts/V4checkChain.js --network <network>` | Read-only chain pre-flight |
| `npx hardhat run scripts/deployPlatformToken.js --network <network>` | Deploy the platform token (and authorise any distributors already deployed) |
| `npx hardhat run scripts/authorizePlatformTokenSnapshotters.js --network <network>` | Authorise the fee-wallet, platform-rewards and platform-tax distributors as platform-token snapshotters (run as the token owner) |
| `npx hardhat run scripts/checkPlatformTokenBytecode.js --network <network>` | Compare a deployed platform token's bytecode with the compiled source |
| `npx hardhat run scripts/addPlatformTokenLiquidity.js --network <network>` | Seed the platform token's V2 pool |
| `npx hardhat run scripts/relayer.js --network <network>` | Start the relayer / front-end / admin service |
| `npx hardhat run scripts/reclaimDeposit.js --network <network>` | Recover a gasless deposit that was never relayed |

## Data storage

Every stateful module under `lib/` (`launchStore`, `trackedTokensStore`, `relayerStore`, `priceHistoryStore`, `activityStore`, `deploymentStore`, `walletLinkStore`) checks a single switch (`lib/db.js`'s `isDbConfigured()`) before doing anything. Leave `DATABASE_URL`/`DB_HOST`+`DB_NAME` unset and everything reads/writes plain JSON files under `public/assets/` and `deployments/` — no database required to run the whole platform. Set them and every store transparently switches to MySQL instead, with no other configuration change needed.

## Testing

```bash
V4_TEST=1 npx hardhat test test/V4*.test.js test/PlatformToken.test.js
```

`V4_TEST=1` compiles with solc 0.8.26 / cancun so the tests can run against Uniswap's real `PoolManager`. This covers the factories, hook, locker, compounder, router, relay (`test/V4LaunchRelay.test.js`), every distributor (including the snapshot-round logic and the deploy-time authorisation helper), and the platform token: 686 tests (681 V4 plus 5 platform-token). The Telegram announcement and Solana API tests are Mocha files run with `npx mocha`. The audit PDFs in the repository root are the narrative security notes for each V4 contract (see [Audits](#audits)).

## Security notes

- Every contract that moves ETH mid-transaction uses `ReentrancyGuard` or follows checks-effects-interactions; fee-wallet and creator payouts are gas-capped.
- All liquidity added at launch is locked in `V4LiquidityLocker` for the creator — never immediately withdrawable. The platform owns no launched token.
- `V4CustomToken` tax rates are set once at initialization and have no setter; the plain token has no tax logic at all.
- A stale price feed never blocks a trade or a graduation check — it is skipped, not reverted.
- The relayer's key can only spend its own gas balance; it cannot forge a launch or move a creator's deposit, because the creator's EIP-712 signature and escrowed deposit are verified on-chain. The gas it recovers is capped by the owner.
- Distributor conversions (swap, buyback) can only be started by the owner, owner-approved keepers and the token creator, so an outsider cannot sandwich them. Airdrop rounds are owner and keeper only as well.
- Airdrops pay from a snapshot taken when the round starts, so buying, splitting wallets or moving tokens mid-round cannot change a payout. A holder who joins after the snapshot simply waits for the next round.
- The platform token's owner cannot mint, pause, blacklist, tax or rewrite balances. The only owner powers are authorising snapshotters and two-step ownership transfer. Snapshots can be taken only by addresses the owner has authorised, and total supply is capped at 2¹²⁸−1.
- A failed snapshot never blocks revenue: if the tax distributor cannot start a round, it still pays the fee wallet and buys the tokens, and the tokens wait for the next round (`DisburseRoundDeferred`).
- The fee wallet's payout is gas-capped (100,000 gas), and the swap's `minOut` is what protects the buyback (the swap deadline is only a short window).
- Admin-only server routes are authenticated by recovering a `personal_sign` signature against a fixed admin wallet, server-side; the front end's admin check is convenience UI only.

## Audits

Every V4 contract has been through a manual audit: a proof-of-concept test against the unmodified contract first, then fixes, then a re-run of the full suite. Each report is a PDF in the repository root, named `HoodLaunch_<Contract>_Audit*.pdf`; the `_Fixed` reports describe the post-fix state and the tests that pin each fix. The most recent ones cover the platform token and airdrop rounds:

- `HoodLaunch_PlatformToken_Audit_Fixed.pdf`: the redesigned token (registry, snapshots, owner limits).
- `HoodLaunch_V4PlatformTokenRewards_Audit_Fixed.pdf`: the shared snapshot-round logic.
- `HoodLaunch_V4PlatformTaxDistributor_Audit_Fixed.pdf`: the tax distributor, including deferred rounds.

The audits are one developer's manual review and the project's own tests. They are not a substitute for an independent third-party audit before real value is at risk.

## Disclaimer

This is experimental software interacting with real funds once deployed to mainnet. Nothing here constitutes financial advice, and launching or trading a token carries real risk — review the contracts and audit notes yourself before relying on them with real value.

## License

Every Solidity file in `contracts/` carries an `SPDX-License-Identifier: MIT` header. Add a repository-wide `LICENSE` file with the MIT license text if one isn't already present.

## Branding (IgnitionX)

The platform is branded IgnitionX. Logo files live in `public/brand/` (`ignitionx-hero.png`, `ignitionx-mark.png`, `ignitionx-wordmark.png`, `ignitionx-badge.png`, favicons, `og-image.png`). Colors are CSS variables at the top of `public/index.html` and `public/docs.html` (`--signal-*` is the fire red, `--cyan-*` now carries the amber secondary). Deliberately unchanged: the text wallets sign for admin/profile/social actions (the relayer checks it byte for byte), the on-chain EIP-712 domain names, and browser storage keys, so nothing on-chain or already saved breaks.
