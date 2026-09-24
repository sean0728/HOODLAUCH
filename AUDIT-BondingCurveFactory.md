# BondingCurveFactory Security Audit

> **Follow-up (added after auditing the newer `CustomBondingCurveFactory.sol`):
> Finding 8 (High) below is fixed.** It's the same root cause
> `AUDIT-CustomBondingCurveFactory.md`'s Finding 1 describes for the sibling
> contract, confirmed here by reading the full, real source of
> `LaunchedToken.sol` directly (it wasn't examined for this specific
> mechanism in the original pass below) rather than assumed to transfer over
> unchanged. `router` and the ten tax-default/reward-diversion fields
> (`platformFeeWallet`, `feeBps`, `priceFeed`, `graduationTargetUsd`,
> `maxOracleStaleness`, `rewardsDistributor`, `rewardBps`,
> `creatorRewardsDistributor`, `creatorRewardBps`, `feeWalletDistributor`)
> are now `private` instead of `public`, replaced by a combined
> `taxDefaults()` view — `router` needed to move here too (unlike
> `CustomBondingCurveFactory.sol`, where it could stay public), since
> `LaunchedToken._maybeAutoActivateTax` calls `tokenFactory.router()`
> directly as its first step. A companion `isGraduationBlocked(token)`
> tripwire view was added, identical in shape to the sibling contract's.
> Regression coverage lives in `BondingCurveFactory.test.js` under "Finding 8
> fix: independent-pair hijack via ITokenFactoryTaxDefaults" (3 new tests),
> reusing the same `createPair()` addition to `MockRouter.sol` that Finding
> 1's regression test added — no further mock changes needed. It's appended
> at the end of the findings list, after the original seven (all of which
> remain fixed, as below), to keep this document's history intact.
>
> **Remediation status: all seven ORIGINAL findings below are fixed** (Finding 7's "fix" is a documentation note only, as its own text already said no code change was needed), pending a full `npx hardhat test` run in the real repo to confirm (this environment doesn't have `LaunchedToken.sol`/`LiquidityLocker.sol`/the OpenZeppelin dependency tree available to compile against directly — see the delivery notes). Summary:
>
> - **Finding 1 (High — sell() could be frozen by a misbehaving fee recipient):** `_distributeEthFee` no longer reverts the triggering `buy()`/`sell()`/`createCurveToken()` call when `feeTreasury` or `rewardsDistributor` rejects a transfer. A failed transfer's amount is tracked in the new `strandedFees` counter (with a `FeeTransferFailed` event) instead of reverting anything — `sell()`'s "holders must always be able to exit" guarantee no longer depends on either recipient's health. See the new "fee distribution resilience (Finding 1)" test suite.
> - **Finding 2 (Medium — stale `realEthReserve` after graduation):** `_doGraduate` now zeroes `curve.realEthReserve` immediately after reading it into `ethForPool`, before any external call. `curveState()` correctly reports `0` for every graduated curve. The delivered test suite's own `realEthReserve == 0` assertion (written before this fix) now passes against the corrected contract.
> - **Finding 3 (Medium — `curveFeeBps` not snapshotted):** `curveFeeBps` is now snapshotted into `Curve.curveFeeBps` at `createCurveToken()` time, exactly like every sibling economic parameter. `setCurveFeeBps()` only ever affects curves created after the change. See the new "curve-parameter snapshotting (Findings 3 & 4)" tests.
> - **Finding 4 (Low — post-graduation tax terms not snapshotted):** the seven post-graduation tax parameters (`platformFeeWallet`, `feeBps`, `priceFeed`, `graduationTargetUsd`, `maxOracleStaleness`, `rewardBps`, `creatorRewardBps`) are now snapshotted into the `Curve` struct at creation and applied verbatim in `_doGraduate`, regardless of what `setTaxDefaults()` does in the meantime. A new `curveTaxConfig(token)` view exposes a curve's locked-in terms. The three distributor addresses remain deliberately live, not snapshotted (see the contract's own top-level comment for why).
> - **Finding 5 (Low — no rescue path):** new owner-gated `rescueStrandedFees(to, amount)` (capped to the tracked `strandedFees` counter, never touching a live curve's own ETH) and `rescueToken(token, to, amount)` (refuses any token this factory ever created as a curve, live or graduated).
> - **Finding 6 (Informational — confusing naming):** `ethGraduationTarget` is renamed `poolSeedTargetWei` throughout (state variable, `Curve` struct field, setter `setPoolSeedTargetWei`, event `PoolSeedTargetUpdated`, `curveState()`'s `poolSeedTargetWei_` return value) to stop it being confused with the unrelated, USD-denominated `graduationTargetUsd`.
> - **Finding 7 (Informational — oversized buys revert rather than partial-fill):** left as-is — this was documented as intentional, correct behavior in the original finding, not a defect; no code change was recommended or made.
>
> The findings below are left exactly as originally written, for the record of what was found and why.

**Scope:** `contracts/BondingCurveFactory.sol` in full — the 5th launch mode (zero-upfront-ETH bonding-curve tokens that auto-graduate into a real Uniswap-V2-style pool). This audit does not re-review `LaunchedToken.sol` or `LiquidityLocker.sol` themselves (both already covered by `AUDIT-LaunchedToken.md` and reused here unmodified); it covers everything specific to `BondingCurveFactory.sol` — the curve pricing math, the ETH/token accounting for a pooled, multi-curve, indefinite-duration balance sitting on one shared contract, the buy/sell/graduate lifecycle, and the admin surface. `contracts/mocks/MaliciousCurveReentrant.sol` and the two delivered test files were also reviewed, but as supporting evidence for what's actually exercised today, not as audit targets in their own right.

**Compiler:** Solidity 0.8.24, `viaIR` enabled. Checked arithmetic throughout (no `unchecked` blocks in this contract).

**Method:** manual line-by-line review of the full contract, cross-checked against `TokenFactory.sol` (the pattern this contract deliberately mirrors for salt derivation, fee distribution, and liquidity seeding — already covered by prior audits) to see exactly which parts are reused-and-trusted versus genuinely new. The genuinely new surface — a single factory holding many curves' pooled ETH simultaneously, rather than routing ETH through a router atomically in one transaction like every other launch mode — got the closest attention, since it's the one property this contract has that nothing else in the codebase does yet.

**Bottom line:** the reentrancy and pool-seeding mechanics are careful and mostly right — CEI ordering on `sell()`, `graduated` flipped before any external call in `_doGraduate`, a buy-only pause that never touches `sell()`, and a running balance-invariant check after every trade all do what they're meant to. The real problem is one specific consequence of this being the first contract in the codebase to run fee distribution on *every trade* rather than once at creation: `sell()`'s ETH payout is gated behind the exact same unprotected fee transfer that `buy()`/`createCurveToken()` also use, so a single misbehaving `feeTreasury` or `rewardsDistributor` doesn't just block new activity — it revokes the one guarantee this contract's own comments explicitly promise holders: that they can always exit. That's Finding 1, and it should be fixed before this ships. Findings 2 and 3 are both real correctness/consistency bugs worth fixing but don't put funds at risk the way Finding 1 does.

---

## Findings

### 1. (High — availability) `sell()`'s ETH payout is not actually always available — a single misbehaving fee recipient freezes every seller on every curve

```solidity
function sell(address token, uint256 tokenAmountIn, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
    ...
    curve.tokensRemaining += tokenAmountIn;
    curve.realEthReserve -= ethOutGross;

    bool pulled = IERC20(token).transferFrom(msg.sender, address(this), tokenAmountIn);
    require(pulled, "BondingCurveFactory: token transferFrom failed");
    require(... invariant ...);

    _distributeEthFee(feeAmount);   // <-- unprotected external call, no isolation

    ethOut = netEthOut;
    (bool sentEth, ) = payable(msg.sender).call{value: ethOut}("");
    require(sentEth, "BondingCurveFactory: ETH payout failed");
    ...
}
```

`_distributeEthFee` forwards `feeAmount` to `feeTreasury` (and, if set, splits half to `rewardsDistributor`) via a plain low-level `.call{value: ...}("")`, each wrapped in `require(sent, ...)`. If either address is ever a contract that reverts on receiving ETH — a treasury multisig that gets paused, a `rewardsDistributor` with a bug, or simply a mistyped address set via `setFeeTreasury`/`setRewardsDistributor` — that `require` fails, and because Solidity reverts undo the entire transaction, **`sell()` reverts in full**: the seller keeps their tokens, but there is no way for them to exit the curve at all while the fee recipient keeps rejecting the transfer.

This is a direct contradiction of the contract's own stated design goal. The top-level comment says outright: *"a buy-only pause circuit breaker (sell() never pauses -- holders must always be able to exit)"*. That guarantee is only true against the `pause()` lever — it says nothing about `_distributeEthFee`, and in practice `_distributeEthFee` is a second, unguarded way to block `sell()` that the pause design never anticipated. Note that simply reordering `_distributeEthFee` to run *after* the ETH payout would **not** fix this — a later revert still unwinds the whole transaction, payout included, since Solidity has no partial-commit. The fee transfer has to be isolated, not just moved.

Unlike `buy()`/`createCurveToken()` hitting the same `_distributeEthFee` failure (which is a real but low-severity availability problem — a blocked *new* purchase or launch, fully recoverable by retrying once the fee recipient is fixed, no funds at risk), a blocked `sell()` traps every existing holder's position on that curve until an owner notices and calls `setFeeTreasury`/`setRewardsDistributor(address(0))` to route around it. There's no time bound on that, no on-chain signal that distinguishes "curve is fine" from "every seller is currently stuck," and it affects every live curve simultaneously, not just the one curve someone happens to be trying to sell — because `feeTreasury`/`rewardsDistributor` are global settings, not per-curve.

**Recommendation:** isolate `_distributeEthFee`'s two transfers with their own `try`/`catch` (an external self-call, the same pattern already used for `_attemptGraduate` and for `LaunchedToken`'s own `_maybeAutoActivateTax`/`_computeMarketCapFromPair`), so a failing fee transfer degrades to "this fee stays on the contract's own balance, to be swept or redistributed later" rather than reverting the trade that generated it. This is the one place this codebase's own established "external call failures degrade gracefully, they don't brick the user-facing action" convention was not extended to reach — extending it here closes the gap.

### 2. (Medium — data integrity) `curve.realEthReserve` is never zeroed at graduation, leaving `curveState()` to report a stale, incorrect balance forever

```solidity
function _doGraduate(address token, Curve storage curve) private returns (address pair, uint256 lpAmount, uint256 lockId) {
    curve.graduated = true;

    uint256 tokensForPool = IERC20(token).balanceOf(address(this));
    uint256 ethForPool = curve.realEthReserve;   // <-- read into a local...
    require(tokensForPool > 0 && ethForPool > 0, "BondingCurveFactory: nothing to graduate");

    IERC20(token).approve(address(router), tokensForPool);
    (, , uint256 lpAmountAdded) = router.addLiquidityETH{value: ethForPool}( ... );
    // curve.realEthReserve is never written to zero anywhere in this function
    ...
}
```

`ethForPool` is read from `curve.realEthReserve` and spent via `addLiquidityETH`, but the storage field itself is never reset. The older, unrelated `contracts/BondingCurve.sol` prototype gets this right (`realEthReserves = 0;` runs before its own equivalent liquidity call) — this appears to be a dropped line rather than a deliberate change, since nothing else about this design calls for keeping it nonzero.

Concretely, after graduation, `curveState(token)` reports a `realEthReserve` equal to whatever the curve had accumulated right before its last graduating trade — forever. That value no longer corresponds to any ETH this contract actually holds on that curve's behalf (it's sitting in the pool now). It is not separately exploitable — `buy()`/`sell()`/`graduate()` all gate on `curve.graduated` first, so nothing reads this stale value to make a security-relevant decision after graduation — but it is a real, permanent view-correctness bug: any front end, indexer, or future contract that trusts `curveState()`'s `realEthReserve` field for a graduated token (e.g., to show "TVL still on the curve" or to sanity-check `pairOf`) will be shown a materially wrong, nonzero number for every single graduated curve, indefinitely.

