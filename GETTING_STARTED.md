# Getting started

This project has two halves: the **contracts** (this folder — `TokenFactory`,
`LaunchedToken`, `LiquidityLocker`) and the **front end** (`index.html`,
delivered separately — the Hood Launch web app your users would actually
open). This doc walks through both, in the order you'd actually do them.

## 1. Prerequisites

- **Node.js 18 or 20 LTS.** Check with `node -v`.
- **npm** (ships with Node).
- Nothing else — no global Hardhat install, no Docker. Everything the
  contracts need is a `devDependency` in `package.json`.

## 2. Quick start — see it work locally, no setup required

This spins up a throwaway local blockchain in memory, deploys everything to
it (including a mock router and a mock $3000 ETH/USD price feed, since there's
no real DEX or oracle to talk to on a fake local chain), and runs the full
test suite against it:

```bash
npm install
npx hardhat compile
npx hardhat test
```

You should see `46 passing`. If you see that, the contracts themselves are
in good shape and everything below is purely about connecting them to a
real network.

Deploy the whole stack to that local chain and try launching a token:

```bash
npx hardhat run scripts/deploy.js --network hardhat
# copy the "TokenFactory deployed at 0x..." address it prints, then:
TOKEN_FACTORY_ADDRESS=0x... LAUNCH_MODE=liquidity \
LAUNCH_NAME="Aurora Ledger" LAUNCH_SYMBOL=AURA LAUNCH_SUPPLY=1000000000 \
npx hardhat run scripts/launch.js --network hardhat
```

None of this touches a real network or spends real ETH — it's the fastest
way to confirm the code runs before you deal with any of the setup below.

## 3. Try the front end

Open `index.html` directly in a browser (double-click it, or `open
index.html` / drag it into a browser tab) — no build step, no server. It
starts in **Demo mode**, pointed at Robinhood Chain Testnet, with
`FACTORY_ADDRESSES.demo` unset — so "launching" a token there is simulated
and stored in your browser's local storage, not sent anywhere. That's
intentional: it's how you evaluate the product experience before any
contract is actually deployed. You'll need a browser wallet extension
(MetaMask or similar) installed to connect a wallet, even in demo mode.

## 4. Deploying for real

Everything past this point involves a real network, and on mainnet, real
money. Go slowly, and read `README.md`'s "Design notes" and "What's not
here yet" sections before you do this against mainnet specifically.

### 4a. Copy the environment file

```bash
cp .env.example .env
```

Every variable in `.env.example` has a comment explaining exactly what it
is and, for the trickier ones, exactly how it was verified (or why it's
still blank). The rest of this section is the short version.

### 4b. Fill in what only you can provide

These have no correct default — they're yours:

| Variable | What it is |
|---|---|
| `DEPLOYER_PRIVATE_KEY` | The wallet that deploys everything and becomes its owner. |
| `FEE_TREASURY_ADDRESS` | Where deploy/launch fees land. Defaults to the deployer if unset. |
| `PLATFORM_FEE_WALLET_ADDRESS` | Where the 0.25% buy/sell transfer tax lands. Defaults to the deployer if unset. |

### 4c. Know what's already confirmed for mainnet — and what isn't

For **Robinhood Mainnet (chain 4663)**, `deploy.js` already has confirmed
defaults baked in for the two trickiest values, so you don't need to set
them:

- `DEX_ROUTER_ADDRESS` — the real Uniswap V2 router, cross-checked against
  Uniswap Labs' own `@uniswap/sdk-core` package and Robinhood's block
  explorer.
- `PRICE_FEED_ADDRESS` — the real Chainlink ETH/USD feed, read from
  Chainlink's own address directory. `deploy.js` also double-checks both
  live on-chain before deploying anything, so a bad override still gets
  caught before it costs gas.

For **Robinhood Testnet (chain 46630)**, neither has a confirmed default —
Uniswap's own tooling doesn't list a testnet deployment at all, and
Chainlink's directory page has to be read from an actual browser (it's
JS-rendered). `deploy.js` will refuse to deploy to testnet until you've
found and set both yourself in `.env`. Don't guess an address here — a
wrong router or price feed is the kind of mistake that's expensive to
discover after the fact.

Everything else (`DEPLOY_FEE_WEI`, `LAUNCH_FEE_WEI`, `LP_LOCK_DURATION_SECONDS`,
RPC URL overrides, `EXPLORER_API_KEY`) has a working default — leave them
blank unless you specifically want to change that behavior.

### 4d. Deploy

```bash
npx hardhat run scripts/deploy.js --network robinhoodMainnet
# or, once testnet's router + price feed are set in .env:
npx hardhat run scripts/deploy.js --network robinhoodTestnet
```

Save the `TokenFactory` address it prints — you'll need it for both the
launch scripts and the front end.

## 5. Connect the front end to your deployment

Open `index.html` and find `FACTORY_ADDRESSES` (search for it). Fill in the
address for whichever network you deployed to:

```js
const FACTORY_ADDRESSES = {
  demo: null,   // <- your robinhoodTestnet TokenFactory address goes here
  live: null,   // <- your robinhoodMainnet TokenFactory address goes here
};
```

The moment either is set, that network stops being simulated — launching a
token there sends a real transaction from whichever wallet is connected,
using the real fee/tax/lock behavior the contracts enforce. There's no
staging flag between "simulated" and "real"; an address here *is* the
switch.

## 6. Before you'd let anyone else use this

- **A security audit.** Not optional before real value is at stake — see
  `README.md`'s "What's not here yet".
- **The testnet router and price feed**, if you want a full real-money-free
  dry run before mainnet.
- Keep `DEPLOYER_PRIVATE_KEY` and the real `.env` out of version control and
  off of any machine you don't fully trust — it's the key to everything
  this factory owns.
