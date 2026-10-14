// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {V4PoolLauncher} from "./V4PoolLauncher.sol";
import {V4CustomToken} from "./V4CustomToken.sol";
import {V4TaxHook} from "./V4TaxHook.sol";
import {V4LiquidityCompounder} from "./V4LiquidityCompounder.sol";

/// @title V4CustomTokenFactory
/// @notice V4's "Custom Tax" launch (the counterpart of V2's CustomTokenFactory):
/// the creator picks separate BUY and SELL fees, each split into reflection /
/// marketing / liquidity / burn and capped at 5.00% per side, plus a marketing
/// wallet. The token is a V4CustomToken; the pool is the usual (ETH, token)
/// V4 pool on the shared V4TaxHook, which carries the creator's split next to
/// the platform's own tax (the platform part switches off at graduation, the
/// creator part never does).
///
/// Always "launch with liquidity": the fees are collected by the pool's hook,
/// so a token with no pool would have nothing to tax. Fees, the locked LP, the
/// optional creator buy-in and the 50/50 fee split work exactly like
/// V4TokenFactory's launch. The platform's tax terms and distributor slots are
/// read from V4TokenFactory (the "tax source"), so they are configured once.
///
/// Gasless launches go through the platform's V4LaunchRelay (see V4PoolLauncher
/// _creator): the relay verifies the creator's signature, keeps the launch fee
/// itself, and calls createCustomToken with the creator's address appended, so
/// that call carries only the liquidity and buy-in ETH.
///
/// Not included (compared with V2): a "deploy token only" option.
contract V4CustomTokenFactory is V4PoolLauncher, IUnlockCallback {
    using SafeERC20 for IERC20;

    address public immutable tokenImplementation;
    V4LiquidityCompounder public immutable compounder;

    /// @notice Hard ceiling on the launch fee (same as V4TokenFactory), so a mistyped or hostile
    /// setLaunchFee can never make launching unaffordable.
    uint256 public constant MAX_LAUNCH_FEE = 1 ether;
    uint256 public constant MAX_NAME_BYTES = 128;
    uint256 public constant MAX_SYMBOL_BYTES = 32;

    uint256 public launchFee;
    uint256 public buyInSlippageBps = 600;
    uint256 public constant MIN_SLIPPAGE_BPS = 500;
    uint256 public constant MAX_SLIPPAGE_BPS = 800;

    address[] private _tokenList;
    mapping(address => address[]) private _tokensByCreator;

    event CustomTokenCreated(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        uint256 totalSupply,
        bytes32 poolId,
        address marketingWallet,
        V4CustomToken.FeeSet buyFees,
        V4CustomToken.FeeSet sellFees
    );
    event CreatorBought(address indexed token, address indexed creator, uint256 ethIn, uint256 tokensOut);
    event LaunchFeeUpdated(uint256 newFee);
    event BuyInSlippageBpsUpdated(uint256 newBps);
    event EthRescued(address indexed to, uint256 amount);
    event TokensRescued(address indexed token, address indexed to, uint256 amount);

    constructor(address tokenImplementation_, address taxSource_, address compounder_, uint256 launchFee_, uint256 lpLockDuration_)
        V4PoolLauncher(taxSource_, lpLockDuration_)
    {
        require(tokenImplementation_ != address(0), "V4CustomTokenFactory: invalid token implementation");
        require(compounder_ != address(0), "V4CustomTokenFactory: invalid compounder");
        tokenImplementation = tokenImplementation_;
        require(launchFee_ <= MAX_LAUNCH_FEE, "V4CustomTokenFactory: launch fee above ceiling");
        compounder = V4LiquidityCompounder(payable(compounder_));
        launchFee = launchFee_;
    }

    /// @dev Only the locker (refunding unused seed ETH) sends ETH here. (The PoolManager is
    /// never paid through this function: swaps settle with `settle{value}` and `take` goes
    /// straight to the recipient.)
    receive() external payable {
        require(msg.sender == address(locker), "V4CustomTokenFactory: unexpected ETH");
    }

    function _checkNameSymbol(string calldata name_, string calldata symbol_) private pure {
        uint256 n = bytes(name_).length;
        uint256 y = bytes(symbol_).length;
        require(n > 0, "V4CustomTokenFactory: name required");
        require(y > 0, "V4CustomTokenFactory: symbol required");
        require(n <= MAX_NAME_BYTES, "V4CustomTokenFactory: name too long");
        require(y <= MAX_SYMBOL_BYTES, "V4CustomTokenFactory: symbol too long");
    }

    function _deriveTokenSalt(address creator_, uint256 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(creator_, salt));
    }

    /// @notice msg.value must equal launchFee + liquidityEthAmount + creatorBuyEthAmount
    /// (a relayed launch carries no launch fee: the relay already holds it).
    function createCustomToken(
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        V4CustomToken.FeeSet calldata buyFees,
        V4CustomToken.FeeSet calldata sellFees,
        V4CustomToken.ReflectionPayout calldata payout,
        address marketingWallet,
        uint256 liquidityEthAmount,
        uint256 creatorBuyEthAmount,
        uint256 minCreatorTokensOut,
        uint256 salt
    ) external payable nonReentrant {
        address token;
        uint256 liquidity;
        uint256 lockId;
        uint256 creatorTokensBought;
        _checkNameSymbol(name_, symbol_);
        // A payout token is only meaningful for mode 2; refuse a stray one rather than ignore it.
        require(payout.mode != 0 || payout.token == address(0), "V4CustomTokenFactory: payout token set for in-kind payout");
        require(totalSupply_ > 0, "V4CustomTokenFactory: supply must be > 0");
        require(liquidityEthAmount > 0, "V4CustomTokenFactory: no ETH sent for liquidity");
        uint256 fee = _feeDue(launchFee);
        require(msg.value >= fee, "V4CustomTokenFactory: launch fee not met");
        require(
            msg.value - fee == liquidityEthAmount + creatorBuyEthAmount,
            "V4CustomTokenFactory: msg.value doesn't match liquidity + buy-in"
        );
        TaxTerms memory terms = _currentTerms();
        _requireTermsReady(terms);

        token = _deployToken(name_, symbol_, totalSupply_, marketingWallet, buyFees, sellFees, payout, salt);

        bytes32 poolId;
        (liquidity, lockId, creatorTokensBought, poolId) =
            _launch(token, totalSupply_, liquidityEthAmount, creatorBuyEthAmount, minCreatorTokensOut, terms, buyFees, sellFees);

        creatorOf[token] = _creator();
        _tokensByCreator[_creator()].push(token);
        _tokenList.push(token);
        _payLaunchFee(fee);
        _emitCreated(token, name_, symbol_, totalSupply_, poolId, marketingWallet, buyFees, sellFees);
    }

    /// @dev Split out of createCustomToken purely to keep its stack shallow
    /// enough for the production compiler settings (0.8.24, via-IR).
    function _deployToken(
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        address marketingWallet,
        V4CustomToken.FeeSet calldata buyFees,
        V4CustomToken.FeeSet calldata sellFees,
        V4CustomToken.ReflectionPayout calldata payout,
        uint256 salt
    ) private returns (address token) {
        token = Clones.cloneDeterministic(tokenImplementation, _deriveTokenSalt(_creator(), salt));
        V4CustomToken(token).initialize(
            name_, symbol_, totalSupply_, _creator(), address(this), address(this), marketingWallet, buyFees, sellFees, _infra()
        );
        // In kind (mode 0) is the token's default; only ETH / other-token payouts need the extra call.
        if (payout.mode != 0) V4CustomToken(token).setReflectionPayout(payout);
    }

    function _emitCreated(
        address token,
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        bytes32 poolId,
        address marketingWallet,
        V4CustomToken.FeeSet calldata buyFees,
        V4CustomToken.FeeSet calldata sellFees
    ) private {
        emit CustomTokenCreated(token, _creator(), name_, symbol_, totalSupply_, poolId, marketingWallet, buyFees, sellFees);
    }

    /// @dev Everything that never earns reflections on this token from day one.
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

    function _launch(
        address token,
        uint256 totalSupply_,
        uint256 liquidityEthAmount,
        uint256 creatorBuyEthAmount,
        uint256 minCreatorTokensOut,
        TaxTerms memory terms,
        V4CustomToken.FeeSet calldata buyFees,
        V4CustomToken.FeeSet calldata sellFees
    ) private returns (uint256 liquidity, uint256 lockId, uint256 creatorTokensBought, bytes32 poolId) {
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
        PoolKey memory key;
        (key, poolId) = _initPool(token, totalSupply_, liquidityEthAmount, terms, true, f);

        uint256 ethUsed;
        uint256 tokenUsed;
        (lockId, liquidity, ethUsed, tokenUsed) = _seed(key, _creator(), totalSupply_, liquidityEthAmount);

        if (creatorBuyEthAmount > 0) {
            creatorTokensBought =
                _creatorBuyIn(key, totalSupply_, creatorBuyEthAmount, ethUsed, tokenUsed, minCreatorTokensOut, buyFees);
        }
    }

    function _payLaunchFee(uint256 fee) private {
        (bool ok,,) = _splitFee(fee);
        require(ok, "V4CustomTokenFactory: fee transfer failed");
    }

    // ---------------------------------------------------------------
    // Creator buy-in (a real, taxed swap)
    // ---------------------------------------------------------------

    function _creatorBuyIn(
        PoolKey memory key,
        uint256 totalSupply_,
        uint256 ethIn,
        uint256 ethReserve,
        uint256 tokenReserve,
        uint256 callerMinOut,
        V4CustomToken.FeeSet calldata buyFees
    ) private returns (uint256 tokensOut) {
        address creator_ = _creator();
        uint256 minOut = _effectiveMinBuyOut(ethIn, ethReserve, tokenReserve, callerMinOut, buyFees);
        bytes memory result = poolManager.unlock(abi.encode(key, ethIn, creator_));
        uint256 ethSpent;
        (ethSpent, tokensOut) = abi.decode(result, (uint256, uint256));

        require(tokensOut >= minOut, "V4CustomTokenFactory: creator buy-in below minimum output");
        require(
            tokensOut <= (totalSupply_ * maxCreatorBuyBps) / 10_000,
            "V4CustomTokenFactory: creator buy-in exceeds max allowed share of supply"
        );
        if (ethIn > ethSpent) _sendEth(creator_, ethIn - ethSpent);
        emit CreatorBought(Currency.unwrap(key.currency1), creator_, ethSpent, tokensOut);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "V4CustomTokenFactory: only pool manager");
        (PoolKey memory key, uint256 ethIn, address recipient) = abi.decode(data, (PoolKey, uint256, address));
        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            ""
        );
        uint256 ethSpent = uint256(uint128(-delta.amount0()));
        uint256 tokensOut = uint256(uint128(delta.amount1()));
        poolManager.settle{value: ethSpent}();
        if (tokensOut > 0) poolManager.take(key.currency1, recipient, tokensOut);
        return abi.encode(ethSpent, tokensOut);
    }

    /// @dev Expected output after the LP fee AND every tax on a buy (platform
    /// + creator buy fees; the ETH-side ones come off the ETH paid in, the token-side ones off the output), less buyInSlippageBps; the caller's own minimum
    /// wins if stricter.
    function _effectiveMinBuyOut(
        uint256 ethIn,
        uint256 ethReserve,
        uint256 tokenReserve,
        uint256 callerMinOut,
        V4CustomToken.FeeSet calldata buyFees
    ) private view returns (uint256) {
        // The platform fee and the creator's marketing share are taken in ETH off the amount paid in; the reflection /
        // liquidity / burn shares are taken in tokens off the pool's output.
        uint256 ethBps = taxSource.feeBps() + buyFees.marketingBps;
        uint256 tokenBps = uint256(buyFees.reflectionBps) + buyFees.liquidityBps + buyFees.burnBps;
        uint256 ethNet = ethIn - (ethIn * ethBps) / 10_000;
        uint256 withFee = ethNet * (1_000_000 - LP_FEE);
        uint256 grossOut = (withFee * tokenReserve) / (ethReserve * 1_000_000 + withFee);
        uint256 expectedNetOut = grossOut - (grossOut * tokenBps) / 10_000;
        uint256 floor = expectedNetOut - (expectedNetOut * buyInSlippageBps) / 10_000;
        return callerMinOut > floor ? callerMinOut : floor;
    }

    // ---------------------------------------------------------------
    // Views + settings
    // ---------------------------------------------------------------

    function tokensOf(address creator_) external view returns (address[] memory) {
        return _tokensByCreator[creator_];
    }

    function allTokens() external view returns (address[] memory) {
        return _tokenList;
    }

    function predictTokenAddress(address creator_, uint256 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(tokenImplementation, _deriveTokenSalt(creator_, salt), address(this));
    }

    function setLaunchFee(uint256 newFee) external onlyOwner {
        require(newFee <= MAX_LAUNCH_FEE, "V4CustomTokenFactory: launch fee above ceiling");
        launchFee = newFee;
        emit LaunchFeeUpdated(newFee);
    }

    function setBuyInSlippageBps(uint256 newBps) external onlyOwner {
        require(newBps >= MIN_SLIPPAGE_BPS, "V4CustomTokenFactory: slippage below 5% floor");
        require(newBps <= MAX_SLIPPAGE_BPS, "V4CustomTokenFactory: slippage above 8% ceiling");
        buyInSlippageBps = newBps;
        emit BuyInSlippageBpsUpdated(newBps);
    }

    /// @notice Recovers ETH that was forced into the factory (selfdestruct, a coinbase reward).
    /// A launch keeps no ETH here between transactions, so nothing is escrowed against it.
    function rescueETH(address payable to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "V4CustomTokenFactory: invalid recipient");
        (bool sent,) = to.call{value: amount}("");
        require(sent, "V4CustomTokenFactory: rescue transfer failed");
        emit EthRescued(to, amount);
    }

    /// @notice Recovers tokens sent to the factory by mistake. A launch holds its own token only
    /// inside the launch transaction (nonReentrant), so this never touches one in progress.
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        require(to != address(0), "V4CustomTokenFactory: invalid recipient");
        IERC20(token).safeTransfer(to, amount);
        emit TokensRescued(token, to, amount);
    }
}
