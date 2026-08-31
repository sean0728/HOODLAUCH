# CustomToken Security Audit

> **Remediation status: all seven findings below are fixed** (Finding 7's "fix" is a deliberate no-op — see its note), verified by the full test suite (273 passing: the prior 264 plus 9 new tests exercising each fix directly, no regressions). Summary:
>
> - **Finding 1 (a single failing swap-and-process step bricks transfers):** `_processLiquidity`/`_processMarketing`/`_processReflections` are now called through an external self-call, each wrapped in its own `try`/`catch` — the same pattern already used for `_computeMarketCapFromPair`'s graduation math. A failing step's tokens go straight back into the relevant `pending*Tokens` counter instead of reverting the triggering transfer. See the "`_swapAndProcess` isolation" test (a `marketingWallet` that reverts on receiving ETH no longer bricks the sell that triggered it).
> - **Finding 2 (zero slippage protection on internal swaps):** every internal swap, plus `_processLiquidity`'s `addLiquidityETH` call, now carries a real `amountOutMin`/minimum derived from the pool's own live reserves (`_quoteOut`, the same constant-product quote helper the factories already use) and a creator-adjustable `processingSlippageBps` (500–800 bps, default 600 — see `setProcessingSlippageBps()`). See the "`processingSlippageBps`" tests, including one that simulates a shortchanging router and confirms the resulting revert is safely caught by Finding 1's isolation rather than bricking the transfer.
> - **Finding 3 (combined platform + creator tax can exceed 100%):** `configurePlatformTax()` now rejects a `feeBps_` that, added to the token's own already-locked-in `buyFees`/`sellFees` total, would exceed 10,000 bps. See the "configurePlatformTax combined-fee-bps guard" tests.
> - **Finding 4 (no rescue path for stray ETH/tokens):** new creator-gated `rescueToken()`/`rescueEth()`, structured like `LiquidityLocker.rescueToken()` — provably unable to touch this token's own pending fee streams or any holder's still-unclaimed reflection entitlement. See the "rescueToken / rescueEth" tests.
> - **Finding 5 (no creator-role transfer mechanism):** new `transferCreator()`/`acceptCreator()`, the same two-step (`Ownable2Step`-style) handoff already used for every other privileged role in this codebase. See the "transferCreator / acceptCreator" tests.
> - **Finding 6 (`reflectionAsset_` not validated against the token itself):** `initialize()` now rejects `reflectionAsset_ == address(this)`. See the "reflectionAsset cannot be the token itself" test.
> - **Finding 7 (holder registry can be cheaply inflated):** left as documented, not fixed — the finding itself concludes there's no cheap mitigation that doesn't trade away this registry's deliberate "fully permissionless, no minimum balance" design, and it's a quality-of-service nuisance, not a fund-safety issue (`claimReflections()` stays correct and available regardless of registry size).
>
> The findings below are left exactly as originally written, for the record of what was found and why; see the README's "CustomToken's swap-and-process pipeline" section for the current, fixed behavior.

**Scope:** `contracts/CustomToken.sol` in full, and the parts of `contracts/CustomTokenFactory.sol` that create, initialize, and configure it. This is the "advanced" launch path's token — creator-configurable buy/sell taxes (reflections, marketing, auto-liquidity, burn) plus the same platform graduating tax `LaunchedToken` carries. The graduation mechanism itself (spot-price manipulation, mock timing, unguarded pair reads, supply cap, oracle-recovery hatch) was already audited and fixed in the prior pass — this pass covers everything else: the reflection accounting, the swap-and-process pipeline, and the fee/access-control surface unique to this contract.

**Compiler:** Solidity 0.8.24, optimizer enabled (200 runs). Checked arithmetic throughout.

**Method:** manual line-by-line review of `CustomToken.sol` end to end, cross-checked against `test/CustomToken.test.js` (102 tests) to confirm which behaviors are already proven versus assumed, and read `CustomTokenFactory.sol`'s `_seedLiquidityAndBuyIn`/`configurePlatformTax` call sites to understand exactly what state exists at each configuration step.

**Bottom line:** the reflection accounting itself is careful and already well-hardened (pair/contract exclusion, the blocked-wallet underflow fix, reentrancy guards shared correctly across `claimReflections`/`pushReflections`, non-blocking per-holder failure handling in the push sweep). The real risk in this contract lives one layer over, in `_swapAndProcess()` — the function that turns accumulated fee tokens into actual marketing ETH, auto-liquidity, and reflection payouts. It runs three external-call-bearing steps with no failure isolation and no slippage protection, and unlike the graduation math (already fixed to fail safely), a problem in any one of those steps doesn't just skip a feature — it reverts the ordinary user transfer that happened to trigger it. That's the finding to fix first.

---

## Findings

### 1. (High — availability) A single failing step inside `_swapAndProcess()` reverts the entire transfer that triggered it, and can permanently brick the token

```solidity
function _swapAndProcess() private lockTheSwap {
    ...
    if (liquidityTokens > 0) _processLiquidity(liquidityTokens);
    if (marketingTokens > 0 && marketingWallet != address(0)) _processMarketing(marketingTokens);
    if (reflectionTokens > 0) _processReflections(reflectionTokens);
}
```

None of `_processLiquidity`, `_processMarketing`, or `_processReflections` are isolated from each other or from the caller. Each does a real external call — a DEX swap, an `addLiquidityETH`, or a plain `.call{value}` to `marketingWallet` — and each can revert for reasons that have nothing to do with the user whose transfer happened to cross `swapThreshold` and trigger this batch:

- `_processMarketing` ends with `require(sent, "CustomToken: marketing transfer failed")`. If `marketingWallet` is ever a contract that reverts on receiving plain ETH (a mistyped address, a contract without a `receive()`/payable `fallback()`, a multisig misconfigured to reject value transfers, or one that simply becomes that way later), this reverts.
- `_processReflections`, when `reflectionAsset != address(0)`, calls `router.swapExactTokensForTokensSupportingFeeOnTransferTokens(... path=[this, WETH, reflectionAsset] ...)`. If that pair doesn't exist, has been drained, or `reflectionAsset` later blacklists this contract, the swap reverts.
- `_processLiquidity`'s `router.addLiquidityETH(...)` can revert for ordinary router-level reasons.

Because `_swapAndProcess()` is called from inside `_update()` (via `_maybeSwapAndProcess()`) on **any** sell or plain transfer once the pending-fee total crosses `swapThreshold`, a revert here doesn't fail gracefully — it reverts the entire outer transfer. Concretely: once `marketingWallet` is broken, *every* future sell and *every* future plain transfer of the token reverts, forever, the moment pending fees cross the threshold again (which they always will, since the threshold keeps getting hit as trading continues). The token is completely frozen — not just its marketing/reflection/liquidity feature, but ordinary trading and even wallet-to-wallet transfers. The only way out is `setMarketingWallet()`, which is `onlyCreator` — if the creator is unreachable, has lost their key, or simply never notices, this is a **permanent, unrecoverable freeze** with no admin override and no rescue path anywhere in the contract.

This is a materially bigger risk than it looks, because the trigger doesn't require an attacker at all — a creator's own typo in `marketingWallet_` at launch, or picking a `reflectionAsset` that later loses its liquidity, is enough. It's also the same class of risk the graduation math already had and was fixed for (`_computeMarketCapFromPair`'s try/catch isolation) — this is the one place that same defensive pattern was never extended to.