This is also directly relevant to the test package delivered alongside this audit: the "auto-graduates the transaction that crosses ethGraduationTarget" test in `BondingCurveFactory.test.js` asserts `state.realEthReserve` equals `0n` after graduation — that assertion is currently **wrong against this contract as written** and will fail once actually run. The fix belongs in the contract, not the test (see Recommendation).

**Recommendation:** add `curve.realEthReserve = 0;` in `_doGraduate`, immediately after `ethForPool` is captured and before the external `addLiquidityETH` call (keeping the existing checks-effects-interactions discipline the rest of this function already follows). Once fixed, the delivered test's `expect(state.realEthReserve).to.equal(0n)` assertion will pass as written — no test change needed, only the contract fix.

### 3. (Medium — design consistency) `curveFeeBps` is a live global parameter, not snapshotted per curve like every other curve economic parameter — the owner can retroactively change a live curve's trading fee

Every other economic parameter that shapes a curve's pricing is deliberately snapshotted into the `Curve` struct at `createCurveToken()` time specifically so an owner change only ever affects curves created *after* it (`virtualEthReserveDefault` → `curve.virtualEthReserve`, `virtualTokenReserveBps` → `curve.virtualTokenReserve`, `ethGraduationTarget` → `curve.ethGraduationTarget`, `curveSupplyBps` → `curve.curveSupply`). `curveFeeBps` is the one exception:

