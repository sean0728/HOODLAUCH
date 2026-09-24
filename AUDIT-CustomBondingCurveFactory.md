# Security Audit: CustomBondingCurveFactory.sol

**Scope:** `contracts/CustomBondingCurveFactory.sol` (~590 lines), plus its
integration points with the unmodified `contracts/CustomToken.sol` and
`contracts/LiquidityLocker.sol` it clones from / deploys against. The
constant-product bonding-curve math, the checks-effects-interactions
discipline on buy/sell/graduate, the buy-only pause circuit breaker, and the
non-reverting fee-distribution pattern are all copied unchanged from
`BondingCurveFactory.sol` (already audited in `AUDIT-BondingCurveFactory.md`
and fixed) — this pass does not re-derive or re-litigate that shared logic.
It focuses on what's actually new: cloning `CustomToken` instead of
`LaunchedToken`, the creator-supplied `buyFees_`/`sellFees_`/
`reflectionAsset_`/`marketingWallet_` parameters, the two-call
(`setPair`+`configurePlatformTax`) graduation wiring, and this factory's own
dedicated `LiquidityLocker`.

**Compiler:** Solidity `^0.8.24`, `viaIR` enabled (per project convention);
not compiled in this environment — see the note at the end of this document.

**Method:** Manual, line-by-line review of `CustomBondingCurveFactory.sol`
against the full text of `CustomToken.sol` (all 1,618 lines, read in full —
in particular `_update`, `_activatePoolIfFound`, `activateIndependentPair`,
`setPair`, `configurePlatformTax`) and `CustomTokenFactory.sol`'s own
equivalent call sites, tracing every state variable this factory shares in
name and type with `ITokenFactoryTaxDefaults.sol`. No prior audit artifact
existed for this file (it's new); every finding below was independently
derived from the code as written.

**Bottom line:** One finding (#1) is serious enough that this contract
should not be deployed as-is — it lets anyone permanently block any curve
from ever graduating, for the cost of one cheap, ordinary Uniswap action,
and it can be triggered before the curve even exists. It does not put
principal at risk (holders can still sell back to the curve at any time),
but it silently defeats the entire graduation/LP-lock guarantee the product
is built around. The remaining findings are lower-severity and
documentation-only.

---

## Findings

### 1. HIGH — This factory accidentally implements the exact interface `CustomToken` uses to self-activate against an independent pool, letting anyone permanently brick a curve's graduation before or during its life

`CustomToken.sol` (cloned here, unmodified) has a feature built for a
*different* product: `CustomTokenFactory`'s "Deploy Custom Tax Token" mode,
where a token is minted with no liquidity at all, and the creator might
independently pair it up against Uniswap at some later, unknown time.
`CustomToken` detects that on its own — no factory involvement required:

```solidity
// CustomToken.sol:916-956 (_update)
bool justActivated = false;
if (pair == address(0) && from != factory) {
    try this._activatePoolIfFound() returns (bool activated) {
        justActivated = activated;
    } catch {
        justActivated = false;
    }
}
```

```solidity
// CustomToken.sol:558-594 (_activatePoolIfFound)
address detectedPair = IUniswapV2FactoryMinimal(dexFactory).getPair(address(this), weth);
if (detectedPair == address(0)) return false;

pair = detectedPair;
emit PairSet(detectedPair);

ITokenFactoryTaxDefaults tokenFactory = ITokenFactoryTaxDefaults(factory);
uint256 feeBps_ = tokenFactory.feeBps();
...
```

and there's also a permissionless, callable-by-anyone convenience for the
same thing:

```solidity
// CustomToken.sol:616-620
function activateIndependentPair() external {
    if (pair != address(0)) revert PairAlreadySet();
    bool activated = this._activatePoolIfFound();
    if (!activated) revert NoPoolFound();
}
```

This is safe on a genuine deploy-only `CustomToken`, because there `factory`
really is `CustomTokenFactory`, and `ITokenFactoryTaxDefaults(factory)` is
the *correct*, intended source of tax defaults for a token that was never
going to get a pool from the factory itself.

`CustomBondingCurveFactory` reuses the same contract for a token whose
`factory` field is **this curve factory**, for an entirely different reason:
`CustomToken._update`'s own `from == factory` guard (see the contract's
header comment) is what keeps every curve-phase transfer this factory
originates — buy() payouts, and the liquidity-seeding transfer inside
`_doGraduate`'s `addLiquidityETH` call — from racing ahead of the explicit
`setPair()` call. That reuse is sound. What isn't sound is that this
factory's own admin-facing state variables happen to satisfy
`ITokenFactoryTaxDefaults` *exactly*, field for field:

```solidity
// CustomBondingCurveFactory.sol
uint256 public feeBps = 100;                    // :153 -- feeBps()
address public platformFeeWallet;               // :152 -- platformFeeWallet()
address public priceFeed;                       // :155 -- priceFeed()
uint256 public graduationTargetUsd = 50_000;     // :156 -- graduationTargetUsd()
uint256 public maxOracleStaleness = 1 hours;     // :157 -- maxOracleStaleness()
address public rewardsDistributor;               // :131 -- rewardsDistributor()
uint256 public rewardBps = 45;                   // :132 -- rewardBps()
address public creatorRewardsDistributor;        // :135 -- creatorRewardsDistributor()
uint256 public creatorRewardBps = 10;            // :136 -- creatorRewardBps()
address public feeWalletDistributor;             // :139 -- feeWalletDistributor()
IUniswapV2Router02 public immutable router;      // :112 -- router()
```

Every one of `ITokenFactoryTaxDefaults`'s eleven functions resolves against
this contract with a matching signature. So when `_activatePoolIfFound()`
calls `ITokenFactoryTaxDefaults(factory).feeBps()`, `factory` really is this
curve factory, and the call **succeeds** — it doesn't revert the way it
would against some unrelated contract.

**The actual attack requires nothing more than an ordinary, permissionless
Uniswap action:**

1. Anyone calls the real Uniswap V2 factory's `createPair(token, WETH)` for
   a curve token's address — no liquidity required, no special permission,
   just gas. Because `predictTokenAddress(creator, salt)` is a public view,
   this address is knowable *before the curve is even created* — an
   attacker (or an opportunistic pair-sniping bot, which already exist in
   the wild for exactly this reason) can front-run a pending
   `createCurveToken()` transaction and pre-create the pair for a token
   that doesn't have code yet. Uniswap's `createPair` doesn't require
   either token to already be deployed.
2. The very first `_update()` call this token ever makes — the mint inside
   its own `initialize()`, since `from == address(0) != factory` — finds
   that pair and calls straight into `_activatePoolIfFound()`. If the
   attacker won the race in step 1, `pair` gets set, and
   `_maybeAutoConfigurePlatformTax` fires using this factory's **live**
   globals, before `createCurveToken()` has even reached the line that
   populates `curves[token]`.
3. If the attacker didn't win that race, the same thing happens later, for
   free, the moment *anyone* calls `sell()` on the curve — `sell()`'s
   `transferFrom(msg.sender, address(this), tokenAmountIn)` has
   `from == msg.sender != factory`, so it re-triggers the same detection
   attempt on every single sell, for the entire life of the curve.

Either way, `CustomToken.pair` is now permanently non-zero. When the curve
later actually crosses `poolSeedTargetWei` and `_doGraduate` runs:

```solidity
// CustomBondingCurveFactory.sol:581 (_doGraduate)
router.addLiquidityETH{value: ethForPool}(...);   // succeeds -- real ETH/tokens really do reach the real, correct pair
pair = IUniswapV2FactoryMinimal(router.factory()).getPair(token, router.WETH());
pairOf[token] = pair;
CustomToken(payable(token)).setPair(pair);        // REVERTS: PairAlreadySet
```

`setPair()` unconditionally reverts once `pair` is non-zero, with no reset
path anywhere in `CustomToken.sol`. Because Solidity reverts unwind the
*entire* call — including the `addLiquidityETH` external call's effects —
nothing is stolen or stranded mid-flight: the whole `_doGraduate` attempt
rolls back atomically, `curve.realEthReserve` is untouched, and `graduate()`
(or `buy()`'s inline attempt) can be called again... and will revert again,
forever. There is no admin override, no rescue function, and no retry path
in this contract that can un-stick a curve once this has happened. The
curve is permanently unable to graduate. Sellers can still exit via
`sell()` (it never depends on `pair`), so this isn't a fund-drain — but it
permanently defeats the one thing this whole factory exists to eventually
do: seed a real, LP-locked pool.

Worth being direct about the blast radius: this isn't a single edge case to
patch around, it's exploitable against *every* curve this factory will ever
create, by *anyone*, for the cost of one `createPair` call, and it can
happen completely by accident (a pair-sniping bot with no idea this factory
even exists) as easily as it can happen deliberately.

**Recommendation:** Stop this factory from being usable as an
`ITokenFactoryTaxDefaults` implementer at all — that's the only thing
standing between "an independently-existing pool is harmless" (the
`CustomTokenFactory` case this mechanism was actually built for) and "an
independently-existing pool permanently bricks graduation" (this factory's
case). Concretely: replace the ten individual public getters this factory
happens to share with `ITokenFactoryTaxDefaults`
(`platformFeeWallet`/`feeBps`/`priceFeed`/`graduationTargetUsd`/
`maxOracleStaleness`/`rewardsDistributor`/`rewardBps`/
`creatorRewardsDistributor`/`creatorRewardBps`/`feeWalletDistributor`) with
private/internal state plus a single combined view (e.g. `taxDefaults()`
returning all ten as a tuple) — the same shape this contract already uses
for `curveTaxConfig()`'s per-curve snapshot. Once none of those individual
selectors exist on this contract, `ITokenFactoryTaxDefaults(factory).feeBps()`
reverts immediately (no matching function, no fallback), which — because
it's the very first call `_activatePoolIfFound()` makes after tentatively
writing `pair = detectedPair` — rolls back that write too, in the same
revert. That closes both halves of the bug (the pair hijack and the
wrong-tax-config hijack) in one fix, requires touching nothing in
`CustomToken.sol`, and has zero effect on legitimate post-graduation
behavior (once this factory's own `setPair()` call succeeds, `pair != 0`
permanently disables `_activatePoolIfFound` from ever running again on that
token anyway). `router()` doesn't need to move — it's never called by
`CustomToken`'s own activation path, only `LaunchedToken`'s per
`ITokenFactoryTaxDefaults.sol`'s own comment — but there's no harm in
folding it into the same combined view for consistency.

As a cheap companion (not a substitute), consider exposing a view like
`isGraduationBlocked(address token)` returning
`CustomToken(token).pair() != address(0) && !curveState(token).graduated`,
purely so this failure mode is instantly visible to monitoring/front-end
code instead of silently manifesting as `graduate()` reverting with a
generic reason.

**This almost certainly also affects the already-shipped, already-audited
`BondingCurveFactory.sol`.** `ITokenFactoryTaxDefaults.sol`'s own doc
comment says it's used by *both* `CustomToken._maybeAutoConfigurePlatformTax`
*and* `LaunchedToken._maybeAutoActivateTax` — and `BondingCurveFactory.sol`
exposes the identical eleven-function surface (I re-checked its source
directly: `router`, `feeBps`, `platformFeeWallet`, `priceFeed`,
`graduationTargetUsd`, `maxOracleStaleness`, `rewardsDistributor`,
`rewardBps`, `creatorRewardsDistributor`, `creatorRewardBps`,
`feeWalletDistributor` are all present, all public, all matching). That
contract's own prior audit (`AUDIT-BondingCurveFactory.md`) didn't examine
`LaunchedToken` for an equivalent independent-activation mechanic, so this
gap likely slipped through there too. This is scoped out of the current
audit (you asked specifically about `CustomBondingCurveFactory.sol`), but I
think it needs the same look before either contract goes live — happy to
do that pass next if useful.

---

### 2. LOW — `tokenImplementation_` isn't verified to actually be a `CustomToken` at construction time

```solidity
// CustomBondingCurveFactory.sol constructor
require(tokenImplementation_ != address(0), "CustomBondingCurveFactory: invalid token implementation");
```

Only checks non-zero. If a deploy script accidentally points this at a
`LaunchedToken` implementation (or any other contract) instead of a
`CustomToken` one, every `createCurveToken()` call fails at the
`CustomToken(payable(token)).initialize(...)` call — `LaunchedToken`'s
`initialize()` takes a different, shorter argument list, so the call either
reverts outright (safe, loud, no funds ever move) or — if some other
contract happens to expose a same-shaped `initialize()` by coincidence —
succeeds while doing something unintended, e.g. because a colliding
function selector resolves to different validation on a different token
type. The realistic failure mode is "every launch reverts and this is
noticed on the first test transaction," not silent fund risk, so this is
Low rather than higher. **Recommendation:** an off-chain deploy-time sanity
check is enough — e.g. call `MAX_TOTAL_BPS()` on `tokenImplementation_`
right after deploying it and assert it returns `500`, before ever wiring it
into this factory's constructor.

---

### 3. INFORMATIONAL — This factory deliberately does not require `platformFeeWallet`/`priceFeed` to be configured before a curve can launch, unlike `BondingCurveFactory`

`BondingCurveFactory.createCurveToken` hard-requires both
(`platformFeeWallet != address(0)` and `priceFeed != address(0)`), mirroring
`TokenFactory`'s mandatory-at-launch convention. This contract's
`createCurveToken` has no equivalent requirement — leaving either unset
simply means the eventual `configurePlatformTax()` call records a
permanently-inactive platform tax for that curve
(`platformTaxActive = feeBps_ > 0 && feeWallet_ != address(0)` inside
`CustomToken._applyPlatformTaxConfig`), same as `CustomTokenFactory`'s own
`createCustomToken` already does. This is an intentional design choice —
this contract mirrors `CustomTokenFactory`'s convention specifically, not
`BondingCurveFactory`'s/`TokenFactory`'s — recorded here so it reads as a
decision, not an inconsistency someone notices later and "fixes" by
accident.

---

## What's already solid (verified, not assumed)

- **Every economic and tax parameter is snapshotted per curve at creation**,
  exactly like `BondingCurveFactory`'s post-audit design:
  `curveFeeBps`, `poolSeedTargetWei`, and all seven `tax*` fields are copied
  into the `Curve` struct once, at `createCurveToken()` time, and
  `_doGraduate` reads only the snapshot, never the live globals. A
  `setTaxDefaults()`/`setCurveFeeBps()` call after a curve exists cannot
  retroactively change what that curve graduates under.
- **Checks-effects-interactions is intact everywhere ETH or tokens move**:
  `curve.graduated = true` and `curve.realEthReserve = 0` are both written
  in `_doGraduate` *before* the `addLiquidityETH` external call; `sell()`
  updates `curve.tokensRemaining`/`curve.realEthReserve` before pulling
  tokens or paying out ETH; `_executeBuy` updates curve state before the
  fee distribution and token transfer.
- **Non-reverting fee distribution** (`_distributeEthFee`) is built in from
  the start here, not retrofitted — a `feeTreasury`/`rewardsDistributor`
  that rejects ETH can never block a trade; the undelivered amount is
  tracked in `strandedFees` and recoverable via `rescueStrandedFees`.
- **The balance invariant check** (`IERC20(token).balanceOf(address(this)) >=
  curve.tokensRemaining + (curve.totalSupply - curve.curveSupply)`) is
  present after both buys and sells, same as `BondingCurveFactory`.
- **`rescueToken` correctly refuses to touch a curve's own token** (gated on
  `creatorOf[token] == address(0)`), so the admin rescue surface can't be
  used to pull a live or graduated curve's own tracked balance.
