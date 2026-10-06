// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
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
/// Not included (compared with V2): a gasless relayed launch for this mode,
/// and a "deploy token only" option.
contract V4CustomTokenFactory is V4PoolLauncher, IUnlockCallback {
    address public immutable tokenImplementation;
    V4LiquidityCompounder public immutable compounder;

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

    constructor(address tokenImplementation_, address taxSource_, address compounder_, uint256 launchFee_, uint256 lpLockDuration_)
        V4PoolLauncher(taxSource_, lpLockDuration_)
    {
        require(tokenImplementation_ != address(0), "V4CustomTokenFactory: invalid token implementation");
        require(compounder_ != address(0), "V4CustomTokenFactory: invalid compounder");
        tokenImplementation = tokenImplementation_;
        compounder = V4LiquidityCompounder(payable(compounder_));
        launchFee = launchFee_;
    }

    /// @dev Only the locker (refunding unused seed ETH) and the PoolManager
    /// (never, but harmless) send ETH here.
    receive() external payable {
        require(msg.sender == address(locker), "V4CustomTokenFactory: unexpected ETH");
    }

    function _deriveTokenSalt(address creator_, uint256 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(creator_, salt));
    }

    /// @notice msg.value must equal launchFee + liquidityEthAmount + creatorBuyEthAmount.
    function createCustomToken(
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        V4CustomToken.FeeSet calldata buyFees,
        V4CustomToken.FeeSet calldata sellFees,
        address marketingWallet,
        uint256 liquidityEthAmount,
        uint256 creatorBuyEthAmount,
        uint256 minCreatorTokensOut,
        uint256 salt
    ) external payable nonReentrant returns (address token, uint256 liquidity, uint256 lockId, uint256 creatorTokensBought) {
        require(bytes(name_).length > 0, "V4CustomTokenFactory: name required");
        require(bytes(symbol_).length > 0, "V4CustomTokenFactory: symbol required");
        require(totalSupply_ > 0, "V4CustomTokenFactory: supply must be > 0");
        require(liquidityEthAmount > 0, "V4CustomTokenFactory: no ETH sent for liquidity");
        require(msg.value >= launchFee, "V4CustomTokenFactory: launch fee not met");
        require(
            msg.value - launchFee == liquidityEthAmount + creatorBuyEthAmount,
            "V4CustomTokenFactory: msg.value doesn't match liquidity + buy-in"
        );
        TaxTerms memory terms = _currentTerms();
        _requireTermsReady(terms);

        token = Clones.cloneDeterministic(tokenImplementation, _deriveTokenSalt(msg.sender, salt));
        V4CustomToken(token).initialize(
            name_, symbol_, totalSupply_, msg.sender, address(this), address(this), marketingWallet, buyFees, sellFees, _infra()
        );

        bytes32 poolId;
        (liquidity, lockId, creatorTokensBought, poolId) =
            _launch(token, totalSupply_, liquidityEthAmount, creatorBuyEthAmount, minCreatorTokensOut, terms, buyFees, sellFees);

        creatorOf[token] = msg.sender;
        _tokensByCreator[msg.sender].push(token);
        _tokenList.push(token);
        _payLaunchFee();
        emit CustomTokenCreated(token, msg.sender, name_, symbol_, totalSupply_, poolId, marketingWallet, buyFees, sellFees);
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
        (lockId, liquidity, ethUsed, tokenUsed) = _seed(key, msg.sender, totalSupply_, liquidityEthAmount);

        if (creatorBuyEthAmount > 0) {
            creatorTokensBought =
                _creatorBuyIn(key, totalSupply_, creatorBuyEthAmount, ethUsed, tokenUsed, minCreatorTokensOut, buyFees);
        }
    }

    function _payLaunchFee() private {
        (bool ok,,) = _splitFee(launchFee);
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
        uint256 minOut = _effectiveMinBuyOut(ethIn, ethReserve, tokenReserve, callerMinOut, buyFees);
        bytes memory result = poolManager.unlock(abi.encode(key, ethIn, msg.sender));
        uint256 ethSpent;
        (ethSpent, tokensOut) = abi.decode(result, (uint256, uint256));

        require(tokensOut >= minOut, "V4CustomTokenFactory: creator buy-in below minimum output");
        require(
            tokensOut <= (totalSupply_ * maxCreatorBuyBps) / 10_000,
            "V4CustomTokenFactory: creator buy-in exceeds max allowed share of supply"
        );
        if (ethIn > ethSpent) _sendEth(msg.sender, ethIn - ethSpent);
        emit CreatorBought(Currency.unwrap(key.currency1), msg.sender, ethSpent, tokensOut);
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
    /// + creator buy fees), less buyInSlippageBps; the caller's own minimum
    /// wins if stricter.
    function _effectiveMinBuyOut(
        uint256 ethIn,
        uint256 ethReserve,
        uint256 tokenReserve,
        uint256 callerMinOut,
        V4CustomToken.FeeSet calldata buyFees
    ) private view returns (uint256) {
        uint256 withFee = ethIn * (1_000_000 - LP_FEE);
        uint256 grossOut = (withFee * tokenReserve) / (ethReserve * 1_000_000 + withFee);
        uint256 totalBps = taxSource.feeBps() + buyFees.reflectionBps + buyFees.marketingBps + buyFees.liquidityBps + buyFees.burnBps;
        uint256 expectedNetOut = grossOut - (grossOut * totalBps) / 10_000;
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
        launchFee = newFee;
        emit LaunchFeeUpdated(newFee);
    }

    function setBuyInSlippageBps(uint256 newBps) external onlyOwner {
        require(newBps >= MIN_SLIPPAGE_BPS, "V4CustomTokenFactory: slippage below 5% floor");
        require(newBps <= MAX_SLIPPAGE_BPS, "V4CustomTokenFactory: slippage above 8% ceiling");
        buyInSlippageBps = newBps;
        emit BuyInSlippageBpsUpdated(newBps);
    }
}
