# LaunchedToken Security Audit

> **Remediation status: all five findings below are fixed** in both `LaunchedToken.sol` and (since it carried the identical vulnerable pattern) `CustomToken.sol`, verified by the full test suite (264 passing, no regressions) plus dedicated new tests exercising each fix directly. Summary:
>
> - **Finding 1 (graduation manipulation):** `_maybeDisableTax()`/`_maybeDisablePlatformTax()` now require the market-cap target to be confirmed on a *second*, separate transfer at least `GRADUATION_CONFIRMATION_WINDOW` (30 minutes) after the first qualifying observation, and any transfer observing the target no longer met resets the candidacy to zero — closing the pump-and-dump path. See `graduationCandidateAt`, `GraduationCandidateObserved`/`GraduationCandidateReset`, and the "resets the candidacy if the price drops back under target before confirmation" tests in `test/LaunchedTokenTax.test.js` and `test/CustomToken.test.js`.
> - **Finding 2 (mock timing divergence):** `contracts/mocks/MockLPToken.sol` now caches reserves and only syncs them at the end of `mint`/`withdrawToken`/`withdrawEth`, matching a real Uniswap V2 pair's actual swap-then-sync ordering, so the test suite now exercises the same two-transaction graduation timing production will see.
> - **Finding 3 (unguarded pair reads/arithmetic):** the pool-reads-and-arithmetic half of the graduation check is now isolated in `_computeMarketCapFromPair()`, called through an external self-call specifically so it sits behind its own `try`/`catch` — a misbehaving pair or an overflow now degrades to "can't confirm graduation right now" instead of reverting the transfer. See the "resilience to a misbehaving pair" tests (using a new `MockRevertingPair` mock).
> - **Finding 4 (unbounded totalSupply):** `initialize()` now enforces `MAX_TOTAL_SUPPLY` (1 quadrillion tokens, comfortably above real-world outliers).
> - **Finding 5 (no oracle recovery path):** a narrow, factory-gated `updatePriceFeed()` (owner-only via `TokenFactory.updateTokenPriceFeed`/`CustomTokenFactory.updateTokenPriceFeed`) can repoint a token's oracle inputs if the original feed dies — and nothing else about the token's tax configuration.
>
> The findings below are left exactly as originally written, for the record of what was found and why; see the README's "The transfer tax" section for the current, fixed behavior.

**Scope:** `contracts/LaunchedToken.sol`, and the parts of `contracts/TokenFactory.sol` and `contracts/LiquidityLocker.sol` that create, initialize, and configure it. This is the token every "Just Launch" and "Launch + Add Liquidity" flow deploys as an EIP-1167 clone.

**Compiler:** Solidity 0.8.24, optimizer enabled (200 runs). Checked arithmetic throughout (no `unchecked` blocks in this contract).

**Method:** manual line-by-line review of the contract and its call sites, cross-checked against the existing test suite (`test/LaunchedTokenTax.test.js`, `test/TokenFactory.test.js`) to confirm which behaviors are already proven versus assumed, and verified two findings below by tracing exact opcode-level ordering against real Uniswap V2 pair semantics rather than relying on this repo's own mock.

**Bottom line:** the contract is well-built for what it's simple by design to do — a one-time mint, an optional one-time tax wiring step, and a permanent one-way tax-disable switch — and several classes of bugs that show up in similar "launchpad token" contracts are structurally absent here (no admin mint, no post-launch fee-wallet rug lever, no ERC777-style reentrancy surface on fee collection). The one real, exploitable issue is how the tax-disable ("graduation") check decides a pool has "made it": it trusts the pair's own instantaneous spot price, which is cheap to move temporarily in exactly the kind of thin, freshly-launched pool this contract is built for. That is a genuine finding, not a nitpick, and is written up first.

---

## Findings

### 1. (High) Graduation can be permanently triggered by manipulating the pool's spot price, not by genuinely reaching the market-cap target

`_maybeDisableTax()` — called after every taxed transfer — decides whether to permanently flip `taxActive` from `true` to `false` using `currentMarketCapInFeedDecimals()`:

