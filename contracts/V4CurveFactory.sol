// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

import {V4PoolLauncher} from "./V4PoolLauncher.sol";
import {V4LaunchedToken} from "./V4LaunchedToken.sol";
import {V4CustomToken} from "./V4CustomToken.sol";
import {V4TaxHook} from "./V4TaxHook.sol";
import {V4LiquidityCompounder} from "./V4LiquidityCompounder.sol";
import {V4IAggregatorV3} from "./interfaces/V4IAggregatorV3.sol";

/// @dev ETH intake on the platform distributors (see V4FeeWalletDistributor.depositFee
/// and V4CreatorRewardsDistributor.depositFor).
interface IV4FeeDeposit {
    function depositFee() external payable;
}

interface IV4CreatorDeposit {
    function depositFor(address token) external payable;
}

/// @title V4CurveFactory
/// @notice V4's bonding-curve launches: the counterpart of V2's
/// BondingCurveFactory (plain token) AND CustomBondingCurveFactory (custom-tax
/// token), in one contract. The curve mechanics are V2's, unchanged: a creator
/// deploys a token with no upfront ETH, the whole supply mints to this
/// factory, `curveSupplyBps` of it (80% default) trades against a pump.fun-style
/// constant-product curve with virtual reserves, and once the curve's real ETH
/// crosses `poolSeedTargetWei` it GRADUATES.
///
/// What changes is graduation. Instead of adding V2 liquidity, graduation now
/// seeds a V4 pool: this contract initializes the (ETH, token) pool on the
/// shared V4TaxHook at exactly the curve's final tokens : ETH ratio (a buy never takes the real
/// reserve past the target: the buy that reaches it is clipped and the rest refunded), snapshots
/// the platform tax terms (as they were when the curve was CREATED) into the
/// hook, attaches the creator's custom fee split when the token is a custom
/// one, and hands the whole remaining token balance plus every wei of real ETH
/// to the V4LiquidityLocker, which locks the full-range position to the
/// ORIGINAL creator for the lpLockDuration in force when the curve was created (snapshotted with the tax
/// terms, so a later change of the setting never touches a curve that is already trading). After that the token trades on the V4
/// pool through V4SwapRouter like any other V4 launch.
///
/// Because the tax lives in the pool's hook, curve trades are never taxed and
/// a custom token needs no "curve managed" flag: its fees simply do not exist
/// until its pool does.
///
/// Curve-phase trade fees (curveFeeBps of the ETH on every buy and sell) follow
/// the same route as the pool's tax, so a token pays one 1% fee from its first
/// curve buy until the pool's market-cap target switches it off: the creator's
/// share (creatorRewardBps / feeBps of the snapshotted terms, 10% by default)
/// goes to the creator-rewards distributor, the rest to the fee-wallet
/// distributor (half to the fee wallet, half to the platform-token buyback).
/// The platform rewards distributor takes NO part of the trade fee; it only
/// receives its half of the flat launch fee (split 50/50 with the treasury).
/// All recipients are read from V4TokenFactory (the tax source). A recipient that
/// rejects ETH, or burns gas, never blocks a trade: each fee transfer is
/// gas-capped and a failed one is parked in strandedFees for the owner to
/// recover. Pausing stops everything that puts new ETH on a curve (buy, launching
/// a curve, the creator buy-in); sell() is never pausable and graduate() stays open.
///
/// Gasless launches go through the platform's V4LaunchRelay (see V4PoolLauncher
/// _creator): the relay verifies the creator's signature, keeps the launch fee
/// itself, and calls the ordinary createCurveToken / createCustomCurveToken with the
/// creator's address appended, so those calls carry only the creator's buy-in.
contract V4CurveFactory is V4PoolLauncher, Pausable {
    using SafeERC20 for IERC20;

    address public immutable plainTokenImplementation;
    address public immutable customTokenImplementation;
    V4LiquidityCompounder public immutable compounder;

    uint256 public curveLaunchFee;
    uint256 public curveFeeBps = 100; // 1.00% of the ETH leg of every curve buy and sell
    uint256 public curveSupplyBps = 8_000; // 80% of supply trades on the curve
    uint256 public virtualEthReserveDefault = 3 ether;
    uint256 public virtualTokenReserveBps = 8_000;
    uint256 public poolSeedTargetWei = 1.5 ether;
    uint256 public constant MAX_CURVE_FEE_BPS = 2_000;
    /// @dev Gas given to a fee recipient. Enough for a Safe, a splitter or the
    /// platform distributor's receive(); bounded so a recipient that burns gas
    /// cannot turn every curve trade (sell included) into a gas-limit-sized one.
    uint256 public constant FEE_CALL_GAS = 300_000;
    /// @dev Same name / symbol bounds as V4TokenFactory and V4CustomTokenFactory.
    uint256 private constant MAX_NAME_BYTES = 128;
    uint256 private constant MAX_SYMBOL_BYTES = 32;
    /// @notice Ceiling on the flat curve launch fee (same as V4TokenFactory and V4CustomTokenFactory).
    uint256 public constant MAX_LAUNCH_FEE = 1 ether;
    /// @dev Gas a buy must still have when it crosses the graduation target. Graduation (pool
    /// creation, hook set-up, locking) runs inside a try/catch; without this floor a caller could give
    /// the buy just enough gas for the try to run out of gas and be swallowed, leaving the curve
    /// at its target and ungraduated. Measured need: about 0.82M gas for the heaviest case (custom token, every
    /// fee leg), so the floor leaves a margin of about 60%.
    uint256 private constant GRADUATION_GAS_RESERVE = 1_300_000;
    /// @dev Gas for each read of the price feed (same bound the hook uses).
    uint256 private constant FEED_CALL_GAS = 200_000;
    uint256 private constant MAX_FEED_DECIMALS = 36;

    struct Curve {
        address creator;
        uint256 totalSupply;
        uint256 curveSupply;
        uint256 tokensRemaining;
        uint256 virtualEthReserve;
        uint256 virtualTokenReserve;
        uint256 realEthReserve;
        uint256 poolSeedTargetWei;
        uint256 curveFeeBps;
        bool graduated;
        bool isCustom;
        uint64 lockDuration; // LP lock seconds, snapshotted at creation (see _storeTerms)
        uint256 createdAt;
        TaxTerms terms; // platform tax terms, snapshotted at creation
        V4TaxHook.CustomFees fees; // creator split, custom curves only
    }

    mapping(address => Curve) private curves;
    address[] private _tokenList;
    mapping(address => address[]) private _tokensByCreator;

    /// @notice ETH a fee recipient rejected; recoverable by the owner.
    uint256 public strandedFees;
    /// @notice Sum of every live curve's realEthReserve, so stray ETH can be
    /// told apart from curve funds.
    uint256 public totalCurveReserveEth;

    struct SellQuote {
        uint256 ethOutGross;
        uint256 feeAmount;
        uint256 netEthOut;
    }

    event CurveTokenCreated(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        uint256 totalSupply,
        uint256 curveSupply,
        uint256 virtualEthReserve,
        uint256 virtualTokenReserve,
        uint256 poolSeedTargetWei
    );
    /// @dev Emitted right after CurveTokenCreated for custom-tax curves only.
    event CustomCurveConfigured(
        address indexed token, address marketingWallet, V4CustomToken.FeeSet buyFees, V4CustomToken.FeeSet sellFees
    );
    // Rarely-hit guards use custom errors: this contract is within a few hundred bytes of the
    // 24,576-byte limit. Messages the UI, relayer or integrators match on stay as strings.
    error InvalidImplementation();
    error InvalidCompounder();
    error BalanceInvariant();
    error CurveSupplyZero();
    error ExceedsRealReserve();
    error PayoutFailed();
    error NothingToGraduate();
    error FeeAboveCeiling();
    error BpsOutOfRange();
    error VirtualEthZero();
    error TargetZero();
    error RescueFailed();
    error CompounderNotSet();

    event CreatorBought(address indexed token, address indexed creator, uint256 ethIn, uint256 tokensOut);
    event CurveBought(address indexed token, address indexed buyer, uint256 ethIn, uint256 feeAmount, uint256 tokensOut, uint256 realEthReserveAfter);
    event CurveSold(address indexed token, address indexed seller, uint256 tokensIn, uint256 feeAmount, uint256 ethOut, uint256 realEthReserveAfter);
    event CurveGraduated(
        address indexed token,
        bytes32 indexed poolId,
        uint256 ethAdded,
        uint256 tokensAdded,
        uint256 liquidity,
        uint256 unlockTime,
        uint256 lockId
    );
    event FeeTransferFailed(address indexed recipient, uint256 amount);
    event StrandedFeesRescued(address indexed to, uint256 amount);
    event StrayEthRescued(address indexed to, uint256 amount);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    event CurveFeeBpsUpdated(uint256 newBps);
    event CurveSupplyBpsUpdated(uint256 newBps);
    event VirtualEthReserveDefaultUpdated(uint256 newDefault);
    event VirtualTokenReserveBpsUpdated(uint256 newBps);
    event PoolSeedTargetUpdated(uint256 newTarget);
    event CurveLaunchFeeUpdated(uint256 newFee);

    constructor(
        address plainImpl_,
        address customImpl_,
        address taxSource_,
        address compounder_,
        uint256 curveLaunchFee_,
        uint256 lpLockDuration_
    ) V4PoolLauncher(taxSource_, lpLockDuration_) {
        if (plainImpl_ == address(0) || customImpl_ == address(0)) revert InvalidImplementation();
        if (compounder_ == address(0)) revert InvalidCompounder();
        _checkLaunchFee(curveLaunchFee_);
        plainTokenImplementation = plainImpl_;
        customTokenImplementation = customImpl_;
        compounder = V4LiquidityCompounder(payable(compounder_));
        curveLaunchFee = curveLaunchFee_;
    }

    /// @dev The locker refunds seed rounding ETH here during graduation.
    receive() external payable {
        require(msg.sender == address(locker), "V4CurveFactory: unexpected ETH");
    }

    /// @dev The curve of a token this factory launched, or a revert.
    function _live(address token) private view returns (Curve storage curve) {
        curve = curves[token];
        require(curve.totalSupply > 0, "V4CurveFactory: unknown curve");
    }

    /// @dev The factory must always hold every token the curve has not sold plus the reserve.
    function _checkCover(address token, Curve storage curve) private view {
        if (IERC20(token).balanceOf(address(this)) < curve.tokensRemaining + (curve.totalSupply - curve.curveSupply)) {
            revert BalanceInvariant();
        }
    }

    function _checkLaunchFee(uint256 fee) private pure {
        require(fee <= MAX_LAUNCH_FEE, "V4CurveFactory: launch fee above ceiling");
    }

    function _deriveTokenSalt(address creator_, uint256 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(creator_, salt));
    }

    // ---------------------------------------------------------------
    // Quotes (V2 maths, unchanged)
    // ---------------------------------------------------------------

    function _quoteBuy(Curve storage curve, uint256 ethIn) private view returns (uint256 tokensOut, uint256 feeAmount, uint256 netEthIn) {
        feeAmount = (ethIn * curve.curveFeeBps) / 10_000;
        netEthIn = ethIn - feeAmount;
        uint256 effEth = curve.virtualEthReserve + curve.realEthReserve;
        uint256 effToken = curve.virtualTokenReserve + curve.tokensRemaining;
        tokensOut = (netEthIn * effToken) / (effEth + netEthIn);
    }

    function _quoteSell(Curve storage curve, uint256 tokenAmountIn) private view returns (SellQuote memory quote) {
        uint256 effEth = curve.virtualEthReserve + curve.realEthReserve;
        uint256 effToken = curve.virtualTokenReserve + curve.tokensRemaining;
        quote.ethOutGross = (tokenAmountIn * effEth) / (effToken + tokenAmountIn);
        quote.feeAmount = (quote.ethOutGross * curve.curveFeeBps) / 10_000;
        quote.netEthOut = quote.ethOutGross - quote.feeAmount;
    }

    /// @dev Curve trade fee, routed like the pool's tax (see the contract notes):
    /// creator share to the creator-rewards distributor, the rest to the
    /// fee-wallet distributor, or straight to the platform fee wallet when no
    /// fee-wallet distributor is set. A failing recipient never reverts the
    /// trade (so sell() always works), the ETH is parked instead.
    function _distributeTradeFee(address token, uint256 amount) private {
        if (amount == 0) return;
        TaxTerms storage t = curves[token].terms;
        uint256 creatorCut;
        address crd = taxSource.creatorRewardsDistributor();
        if (crd != address(0) && t.feeBps > 0 && t.creatorRewardBps > 0) {
            creatorCut = (amount * t.creatorRewardBps) / t.feeBps;
            if (creatorCut > 0) {
                _callOrStrand(crd, creatorCut, abi.encodeCall(IV4CreatorDeposit.depositFor, (token)));
            }
        }
        uint256 rest = amount - creatorCut;
        if (rest == 0) return;
        address fwd = taxSource.feeWalletDistributor();
        if (fwd != address(0)) _callOrStrand(fwd, rest, abi.encodeCall(IV4FeeDeposit.depositFee, ()));
        else _sendOrStrand(t.feeWallet, rest);
    }

    /// @dev The flat launch fee: 50/50 between the treasury and the platform
    /// rewards distributor when one is set (the distributor's only income from
    /// this contract), all to the treasury otherwise. Same rule as V4TokenFactory.
    function _distributeEthFee(uint256 amount) private {
        if (amount == 0) return;
        address rd = taxSource.rewardsDistributor();
        address treasury = taxSource.feeTreasury();
        if (rd != address(0)) {
            uint256 toRewards = amount / 2;
            uint256 toTreasury = amount - toRewards;
            if (toRewards > 0) _sendOrStrand(rd, toRewards);
            _sendOrStrand(treasury, toTreasury);
        } else {
            _sendOrStrand(treasury, amount);
        }
    }

    function _sendOrStrand(address to, uint256 amount) private {
        _callOrStrand(to, amount, "");
    }

    function _callOrStrand(address to, uint256 amount, bytes memory data) private {
        (bool ok,) = to.call{value: amount, gas: FEE_CALL_GAS}(data);
        if (!ok) {
            strandedFees += amount;
            emit FeeTransferFailed(to, amount);
        }
    }

    /// @dev A buy is clipped at the graduation target: it takes only the ETH (fee included) that brings the
    /// curve's real reserve to its target, and the caller gets the rest back. A buy that could overshoot
    /// would open the pool at a price the curve never quoted (see the audit report, CF-1); 0 means the
    /// curve is already at its target and waiting to graduate.
    function _clipToTarget(Curve storage curve, uint256 ethIn) private view returns (uint256) {
        uint256 target = curve.poolSeedTargetWei;
        if (curve.realEthReserve >= target) return 0;
        uint256 keep = 10_000 - curve.curveFeeBps; // curveFeeBps <= 20%, so never zero
        uint256 maxGross = ((target - curve.realEthReserve) * 10_000 + keep - 1) / keep; // net of the fee reaches the room
        return ethIn > maxGross ? maxGross : ethIn;
    }

    function _executeBuy(address token, Curve storage curve, address recipient, uint256 ethIn, uint256 minTokensOut)
        private
        returns (uint256 tokensOut, uint256 feeAmount, uint256 ethUsed)
    {
        ethUsed = _clipToTarget(curve, ethIn);
        require(ethUsed > 0, "V4CurveFactory: target reached, graduate the curve");
        uint256 netEthIn;
        (tokensOut, feeAmount, netEthIn) = _quoteBuy(curve, ethUsed);
        require(tokensOut > 0, "V4CurveFactory: zero tokens out");
        require(tokensOut <= curve.tokensRemaining, "V4CurveFactory: exceeds curve supply");
        require(tokensOut >= minTokensOut, "V4CurveFactory: slippage");

        curve.realEthReserve += netEthIn;
        totalCurveReserveEth += netEthIn;
        curve.tokensRemaining -= tokensOut;

        _distributeTradeFee(token, feeAmount);
        IERC20(token).safeTransfer(recipient, tokensOut);

        _checkCover(token, curve);
    }

    /// @dev Graduation is attempted inside a try/catch so a failing graduation never blocks the buy that
    /// reached the target (graduate() is the fallback). The gas floor makes sure the attempt is given
    /// enough gas to finish: a buy that cannot afford it reverts instead of silently skipping it.
    function _tryGraduate(address token) private {
        require(gasleft() >= GRADUATION_GAS_RESERVE, "V4CurveFactory: not enough gas to graduate");
        try this._attemptGraduate(token) returns (bytes32) {} catch {}
    }

    // ---------------------------------------------------------------
    // Launch
    // ---------------------------------------------------------------

    /// @notice Plain-token curve. msg.value = curveLaunchFee + creatorBuyEthAmount.
    function createCurveToken(
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        uint256 creatorBuyEthAmount,
        uint256 minCreatorTokensOut,
        uint256 salt
    ) external payable nonReentrant whenNotPaused returns (address token, uint256 creatorTokensBought) {
        _checkLaunch(name_, symbol_, totalSupply_, creatorBuyEthAmount);
        token = Clones.cloneDeterministic(plainTokenImplementation, _deriveTokenSalt(_creator(), salt));
        V4LaunchedToken(token).initialize(name_, symbol_, totalSupply_, _creator(), address(this), address(this));
        V4TaxHook.CustomFees memory none;
        _registerCurve(token, name_, symbol_, totalSupply_, false, none);
        creatorTokensBought = _creatorBuy(token, totalSupply_, creatorBuyEthAmount, minCreatorTokensOut);
    }

    /// @notice Custom-tax curve: same curve, but the token is a V4CustomToken
    /// whose buy/sell fee split (<= 5% per side) takes effect on the V4 pool the
    /// curve graduates into. msg.value = curveLaunchFee + creatorBuyEthAmount.
    function createCustomCurveToken(
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        V4CustomToken.FeeSet calldata buyFees,
        V4CustomToken.FeeSet calldata sellFees,
        V4CustomToken.ReflectionPayout calldata payout,
        address marketingWallet,
        uint256 creatorBuyEthAmount,
        uint256 minCreatorTokensOut,
        uint256 salt
    ) external payable nonReentrant whenNotPaused returns (address token, uint256 creatorTokensBought) {
        _checkLaunch(name_, symbol_, totalSupply_, creatorBuyEthAmount);
        token = Clones.cloneDeterministic(customTokenImplementation, _deriveTokenSalt(_creator(), salt));
        V4CustomToken(token).initialize(
            name_, symbol_, totalSupply_, _creator(), address(this), address(this), marketingWallet, buyFees, sellFees, _infra()
        );
        if (payout.mode != 0) V4CustomToken(token).setReflectionPayout(payout);
        else require(payout.token == address(0), "V4CurveFactory: payout token set for in-kind payout");
        V4TaxHook.CustomFees memory f = V4TaxHook.CustomFees({
            buyReflectionBps: buyFees.reflectionBps,
            buyMarketingBps: buyFees.marketingBps,
            buyLiquidityBps: buyFees.liquidityBps,
            buyBurnBps: buyFees.burnBps,
            sellReflectionBps: sellFees.reflectionBps,
            sellMarketingBps: sellFees.marketingBps,
            sellLiquidityBps: sellFees.liquidityBps,
            sellBurnBps: sellFees.burnBps
        });
        // The hook only enforces the 5% cap and the compounder when the pool
        // is configured, at graduation -- by then it would be too late to
        // reject the launch, so check both now.
        if ((buyFees.liquidityBps != 0 || sellFees.liquidityBps != 0) && hook.liquidityCompounder() == address(0)) {
            revert CompounderNotSet();
        }
        _registerCurve(token, name_, symbol_, totalSupply_, true, f);
        emit CustomCurveConfigured(token, marketingWallet, buyFees, sellFees);
        creatorTokensBought = _creatorBuy(token, totalSupply_, creatorBuyEthAmount, minCreatorTokensOut);
    }

    function _checkLaunch(string calldata name_, string calldata symbol_, uint256 totalSupply_, uint256 creatorBuyEthAmount)
        private
        view
    {
        uint256 n = bytes(name_).length;
        uint256 y = bytes(symbol_).length;
        require(n > 0, "V4CurveFactory: name required");
        require(y > 0, "V4CurveFactory: symbol required");
        require(n <= MAX_NAME_BYTES, "V4CurveFactory: name too long");
        require(y <= MAX_SYMBOL_BYTES, "V4CurveFactory: symbol too long");
        require(totalSupply_ > 0, "V4CurveFactory: supply must be > 0");
        require(msg.value == _feeDue(curveLaunchFee) + creatorBuyEthAmount, "V4CurveFactory: incorrect ETH sent");
        TaxTerms memory t = _currentTerms();
        _requireTermsReady(t);
        _requireReachableTarget(totalSupply_);
        // The curve-phase fee runs until graduation and the pool's tax until the
        // market-cap target, so a curve that would already graduate AT or ABOVE
        // that target would charge a fee on a token the platform tax says is done.
        (uint256 usd, bool known) = _projectedGraduationUsd(t, totalSupply_);
        require(!known || usd < t.graduationTargetUsd, "V4CurveFactory: curve would graduate above the platform tax target");
    }

    /// @notice The market cap, in whole USD, a curve for `totalSupply_` would have
    /// the moment it graduates, under the current curve settings and the platform's
    /// price feed. `known` is false when the feed cannot be read (dead, stale,
    /// malformed), in which case launches are not blocked on it (the same fail-open
    /// rule the hook uses). The pool's own market cap is price x total supply, so
    /// this is the pool's opening price: target ETH over the tokens it is seeded with.
    function projectedGraduationMarketCapUsd(uint256 totalSupply_) external view returns (uint256 usd, bool known) {
        return _projectedGraduationUsd(_currentTerms(), totalSupply_);
    }

    function _projectedGraduationUsd(TaxTerms memory t, uint256 totalSupply_) private view returns (uint256 usd, bool known) {
        uint256 curveSupply = (totalSupply_ * curveSupplyBps) / 10_000;
        uint256 virtualToken = (totalSupply_ * virtualTokenReserveBps) / 10_000;
        // Tokens left on the curve when its real ETH reaches the target: the
        // constant-product point (rounded up, i.e. the curve's way).
        uint256 effEthEnd = virtualEthReserveDefault + poolSeedTargetWei;
        uint256 k = virtualEthReserveDefault * (virtualToken + curveSupply);
        uint256 effTokenEnd = (k + effEthEnd - 1) / effEthEnd;
        uint256 remaining = effTokenEnd > virtualToken ? effTokenEnd - virtualToken : 0;
        uint256 poolTokens = remaining + (totalSupply_ - curveSupply);
        if (poolTokens == 0) return (0, false);
        uint256 capWei = (poolSeedTargetWei * totalSupply_) / poolTokens;

        (bool ok, uint256 answer, uint256 decimals_) = _readFeed(t.priceFeed, t.maxOracleStaleness);
        if (!ok) return (0, false);
        return ((capWei * answer) / (1e18 * (10 ** decimals_)), true);
    }

    /// @dev Latest price and decimals via bounded raw staticcalls, as the hook does:
    /// anything that is not a clean, fresh, positive answer counts as unreadable.
    function _readFeed(address feed, uint256 maxStaleness) private view returns (bool ok, uint256 answer, uint256 decimals_) {
        if (feed.code.length == 0) return (false, 0, 0);
        bytes4 roundSel = V4IAggregatorV3.latestRoundData.selector;
        bytes4 decSel = V4IAggregatorV3.decimals.selector;
        uint256 callGas = FEED_CALL_GAS;
        int256 raw;
        uint256 updatedAt;
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, roundSel)
            ok := staticcall(callGas, feed, m, 4, m, 160)
            if lt(returndatasize(), 160) { ok := 0 }
            if ok {
                raw := mload(add(m, 32))
                updatedAt := mload(add(m, 96))
            }
        }
        if (!ok || raw <= 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > maxStaleness) return (false, 0, 0);
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, decSel)
            ok := staticcall(callGas, feed, m, 4, m, 32)
            if lt(returndatasize(), 32) { ok := 0 }
            if ok { decimals_ := mload(m) }
        }
        if (!ok || decimals_ > MAX_FEED_DECIMALS) return (false, 0, 0);
        answer = uint256(raw);
    }

    /// @dev A curve can take at most virtualEth * curveSupply / virtualToken of
    /// real ETH (the amount that sells every curve token). A graduation target at
    /// or above that can never be met: the curve would sit open forever and
    /// buyers could only leave by selling back at a loss to the fees. Refuse such
    /// a launch instead of creating it.
    function _requireReachableTarget(uint256 totalSupply_) private view {
        uint256 curveSupply = (totalSupply_ * curveSupplyBps) / 10_000;
        uint256 virtualToken = (totalSupply_ * virtualTokenReserveBps) / 10_000;
        require(
            poolSeedTargetWei * virtualToken < virtualEthReserveDefault * curveSupply,
            "V4CurveFactory: graduation target unreachable with the current curve settings"
        );
    }

    /// @dev Everything that never earns reflections on a custom token from day one.
    function _infra() private view returns (address[] memory list) {
        list = new address[](8);
        list[0] = address(poolManager);
        list[1] = address(locker);
        list[2] = address(hook);
        list[3] = address(compounder);
        list[4] = taxSource.rewardsDistributor();
        list[5] = taxSource.creatorRewardsDistributor();
        list[6] = taxSource.feeWalletDistributor();
        list[7] = taxSource.platformFeeWallet();
    }

    function _registerCurve(
        address token,
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        bool isCustom,
        V4TaxHook.CustomFees memory fees
    ) private {
        _initCurveStorage(token, totalSupply_, isCustom);
        _storeTerms(token);
        if (isCustom) _storeFees(token, fees);
        creatorOf[token] = _creator();
        _tokensByCreator[_creator()].push(token);
        _tokenList.push(token);
        _emitCreated(token, name_, symbol_);
    }

    function _initCurveStorage(address token, uint256 totalSupply_, bool isCustom) private {
        uint256 curveSupply = (totalSupply_ * curveSupplyBps) / 10_000;
        if (curveSupply == 0) revert CurveSupplyZero();
        Curve storage curve = curves[token];
        curve.creator = _creator();
        curve.totalSupply = totalSupply_;
        curve.curveSupply = curveSupply;
        curve.tokensRemaining = curveSupply;
        curve.virtualEthReserve = virtualEthReserveDefault;
        curve.virtualTokenReserve = (totalSupply_ * virtualTokenReserveBps) / 10_000;
        curve.poolSeedTargetWei = poolSeedTargetWei;
        curve.curveFeeBps = curveFeeBps;
        curve.createdAt = block.timestamp;
        curve.isCustom = isCustom;
    }

    function _storeTerms(address token) private {
        curves[token].terms = _currentTerms();
        curves[token].lockDuration = uint64(lpLockDuration); // bounded by MAX_LOCK_DURATION
    }

    function _storeFees(address token, V4TaxHook.CustomFees memory f) private {
        curves[token].fees = f;
    }

    function _emitCreated(address token, string calldata name_, string calldata symbol_) private {
        Curve storage c = curves[token];
        emit CurveTokenCreated(
            token, c.creator, name_, symbol_, c.totalSupply, c.curveSupply,
            c.virtualEthReserve, c.virtualTokenReserve, c.poolSeedTargetWei
        );
    }

    /// @dev The optional creator buy-in: an ordinary first buy on the fresh
    /// curve, capped at maxCreatorBuyBps of supply; then the launch fee.
    function _creatorBuy(address token, uint256 totalSupply_, uint256 ethAmount, uint256 minTokensOut)
        private
        returns (uint256 tokensBought)
    {
        Curve storage curve = curves[token];
        if (ethAmount > 0) {
            uint256 ethUsed;
            (tokensBought,, ethUsed) = _executeBuy(token, curve, _creator(), ethAmount, minTokensOut);
            require(
                tokensBought <= (totalSupply_ * maxCreatorBuyBps) / 10_000,
                "V4CurveFactory: creator buy-in exceeds max allowed share of supply"
            );
            emit CreatorBought(token, _creator(), ethUsed, tokensBought);
            _finishBuy(token, curve, _creator(), ethAmount, ethUsed);
        }
        _distributeEthFee(_feeDue(curveLaunchFee));
    }

    // ---------------------------------------------------------------
    // Trading on the curve
    // ---------------------------------------------------------------

    function buy(address token, uint256 minTokensOut) external payable nonReentrant whenNotPaused returns (uint256 tokensOut) {
        Curve storage curve = _live(token);
        require(!curve.graduated, "V4CurveFactory: already graduated");
        require(msg.value > 0, "V4CurveFactory: no ETH sent");

        uint256 feeAmount;
        uint256 ethUsed;
        (tokensOut, feeAmount, ethUsed) = _executeBuy(token, curve, msg.sender, msg.value, minTokensOut);
        _emitBought(token, ethUsed, feeAmount, tokensOut);

        _finishBuy(token, curve, msg.sender, msg.value, ethUsed);
    }

    /// @dev After a buy: graduate if the target is reached, then return the part of the offer that
    /// was past it (see _clipToTarget).
    function _finishBuy(address token, Curve storage curve, address to, uint256 ethIn, uint256 ethUsed) private {
        if (curve.realEthReserve >= curve.poolSeedTargetWei) _tryGraduate(token);
        if (ethIn > ethUsed) _sendEth(to, ethIn - ethUsed);
    }

    function _emitBought(address token, uint256 ethUsed, uint256 feeAmount, uint256 tokensOut) private {
        emit CurveBought(token, msg.sender, ethUsed, feeAmount, tokensOut, curves[token].realEthReserve);
    }

    /// @notice Never pausable: holders can always leave a live curve.
    function sell(address token, uint256 tokenAmountIn, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        Curve storage curve = _live(token);
        require(!curve.graduated, "V4CurveFactory: already graduated");
        require(tokenAmountIn > 0, "V4CurveFactory: zero amount");

        SellQuote memory quote = _quoteSell(curve, tokenAmountIn);
        if (quote.ethOutGross > curve.realEthReserve) revert ExceedsRealReserve();
        require(quote.netEthOut >= minEthOut, "V4CurveFactory: slippage");

        curve.tokensRemaining += tokenAmountIn;
        curve.realEthReserve -= quote.ethOutGross;
        totalCurveReserveEth -= quote.ethOutGross;

        ethOut = _settleSell(token, curve, tokenAmountIn, quote);
    }

    function _settleSell(address token, Curve storage curve, uint256 tokenAmountIn, SellQuote memory quote)
        private
        returns (uint256 ethOut)
    {
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokenAmountIn);
        _checkCover(token, curve);
        _distributeTradeFee(token, quote.feeAmount);
        ethOut = quote.netEthOut;
        (bool sentEth,) = payable(msg.sender).call{value: ethOut}("");
        if (!sentEth) revert PayoutFailed();
        _emitSold(token, tokenAmountIn, quote.feeAmount, ethOut);
    }

    function _emitSold(address token, uint256 tokenAmountIn, uint256 feeAmount, uint256 ethOut) private {
        emit CurveSold(token, msg.sender, tokenAmountIn, feeAmount, ethOut, curves[token].realEthReserve);
    }

    // ---------------------------------------------------------------
    // Graduation: seed the V4 pool
    // ---------------------------------------------------------------

    /// @notice Permissionless once a curve's real ETH has crossed its target:
    /// the guaranteed fallback to buy()'s own best-effort attempt.
    function graduate(address token) external nonReentrant returns (bytes32 poolId) {
        Curve storage curve = _live(token);
        require(!curve.graduated, "V4CurveFactory: already graduated");
        require(curve.realEthReserve >= curve.poolSeedTargetWei, "V4CurveFactory: graduation target not met");
        return _doGraduate(token, curve);
    }

    /// @dev External only so buy() can try/catch it; internal callers only.
    function _attemptGraduate(address token) external returns (bytes32 poolId) {
        require(msg.sender == address(this), "V4CurveFactory: internal only");
        Curve storage curve = curves[token];
        if (curve.totalSupply == 0 || curve.graduated || curve.realEthReserve < curve.poolSeedTargetWei) return bytes32(0);
        return _doGraduate(token, curve);
    }

    /// @dev Flips `graduated` before any external call. Seeds the pool with the
    /// factory's ENTIRE remaining token balance (unsold curve tokens plus the
    /// untouched reserve; only rounding dust the locker hands back is burned) and every wei of real ETH, locks
    /// the position to the ORIGINAL creator, and opts the pool into the
    /// platform tax terms snapshotted when the curve was created.
    function _doGraduate(address token, Curve storage curve) private returns (bytes32 poolId) {
        (uint256 tokensForPool, uint256 ethForPool) = _closeCurve(token, curve);
        if (curve.isCustom) _excludeDistributors(token);
        return _launchPool(token, tokensForPool, ethForPool);
    }

    /// @dev Marks the curve graduated and takes its reserves out of the books
    /// before any external call.
    function _closeCurve(address token, Curve storage curve) private returns (uint256 tokensForPool, uint256 ethForPool) {
        curve.graduated = true;
        tokensForPool = IERC20(token).balanceOf(address(this));
        ethForPool = curve.realEthReserve;
        curve.realEthReserve = 0;
        totalCurveReserveEth -= ethForPool;
        if (tokensForPool == 0 || ethForPool == 0) revert NothingToGraduate();
    }

    function _launchPool(address token, uint256 tokensForPool, uint256 ethForPool) private returns (bytes32 poolId) {
        PoolKey memory key;
        (key, poolId) = _initCurvePool(token, tokensForPool, ethForPool);
        _seedAndAnnounce(key, token, poolId, curves[token].creator, tokensForPool, ethForPool);
    }

    function _initCurvePool(address token, uint256 tokensForPool, uint256 ethForPool)
        private
        returns (PoolKey memory key, bytes32 poolId)
    {
        Curve storage curve = curves[token];
        TaxTerms memory t = curve.terms;
        V4TaxHook.CustomFees memory f = curve.fees;
        return _initPool(token, tokensForPool, ethForPool, t, curve.isCustom, f);
    }

    function _seedAndAnnounce(
        PoolKey memory key,
        address token,
        bytes32 poolId,
        address creator_,
        uint256 tokensForPool,
        uint256 ethForPool
    ) private {
        (uint256 lockId, uint256 liquidity, uint256 ethUsed, uint256 tokenUsed) =
            _seed(key, creator_, tokensForPool, ethForPool, _lockDurationOf(token));
        emit CurveGraduated(token, poolId, ethUsed, tokenUsed, liquidity, block.timestamp + _lockDurationOf(token), lockId);
    }

    /// @dev The LP lock this curve was created under. The owner can change lpLockDuration at any time,
    /// but a curve's buyers were promised the lock that was in force when it was created.
    function _lockDurationOf(address token) private view returns (uint256) {
        return curves[token].lockDuration;
    }

    /// @dev The distributor slots may have changed since the token was
    /// created, so make sure the current ones are on the token's no-reflections
    /// list (the platform tax itself is paid in ETH; this only keeps a distributor that ever
    /// holds the token from sharing in reflections).
    function _excludeDistributors(address token) private {
        address a = taxSource.rewardsDistributor();
        address b = taxSource.creatorRewardsDistributor();
        address c = taxSource.feeWalletDistributor();
        if (a != address(0)) V4CustomToken(token).excludeFromReflections(a);
        if (b != address(0)) V4CustomToken(token).excludeFromReflections(b);
        if (c != address(0)) V4CustomToken(token).excludeFromReflections(c);
    }

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    function quoteBuy(address token, uint256 ethIn) external view returns (uint256 tokensOut, uint256 feeAmount) {
        Curve storage curve = _live(token);
        (tokensOut, feeAmount,) = _quoteBuy(curve, _clipToTarget(curve, ethIn)); // what a buy of ethIn would actually take
    }

    function quoteSell(address token, uint256 tokenAmountIn) external view returns (uint256 ethOut, uint256 feeAmount) {
        Curve storage curve = _live(token);
        SellQuote memory quote = _quoteSell(curve, tokenAmountIn);
        ethOut = quote.netEthOut;
        feeAmount = quote.feeAmount;
    }

    function curveState(address token)
        external
        view
        returns (
            address creator,
            uint256 totalSupply_,
            uint256 curveSupply,
            uint256 tokensRemaining,
            uint256 virtualEthReserve,
            uint256 virtualTokenReserve,
            uint256 realEthReserve,
            uint256 poolSeedTargetWei_,
            uint256 curveFeeBps_,
            bool graduated,
            uint256 createdAt
        )
    {
        Curve storage curve = _live(token);
        return (
            curve.creator,
            curve.totalSupply,
            curve.curveSupply,
            curve.tokensRemaining,
            curve.virtualEthReserve,
            curve.virtualTokenReserve,
            curve.realEthReserve,
            curve.poolSeedTargetWei,
            curve.curveFeeBps,
            curve.graduated,
            curve.createdAt
        );
    }

    /// @notice True for a custom-tax curve (V4CustomToken), false for a plain one.
    function isCustomCurve(address token) external view returns (bool) {
        _live(token);
        return curves[token].isCustom;
    }

    /// @notice The platform tax terms this curve will graduate under.
    function curveTaxConfig(address token) external view returns (TaxTerms memory) {
        _live(token);
        return curves[token].terms;
    }

    function tokensOf(address creator_) external view returns (address[] memory) {
        return _tokensByCreator[creator_];
    }

    function allTokens() external view returns (address[] memory) {
        return _tokenList;
    }

    function predictTokenAddress(address creator_, uint256 salt, bool custom) external view returns (address) {
        return Clones.predictDeterministicAddress(
            custom ? customTokenImplementation : plainTokenImplementation, _deriveTokenSalt(creator_, salt), address(this)
        );
    }

    // ---------------------------------------------------------------
    // Owner settings (apply to curves created afterwards)
    // ---------------------------------------------------------------

    function setCurveFeeBps(uint256 newBps) external onlyOwner {
        if (newBps > MAX_CURVE_FEE_BPS) revert FeeAboveCeiling();
        curveFeeBps = newBps;
        emit CurveFeeBpsUpdated(newBps);
    }

    function setCurveSupplyBps(uint256 newBps) external onlyOwner {
        if (newBps == 0 || newBps > 10_000) revert BpsOutOfRange();
        curveSupplyBps = newBps;
        emit CurveSupplyBpsUpdated(newBps);
    }

    function setVirtualEthReserveDefault(uint256 newDefault) external onlyOwner {
        if (newDefault == 0) revert VirtualEthZero();
        virtualEthReserveDefault = newDefault;
        emit VirtualEthReserveDefaultUpdated(newDefault);
    }

    function setVirtualTokenReserveBps(uint256 newBps) external onlyOwner {
        if (newBps == 0 || newBps > 10_000) revert BpsOutOfRange();
        virtualTokenReserveBps = newBps;
        emit VirtualTokenReserveBpsUpdated(newBps);
    }

    function setPoolSeedTargetWei(uint256 newTarget) external onlyOwner {
        if (newTarget == 0) revert TargetZero();
        poolSeedTargetWei = newTarget;
        emit PoolSeedTargetUpdated(newTarget);
    }

    function setCurveLaunchFee(uint256 newFee) external onlyOwner {
        _checkLaunchFee(newFee);
        curveLaunchFee = newFee;
        emit CurveLaunchFeeUpdated(newFee);
    }

    function rescueStrandedFees(address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "V4CurveFactory: invalid recipient");
        require(amount <= strandedFees, "V4CurveFactory: exceeds stranded fees");
        strandedFees -= amount;
        (bool sent,) = payable(to).call{value: amount}("");
        if (!sent) revert RescueFailed();
        emit StrandedFeesRescued(to, amount);
    }

    /// @notice Sweeps ETH that is neither a tracked stranded fee nor any live
    /// curve's reserve.
    function rescueStrayEth(address to) external onlyOwner nonReentrant returns (uint256 amount) {
        require(to != address(0), "V4CurveFactory: invalid recipient");
        uint256 accountedFor = totalCurveReserveEth + strandedFees;
        require(address(this).balance > accountedFor, "V4CurveFactory: no stray ETH to rescue");
        amount = address(this).balance - accountedFor;
        (bool sent,) = payable(to).call{value: amount}("");
        if (!sent) revert RescueFailed();
        emit StrayEthRescued(to, amount);
    }

    /// @notice Cannot reach any token this factory created as a curve.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "V4CurveFactory: invalid recipient");
        require(creatorOf[token] == address(0), "V4CurveFactory: cannot rescue a curve's own token");
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }
}