- **LP always locks to the curve's original creator**, recorded at creation
  time, via `_doGraduate`'s `locker.lock(pair, curve.creator, ...)` — never
  to whoever happens to call `graduate()`.
- **This factory correctly relies on `CustomToken.initialize()`'s own
  validation** (the 5%-per-side `MAX_TOTAL_BPS` cap, the
  marketing-wallet-required-if-marketingBps-set check) rather than
  duplicating it — consistent with how `CustomTokenFactory` itself doesn't
  duplicate that validation either. An invalid `buyFees_`/`sellFees_`
  combination reverts the whole transaction, clone included; nothing is
  left half-created.
- **The `factory_ == mintTo_ == address(this)` wiring is correct and
  necessary**: it's specifically what makes `CustomToken._update`'s
  `from == factory` guard skip independent-pool-detection on every transfer
  this factory itself originates (buy payouts, and the liquidity-seeding
  transfer inside `_doGraduate`) — the same pattern
  `CustomTokenFactory._seedLiquidityAndBuyIn` already relies on for its own
  atomic launch path. (This is also *exactly* the mechanism Finding 1
  exploits from the other direction — the guard only helps against
  transfers this factory originates; it does nothing against a transfer a
  third party originates once an independent pool already exists.)

## Test coverage notes

`CustomBondingCurveFactory.test.js` (delivered alongside the contract)
covers curve creation with custom fees, the zero-fee equivalence case,
`initialize()`'s own validation bubbling up correctly, the two-call
graduation wiring landing the right snapshotted values, LP locking through
this factory's own locker, and the optional-platform-config behavior from
Finding 3. It does **not** yet cover Finding 1 — that's the natural next
addition once a fix lands: a test that has a `MockRouter`-backed "attacker"
call the mock DEX factory's pair-creation function for a predicted curve
token address before `createCurveToken()` runs, then confirms graduation no
longer reverts after the fix (and does, reproducibly, before it). I'd
recommend writing that regression test as part of applying the fix, the
same way each finding in `AUDIT-BondingCurveFactory.md` shipped with its
own targeted test.

**Not compiled or run in this environment** — no local Hardhat/solc
toolchain or the full OpenZeppelin/CustomToken/LiquidityLocker dependency
tree available here. Every finding above was traced by hand against the
actual, complete source of `CustomToken.sol`, `CustomTokenFactory.sol`, and
`ITokenFactoryTaxDefaults.sol` rather than assumed — Finding 1 in particular
was confirmed by checking each of `ITokenFactoryTaxDefaults`'s eleven
function signatures individually against this contract's own state
variable declarations, not inferred generally. You'll still want to run
`npx hardhat test` yourself, and ideally add the front-running regression
test described above, before treating this as deploy-ready.