**Recommendation:** wrap each of the three `_process*` calls the same way `_computeMarketCapFromPair` was wrapped — an external self-call behind its own `try`/`catch` — so a failure in any one step degrades to "this batch's tokens stay pending, try again next time" (or "this specific stream is skipped this round") rather than reverting the transfer that happened to trigger it. Marketing/reflection/liquidity tokens that fail to process should simply be added back to the relevant `pending*Tokens` counter rather than lost, so nothing is silently forfeited — just deferred until whatever was broken gets fixed (e.g., via `setMarketingWallet()`).

### 2. (High — value leakage) The internal swap-and-process trades have zero slippage protection, making them a predictable, repeatable MEV target

```solidity
function _swapTokensForEth(uint256 amount) private {
    ...
    IUniswapV2Router02(router).swapExactTokensForETHSupportingFeeOnTransferTokens(
        amount, 0, path, address(this), block.timestamp + 15 minutes
    );
}
```

Every internal swap — the marketing fee's token-for-ETH swap, half of the liquidity fee's token-for-ETH swap, and the reflection fee's token-for-ETH-or-token swap — passes `amountOutMin: 0`. `_processLiquidity`'s own `addLiquidityETH` call passes `0, 0` for its token/ETH minimums too.

Unlike the creator's own buy-in (which has `liquiditySlippageBps`/`buyInSlippageBps` protecting it — see the README) or a trader's own swap (protected by whatever `amountOutMin` their own router call specifies), **these internal swaps are the contract's own trades on behalf of every holder**, and nothing protects them. Because the trigger condition (`pendingLiquidityTokens + pendingMarketingTokens + pendingReflectionTokens >= swapThreshold`) is public on-chain state, anyone can predict almost exactly which future sell will cross the threshold and trigger the batch, then sandwich that exact transaction: push the price unfavorably right before the internal swap executes, let it fill at the bad price, and reverse the price right after. The extracted value comes directly out of what marketing/reflections/liquidity would otherwise have received — a well-documented value leak pattern in fee-collecting tokens, and one this codebase already explicitly protects against everywhere else it applies (the liquidity-add and creator buy-in both have owner-adjustable slippage floors for exactly this reason).