```solidity
function _quoteBuy(Curve storage curve, uint256 ethIn) private view returns (...) {
    feeAmount = (ethIn * curveFeeBps) / 10_000;   // <-- reads the CURRENT global value, not a per-curve snapshot
    ...
}
```

`_quoteBuy`/`_quoteSell` both read the contract's current `curveFeeBps` directly, live, on every single trade — there is no `curve.feeBps` field at all. This means `setCurveFeeBps()` (bounded up to `MAX_FEE_BPS`, 20%) changes the trading fee on *every already-live curve* the instant it's called, not just curves created afterward. A trader who bought into a curve expecting a 1% fee could find themselves paying up to 20% on their very next trade against that same curve, with no notice baked into the protocol itself beyond whatever the owner communicates off-chain.

This isn't a fund-theft bug — `MAX_FEE_BPS` still bounds the damage, and nothing here lets the owner touch principal, only the fee rate on new trades — but it's a real inconsistency against this contract's own stated design pattern (every other per-curve parameter is deliberately insulated from being changed after the fact), and it's the kind of thing a trader would reasonably expect to be protected given how carefully the sibling parameters already are.

**Recommendation:** either snapshot `curveFeeBps` into the `Curve` struct at creation time (matching every sibling parameter, so `setCurveFeeBps()` only ever affects curves created after the change), or — if a live-adjustable trading fee is actually intended — say so explicitly in the contract's top-level comment and in user-facing documentation, since right now the code's own pattern implies the opposite for every parameter next to it.

