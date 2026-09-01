# Hood Launch — token factory contracts

Solidity contracts for the launch flow. A creator submits a token's
identity (name, ticker, supply), then picks one of two paths for what
happens next — each charging its own flat fee, in ETH:

- **"Deploy Token"** — create + verify, nothing else. 100% of the supply
  mints straight into the creator's own wallet. No pool, no tax, no further
  on-chain involvement from this contract at all — the transaction is over
  the moment it confirms. Adding liquidity anywhere, any time, by whatever
  means, is entirely the creator's own responsibility from here.
- **"Deploy and Add Liquidity (Launch)"** — token creation and liquidity provisioning
  happen atomically, in the same transaction. 100% of the supply is minted
  into a real DEX pool paired against the creator's own ETH, the resulting
  LP tokens are locked to the creator for a fixed period, and the token
  carries a **0.25% transfer tax** on buys and sells — routed to the
  platform's fee wallet — until the pool's live market cap crosses
  **$80,000**, at which point the tax permanently and automatically
  disables itself.

Either way, the token is **deployed and verified before anything else
happens** — verification always runs right after creation. Every launch is
also recorded to a lightweight local ledger under `deployed-contracts/`,
split into its own subdirectory per network so a testnet launch and a
mainnet launch never share a file (see below).

This is an MVP for the on-chain piece only. It does not include the
off-chain identity/socials/dashboard backend (see "What's not here" below).

## The launch flow

`TokenFactory.createToken(name, symbol, totalSupply, addLiquidityAtLaunch, liquidityEthAmount, creatorBuyEthAmount, minCreatorTokensOut)`
— payable, one call, both paths start and end here:

1. Clones a new `LaunchedToken`.
2. Takes the mode-appropriate fee — `deployFee` for "Deploy Token" or
   `launchFee` for "Deploy and Add Liquidity (Launch)" — out of `msg.value`
   and forwards it to the fee treasury.
3. If `addLiquidityAtLaunch = false` ("Deploy Token"): mints **100% of
   `totalSupply` straight to `msg.sender`**. `liquidityEthAmount`,
   `creatorBuyEthAmount`, and `minCreatorTokensOut` must all be `0`, and
   `msg.value` must equal `deployFee` exactly — this call does nothing
   else.
4. If `addLiquidityAtLaunch = true` ("Deploy and Add Liquidity (Launch)"): mints
   **100% of `totalSupply` to the factory itself**, then in the same
   transaction:
   1. Approves the DEX router and calls `addLiquidityETH()`, pairing the
      full supply against `liquidityEthAmount` ETH. The resulting LP tokens
      mint directly to `LiquidityLocker` — they never pass through the
      factory.
   2. Looks up the pair the router just created (or reused) and calls
      `LaunchedToken.configureTax()` on the new token, pointing it at that
      pair with the factory's current tax defaults (fee bps, fee wallet,
      price feed, graduation target) — see "The transfer tax" below.
   3. Locks the LP tokens to `msg.sender` in `LiquidityLocker` for
      `lpLockDuration` (default **15 days**).
   4. If `creatorBuyEthAmount > 0`: immediately swaps that ETH for tokens
      against the pool that was just created, sending them straight to the
      creator's wallet, capped at a fixed share of supply — see "The
      creator buy-in" below.
   `msg.value` must equal `launchFee + liquidityEthAmount + creatorBuyEthAmount`
   exactly.
5. Records `creator` on the token either way, and `pairOf[token]` (the DEX
   pair address, or `address(0)` for a "Deploy Token" token).

Then, off-chain, `scripts/launch.js` verifies the token before doing
anything else — see "Contract verification" below.

## The transfer tax

A real Uniswap V2-style pool has no transaction hooks — there's no way for
an external contract to intercept a swap and skim a fee from it. The only
way to collect a fee on trades against a real pool is for the **token
itself** to notice when a transfer touches the pool and take a cut right
then. That's what `LaunchedToken._update()` does, once `configureTax()` has
pointed it at a pair:

- Any transfer where `from == pair` (a buy) or `to == pair` (a sell) has
  `feeBps` (default 25 = 0.25%) skimmed to `feeWallet`, and the remainder
  goes through as normal. Every other transfer — wallet-to-wallet, the
  factory's own one-time seeding transfer into the pair before the tax is
  even configured — is untouched.
- After every taxed transfer, the token checks its pool's **live** market
  cap (current pair reserves × a Chainlink-style ETH/USD price feed × total
  supply) against `graduationTargetUsd` (default **$80,000**). Once the
  target is met, `taxActive` permanently flips to `false` and `TaxDisabled`
  fires. There is no way to turn it back on — this check runs once, in one
  direction, forever.
- **Graduation requires confirmation, not one instantaneous reading.** A
  pool's spot price is cheap to move temporarily, and since market cap here
  is spot price × total supply, a typical launch's enormous total supply
  relative to its actual (thin, freshly-seeded) liquidity means a
  comparatively small, temporary trade could otherwise imply a market cap
  far beyond the pool's real ETH value for exactly one instant — permanently
  disabling the tax off a manipulated spike. So the first time a transfer
  observes the target met, that only starts a candidacy
  (`graduationCandidateAt`, `GraduationCandidateObserved`); the tax only
  actually disables once a **later** transfer, at least
  `GRADUATION_CONFIRMATION_WINDOW` (30 minutes) after the first observation,
  still sees the target met. Any transfer in between that observes the
  target no longer met resets the candidacy to zero
  (`GraduationCandidateReset`) — so unwinding a manipulated position (itself
  a transfer against the same pool) undoes the countdown instead of letting
  it quietly finish, meaning an attacker has to keep real capital committed
  and the price genuinely elevated for the entire window, not just for one
  instant. See `AUDIT-LaunchedToken.md` for the full writeup of why this
  mattered and how it's tested (`test/LaunchedTokenTax.test.js`'s
  "graduation" and "resilience to a misbehaving pair" suites include a
  dedicated pump-and-dump test proving the reset actually closes the loop).
- **Oracle resilience** — if the price feed is stale (older than
  `maxOracleStaleness`, default 1 hour) or reports a non-positive price,
  the disable-check is silently skipped for that transfer (the transfer
  itself still succeeds) rather than reverting, leaving any in-progress
  candidacy untouched. The check resumes normally as soon as the feed is
  healthy again. The pool-reads-and-arithmetic half of the check is also
  independently guarded (via an internal self-call wrapped in its own
  try/catch): a misbehaving pair or an extreme-value overflow in the
  graduation math degrades to "can't confirm graduation right now" rather
  than reverting the transfer that triggered it.
- **`updatePriceFeed(newPriceFeed_, newMaxOracleStaleness_)`** is a narrow,
  factory-gated escape hatch (`TokenFactory.updateTokenPriceFeed`,
  owner-only) for a price feed that goes permanently stale or was never a
  real, maintained feed to begin with — a real risk on a young chain. It can
  only repoint the oracle inputs the graduation check reads; it cannot touch
  `feeBps`, `feeWallet`, `pair`, or `taxActive` directly, and disabling the
  tax still requires the same market-cap/confirmation-window path as ever.