```solidity
(uint112 reserve0, uint112 reserve1, ) = IUniswapV2PairMinimal(pair).getReserves();
...
uint256 pricePerTokenWei = (ethReserve * 1e18) / tokenReserve;
uint256 usdPerToken = (pricePerTokenWei * ethUsd) / 1e18;
marketCap = (usdPerToken * totalSupply()) / 1e18;
```

This is `spot price × total supply`, read live off the pair's reserves at the moment of the check — not a time-weighted average, not anything that accounts for how thin the pool actually is. Two properties of this design combine to make it cheap to abuse:

- **Total supply is typically enormous relative to pool depth.** A meme-style launch might mint a billion tokens against a few ETH of liquidity. Because `marketCap` scales with `totalSupply()`, a comparatively small trade that nudges the spot price up by even a modest percentage gets multiplied by that entire supply — so the nominal "market cap" implied by the pool can look far larger than the pool's actual ETH value (its real TVL). Crossing an "$80,000 market cap" threshold this way can cost dramatically less than $80,000 of actual capital.
- **The check is real-time, not time-weighted.** There is no requirement that the elevated price persist for any length of time, across any number of blocks, or survive the attacker's own position being unwound. One qualifying instant is permanent and irreversible (`taxActive` never goes back to `true`).

**This is not theoretical — your own test suite demonstrates it.** In `test/LaunchedTokenTax.test.js`, `"permanently disables the tax the moment a buy pushes market cap past the USD target"` graduates a token by having a single trader buy against a 0.001 ETH pool. That test was written to prove the *intended* graduation behavior works, but it's identical in shape to the attack: nothing distinguishes "a token organically succeeding" from "someone temporarily inflating the reserves" from this contract's point of view, because it only ever looks at the instant the check runs.

**Concrete exploit path** (see Finding 2 for why this takes two transactions against a *real* Uniswap V2 pair rather than one, which does not reduce how practical it is):