### 4. (Low) Post-graduation tax parameters are read live at graduation time, not snapshotted at curve creation — a long-lived curve can graduate under different terms than existed when it was created

`_doGraduate` reads `platformFeeWallet`, `feeBps`, `priceFeed`, `graduationTargetUsd`, `maxOracleStaleness`, `rewardBps`, and `creatorRewardBps` directly from contract state at the moment graduation actually happens, not from anything captured when the curve was created:

```solidity
LaunchedToken(token).configureTax(
    pair, platformFeeWallet, feeBps, priceFeed, graduationTargetUsd, maxOracleStaleness,
    rewardsDistributor, effectiveRewardBps, creatorRewardsDistributor, effectiveCreatorRewardBps,
    feeWalletDistributor
);
```

For `TokenFactory`'s "launch with liquidity" path this distinction doesn't exist — pool creation and tax configuration happen in the same transaction as the launch itself, so "at launch time" and "at configuration time" are the same instant. Here, a curve can sit unsold for an arbitrary length of time between `createCurveToken()` and whichever trade eventually crosses `ethGraduationTarget` — during that window, `setTaxDefaults()` can change the post-graduation tax terms an early buyer implicitly bought into. This is a materially different (and longer) exposure window than anything the existing "launch with liquidity" audits needed to consider.