- `totalSupply_` is capped at `MAX_TOTAL_SUPPLY` (1 quadrillion tokens, 18
  decimals — comfortably above real-world outliers like PEPE's ~420
  trillion or SHIB's ~589 trillion supply) at `initialize()`, purely as
  defense-in-depth against the graduation math's arithmetic ever
  overflowing for an unrealistic supply choice.
- `configureTax()` is `onlyFactory` and callable **exactly once** per
  token — there's no path to reconfigure a live tax, retarget it at a
  different pair, or re-enable it after it's disabled.
- A "Deploy Token" token never has `configureTax()` called on it at all, so
  it behaves as a completely ordinary, untaxed ERC20 for its entire life.

`CustomToken`'s own platform tax (`platformTaxActive` / `platformFeeBps` /
`configurePlatformTax()`) is a separate fee stream from a creator's own
`buyFees`/`sellFees`, but mirrors every piece of the graduation mechanism
above exactly — the same confirmation-window candidacy, the same
`updatePriceFeed()` escape hatch (via `CustomTokenFactory.updateTokenPriceFeed`),
the same `MAX_TOTAL_SUPPLY` cap — since both contracts read a pool's spot
price the same way and are equally exposed to the same manipulation risk.

Because the tax nets down what a taxed transfer actually delivers, any swap
against a "Deploy and Add Liquidity (Launch)" token **must** use the
`...SupportingFeeOnTransferTokens` router functions
(`swapExactETHForTokensSupportingFeeOnTransferTokens`,
`swapExactTokensForETHSupportingFeeOnTransferTokens`) rather than the plain
`swapExactETHForTokens`/`swapExactTokensForETH` — the plain variants
pre-compute an expected output and revert (or worse, are exploitable)
against a token that can deliver less than that. `scripts/buyToken.js` and
`scripts/sellToken.js` use the correct variants and measure what actually
landed via a before/after balance diff, exactly like a real router does
internally — a real front end must do the same.

Everything about the tax — fee bps, platform fee wallet, price feed,
graduation target, oracle staleness tolerance — is adjustable going forward
via `TokenFactory.setTaxDefaults()` (owner-only). Changing it only affects
pools created after the change; existing tokens keep whatever they were
configured with at creation.

## CustomToken's swap-and-process pipeline: failure isolation, slippage floor, and cleanup

`CustomToken`'s creator-side fee streams (reflections, marketing, auto-liquidity)
are collected in-kind and turned into their real outcome — a DEX swap, an
`addLiquidityETH` call, a plain ETH send to `marketingWallet` — in a single
batched `_swapAndProcess()` step once pending fees cross `swapThreshold`,
triggered automatically from inside `_update()` on any sell or plain transfer.
See `AUDIT-CustomToken.md` for the full writeup; in short:

- Each of the three steps (`_processLiquidity`, `_processMarketing`,
  `_processReflections`) runs behind its own `try`/`catch`, via the same
  external-self-call pattern the graduation math already used
  (`_computeMarketCapFromPair`). Before this, a single broken step — a
  `marketingWallet` that reverts on receiving ETH, a drained `reflectionAsset`
  pool — reverted the *entire* transfer that happened to trigger the batch,
  and since this runs on every sell/transfer, that meant one broken step could
  permanently freeze all trading. Now a failing step's tokens go straight back
  into the relevant `pending*Tokens` counter — deferred, never lost — and get
  retried on the next qualifying transfer.