**Recommendation:** apply the same pattern already used for `_effectiveMinBuyOut` in `TokenFactory`/`CustomTokenFactory` — derive a protective floor from the pool's own live reserves via the same constant-product quote helper, apply an owner-adjustable slippage tolerance (a new `processingSlippageBps`, same 5–8% band as `liquiditySlippageBps`), and pass that as `amountOutMin` instead of `0`. This won't eliminate MEV entirely (nothing short of a private mempool does), but it bounds the damage to the same tolerance already accepted everywhere else in this codebase, instead of leaving it completely unbounded.

### 3. (Medium) Nothing prevents the platform's `feeBps` and a token's own creator-side tax from summing past 100%, which would permanently brick every taxed transfer

`configurePlatformTax()` validates `rewardBps_ <= feeBps_` and the distributor requirement, but never checks its `feeBps_` against the token's own `buyFees`/`sellFees` totals (which are already set by the time it runs — `initialize()` always runs first). `CustomTokenFactory.setTaxDefaults()` separately bounds `feeBps_ <= 10_000` (100%) with no awareness of what any individual token's creator-side tax is.

If the platform owner ever raises the default `feeBps` close to 100% (there's no reason to today — the default is 0.25% — but nothing stops it, and `setTaxDefaults` allowing up to 100% is already an accepted, tested, deliberate design choice elsewhere in this codebase), any token launched under that config with even a small nonzero creator-side tax would have `reflectionCut + marketingCut + liquidityCut + burnCut + platformCut` exceed `value` on a taxed transfer. Since `_update()` computes `super._update(from, to, value - totalCut)`, that subtraction underflows and Solidity 0.8's checked arithmetic reverts — meaning **every buy and sell of that token reverts, permanently**, since none of these fee rates can be changed after launch. This is a second, independent path to the exact same "permanently bricked token" outcome as Finding 1, just triggered by a parameter combination instead of a downstream failure.

**Recommendation:** add a defensive bound in `configurePlatformTax()` — `require(feeBps_ + max(buyTotal, sellTotal) <= 10_000, ...)` using the token's own already-set `buyFees`/`sellFees` — so this combination is rejected at configuration time rather than silently shipping a token that can never process a taxed transfer.

### 4. (Low) No sweep/rescue function for stray ETH or tokens stuck on the contract

`LiquidityLocker.rescueToken()` exists specifically so tokens sent to that contract by mistake (or left over from a miscounted operation) aren't stranded forever. `CustomToken` has no equivalent. Two concrete ways value can get stuck here with no recovery path:

- `_processLiquidity` computes `half`/`otherHalf` from the pending liquidity-fee tokens, but `addLiquidityETH` is called with `amountTokenMin: 0, amountETHMin: 0` — if the pool's ratio doesn't exactly match the desired amounts, the router uses less than the full `otherHalf`/`ethForLiquidity` and can leave leftover token or ETH dust on this contract. That dust was already zeroed out of `pendingLiquidityTokens` before this ran, so it's never picked up by a future batch either — it just sits there.
- Anyone can send ETH or an arbitrary ERC20 directly to the token's own address (the `receive()` function accepts any ETH unconditionally) with no way for the creator or platform to ever retrieve it.

None of this is attacker-exploitable for profit — it's value loss, not value theft — but it's an easy, low-risk gap to close.

**Recommendation:** add a creator- or factory-gated `rescueToken(address token, address to, uint256 amount)` / `rescueEth(...)`, structured the same defensive way `LiquidityLocker.rescueToken` is — provably incapable of touching anything currently tracked in `pendingLiquidityTokens`/`pendingMarketingTokens`/`pendingReflectionTokens`, or (for ETH) anything owed to a specific holder's `withdrawableDividendOf`.

### 5. (Informational) No creator-role transfer mechanism

Every other privileged role in this codebase — `TokenFactory`'s owner, `CustomTokenFactory`'s owner, `LiquidityLocker`'s owner — uses `Ownable2Step` specifically so a role can be safely handed off or rotated without a single mistyped address permanently losing it. `creator` on `CustomToken` is set once at `initialize()` with no transfer path at all. If a creator loses their key, `setMarketingWallet()`, `setSwapThreshold()`, `setRewardsBlocked()`, and `activateIndependentPair()` become permanently uncallable — worth a deliberate decision (a two-step creator handoff, mirroring `Ownable2Step`, would be a small, low-risk addition) rather than an oversight.

### 6. (Informational) `reflectionAsset_` isn't validated against the token's own address

`initialize()` accepts any `reflectionAsset_`, including `address(this)`. Nothing rejects that, and it would produce a confusing self-referential swap path (`[address(this), WETH, address(this)]`) in `_swapTokensForToken`. Not exploitable by anyone but the creator configuring their own launch badly — cheap to reject explicitly (`require(reflectionAsset_ != address(this), ...)`).

### 7. (Informational) The holder registry can be cheaply inflated to dilute `pushReflections()`'s throughput

Any address whose balance goes from zero to nonzero is added to `_reflectionHolders` (see `_afterBalanceChange`). An attacker can fund many throwaway wallets with dust amounts of the token, inflating the registry without ever selling. `pushReflections(maxHolders)`'s cost per call is still bounded (it only ever visits `maxHolders` entries), but more of a keeper's sweep gets spent on wallets with nothing meaningful to claim, slowing how quickly it reaches genuine holders. This doesn't put anyone's funds at risk — `claimReflections()` stays correct and available to every real holder regardless of registry size — it's a quality-of-service nuisance, not a fund-safety issue, and there's no cheap fix that doesn't trade away the "fully permissionless, no minimum balance" design this registry deliberately has.

---

## What's already solid (verified, not assumed)

- **Reflection accounting is correct and already hardened.** The magnified-dividend-per-share bookkeeping correctly excludes the pair, the contract's own balance, and creator-blocked wallets (`accumulativeDividendOf`), with the underflow guard in `withdrawableDividendOf` already in place for a wallet that claimed before being blocked.
- **`claimReflections()` and `pushReflections()` share one `nonReentrant` guard status deliberately** — the comment in the code is correct that this closes cross-function reentrancy, not just self-recursion, which matters given the send-then-record ordering both functions use.
- **A single holder's failed payment in `pushReflections()` never blocks the batch and never costs them their entitlement** — exactly the defensive pattern Finding 1 above is asking to be extended to `_swapAndProcess()`'s three sub-steps.
- **Fee rates are genuinely immutable after launch** — `MAX_TOTAL_BPS` (5% per side) is enforced once at `initialize()`, and the only mutable piece of the whole fee configuration is `marketingWallet` itself, exactly as this contract's own top-level comment promises. There's no function anywhere that can raise a creator's tax after the fact.
- **No admin mint path** — `_mint` runs exactly once, from `initialize()`; `totalSupply()` only ever decreases (burns), never increases.
- **`activateIndependentPair()` derives `pair` trustlessly** off the DEX factory's own `getPair()` — a creator can't point it at an arbitrary address to fake tax activation against something they control.
- **The graduation mechanism (already audited and fixed in the prior pass)** — the confirmation-window candidacy, the revert-safe `_computeMarketCapFromPair`, the `MAX_TOTAL_SUPPLY` cap, and the `updatePriceFeed` escape hatch — all carry over correctly to `CustomToken`'s platform tax and are covered by their own dedicated tests.

## Test coverage notes

The existing 102-test suite thoroughly covers the "happy path" for every fee type individually and in combination, the reflection accounting's correctness (including four dedicated hostile-recipient tests for `pushReflections`), and the blocked-wallet feature. It does not currently cover: a failing `marketingWallet`/`reflectionAsset` swap during `_swapAndProcess` (Finding 1), MEV/sandwich exposure on the internal swaps (Finding 2 — hard to test meaningfully against `MockRouter`, which has no concept of slippage today, but worth at least a unit test asserting a nonzero `amountOutMin` is passed once fixed), or the combined-fee-bps overflow (Finding 3). Recommend adding tests for each once fixed, the same way the graduation fixes each got a dedicated regression test in the prior pass.