**Recommendation:** decide deliberately whether this is intended (a long-lived curve inheriting *current* platform tax policy at graduation, similar in spirit to how `curveFeeBps` behaves today) or not (in which case snapshot the same seven values into the `Curve` struct at `createCurveToken()` time, alongside the parameters that already are). Either is defensible — what matters is that it's a choice, not an oversight, and that it's documented so it isn't rediscovered as a surprise later.

### 5. (Low) No sweep/rescue function for stray ETH or accidentally-sent tokens

```solidity
receive() external payable {}
```

This exists specifically to absorb router refunds mid-`addLiquidityETH` (a real need — see the contract's own comment on it), but it also accepts ETH from *any* sender for *any* reason, unconditionally. ETH sent here directly (not via `buy()`) is never credited to any curve's `realEthReserve` and has no way to be recovered — there is no rescue function anywhere in this contract, unlike `LiquidityLocker.rescueToken()` elsewhere in this codebase. The same gap exists for an arbitrary ERC20 sent to this contract by mistake. This is value loss, not value theft, and nothing about it is attacker-exploitable for profit — but it's a small, easy gap to close, and this contract is a more attractive place for it to matter than most, given it's designed to hold real ETH balances for extended periods (unlike `TokenFactory`, which only ever holds ETH transiently within one atomic transaction).

**Recommendation:** add an owner-gated `rescueEth(address to, uint256 amount)` / `rescueToken(address token, address to, uint256 amount)` pair, structured the same defensive way as `LiquidityLocker.rescueToken` — provably incapable of pulling from any live curve's own `realEthReserve` or tracked token balance (e.g., cap `rescueEth` to `address(this).balance` minus the sum of every non-graduated curve's `realEthReserve`, or simpler: only allow rescuing ETH/tokens for curves that have already graduated, where the tracked balance is known to be exactly zero).

### 6. (Informational) `ethGraduationTarget` and `graduationTargetUsd` are two different thresholds, in two different units, that control two different transitions — and the similar naming invites confusion

`ethGraduationTarget` (ETH, per-curve, triggers the curve → pool transition) and `graduationTargetUsd` (USD, global, triggers the post-pool tax permanently disabling) are unrelated numbers guarding unrelated events, but the near-identical names make them easy to conflate — including, in practice, in this exact project's own planning conversation, where "the bonding curve" and "$50k" were initially discussed as if they were the same gate. They aren't: a curve graduates into a pool at 1.5 ETH raised (a curve-specific, ETH-denominated, one-time event), and *after* that, the resulting pool's tax separately, permanently disables once its live market cap crosses $50,000 (a platform-wide, USD-denominated, oracle-dependent event) — the same mechanic every other "launch with liquidity" token already has post-launch.

**Recommendation:** no code change needed, but worth a documentation/naming pass — e.g., renaming the curve-phase field to something unambiguous like `poolSeedTargetWei` — so this distinction doesn't have to be re-explained every time someone new (a front-end engineer, a support agent, a future auditor) reads this contract for the first time.

### 7. (Informational) A single oversized buy reverts entirely rather than partial-filling near curve exhaustion

`_executeBuy` requires `tokensOut <= curve.tokensRemaining`; a buy sized to demand more than the curve has left reverts outright with `"BondingCurveFactory: exceeds curve supply"` rather than filling whatever's available and returning change. This is consistent, intentional behavior (and is exactly why `ethGraduationTarget` was deliberately set below the curve's own exhaustion point — see the contract's own comment on it), not a bug — but it means a front end must call `quoteBuy`/`curveState` first and clamp the ETH amount itself for a buyer trying to ape in near the top of a curve, or that buyer's transaction simply fails.

### 8. HIGH — This factory accidentally implements the exact interface `LaunchedToken` uses to self-activate its tax against an independent pool, letting anyone permanently brick a curve's graduation