1. Attacker (who could be the token's own creator, or a large holder, or an unrelated third party) buys a large amount against the pool, spiking the spot price. This trade is taxed normally — it costs the attacker `feeBps` of the trade plus ordinary AMM slippage, nothing more.
2. On the very next transfer that touches the pair — which could be the attacker's own follow-up transaction, or simply the next organic trade from anyone else, since the pool is now live and trading — `_maybeDisableTax()` reads the now-inflated reserves and permanently sets `taxActive = false`.
3. Attacker sells back down (or simply stops holding the manipulated position). The tax is now off forever for every future trade by every holder — most usefully for the attacker, if they're a large holder who wanted to exit a big position without paying the platform's transfer tax on the way out.

**Impact:** this is a griefing/revenue-integrity issue against the platform and against the "tax funds continue until the project has genuinely succeeded" premise sold to holders — it does not let anyone drain pool funds or steal another holder's balance. But it is realistically exploitable by anyone willing to front the temporary capital (cheaper than it sounds, per above), is irreversible once triggered, and directly defeats the stated purpose of `graduationTargetUsd`.

**Recommendation:** don't decide graduation from a single instantaneous read. Options, in rough order of how much rework each needs:
- Require the market-cap condition to hold across two (or more) checks separated by a minimum elapsed time (e.g., store the timestamp of the first qualifying observation, only flip `taxActive` off if a second qualifying observation occurs after some cooldown) — cheap to add, meaningfully raises the cost of a two-transaction spike-and-hold.
- Use the pair's TWAP (Uniswap V2 pairs already expose `price0CumulativeLast`/`price1CumulativeLast` for exactly this purpose) instead of instantaneous `getReserves()`.
- Gate graduation on pool depth (actual ETH reserves), not just implied market cap from spot price times total supply, so a thin pool can't produce a large nominal number from a small trade.

This same pattern (`currentMarketCapInFeedDecimals()` / `graduationTargetUsd`) is duplicated verbatim in `CustomToken.sol` — whatever fix is chosen should be applied to both, once.

### 2. (Low, but worth knowing before you rely on the existing tests) The mock pair's `getReserves()` doesn't model real Uniswap V2 timing — production will behave differently than the test suite shows

`contracts/mocks/MockLPToken.sol` returns *live* balances from `getReserves()`:

```solidity
/// @notice Live reserves: ... this mock just reads live
/// balances, which is simpler and sufficient here since nothing in
/// this mock does mid-transaction reserve manipulation.
function getReserves() external view returns (...) {
    reserve0 = uint112(IERC20(token0).balanceOf(address(this)));
    reserve1 = uint112(address(this).balance);
    ...
}
```

A real `UniswapV2Pair` does not work this way. Its `swap()` optimistically transfers the output tokens to the buyer *first* (which is what fires `LaunchedToken._update` → `_maybeDisableTax` → `getReserves()`), and only calls its own internal reserve-sync (`_update(balance0, balance1, ...)`, unrelated to this token's `_update`) *after* that transfer, right before `swap()` returns. So on a real pair, when `_maybeDisableTax()` runs mid-swap, `getReserves()` still returns the *pre-trade* cached reserves — a single buy can never see its own price impact and graduate itself in the same transaction.

Concretely: the existing test `"permanently disables the tax the moment a buy pushes market cap past the USD target"` passes against this mock but would **not** reproduce that way against a real Uniswap V2 pair — the same buy would leave `taxActive` still `true`, and graduation would only trigger on whatever transfer touches the pair *next* (once the pair's own post-swap sync has run). That doesn't fix Finding 1 — the next organic trade seconds later closes the gap just as easily — but it means:
- the test suite is currently verifying a different (faster, single-transaction) mechanic than what will actually run on Robinhood Chain against a genuine Uniswap V2-style pair, which could give false confidence about exactly when graduation fires, and
- anyone tracing "why didn't this token graduate on my one big buy" in production should know it's expected to need a second pair-touching transfer, not a bug.

**Recommendation:** either update `MockLPToken.getReserves()` to cache reserves and only sync them after a swap/mint completes (matching real V2 semantics), or add an explicit comment/test documenting the divergence so nobody mistakes the mock's behavior for the production contract's actual timing. This is a test-infrastructure accuracy issue, not a change to `LaunchedToken.sol` itself.

### 3. (Low) The oracle `try/catch` doesn't cover the pair reads or the market-cap arithmetic — only the price feed call

```solidity
try priceFeed.latestRoundData() returns (...) {
    ...
    (uint112 reserve0, uint112 reserve1, ) = IUniswapV2PairMinimal(pair).getReserves();
    address token0 = IUniswapV2PairMinimal(pair).token0();
    ...
    marketCap = (usdPerToken * totalSupply()) / 1e18;
    feedIsFresh = true;
} catch {
    return (0, false);
}
```

Everything after the price feed call — the two calls into `pair`, and the multiplication chain that derives `marketCap` — sits *inside* the `try` block's success body, but is not itself wrapped in anything that catches its own failure. If `pair.getReserves()`/`pair.token0()` were ever to revert, or if the arithmetic overflowed (see Finding 4), that failure would propagate out of `currentMarketCapInFeedDecimals()`, out of `_maybeDisableTax()`, and revert the entire transfer — meaning every taxed buy/sell against that pool would start failing, with no way to recover other than the tax having already disabled itself some other way.

In practice this is low-risk today: `pair` is always a real, immutable, already-verified Uniswap V2 pair by the time this runs, and `getReserves()`/`token0()` on a genuine V2 pair are simple view reads that don't revert under normal conditions. This is flagged as defense-in-depth, not an active exploit — the price-feed call is defensively wrapped and everything downstream of it isn't, which is an inconsistency worth closing given how cheap it is to fix (wrap the whole computation, or move the pair reads to their own low-level staticcall with a decode check).

### 4. (Informational) No upper bound on `totalSupply_`

Neither `TokenFactory.createToken()` nor `LaunchedToken.initialize()` bound `totalSupply_` beyond `> 0`. Combined with Finding 3, a creator who deliberately (or mistakenly, e.g. by forgetting to account for 18 decimals in a script and adding many extra zeros) sets an extreme `totalSupply_` could push `usdPerToken * totalSupply()` in `currentMarketCapInFeedDecimals()` past `type(uint256).max`, which reverts (Solidity 0.8 checked math) rather than wrapping — bricking every taxed transfer for that specific token via the same uncaught-revert path as Finding 3. This requires a genuinely extreme value (ordinary large meme-coin supplies, even in the trillions with 18 decimals, are nowhere near this range) and only affects the token that chose it, but a simple sanity cap (e.g., reject anything above ~1e30) at `initialize()`/`createToken()` costs nothing and removes the edge case entirely.

### 5. (Informational) No manual recovery if the price feed becomes permanently unusable

If `priceFeed` is stale or reports a non-positive answer, `_maybeDisableTax()` correctly skips the check without reverting the trade — trading is never blocked by a broken oracle. But there is also no owner/factory-level escape hatch to force graduation (or otherwise adjust `taxActive`) if the configured feed is later deprecated or was simply never a real, maintained feed on a young chain. Since your own comment on `IAggregatorV3` already flags "confirm a feed actually exists there... before relying on this in production; there is no guarantee one does yet," a token whose feed goes permanently stale would tax every trade forever with no way out short of redeploying. Worth a deliberate decision either way (accept the risk, or add a guarded manual override) rather than leaving it implicit.

---

## What's already solid (verified, not assumed)

- **No admin mint, ever.** `_mint` is called exactly once, from `initialize()`. `totalSupply()` is monotonically non-increasing after that (mint once, burn optionally) — there is no path back to inflating supply.
- **No post-launch rug lever.** `configureTax()` is `onlyFactory`, one-time (`require(!taxConfigured)`), and there is no function anywhere to change an already-launched token's `feeWallet`, `feeBps`, or `pair` afterward. The only state transition left after launch is `taxActive: true → false`, never the reverse.
- **Burn is unconditionally untaxed by construction**, not by a special-cased check — `to == address(0)` structurally never equals `pair`, so it can't hit the tax branch in `_update()`. Verified against a real taxed, liquidity-added token in `TokenFactory.test.js`.
- **Fee collection has no reentrancy or revert-griefing surface.** The tax split (`super._update(from, feeWallet, ...)`, `super._update(from, rewardsDistributor, ...)`) is a plain internal ERC20 balance update, not a push-based `.call{value}` or a token with transfer hooks — there's no way for a malicious `feeWallet`/`rewardsDistributor` contract to revert or reenter on receiving its cut.
- **Clone initialization has no front-runnable gap.** `Clones.clone()` and the matching `initialize()` call happen in the same transaction at every call site (`createToken`, `relayedCreateToken`), so there's no window for a third party to front-run initialization of a freshly cloned address. The master implementation contract locks itself via `_initialized = true` in its own constructor, so it can never be initialized directly either.
- **`configureTax`'s bounds are actually enforced before it can be reached** — `rewardBps_ <= feeBps_` and "no distributor implies no reward cut" are both checked in `configureTax` itself, and the only two call sites (`_launchWithLiquidity`, `_relayedLaunchWithLiquidity`) always pass values that were already bounds-checked in `TokenFactory.setTaxDefaults`. No path exists to violate these invariants.
- **Reentrancy guards are correctly placed** at the TokenFactory entry points that move ETH or create pools (`createToken`, `relayedCreateToken`, `depositForRelayedLaunch`, `reclaimDeposit` are all `nonReentrant`), and `_finalizeLaunch` follows checks-effects-interactions (factory-side bookkeeping is written before any external fee transfer).
- **Standard bps math, no silent overflow class of bugs** — Solidity 0.8.24's checked arithmetic means any genuine overflow reverts loudly rather than wrapping; the one place this matters in practice is covered by Findings 3/4 above.

## Test coverage notes

The existing suite already exercises buy/sell taxation, graduation under a normal (non-adversarial) large buy, oracle staleness/invalid-price resilience, and `configureTax` access control/one-time enforcement — this is good coverage for the "happy path" and for the oracle-availability edge cases. What it does not yet cover, and what would directly validate (or invalidate) Finding 1 once a fix is chosen: a test that pumps the price, lets it graduate, then unwinds the position — proving graduation either resists that pattern (after a fix) or is limited to it (documenting the current risk). Given `MockLPToken.getReserves()` reads live balances (Finding 2), such a test would currently need a second transaction after the pump to see the effect that a real pair would show — which is itself useful to encode once the mock or the graduation logic changes.