- Every internal swap (and `addLiquidityETH`'s own token/ETH minimums) now
  carries a real `amountOutMin`/slippage floor instead of `0`, derived from
  the pool's own live reserves via the same constant-product quote helper
  `TokenFactory`/`CustomTokenFactory` already use for `_effectiveMinBuyOut`,
  and bounded by `processingSlippageBps` (creator-adjustable, 500–800 bps,
  defaulting to 600 — see `setProcessingSlippageBps()`). This won't stop a
  same-block sandwich outright (there's no pre-manipulation reference price to
  fall back on for an autonomous, publicly-triggered swap like this one — see
  the audit's own note on this), but it does catch a genuinely misbehaving
  router, a multi-hop quote that drifted, or a hostile/reentrant pair, and
  fails the transaction safely into the try/catch above rather than accepting
  an arbitrarily bad fill silently.
- `configurePlatformTax()` now rejects a `feeBps_` that, combined with the
  token's own already-locked-in `buyFees`/`sellFees` total, would exceed
  10,000 bps — that combination used to underflow `_update()`'s fee
  subtraction and permanently brick every taxed transfer of that token.
- `rescueToken()`/`rescueEth()` (creator-gated) recover ERC20/ETH dust stuck
  on the contract — leftover from an imperfect-ratio `addLiquidityETH` call,
  or a direct donation — while being structurally unable to touch this
  token's own pending fee balances or any holder's still-unclaimed reflection
  entitlement.
- `transferCreator()`/`acceptCreator()` add the same two-step ownership
  handoff (`Ownable2Step`-style) already used everywhere else in this
  codebase, so a single mistyped address can never permanently strand the
  `creator` role.
- `initialize()` rejects a `reflectionAsset_` equal to the token's own
  address, closing off a confusing self-referential swap path.

### Tax-exemption whitelist, and the standard renounce/transfer levers

Two more creator-controlled features round out `CustomToken`'s access
surface, both onlyCreator-gated the same way as `setMarketingWallet`:

- **`setTaxExempt(account, exempt)`** whitelists (or un-whitelists) a
  specific address to bypass *all* tax — both the creator's own buy/sell
  fee and the platform's graduating tax — on any transfer where it's
  either side (`isTaxExempt` mapping, checked in `_update()` before either
  fee is computed). This is for addresses that legitimately shouldn't be
  taxed on their own token movements: the `LiquidityLocker` holding the
  locked LP, a vesting/airdrop contract, a CEX deposit wallet. **It never
  changes `buyFees`/`sellFees`/`platformFeeBps` themselves** — there is no
  function anywhere in the contract that can raise, lower, or otherwise
  touch those rates after `initialize()`/`configurePlatformTax()`. The
  whitelist only ever changes *who* pays the one fixed rate everyone else
  already pays; it can't be used to reintroduce the "creator jacks up the
  tax" rug the immutable rates already close off. Every exempt/non-exempt
  transition is logged via `TaxExemptionUpdated`.
- **`transferCreator(newCreator)` / `acceptCreator()`** is the two-step
  (`Ownable2Step`-style) handoff already covered above — moving the
  creator role to a new address without a single mistyped address
  permanently stranding it.
- **`renounceCreator()`** is the standard "renounce ownership" assurance:
  it permanently zeroes the `creator` role (and cancels any in-flight
  `transferCreator` handoff), with no recovery path. The moment it's
  called, every onlyCreator function — `setMarketingWallet`,
  `setSwapThreshold`, `setRewardsBlocked`, `activateIndependentPair`,
  `setProcessingSlippageBps`, `setTaxExempt`, `rescueToken`, `rescueEth`,
  `transferCreator` — becomes permanently uncallable by anyone, including
  whoever just called it. Renouncing doesn't need to "lock in" the tax
  rate the way it does on some other launchpads' tokens, because the rate
  was never mutable in the first place — renouncing here removes every
  remaining *operational* lever, on top of a fee structure that was
  already fixed at launch.

## Burning tokens

Both `LaunchedToken` and `CustomToken` expose a standard, OpenZeppelin-style
burn interface, callable directly on the token contract by any holder —
this is separate from (and in addition to, for `CustomToken`) the
tax-triggered `burnBps` component described above:

- `burn(uint256 amount)` — permanently destroys `amount` of the caller's
  own tokens.
- `burnFrom(address account, uint256 amount)` — same, but spends
  `account`'s allowance to the caller first, so a third-party contract a
  holder has approved can burn on their behalf without ever taking custody
  of the tokens.

Both are a **true burn**: they route through OpenZeppelin's `ERC20._burn`,
which calls the same `_update()` every transfer already goes through, and
`totalSupply()` actually decreases — this is not a transfer to
`0x…dEaD` that would leave real supply sitting at an address someone could
mistake for still being in circulation. Neither function is ever taxed,
even on a token with an active transfer tax: a burn's destination is
`address(0)`, which never equals a pool's `pair` address, so it can never
match the condition either contract's tax logic checks (`from == pair ||
to == pair`) — a holder destroying their own tokens keeps the full amount
they intended to burn, with nothing skimmed off first. Covered by
dedicated tests in both `test/TokenFactory.test.js` ("burn (LaunchedToken)")
and `test/CustomToken.test.js` ("voluntary burn"), including that it's
untaxed on a fully-taxed `CustomToken`, that `burnFrom` correctly requires
and spends an allowance, and that the DEX pair's reflection exclusion
(see above) isn't disturbed by a holder burning tokens around it.

## The creator buy-in

In "Deploy and Add Liquidity (Launch)" mode, a creator can choose to be the very first
buyer of their own token, in the same transaction that creates its pool.
This is an ordinary DEX swap, not a mint or any other privileged path — the
creator pays whatever the pool's constant-product pricing (and the same
0.25% tax any other buyer would pay) says for that trade size, and the
resulting tokens land in their wallet exactly like a normal buy. The only
thing special about it is timing: because it executes inside the very
transaction that creates the pool, there is no possible window for anyone
else to trade against that pool first.

- `creatorBuyEthAmount` is extra ETH sent on top of `liquidityEthAmount` —
  `msg.value` must cover `launchFee + liquidityEthAmount +
  creatorBuyEthAmount` exactly.
- `minCreatorTokensOut` is that swap's slippage floor. Since the buy-in
  trades against the pool the creator's own liquidity just created, a
  buy-in that's large relative to the liquidity amount will move the price
  significantly against itself (the same way any AMM trade has price
  impact) — set this deliberately rather than leaving it at 0 for anything
  beyond a small buy-in.
- **The buy-in is capped at `maxCreatorBuyBps` of `totalSupply`** (default
  `500` = 5.00%) — an anti-rug safeguard so a creator can't quietly walk
  away with a large share of their own token's supply the moment its pool
  exists. The check happens in the same transaction, against the actual net
  tokens the creator received (i.e. after the 0.25% tax already came out) —
  not an estimate — so there's no way to structure a buy-in that lands over
  the cap. Requesting one that would reverts the **entire** launch with
  `"TokenFactory: creator buy-in exceeds max allowed share of supply"`,
  nothing partially executes. Owner-adjustable via
  `TokenFactory.setMaxCreatorBuyBps()`, and only affects launches from that
  point forward.
- Pass `0` for both `creatorBuyEthAmount` and `minCreatorTokensOut` to skip
  this entirely — the cap check is a no-op when there's no buy-in.
- `scripts/launch.js` prints the full ETH breakdown, and the ledger records
  `creatorBuyEthAmount` and `creatorTokensBought` alongside the rest of a
  launch's liquidity fields.
- This has nothing to do with "Deploy Token" mode — there's no pool to buy
  into at all there.

## Liquidity-add and buy-in slippage protection

Both factories apply an owner-adjustable slippage tolerance, bounded to a
**5.00%–8.00%** band, to two separate steps of a "Deploy and Add Liquidity"
launch:

- **`liquiditySlippageBps`** (default `600` = 6.00%) sets `amountTokenMin` /
  `amountETHMin` on the `addLiquidityETH` call itself — previously hardcoded
  to `0`. Owner-adjustable via `setLiquiditySlippageBps()` on either
  factory; `MIN_LIQUIDITY_SLIPPAGE_BPS` (500) and
  `MAX_LIQUIDITY_SLIPPAGE_BPS` (800) are hard floors/ceilings the setter
  enforces, so it can never be configured outside 5–8% in either direction.
- **`buyInSlippageBps`** (default `600` = 6.00%, same 5–8% band, same setter
  pattern via `setBuyInSlippageBps()`) protects the creator's own same-
  transaction buy-in (see "The creator buy-in" above). The factory computes
  the AMM's real constant-product quote for the buy-in against the reserves
  the liquidity add just created, nets out the token's actual buy-side tax
  (CustomTokenFactory reads this live off the token's own `buyFees()` /
  `platformTaxActive()` / `platformFeeBps()` getters, so it can never drift
  out of sync with what `_update()` actually deducts), applies the slippage
  tolerance, and uses **whichever is higher** — that computed floor, or the
  caller-supplied `minCreatorTokensOut` — as the actual minimum passed to the
  swap. A caller can still ask for tighter slippage than the default; they
  just can't accidentally get less protection than the floor.

**Worth knowing before assuming this stops bot front-running:** the
liquidity add and the creator's buy-in happen inside one function call, in
one atomic transaction — there is no block boundary, and no other
transaction can ever be interleaved between "pool created" and "creator
buys in." A classic sandwich attack (front-run the add, back-run the
buy-in) is structurally impossible in this flow regardless of any slippage
setting. What this protection actually guards against is router/fee-model
mismatches, rounding, or a future refactor accidentally breaking that
atomicity — genuine defense-in-depth, just not "anti-bot" in the sandwich
sense. It's also worth knowing that because this is *always* a token's very
first liquidity add (a fresh pair created in the same transaction), the
real `UniswapV2Router02._addLiquidity` takes its well-known zero-reserve
fast path — using the full desired amounts unconditionally without checking
`amountAMin`/`amountBMin` at all — so `liquiditySlippageBps` is inert for
that specific call today; it's still configured and enforced correctly for
any future scenario where reserves already exist. `buyInSlippageBps`, on
the buy-in swap itself, is not subject to that same router special case and
is fully active on every launch that includes a buy-in.

## CustomToken reflections: the pair never accrues a payout

`CustomToken` supports two separate reflection-distribution paths: a
pull-based `claimReflections()` (backed by a magnified-dividend-per-share
accounting model) and a push-based `pushReflections(maxHolders)` that
sweeps the holder registry. `pushReflections` already excluded the DEX pair
and the token contract itself from ever being paid. `accumulativeDividendOf`
(and therefore `withdrawableDividendOf`, which every claim/push path reads
through) now carries the same exclusion directly:

```solidity
function accumulativeDividendOf(address account) public view returns (uint256) {
    if (account == pair || account == address(this)) return 0;
    ...
}
```

Concretely, this means the pair's balance (i.e. pool liquidity, which
shifts on every single buy and sell) never shows or accrues a reflection
entitlement, on either distribution path, full stop. This was a
value-leak, not a fund-drain risk — a Uniswap V2 pair has no owner/EOA
control and can never itself call `claimReflections()`, so nothing was ever
actually stealable — but the accrued-and-unclaimable entitlement was
wasteful and is now guaranteed not to exist. The unpaid share the pair
would have accrued is simply never distributed at all (rather than being
redistributed pro-rata to real holders); doing the latter would require a
much larger "excluded from rewards" dual-accounting rewrite and wasn't
what was asked for here.

## CustomToken's marketing wallet is paid in native ETH, not tokens

`marketingBps` (part of the buy/sell fee split alongside `reflectionBps` and
`burnBps`) is collected in `CustomToken`'s own tokens like every other fee
component, but it is never *paid out* in tokens. `_processMarketing()`
swaps the accumulated marketing-fee tokens for native ETH through the DEX
router (the same pool the token trades on) once the swap threshold is hit,
then sends that ETH straight to `marketingWallet`:

```solidity
(bool sent, ) = marketingWallet.call{value: ethOut}("");
```

So a creator who sets a marketing wallet is guaranteed to receive
Robinhood Chain's native coin there, not a balance of the token itself —
there's nothing for the marketing wallet to sell or route through a DEX
before it's spendable. This is existing, tested behavior (see
`test/CustomToken.test.js`'s marketing-tax tests, which assert on
`marketingWallet`'s native ETH balance delta) — noted here because it's
easy to assume a "marketing fee" pays out in the project's own token the
way `reflectionBps` and `burnBps` do; it doesn't.

## Blocking a wallet from reflections (`setRewardsBlocked`)

The creator can block any address — a known bot, a wallet farming the
reflection mechanism with wash trades, an exchange hot wallet that would
otherwise accrue and never claim — from receiving further reflection
payouts, without touching its token balance or ability to transfer:

```solidity
function setRewardsBlocked(address account, bool blocked) external onlyCreator;
mapping(address => bool) public isBlockedFromRewards;
```

Once blocked, `account` shows `accumulativeDividendOf(account) == 0`
immediately, on both distribution paths: a pull-based `claimReflections()`
call reverts with nothing to claim, and a push-based `pushReflections()`
sweep silently skips the address (without reverting the rest of the
batch). This is the exact same read-time-guard pattern already used to
exclude the DEX pair and the token contract itself (see the section
above) — `accumulativeDividendOf` returns 0 up front rather than trying to
retroactively zero out or claw back an entitlement.

**Important caveat, stated plainly:** blocking is airtight for as long as
it's active, but it is not a permanent forfeiture. The underlying
magnified-dividend-per-share bookkeeping keeps running in the background
for a blocked account exactly as it would for anyone else; blocking only
makes `accumulativeDividendOf` report 0 while the flag is set. The moment
the creator calls `setRewardsBlocked(account, false)`, that account's
uninterrupted accrual — including whatever built up "underneath" the
block — becomes claimable again. A true permanent forfeiture (redistribute
a blocked wallet's would-be share to everyone else, forever) would need
the same larger "excluded from rewards" dual-accounting rewrite noted in
the pair-exclusion section above, and wasn't what was asked for here. Use
`setRewardsBlocked` to pause a wallet's rewards for as long as you want it
paused — not as a way to permanently erase value it would otherwise have
been entitled to.

One safety fix shipped alongside this: `withdrawableDividendOf` used to
compute `accumulativeDividendOf(account) - withdrawnDividends[account]`
directly, which would revert on underflow for a wallet that had already
claimed once *before* being blocked (blocking forces the left-hand side to
0 while the right-hand side stays whatever was already withdrawn). It now
guards with `total > withdrawn ? total - withdrawn : 0`, so blocking a
wallet with claim history is always safe and never bricks that wallet's
entry in a `pushReflections()` sweep.

Only the creator can call `setRewardsBlocked` (`onlyCreator`), and
`address(0)` is rejected — see `test/CustomToken.test.js`'s "reflections —
creator can block a wallet from rewards" tests for all seven scenarios
covered (zero entitlement while blocked, safe claim after prior
withdrawal, skip-not-revert in a push sweep, access control, the
zero-address rejection, resumed accrual after unblocking, and balance/
transfer ability being untouched throughout).

## Zero/blank tax fields never crash the contract

Every fee field on `CustomToken` (`reflectionBps`, `marketingBps`,
`liquidityBps`, `burnBps`, on both the buy and sell side) can be `0`, and a
creator can leave any subset of them unset without anything reverting.
`index.html`'s fee inputs already coerce a blank or invalid percentage to
`0` before it's encoded (see `.fee-input`'s change handler and
`encodeFeeSet`), so "left blank" and "explicitly typed 0" are the exact
same value by the time it reaches the contract. `CustomToken.initialize()`
only requires each side's total to stay `<= 500` bps (5%) and a marketing
wallet to be set **if and only if** that side's `marketingBps > 0` — an
all-zero `FeeSet` on both sides passes every check and produces an
ordinary, fully-untaxed ERC20. `test/CustomToken.test.js`'s "zero / blank
tax fields" suite exercises this directly: all-zero on both sides, only one
field filled in, a blank marketing wallet with `marketingBps == 0`, the
deploy-only path, and a full buy/transfer/sell cycle on a 0%-tax token —
none of it reverts.

## Where the fee goes

Every `deployFee`/`launchFee` collected — whichever path relayed it in, see
"Gasless relayed launches" below — settles the same way:

- If a gas reimbursement is owed (relayed launches only — see below), it's
  paid to the relayer **first**, out of the collected fee.
- Whatever's left (`netFee`) splits **50% to `feeTreasury`, 50% to
  `rewardsDistributor`** — if a `rewardsDistributor` is configured.
- If `rewardsDistributor` is unset (`address(0)`), **100% of `netFee` goes
  to `feeTreasury`** instead.

This one rule is shared, byte-for-byte, by `_finalizeLaunch` (the direct
`createToken`/`createCustomToken` paths) and `_settleRelayedFee` (the
gasless relayed paths, after gas reimbursement) in both `TokenFactory.sol`
and `CustomTokenFactory.sol`. Owner-configurable via `setFeeTreasury()` /
`setRewardsDistributor()`; whether the split is 50/50 or 100/0 is decided
purely by whether `rewardsDistributor` is the zero address at the moment a
launch settles — there's no separate on/off flag.

## Gasless relayed launches

A creator can launch **without ever paying gas themselves** for the deploy
(or deploy + add-liquidity) transaction. Instead of calling
`createToken`/`createCustomToken` directly, they:

1. Sign an EIP-712 **voucher** off-chain — `LaunchVoucher` (TokenFactory) or
   `CustomLaunchVoucher` (CustomTokenFactory) — describing exactly what
   they want launched. This costs no gas at all; it's a wallet signature,
   nothing more.
2. Send **one small deposit transaction** — `depositForRelayedLaunch(voucherHash,
   deadline)`, a plain ETH transfer covering the fee (plus liquidity/buy-in,
   if any) into on-chain escrow. This is the only transaction the creator
   ever pays gas for, and it's cheap — it doesn't deploy anything.
3. Hand the signed voucher to a **relayer** — a platform-operated hot wallet,
   configured on-chain via `setRelayer(address)` — which submits the actual
   `relayedCreateToken`/`relayedCreateCustomToken` transaction from its own
   wallet, paying that transaction's (much larger) gas cost itself.

The contract then reimburses the relayer's *measured* gas cost
(`gasUsed * tx.gasprice`, capped by owner-configurable
`maxRelayerGasReimbursementWei` and by the fee actually collected) out of
the escrowed fee, and only the genuine remainder goes through the 50/50
split described above.

**Trust model** — the relayer is trusted to *execute correctly* (same tier
as `owner`/`feeTreasury`), but it is never trusted with custody of anything
beyond its own gas float:

- It can only ever deploy **exactly what the creator signed** — the
  contract independently recovers the signer from `(voucher, signature)`
  via ECDSA and requires it to equal `voucher.creator`, and independently
  checks the creator's own escrowed deposit covers `voucher.fee` (+
  liquidity/buy-in). A relayer cannot substitute a different name, symbol,
  supply, fee split, or recipient than what was actually signed.
- It cannot touch a creator's deposit except by relaying the exact voucher
  it was escrowed for. `deposits` is keyed by `(depositor address, voucher
  hash)` — not by voucher hash alone — specifically so a second party can
  never front-run or squat a legitimate creator's deposit slot.
- Its gas reimbursement is capped by `maxRelayerGasReimbursementWei`, so a
  compromised relayer key can waste its own ETH via an inflated
  `tx.gasprice`, or simply stop relaying — but it cannot drain more than
  that cap from any single launch's fee, and it can never reach a creator's
  liquidity/buy-in ETH except to deliver it into the pool the creator's own
  voucher specified.
- If a signed voucher is never relayed (relayer is down, rejects it, or
  the creator changes their mind) the creator can call `reclaimDeposit
  (voucherHash)` **themselves**, once `voucher.deadline` passes, and get
  their full deposit back — no platform involvement required.

### Running the relayer service

`scripts/relayer.js` is the off-chain half — an Express API plus a poller
that watches both factories' `LaunchDeposited` events. It needs its own
funded wallet, kept **entirely separate** from `DEPLOYER_PRIVATE_KEY`:

```bash
RELAYER_PRIVATE_KEY=0x...        # a FRESH key you generate and fund yourself — never reuse another key for this
TOKEN_FACTORY_ADDRESS=0x...      # optional — omit to skip relaying plain TokenFactory launches
CUSTOM_TOKEN_FACTORY_ADDRESS=0x... # optional — omit to skip relaying CustomTokenFactory launches
PORT=8787                        # optional, defaults to 8787
npx hardhat run scripts/relayer.js --network <network>
```

**You are responsible for generating, funding, and securing
`RELAYER_PRIVATE_KEY`** — this repo never generates or holds a real private
key on your behalf. Fund that wallet with enough native ETH to cover the
gas of every launch you expect it to relay; if it runs dry, relaying simply
stops (deposits stay safe and reclaimable — nothing is lost). Whoever holds
this key can spend its own ETH balance and choose which valid, signed
vouchers to relay and when — see "Trust model" above for exactly what it
can and cannot do beyond that.

On startup, the relayer warns (but doesn't refuse to run) if the factory's
on-chain `relayer()` address doesn't match its own wallet — call
`setRelayer(<relayer wallet address>)` (owner-only, on each factory you
want it to serve) before expecting real relays to succeed.
`scripts/setRelayer.js` does exactly that from the command line instead of
a console/Etherscan "write contract" call:

```
RELAYER_ADDRESS=0x... TOKEN_FACTORY_ADDRESS=0x... CUSTOM_TOKEN_FACTORY_ADDRESS=0x... \
  npx hardhat run scripts/setRelayer.js --network robinhoodTestnet
```

Run it with the factory OWNER's key (`DEPLOYER_PRIVATE_KEY`, unless
ownership has since moved), pointing `RELAYER_ADDRESS` at the relayer
wallet's plain address — never its private key, which this script has no
need for. It's a no-op if the relayer is already set correctly, and setting
`RELAYER_ADDRESS` to the zero address turns gasless relayed launches back
off for that factory (fully reversible). Restart `scripts/relayer.js`
afterward — it only reads `relayer()` once, at startup.

It exposes:

- `POST /vouchers/token` / `POST /vouchers/custom` — front end submits
  `{ voucher, signature }` here right after the deposit confirms.
- `GET /status/:voucherHash` — polled by the front end until the voucher
  reaches `"relayed"` (with `txHash`/`tokenAddress`/`pairAddress`) or
  `"failed"` (with an `error`).
- `GET /launches` — every launch recorded for whichever network this relayer
  instance is running against (`{ network, launches: [...] }`), read
  straight off that network's `deployed-contracts/<network>/` ledger. Each
  entry only carries the same public-safe fields the ledger's own CSV mirror
  does (ticker, addresses, mode, liquidity/verification info, timestamps,
  etc.) — never the archived `flattenedSource`, which would make every
  response needlessly huge. This is what lets the front end show "every
  launch on this network" instead of only whatever a given browser happened
  to launch or see itself; since one relayer instance is always bound to one
  network, switching Demo/Live on the front end means pointing it at a
  different relayer instance (a different `relayerApiUrl` per mode — see the
  front end's admin panel), which is what actually changes which network's
  launches come back.
- `GET /health` — liveness check.

Its own bookkeeping (voucher lifecycle, block-scan cursors so a restart
resumes instead of rescanning from genesis) lives in `relayer-data/<network>/`
— plain JSON files, same philosophy as `deployed-contracts/`, and **not**
something to hand-edit or commit. The relayer process always runs against
exactly one network at a time (`--network <name>`, or `HARDHAT_NETWORK`),
so it automatically writes into that network's own subdirectory — a
testnet relayer's vouchers and cursor never mix with a mainnet relayer's,
even if you happen to run both from the same checkout.

The relayer starts watching for deposits **from its own startup block
onward**, not from genesis — a deposit made before the relayer's first run
(e.g. while it was down) needs either a fresh signed voucher + deposit, or
a manual `reclaimDeposit()` call, since nothing will discover it
automatically.

### Deploying the relayer on a managed Node.js host (e.g. GoDaddy Node.js Hosting)

You don't need your own server or SSH access to run this — `scripts/relayer.js`
also runs fine on a managed Node.js host as long as a few things line up.
This repo is already set up for that:

- `package.json` declares `main`, `build` (`hardhat compile` — needed so the
  factory ABIs are available before startup), and `start` (`node
  scripts/relayer.js`), and every package the relayer needs at runtime is a
  `dependencies` entry, not a `devDependencies` one — some hosts run a
  production-only install that skips `devDependencies` entirely, which
  would otherwise leave `hardhat` missing at startup even though `npx
  hardhat run` worked fine on your own machine.
- That list of `dependencies` is longer than you might expect —
  `@nomicfoundation/hardhat-toolbox` bundles a dozen-plus sub-plugins
  (`hardhat-ethers`, `hardhat-chai-matchers`, `hardhat-verify`, `typechain`,
  `ts-node`, `typescript`, `solidity-coverage`, `hardhat-gas-reporter`,
  etc.) as **peer dependencies**, not dependencies of its own package — npm
  auto-installs those for you locally, so they're easy to forget even exist
  until a host's install doesn't do that same auto-install. If you see
  `HardhatError: HH801: Plugin @nomicfoundation/hardhat-toolbox requires
  the following dependencies to be installed: ...` on a fresh host, that's
  this exact problem: the toolbox's own config-loading check runs on
  *every* Hardhat command (including a plain `hardhat compile`), regardless
  of whether your code actually uses gas-reporter or typechain output, so
  none of these are safe to leave off — they're all already listed in this
  repo's `package.json` for that reason, with the versions HH801 itself
  reports as compatible.
- The relayer listens on `process.env.PORT` (falling back to `RELAYER_PORT`,
  then `8787`) rather than a fixed port — required by hosts that assign the
  port for you and route your app's domain to it.
- It sets permissive CORS headers on every response, since the front end
  (`index.html`) is essentially always served from a different origin than
  wherever this API ends up.
- `relayer-data/`, `deployed-contracts/`, and `deployments/` (its three
  JSON-file-backed data directory roots — each one holding a subdirectory
  per network underneath it) can be redirected via `RELAYER_DATA_DIR` /
  `DEPLOYED_CONTRACTS_DIR` / `DEPLOYMENTS_DIR` env vars — **check whether
  your host's default app directory actually survives a redeploy or
  restart.** If it doesn't, point these at whatever path your host
  documents as persistent storage; otherwise a redeploy can silently forget
  in-flight vouchers, the block-scan cursor, and the launch ledger.

Deploying to GoDaddy's Node.js Hosting specifically, using its GitHub-import
flow (Hosting dashboard → **Node.js Apps** → **Add App** → **Connect
GitHub**):

1. Push this repo to a GitHub repo GoDaddy can access, then connect it in
   the **Add App** flow and pick the branch to deploy.
2. When prompted for the app's environment variables/secrets, set:
   `RELAYER_PRIVATE_KEY`, at least one of `TOKEN_FACTORY_ADDRESS` /
   `CUSTOM_TOKEN_FACTORY_ADDRESS`, and **`HARDHAT_NETWORK`** (e.g.
   `robinhoodMainnet` or `robinhoodTestnet`) — this last one matters more
   here than it does when you run `npx hardhat run --network <network>`
   yourself: without the CLI wrapper choosing the network for you, Hardhat
   picks it up from the `HARDHAT_NETWORK` environment variable instead
   (confirmed by running this repo's own `require("hardhat")` under `node`
   directly with `HARDHAT_NETWORK` set — it boots and resolves the right
   network exactly like the CLI does). Add `ROBINHOOD_TESTNET_RPC_URL` /
   `ROBINHOOD_MAINNET_RPC_URL` too if you're using a dedicated RPC endpoint
   rather than the public default. Do **not** upload or commit a real
   `.env` file — use the host's own secrets UI for all of this.
3. Deploy. The host runs its own `npm install` + `npm run build` (compiling
   the contracts) + `npm start` (which is `node scripts/relayer.js`) —
   nothing else to configure.
4. Once it's live, call its own `GET /health` endpoint to confirm the
   relayer wallet address it reports, and confirm that address matches what
   you've set via `setRelayer(...)` on whichever factory (or factories)
   you're relaying for.
5. In `index.html`'s admin panel, set **"Gasless relayer API"**
   (`relayerApiUrl` in `config.json`, per mode) to this app's URL — that's
   the only front-end change needed; everything else about the gasless flow
   is unaffected by where the relayer happens to be hosted.

None of this is GoDaddy-specific in spirit — the same four bullet points
above (runtime deps in `dependencies`, `PORT` env var, CORS, configurable
data directories) are exactly what any other managed Node.js host (Render,
Railway, a PaaS, etc.) would also require, so the relayer isn't locked to
one platform.

## Contracts

- **`LaunchedToken.sol`** — the ERC20 every launch deploys. Fixed supply,
  minted once at `initialize()` (to the creator directly for "Deploy Token",
  or to the factory itself for "Deploy and Add Liquidity (Launch)"). Carries the
  transfer-tax logic described above, but it only ever activates if
  `configureTax()` is called — which only happens for the liquidity path.
  Deployed as a cheap EIP-1167 clone per launch rather than a full
  contract.
- **`TokenFactory.sol`** — the entry point; see "The launch flow" above.
- **`LiquidityLocker.sol`** — holds LP tokens from a "Launch + Add
  Liquidity" launch until a configurable unlock time, then lets the
  original creator withdraw them. Generic timelock, not tied to any one
  token.
- **Gasless relaying** (`TokenFactory.sol` and `CustomTokenFactory.sol`
  both carry this, alongside their normal direct-pay flow) —
  `depositForRelayedLaunch()`, `reclaimDeposit()`,
  `relayedCreateToken()`/`relayedCreateCustomToken()`,
  `hashLaunchVoucher()`/`hashCustomLaunchVoucher()` (EIP-712), and the
  `setRelayer()`/`setMaxRelayerGasReimbursement()` admin functions. See
  "Gasless relayed launches" below. `scripts/relayer.js` +
  `lib/relayerStore.js` are the off-chain half.
- **`interfaces/IUniswapV2Router02.sol`** — the minimal router/factory
  interface `TokenFactory` depends on, including the
  `SupportingFeeOnTransferTokens` swap variants. Any Uniswap V2-style DEX
  implements this, so swapping in Robinhood Chain's real router shouldn't
  require changing the contract.
- **`interfaces/IUniswapV2Pair.sol`** — the minimal pair interface
  `LaunchedToken` reads (`getReserves()`, `token0()`) for its market-cap
  check.
- **`interfaces/IAggregatorV3.sol`** — the minimal Chainlink-style price
  feed interface `LaunchedToken` reads for the tax's graduation check.
- **`mocks/`** — `MockRouter`, `MockLPToken` (doubles as the mock pair —
  real Uniswap V2 pairs are simultaneously the LP token and the reserve
  holder, and this mirrors that), `MockERC20`, `MockAggregatorV3`:
  test-only stand-ins for a real DEX and a real price feed. **Never point
  these at a real deployment.**

## Contract verification

Verification here has three genuinely different cases, and it's worth
understanding why before assuming something's broken:

- **`TokenFactory` and `CustomTokenFactory` themselves** have real, unique
  bytecode — they aren't clones of anything — and get normal source
  verification the moment they exist. `scripts/deploy.js` calls
  `lib/verify.js`'s `verifyContract()` on each right after it deploys,
  passing its exact constructor arguments, so both factories show up
  verified on the explorer as part of the same one-time platform
  deployment, before a single token has ever launched through them.
- **The shared implementations** (`LaunchedToken`, `CustomToken`,
  `LiquidityLocker`) also have real, unique bytecode and get the same
  normal source verification. `verifyContract()` is safe to call on every
  launch regardless — it detects "already verified" and returns instantly
  after the first time — which is why `scripts/launch.js` and
  `scripts/customLaunch.js` both call it again on every run rather than
  assuming deploy-time verification already covered it.
- **Every individual launched token is an EIP-1167 minimal proxy clone**,
  which means its on-chain bytecode is ~45 bytes of proxy code pointing at
  the implementation — not `LaunchedToken`'s or `CustomToken`'s bytecode.
  You cannot "verify" that the normal way (submitting the implementation's
  source against a clone's address will always fail, correctly, because it
  isn't that bytecode). What actually happens on most modern explorers
  (Etherscan, Blockscout) is automatic: once the implementation is
  verified, the explorer recognizes the standard EIP-1167 pattern and shows
  the implementation's ABI/source at every clone's address with no extra
  step. `lib/verify.js`'s `verifyProxyClone()` additionally makes a
  best-effort Etherscan-style `verifyproxycontract` API call for explorers
  that don't auto-detect it. Robinhood Chain's explorer is confirmed to be
  Blockscout-based (`robinhoodchain.blockscout.com` / `explorer.testnet.
  chain.robinhood.com`, both wired into `hardhat.config.js`'s
  `customChains`) — Blockscout's own proxy-verification API differs from
  Etherscan's, so this call may still no-op there; it isn't a blocker for
  the reason above (Blockscout auto-detects EIP-1167 clones without it).

Practically: run `scripts/deploy.js` once to stand up the platform — both
factories verify themselves as part of that same run (`tokenFactoryVerified`/
`customTokenFactoryVerified` in its summary log confirm it). From then on,
every "Deploy and Add Liquidity (Launch)" via `scripts/launch.js` and every
"Deploy Custom Tax Token" / "Deploy and Add Liquidity (Live)" via
`scripts/customLaunch.js` re-verifies the relevant implementation (a fast
no-op after the first time) and attempts the proxy-clone call for that
token. All of this requires `EXPLORER_API_URL` (and usually
`EXPLORER_API_KEY`) to be set in `.env` — without it, every verification
call logs a warning and skips cleanly rather than failing the deployment or
launch itself.

`verified` and `proxyVerified` booleans are recorded per launch in the
ledger, so you can see at a glance what actually got confirmed.

## The launch ledger (`deployed-contracts/`)

`scripts/launch.js` writes every launch to `deployed-contracts/<network>/`
— one subdirectory per network (e.g. `deployed-contracts/robinhoodTestnet/`,
`deployed-contracts/robinhoodMainnet/`) — no database server required, just
files:

- **`launched-tokens.json`** — that network's ledger, one JSON object per
  launch, appended to on every run.
- **`launched-tokens.csv`** — the same data as a flat CSV, for opening in a
  spreadsheet or importing elsewhere. Columns include `mode`,
  `tokenAddress`, `pairAddress`, `network`, and the rest of the
  liquidity/verification fields alongside the original identity fields.
- **`<SYMBOL>.json`** — that one launch's record on its own, named after
  the token's ticker (e.g. `AURA.json`).
- **`<SYMBOL>.sol`** — an archival copy of `LaunchedToken.sol`'s flattened
  source, with a header comment giving the token address, pair address (if
  any), the implementation address (the one that's actually verified — see
  above), creator, network, and transaction hash.

Launches are split by network specifically so a token launched on testnet
can never collide with — or be mistaken for — one launched on mainnet under
the same ticker: before this, every network wrote into one shared
directory, so a testnet `AURA` and a mainnet `AURA` would silently
overwrite each other's `AURA.json`/`AURA.sol`. Each entry still carries its
own `network` field/column too, so a single ledger file stays
self-describing even if it's copied out on its own. `readAllLedgers()` (in
`lib/launchStore.js`) gives a combined, cross-network view when you want
one; `listNetworks()` lists which network subdirectories currently exist.

For a "Deploy and Add Liquidity (Launch)" launch that included a creator buy-in, the
ledger record also carries `creatorBuyEthAmount` and `creatorTokensBought`;
`null` otherwise.

`lib/launchStore.js` is the module behind this — it's written so that
swapping it for a real database later (Postgres, etc.) means changing that
one file, not the launch flow that calls it. The record shape it writes is
already what you'd want as a `launched_tokens` table's columns.

## The platform deployment record (`deployments/`)

`scripts/deploy.js` deploys the platform's own infrastructure — the
`TokenFactory`/`CustomTokenFactory` pair, their token implementations and
liquidity lockers, and whatever optional platform-rewards pieces that run
included — which is a different thing from an individual token launch, so
it gets its own directory rather than sharing `deployed-contracts/`.
Every run writes into `deployments/<network>/`:

- **`current.json`** — the latest deployment for that network, overwritten
  every run. This is what you'd point another script, a `.env` template, or
  the front end's network config at to get "the addresses in use right now"
  for that network, instead of scrolling back through console output.
- **`history.json`** — every run ever recorded for that network, appended
  to, oldest first — so redeploying (including a run that reuses a piece
  via `REWARDS_DISTRIBUTOR_ADDRESS`/`PLATFORM_TOKEN_ADDRESS`) never
  silently loses the previous record.

`lib/deploymentStore.js` is the module behind this, same dependency-free
philosophy as `lib/launchStore.js` and `lib/relayerStore.js`.

## Design notes worth knowing before you touch this

- **No minimum liquidity is enforced** on the "Deploy and Add Liquidity (Launch)"
  path, by product decision — any amount above zero is accepted.
- **`deployFee`/`launchFee`, liquidity, the creator buy-in, and the transfer
  tax are all in the chain's native token** (ETH-equivalent), not a
  stablecoin. The $80,000 graduation target is the only USD-denominated
  number in the system, and it only exists as a conversion through the
  price feed — nothing is ever priced or paid in an actual stablecoin.
- **The creator buy-in is capped at `maxCreatorBuyBps` (default 500 =
  5.00%) of `totalSupply`** — see "The creator buy-in" above. It's an
  anti-rug safeguard, not slippage protection (`minCreatorTokensOut`
  already covers that separately), and it's owner-adjustable via
  `setMaxCreatorBuyBps` for launches going forward.
- **The transfer tax is fixed at 25 bps (0.25%) by default**, applied
  identically to buys and sells, and permanently stops once a pool's
  market cap crosses the graduation target. It's an owner-adjustable
  default (`setTaxDefaults`) for pools created going forward, not a
  per-trade choice, and it never applies to a "Deploy Token" token at all.
- **LP lock duration defaults to 15 days**, owner-adjustable via
  `setLpLockDuration`. Changing it only affects locks created after the
  change.
- **A "Deploy Token" token is a completely ordinary ERC20.**
  `configureTax()` is simply never called on it, so there's no tax state,
  no pool reference, nothing — not a flag that happens to be off, but code
  that never ran.
- **Robinhood Chain's RPC URL, chain ID, and block explorer are confirmed**
  (https://docs.robinhood.com/chain/connecting) and built into
  `hardhat.config.js` as the `robinhoodTestnet` (46630) and
  `robinhoodMainnet` (4663) networks.
  **The DEX router and Chainlink ETH/USD price feed both have confirmed
  mainnet defaults baked into `deploy.js`** — the router at
  `0x89e5DB8B5aA49aA85AC63f691524311AEB649eba` (cross-checked against
  Uniswap Labs' own `@uniswap/sdk-core` package and Robinhood's block
  explorer), and the price feed at
  `0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9` — Chainlink's "Standard
  Proxy" for ETH/USD, read directly off Chainlink's own address directory
  (https://docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood),
  which Robinhood's own docs
  (https://docs.robinhood.com/chain/oracles-and-price-feeds/) name as the
  source of truth for these. Neither needs to be set in `.env` to deploy to
  `robinhoodMainnet` — `deploy.js` also double-checks both live on-chain
  (router `factory()`, feed `decimals()`/`latestRoundData()`) before
  deploying anything, so a bad override still gets caught before it costs
  any gas.
  **Neither has a confirmed default for testnet (46630)**, for different
  reasons: the testnet block explorer turns up 15 separately-verified
  copies of `UniswapV2Router02` with no way to tell which one real liquidity
  routes through, while the Chainlink directory page above renders its
  table with client-side JavaScript, so its testnet row (if one even exists)
  has to be read from an actual browser rather than fetched. `deploy.js`
  refuses to run against `robinhoodTestnet` until you set both yourself in
  `.env` — do not guess.
  Also confirm the real router actually implements both
  `...SupportingFeeOnTransferTokens` swap functions — the plain
  `swapExactETHForTokens`/`swapExactTokensForETH` are not safe to use
  against this token once its tax is active.

## What's not here yet

- The off-chain **identity + dashboard backend** — where a creator drafts
  name/ticker/description/socials before launching, logs in with their
  wallet (Sign-In With Ethereum) to edit socials and check status, and
  where the front end reads live token/price/pool data from. That's a
  separate Node service (indexer + API + DB) that reads this contract's
  events (`TokenCreated`, `LiquidityAdded`, `CreatorBought`, `TaxDisabled`)
  — the ledger here is a starting point for that, not a replacement for
  it.
- A **security audit**. Do not deploy this with real value at stake without
  one — a fee-on-transfer token interacting with a real AMM has real edge
  cases (front-running the tax-disable transaction, router compatibility,
  reentrancy surface) that deserve real scrutiny before going live.
- Real DEX integration on **testnet** — `deploy.js` has a confirmed router
  for mainnet (see the note above), but testnet still deploys `MockRouter`
  until someone sets `DEX_ROUTER_ADDRESS` from a trusted testnet source and
  confirms it supports the `SupportingFeeOnTransferTokens` swap variants.
- A real price feed integration on **testnet** — `deploy.js` has a confirmed
  Chainlink ETH/USD address for mainnet (see the note above), but testnet
  still deploys `MockAggregatorV3` until someone sets `PRICE_FEED_ADDRESS`
  from a browser-verified testnet feed address.
- Blockscout-specific proxy verification, if that turns out to be what
  Robinhood Chain runs (see "Contract verification" above).

## Running it

```bash
npm install
npx hardhat compile
npx hardhat test
```

`TokenFactory.createToken()` compiles with Solidity's IR pipeline
(`viaIR: true` in `hardhat.config.js`) rather than the legacy codegen — it
passes enough parameters and return values around (name, symbol, supply,
mode, three separate ETH amounts, pair, lpAmount, lockId,
creatorTokensBought) to hit the EVM's 16-slot local-stack limit under the
legacy pipeline even after splitting the function into smaller internal
pieces. This is a normal, supported compiler setting — not a workaround
specific to this environment.

Deploy locally (spins up a mock router and a mock $3000 ETH/USD price feed
automatically):

```bash
npx hardhat run scripts/deploy.js --network hardhat
```

### Deploying to robinhoodTestnet

Unlike mainnet, testnet has no confirmed official Uniswap V2 router and no
confirmed Chainlink price feed (see the `DEX_ROUTER_ADDRESS`/
`PRICE_FEED_ADDRESS` comments in `.env.example`) — `deploy.js` refuses to
guess either one, so both need a real address before it'll run against
`robinhoodTestnet`.

For the router: verify any candidate address directly against the block
explorer (`https://explorer.testnet.chain.robinhood.com`) before trusting
it — check that it's verified under the name `UniswapV2Router02`, compiled
with Solidity `0.6.6` (the real version; a different name or compiler
version, e.g. a custom "SwapRouter" on `0.8.x`, means it's a different kind
of contract that won't behave the way this platform's contracts expect),
and that its constructor's `_factory`/`_WETH` addresses are themselves
separately verified as `UniswapV2Factory`/`WETH9`. A router passing all of
that is a genuine, unmodified Uniswap V2 deployment — safe to use for
testing even though (unlike mainnet) it isn't an "official" one, since
standard Uniswap V2 has no owner/upgrade/pause mechanism that could do
anything to you beyond its already-public fee-sharing option.

For the price feed: since no confirmed Chainlink feed exists on testnet,
deploy `MockAggregatorV3` yourself:

```bash
npx hardhat run scripts/deployMockPriceFeed.js --network robinhoodTestnet
```

This refuses to run against `robinhoodMainnet` — it's a fixed-price,
unauthenticated stand-in (anyone can call `setAnswer()` on it — see the
contract) that must never back a real deployment. It prints the address to
set as `PRICE_FEED_ADDRESS`.

With both addresses in `.env` (`DEX_ROUTER_ADDRESS` and
`PRICE_FEED_ADDRESS`), run the normal deploy:

```bash
npx hardhat run scripts/deploy.js --network robinhoodTestnet
```

Launch a token with "Deploy Token" — create + verify only, 100% of supply
straight to your own wallet, no pool:

```bash
TOKEN_FACTORY_ADDRESS=0x... LAUNCH_MODE=just \
LAUNCH_NAME="Aurora Ledger" LAUNCH_SYMBOL=AURA LAUNCH_SUPPLY=1000000000 \
npx hardhat run scripts/launch.js --network hardhat
```

Launch a token with "Deploy and Add Liquidity (Launch)" — a real pool exists the
instant this transaction confirms, taxed at 0.25%/trade until its market
cap crosses $80,000, LP locked to you for 15 days:

```bash
TOKEN_FACTORY_ADDRESS=0x... LAUNCH_MODE=liquidity \
LAUNCH_NAME="Aurora Ledger" LAUNCH_SYMBOL=AURA LAUNCH_SUPPLY=1000000000 \
LAUNCH_LIQUIDITY_ETH=1 \
npx hardhat run scripts/launch.js --network hardhat
```

Same, but you also buy in for 0.1 ETH the instant the pool exists —
guaranteed to be the first trade against it (see "The creator buy-in"
above):

```bash
TOKEN_FACTORY_ADDRESS=0x... LAUNCH_MODE=liquidity \
LAUNCH_NAME="Aurora Ledger" LAUNCH_SYMBOL=AURA LAUNCH_SUPPLY=1000000000 \
LAUNCH_LIQUIDITY_ETH=1 LAUNCH_CREATOR_BUY_ETH=0.1 \
npx hardhat run scripts/launch.js --network hardhat
```

Buy from / sell into a live pool (testing/demo only — a real front end
calls the router directly from the trader's own wallet):

```bash
ROUTER_ADDRESS=0x... TOKEN_ADDRESS=0x... ETH_AMOUNT=0.5 npx hardhat run scripts/buyToken.js --network hardhat
ROUTER_ADDRESS=0x... TOKEN_ADDRESS=0x... TOKEN_AMOUNT=1000 npx hardhat run scripts/sellToken.js --network hardhat
```

(Swap `--network hardhat` for `--network localhost` if you're running
against a persistent `npx hardhat node`, so every script sees the same
chain state — this is required if you want `deploy.js`, `launch.js`,
`buyToken.js`, and `sellToken.js` to all interact with the same deployed
contracts across separate commands.)

Robinhood Chain's RPC URL, chain ID, and block explorer are confirmed (see
https://docs.robinhood.com/chain/connecting) and already built into
`hardhat.config.js` as two named networks — `robinhoodTestnet` (chain ID
46630) and `robinhoodMainnet` (chain ID 4663) — so you don't need to
configure those yourself. **Deploy to testnet first**, same as Robinhood's
own docs recommend. To deploy: copy `.env.example` to `.env`, fill in at
least `DEPLOYER_PRIVATE_KEY`, `DEX_ROUTER_ADDRESS`, `FEE_TREASURY_ADDRESS`,
`PLATFORM_FEE_WALLET_ADDRESS`, and `PRICE_FEED_ADDRESS` — those four are
*not* confirmed for Robinhood Chain and `deploy.js` refuses to guess them —
then:

```bash
npx hardhat run scripts/deploy.js --network robinhoodTestnet
TOKEN_FACTORY_ADDRESS=<from the output above> LAUNCH_MODE=just LAUNCH_NAME=... LAUNCH_SYMBOL=... \
  npx hardhat run scripts/launch.js --network robinhoodTestnet
```

Swap `robinhoodTestnet` for `robinhoodMainnet` once you're ready to go live
— that network moves real ETH, so double-check `DEPLOYER_PRIVATE_KEY` and
every address above before running anything against it.

`deploy.js` refuses to run against a non-local network without
`DEX_ROUTER_ADDRESS` and `PRICE_FEED_ADDRESS` set, on purpose — there's no
safe default for either; a real Uniswap V2-style router and a real
Chainlink-style ETH/USD feed both need to actually exist on Robinhood Chain
(and be confirmed by you) before either network is usable end to end.