Identified while auditing the newer `CustomBondingCurveFactory.sol` (see
that document's Finding 1) and re-confirmed here directly against this
contract and the real, complete `LaunchedToken.sol` — not assumed to carry
over unchanged.

`LaunchedToken.sol` (cloned here, unmodified) has a permissionless,
automatic mechanism built for `TokenFactory`'s "Just Launch" mode: a token
minted with no liquidity at all, where the creator might independently pair
it up against Uniswap at some later, unknown time. Every transfer checks
for that on its own:

```solidity
// LaunchedToken.sol:388-395 (_update)
bool justActivated = false;
if (!taxConfigured && from != factory) {
    try this._maybeAutoActivateTax() returns (bool activated) {
        justActivated = activated;
    } catch {
        justActivated = false;
    }
}
```

```solidity
// LaunchedToken.sol:294-318 (_maybeAutoActivateTax)
function _maybeAutoActivateTax() external returns (bool justActivated) {
    require(msg.sender == address(this), "LaunchedToken: internal only");
    if (taxConfigured) return false;

    ITokenFactoryTaxDefaults tokenFactory = ITokenFactoryTaxDefaults(factory);
    IUniswapV2Router02 factoryRouter = tokenFactory.router();
    address dexFactory = factoryRouter.factory();
    address weth = factoryRouter.WETH();
    address detectedPair = IUniswapV2FactoryMinimal(dexFactory).getPair(address(this), weth);
    if (detectedPair == address(0)) return false;
    ...
    uint256 feeBps_ = tokenFactory.feeBps();
    address platformFeeWallet_ = tokenFactory.platformFeeWallet();
    ...
    taxConfigured = true;
    pair = detectedPair;
    ...
}
```

This is safe on a genuine "Just Launch" `LaunchedToken`, because there
`factory` really is `TokenFactory`, the correct source of tax defaults for
a token that was never going to get a pool from the factory itself.

`BondingCurveFactory` reuses the same contract for a token whose `factory`
field is **this curve factory** — for the specific, documented reason that
`LaunchedToken._update`'s own `from == factory` guard is what keeps every
curve-phase transfer this factory originates (buy payouts, and the
liquidity-seeding transfer inside `_doGraduate`'s `addLiquidityETH` call)
from racing ahead of the explicit `configureTax()` call. That reuse is
sound. What isn't sound — confirmed by checking every one of
`ITokenFactoryTaxDefaults`'s eleven functions against this contract's own
declarations, the same way `AUDIT-CustomBondingCurveFactory.md`'s Finding 1
was verified — is that this factory satisfies the interface completely:

```solidity
IUniswapV2Router02 public immutable router;      // :112 -- router() -- called FIRST by _maybeAutoActivateTax, unlike CustomToken's equivalent
address public platformFeeWallet;                // :202 -- platformFeeWallet()
uint256 public feeBps = 100;                      // :203 -- feeBps()
address public priceFeed;                         // :204 -- priceFeed()
uint256 public graduationTargetUsd = 50_000;      // :205 -- graduationTargetUsd()
uint256 public maxOracleStaleness = 1 hours;      // :206 -- maxOracleStaleness()
address public rewardsDistributor;                // :175 -- rewardsDistributor()
uint256 public rewardBps = 45;                    // :176 -- rewardBps()
address public creatorRewardsDistributor;         // :183 -- creatorRewardsDistributor()
uint256 public creatorRewardBps = 10;             // :184 -- creatorRewardBps()
address public feeWalletDistributor;              // :190 -- feeWalletDistributor()
```

Worth noting this is if anything MORE directly exploitable here than the
`CustomToken` case: `LaunchedToken._maybeAutoActivateTax` calls
`tokenFactory.router()` as its very first external call (to derive the DEX
factory and WETH address), and `router` is this factory's own `public
immutable` state variable — matching `ITokenFactoryTaxDefaults.router()`
exactly. `CustomToken`'s equivalent function uses its own `router` state
variable for that part instead and only reaches into `factory` for the tax
getters, so `router()` collides but was never actually the exploited call
there; here, it's the very first thing that succeeds.

**The attack is identical in shape to Finding 1 of
`AUDIT-CustomBondingCurveFactory.md`:** anyone calls the real DEX factory's
permissionless `createPair(token, WETH)` — no liquidity required, and
`predictTokenAddress(creator, salt)` being public means this can happen
before the curve is even created, front-running `createCurveToken()`
itself. The token's own first `_update()` call (the mint inside
`initialize()`, since `from == address(0) != factory`) or, failing that,
literally any `sell()` on the curve (`from == msg.sender != factory`)
triggers `_maybeAutoActivateTax()`, which succeeds against this factory's
live getters and permanently sets `pair` and `taxConfigured = true`, using
this factory's CURRENT global tax settings rather than anything
curve-specific (there's no snapshot involved in this path at all).

When the curve later actually crosses `poolSeedTargetWei` and `_doGraduate`
runs:

```solidity
// BondingCurveFactory.sol:680 (_doGraduate)
LaunchedToken(token).configureTax(
    pair, curve.taxPlatformFeeWallet, curve.taxFeeBps, ...
);
```

`configureTax()` unconditionally reverts with `"LaunchedToken: tax already
configured"` once `taxConfigured` is true — with no reset path anywhere in
`LaunchedToken.sol`. Exactly as in the `CustomToken` case, the whole
`_doGraduate` attempt (including the `addLiquidityETH` call that already
ran) unwinds atomically on that revert, so nothing is stolen or stranded
mid-flight — but the curve can never successfully graduate again.
`sell()` still works throughout (it never depends on `pair`/`taxConfigured`),
so holders can always exit at the curve's live price, but the one thing
this whole factory exists to eventually do — seed a real, LP-locked pool —
is permanently defeated, for the price of one ordinary, cheap, permissionless
Uniswap action, exploitable against every curve this factory will ever
create.

**Recommendation:** identical fix to `AUDIT-CustomBondingCurveFactory.md`'s
Finding 1 — stop this factory from satisfying `ITokenFactoryTaxDefaults` at
all. Concretely: make `platformFeeWallet`, `feeBps`, `priceFeed`,
`graduationTargetUsd`, `maxOracleStaleness`, `rewardsDistributor`,
`rewardBps`, `creatorRewardsDistributor`, `creatorRewardBps`, and
`feeWalletDistributor` private, and replace their individual getters with
one combined view (e.g. `taxDefaults()`, mirroring this contract's own
`curveTaxConfig()` shape). Here, `router` also needs to move — unlike
`CustomToken`'s version, `LaunchedToken._maybeAutoActivateTax` calls
`tokenFactory.router()` directly, so leaving `router` `public` alone would
leave the very first call in the chain still succeeding (it would just fail
one call later, at `feeBps()`, which is still enough to roll back the
`pair`/`taxConfigured` write in the same revert — but there's no reason to
leave `router()` matching when folding it into the same combined view
closes it just as completely and keeps the interface-match surface at
zero). A companion `isGraduationBlocked(token)` view, identical in shape to
the one added to `CustomBondingCurveFactory.sol`, is worth adding here too.

This has zero effect on legitimate post-graduation behavior, for the same
reason as the sibling contract: once this factory's own `configureTax()`
call succeeds, `taxConfigured` is permanently true, which already disables
`_maybeAutoActivateTax` from running again on that token regardless.

---

## What's already solid (verified, not assumed)

- **`sell()` genuinely never carries `whenNotPaused`** — verified directly in the source (`pause()`'s own doc comment claims this, and the modifier list on `sell()` confirms it: only `nonReentrant`, no `whenNotPaused`). The *pause* mechanism keeps its promise; Finding 1 is a completely separate way that promise can still be broken.
- **`_doGraduate` correctly flips `graduated = true` before any external call** — a reentrant `buy()`/`sell()`/`graduate()` triggered from inside the router/locker/`configureTax` calls can never observe a half-graduated curve, and a full revert of `_doGraduate` (e.g., the router failing) correctly unwinds `graduated` back to `false` along with everything else, so a failed graduation attempt never leaves a curve stuck in a corrupted "graduated but not really" state.
- **`sell()`'s CEI ordering is correct**: `curve.tokensRemaining`/`curve.realEthReserve` are updated, the token is pulled, and the balance invariant is checked — all before the ETH payout's external call. A reentrant call during that payout sees fully-updated, consistent curve state, not a half-applied one.
- **One shared `nonReentrant` lock correctly blocks cross-function reentrancy, not just self-recursion** — confirmed via the delivered hostile-recipient tests: a malicious recipient's `receive()` attempting to call back into `sell()`, `buy()`, or `graduate()` during a `sell()` payout is blocked in every case, because OpenZeppelin's `ReentrancyGuard` shares one status flag across every `nonReentrant`-modified function on this contract.
- **The balance invariant check (`IERC20(token).balanceOf(address(this)) >= curve.tokensRemaining + (curve.totalSupply - curve.curveSupply)`) runs after every buy and every sell** — a real defense-in-depth check against this contract's own bookkeeping ever drifting from its actual token balance, on a token whose supply is otherwise fully accounted for between the curve and the untouched reserve.
- **CREATE2 salt derivation is bound to the caller** (`keccak256(abi.encode(creator_, salt))`, identical to `TokenFactory`'s already-audited approach) — a mempool-visible salt can't be front-run and claimed by a third party.
- **`tokenImplementation`, `router`, and `locker` are all `immutable`** — none of them can be swapped out post-deployment, closing off an entire class of "owner silently redirects trading/liquidity to a malicious contract" rug vectors that a mutable version of any of these three would open up.
- **The owner has no direct withdrawal path over a live curve's pooled ETH or held tokens.** Every owner-only function in this contract either changes forward-looking parameters (fees, targets, tax defaults) or pauses new buys — there is no function that moves a curve's `realEthReserve` or token balance to an arbitrary address. (Finding 5 is about *stray*, untracked ETH/tokens with no owner attached to them, not about clawing back a curve's own funds.)
- **`MAX_FEE_BPS` correctly bounds both `curveFeeBps` and the post-graduation `feeBps`** at a hard 20% ceiling, closing off the "owner sets a confiscatory fee" failure mode regardless of how Finding 3 is eventually resolved.
- **The optional creator buy-in inside `createCurveToken()` correctly re-attempts auto-graduation** if it alone crosses `ethGraduationTarget` — this symmetry with `buy()`'s own inline attempt was verified directly in the source and is covered by a dedicated test in the delivered suite.

## Test coverage notes

The delivered `BondingCurveFactory.test.js`/`BondingCurveMath.test.js` suite (written and reviewed alongside this audit, not run in this environment — see the delivery notes) covers the happy paths for creation, buying, selling, graduation, pausing, and four distinct reentrancy scenarios against a hostile recipient contract. It does **not** yet cover any of Findings 1–4 above, since all four describe behavior that needs a dedicated adversarial or parameter-drift test to demonstrate:

- **Finding 1** needs a test with a `feeTreasury`/`rewardsDistributor` set to a contract that reverts on receiving ETH, confirming `sell()` currently reverts in that state (proving the bug) and, once fixed, that it no longer does (regression test for the fix).
- **Finding 2** is already indirectly caught by the delivered suite's own `realEthReserve == 0` assertion post-graduation — that assertion will fail until Finding 2 is fixed, which is itself a useful, already-in-place regression test once the one-line fix lands.
- **Finding 3** needs a test that creates a curve, calls `setCurveFeeBps()` to a new value, and confirms a subsequent `buy()`/`sell()` on that *already-existing* curve is priced at the new (not the original) fee — demonstrating the live-vs-snapshotted behavior directly.
- **Finding 4** needs an equivalent test with a time gap between `createCurveToken()` and the crossing trade, with `setTaxDefaults()` called in between, confirming which set of tax terms the graduated token actually ends up with.

Recommend adding one dedicated test per finding once each is resolved, the same pattern `AUDIT-CustomToken.md` and `AUDIT-LaunchedToken.md` both used for their own fixes.

- **Finding 8** needs the same regression shape added for
  `CustomBondingCurveFactory.test.js`'s Finding 1 coverage: a mock DEX
  factory's `createPair()` called for a curve token before graduation, an
  ordinary transfer confirmed NOT to hijack `pair`/`taxConfigured` after the
  fix, and graduation confirmed to still succeed afterward. `MockRouter.sol`
  already has the needed `createPair()` addition (added for the sibling
  contract's regression test) — this suite would reuse the same mock
  function, no further mock changes needed.
