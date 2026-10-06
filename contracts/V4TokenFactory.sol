// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {SafeCast} from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {V4LaunchedToken} from "./V4LaunchedToken.sol";
import {V4LiquidityLocker} from "./V4LiquidityLocker.sol";
import {V4TaxHook} from "./V4TaxHook.sol";

/// @title V4TokenFactory
/// @notice The Uniswap V4 counterpart of TokenFactory (V2 is untouched and keeps
/// running side by side). Same two launch modes, same fees, same relayed
/// (gasless) flow, same EIP-712 voucher, same 50/50 fee split. What changes is
/// everything underneath the "add liquidity" step:
///
///  - the pool is a V4 pool in the singleton PoolManager, (native ETH, token),
///    created by THIS contract at exactly the launch price, with V4TaxHook
///    attached. Because the hook only lets this factory initialize a pool, a
///    third party can no longer pre-create the pair to interfere with a launch;
///  - the position is a full-range V4 position owned by V4LiquidityLocker, which
///    also enforces the creator's lock (see that contract);
///  - the trading tax is collected by the hook at the pool, in the token, on
///    every swap (see V4TaxHook) instead of inside the token's _update();
///  - the creator's optional same-transaction buy-in is a real swap through the
///    PoolManager, so it pays the tax like any other buyer's.
///
/// "Deploy Token" (addLiquidityAtLaunch = false) is unchanged in spirit: a plain
/// ERC20 minted entirely to the creator, no pool, no tax, forever.
contract V4TokenFactory is Ownable2Step, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using PoolIdLibrary for PoolKey;

    address public immutable tokenImplementation;
    IPoolManager public immutable poolManager;
    V4LiquidityLocker public immutable locker;
    V4TaxHook public immutable hook;

    /// @notice Every HoodLaunch V4 pool uses the same pool-level LP fee (0.30%,
    /// matching the V2 pair's swap fee) and tick spacing 60 (the standard
    /// spacing for a 0.30% fee tier). LP fees accrue to the locked position and
    /// are paid to the creator at unlock, exactly like V2's LP fees.
    uint24 public constant LP_FEE = 3000;
    int24 public constant TICK_SPACING = 60;

    uint256 public deployFee;
    uint256 public launchFee;
    address public feeTreasury;
    uint256 public lpLockDuration;

    uint256 public constant MAX_FEE_BPS = 2_000; // 20.00%

    address public platformFeeWallet;
    uint256 public feeBps = 100; // 1.00%
    address public priceFeed;
    uint256 public graduationTargetUsd = 50_000;
    uint256 public maxOracleStaleness = 1 hours;

    address public rewardsDistributor;
    uint256 public rewardBps = 0;
    address public creatorRewardsDistributor;
    uint256 public creatorRewardBps = 10; // 0.10%
    address public feeWalletDistributor;

    /// @notice Anti-rug cap on the creator's same-transaction buy-in, in bps of
    /// totalSupply, checked against the tokens the creator actually receives
    /// AFTER the hook's tax.
    uint256 public maxCreatorBuyBps = 500; // 5.00%

    /// @notice Slippage floor on the creator's buy-in (5%-8% band, as in V2).
    /// There is no liquiditySlippageBps in V4: the factory is the only party
    /// that can initialize the pool, so nobody can skew its price between
    /// submission and execution the way a V2 pair could be skewed.
    uint256 public buyInSlippageBps = 600;
    uint256 public constant MIN_SLIPPAGE_BPS = 500;
    uint256 public constant MAX_SLIPPAGE_BPS = 800;

    mapping(address => address) public creatorOf;
    /// @notice token => its V4 PoolId, or bytes32(0) for a "Deploy Token" launch.
    mapping(address => bytes32) public poolIdOf;
    address[] private _tokenList;
    mapping(address => address[]) private _tokensByCreator;

    // ---- gasless relayed launches (identical scheme to V2; see TokenFactory) ----
    address public relayer;
    uint256 public maxRelayerGasReimbursementWei;
    uint256 public constant RELAY_GAS_OVERHEAD = 60_000;

    struct Deposit {
        uint256 amount;
        uint256 deadline;
        bool settled;
        bool reclaimed;
    }

    mapping(address => mapping(bytes32 => Deposit)) public deposits;

    struct LaunchVoucher {
        address creator;
        string name;
        string symbol;
        uint256 totalSupply;
        bool addLiquidityAtLaunch;
        uint256 liquidityEthAmount;
        uint256 creatorBuyEthAmount;
        uint256 minCreatorTokensOut;
        uint256 fee;
        uint256 salt;
        uint256 deadline;
    }

    bytes32 private constant LAUNCH_VOUCHER_TYPEHASH = keccak256(
        "LaunchVoucher(address creator,string name,string symbol,uint256 totalSupply,bool addLiquidityAtLaunch,uint256 liquidityEthAmount,uint256 creatorBuyEthAmount,uint256 minCreatorTokensOut,uint256 fee,uint256 salt,uint256 deadline)"
    );
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private immutable _domainSeparator;

    event RelayerUpdated(address newRelayer);
    event MaxRelayerGasReimbursementUpdated(uint256 newCapWei);
    event LaunchDeposited(bytes32 indexed voucherHash, address indexed creator, uint256 amount, uint256 deadline);
    event DepositReclaimed(bytes32 indexed voucherHash, address indexed creator, uint256 amount);
    event RelayedFeeSettled(
        bytes32 indexed voucherHash,
        address indexed token,
        uint256 feeCollected,
        uint256 gasReimbursed,
        uint256 toTreasury,
        uint256 toRewards
    );
    event TokenCreated(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        uint256 totalSupply,
        bool launchedWithLiquidity,
        bytes32 poolId
    );
    event LiquidityAdded(
        address indexed token,
        address indexed creator,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint256 liquidity,
        uint256 unlockTime,
        uint256 indexed lockId
    );
    event CreatorBought(address indexed token, address indexed creator, uint256 ethIn, uint256 tokensOut);
    event DeployFeeUpdated(uint256 newFee);
    event LaunchFeeUpdated(uint256 newFee);
    event LpLockDurationUpdated(uint256 newDuration);
    event FeeTreasuryUpdated(address newTreasury);
    event TaxDefaultsUpdated();
    event MaxCreatorBuyBpsUpdated(uint256 newBps);
    event BuyInSlippageBpsUpdated(uint256 newBps);
    event RewardsDistributorUpdated(address newDistributor);
    event CreatorRewardsDistributorUpdated(address newDistributor);
    event FeeWalletDistributorUpdated(address newDistributor);
    event TokenPriceFeedUpdated(address indexed token, address newPriceFeed, uint256 newMaxOracleStaleness);

    modifier onlyRelayer() {
        require(msg.sender == relayer, "V4TokenFactory: caller is not the relayer");
        _;
    }

    constructor(
        address tokenImplementation_,
        address poolManager_,
        address locker_,
        address hook_,
        uint256 deployFee_,
        uint256 launchFee_,
        address feeTreasury_,
        uint256 lpLockDuration_,
        address platformFeeWallet_,
        address priceFeed_
    ) Ownable(msg.sender) {
        require(tokenImplementation_ != address(0), "V4TokenFactory: invalid token implementation");
        require(poolManager_ != address(0), "V4TokenFactory: invalid pool manager");
        require(locker_ != address(0), "V4TokenFactory: invalid locker");
        require(hook_ != address(0), "V4TokenFactory: invalid hook");
        require(feeTreasury_ != address(0), "V4TokenFactory: invalid treasury");

        tokenImplementation = tokenImplementation_;
        poolManager = IPoolManager(poolManager_);
        locker = V4LiquidityLocker(locker_);
        hook = V4TaxHook(hook_);
        deployFee = deployFee_;
        launchFee = launchFee_;
        feeTreasury = feeTreasury_;
        lpLockDuration = lpLockDuration_;
        platformFeeWallet = platformFeeWallet_;
        priceFeed = priceFeed_;

        _domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("HoodLaunchV4TokenFactory")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /// @dev Only the locker (refunding unused seed ETH) ever sends ETH here.
    receive() external payable {
        require(msg.sender == address(locker), "V4TokenFactory: unexpected ETH");
    }

    function _hashTypedDataV4(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator, structHash));
    }

    function _deriveTokenSalt(address creator_, uint256 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(creator_, salt));
    }

    // ---------------------------------------------------------------
    // Launch entry points
    // ---------------------------------------------------------------

    /// @notice Same contract as V2's createToken: msg.value must equal
    /// deployFee exactly for "Deploy Token", or launchFee + liquidityEthAmount +
    /// creatorBuyEthAmount for "Deploy and Add Liquidity (Launch)".
    function createToken(
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        bool addLiquidityAtLaunch,
        uint256 liquidityEthAmount,
        uint256 creatorBuyEthAmount,
        uint256 minCreatorTokensOut,
        uint256 salt
    )
        external
        payable
        nonReentrant
        returns (address token, uint256 liquidity, uint256 lockId, uint256 creatorTokensBought)
    {
        require(bytes(name_).length > 0, "V4TokenFactory: name required");
        require(bytes(symbol_).length > 0, "V4TokenFactory: symbol required");
        require(totalSupply_ > 0, "V4TokenFactory: supply must be > 0");

        token = Clones.cloneDeterministic(tokenImplementation, _deriveTokenSalt(msg.sender, salt));

        if (!addLiquidityAtLaunch) {
            _createDeployOnly(token, name_, symbol_, totalSupply_);
        } else {
            (liquidity, lockId, creatorTokensBought) = _createWithLiquidity(
                token, name_, symbol_, totalSupply_, liquidityEthAmount, creatorBuyEthAmount, minCreatorTokensOut
            );
        }
    }

    /// @dev "Deploy Token": plain ERC20, 100% to the creator, nothing else.
    /// The helpers below also record + emit, so createToken's own stack stays
    /// shallow enough to compile without viaIR (same reason V2 split it).
    function _createDeployOnly(address token, string calldata name_, string calldata symbol_, uint256 totalSupply_)
        internal
    {
        require(msg.value == deployFee, "V4TokenFactory: incorrect ETH sent for Deploy Token");
        V4LaunchedToken(token).initialize(name_, symbol_, totalSupply_, msg.sender, msg.sender, address(this));
        _finalizeLaunch(token, deployFee);
        emit TokenCreated(token, msg.sender, name_, symbol_, totalSupply_, false, bytes32(0));
    }

    /// @dev "Deploy and Add Liquidity": validates the ETH split, initializes
    /// the token, runs the shared launch, records and emits.
    function _createWithLiquidity(
        address token,
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        uint256 liquidityEthAmount,
        uint256 creatorBuyEthAmount,
        uint256 minCreatorTokensOut
    ) internal returns (uint256 liquidity, uint256 lockId, uint256 creatorTokensBought) {
        require(msg.value >= launchFee, "V4TokenFactory: launch fee not met");
        require(
            msg.value - launchFee == liquidityEthAmount + creatorBuyEthAmount,
            "V4TokenFactory: msg.value doesn't match liquidity + buy-in"
        );
        V4LaunchedToken(token).initialize(name_, symbol_, totalSupply_, msg.sender, address(this), address(this));
        bytes32 poolId;
        (liquidity, lockId, creatorTokensBought, poolId) = _launchWithLiquidity(
            token, msg.sender, totalSupply_, liquidityEthAmount, creatorBuyEthAmount, minCreatorTokensOut
        );
        poolIdOf[token] = poolId;
        _finalizeLaunch(token, launchFee);
        emit TokenCreated(token, msg.sender, name_, symbol_, totalSupply_, true, poolId);
    }

    function _finalizeLaunch(address token, uint256 feeCollected) internal {
        creatorOf[token] = msg.sender;
        _tokensByCreator[msg.sender].push(token);
        _tokenList.push(token);

        if (feeCollected == 0) return;

        if (rewardsDistributor != address(0)) {
            uint256 toRewards = feeCollected / 2;
            uint256 toTreasury = feeCollected - toRewards;
            if (toRewards > 0) {
                (bool sentRewards,) = rewardsDistributor.call{value: toRewards}("");
                require(sentRewards, "V4TokenFactory: rewards transfer failed");
            }
            (bool sent,) = feeTreasury.call{value: toTreasury}("");
            require(sent, "V4TokenFactory: fee transfer failed");
        } else {
            (bool sent,) = feeTreasury.call{value: feeCollected}("");
            require(sent, "V4TokenFactory: fee transfer failed");
        }
    }

    // ---------------------------------------------------------------
    // Relayed (gasless) launches
    // ---------------------------------------------------------------

    function hashLaunchVoucher(LaunchVoucher calldata voucher) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                LAUNCH_VOUCHER_TYPEHASH,
                voucher.creator,
                keccak256(bytes(voucher.name)),
                keccak256(bytes(voucher.symbol)),
                voucher.totalSupply,
                voucher.addLiquidityAtLaunch,
                voucher.liquidityEthAmount,
                voucher.creatorBuyEthAmount,
                voucher.minCreatorTokensOut,
                voucher.fee,
                voucher.salt,
                voucher.deadline
            )
        );
        return _hashTypedDataV4(structHash);
    }

    function depositForRelayedLaunch(bytes32 voucherHash, uint256 deadline) external payable nonReentrant {
        require(msg.value > 0, "V4TokenFactory: no ETH sent");
        require(deadline > block.timestamp, "V4TokenFactory: deadline already passed");
        Deposit storage d = deposits[msg.sender][voucherHash];
        require(d.amount == 0, "V4TokenFactory: voucher already funded");
        d.amount = msg.value;
        d.deadline = deadline;
        emit LaunchDeposited(voucherHash, msg.sender, msg.value, deadline);
    }

    function reclaimDeposit(bytes32 voucherHash) external nonReentrant {
        Deposit storage d = deposits[msg.sender][voucherHash];
        require(d.amount > 0, "V4TokenFactory: no such deposit");
        require(!d.settled, "V4TokenFactory: voucher already relayed");
        require(!d.reclaimed, "V4TokenFactory: already reclaimed");
        require(block.timestamp > d.deadline, "V4TokenFactory: deadline has not passed yet");
        d.reclaimed = true;
        uint256 amount = d.amount;
        (bool sent,) = payable(msg.sender).call{value: amount}("");
        require(sent, "V4TokenFactory: refund transfer failed");
        emit DepositReclaimed(voucherHash, msg.sender, amount);
    }

    function relayedCreateToken(LaunchVoucher calldata voucher, bytes calldata signature)
        external
        onlyRelayer
        nonReentrant
        returns (address token, uint256 liquidity, uint256 lockId, uint256 creatorTokensBought)
    {
        uint256 gasStart = gasleft();
        bytes32 voucherHash = _verifyAndConsumeVoucher(voucher, signature);
        (token, liquidity, lockId, creatorTokensBought) = _relayedLaunch(voucher);

        _settleRelayedFee(voucherHash, token, voucher.fee, gasStart);
    }

    /// @dev Checks the voucher, the creator's signature and the escrowed
    /// deposit, and marks the deposit settled (effects before interactions).
    function _verifyAndConsumeVoucher(LaunchVoucher calldata voucher, bytes calldata signature)
        private
        returns (bytes32 voucherHash)
    {
        require(block.timestamp <= voucher.deadline, "V4TokenFactory: voucher expired");
        require(bytes(voucher.name).length > 0, "V4TokenFactory: name required");
        require(bytes(voucher.symbol).length > 0, "V4TokenFactory: symbol required");
        require(voucher.totalSupply > 0, "V4TokenFactory: supply must be > 0");

        voucherHash = hashLaunchVoucher(voucher);
        require(
            ECDSA.recover(voucherHash, signature) == voucher.creator,
            "V4TokenFactory: signature does not match voucher creator"
        );

        Deposit storage d = deposits[voucher.creator][voucherHash];
        require(d.amount > 0, "V4TokenFactory: no matching deposit");
        require(!d.settled, "V4TokenFactory: voucher already relayed");
        require(!d.reclaimed, "V4TokenFactory: deposit already reclaimed");
        require(block.timestamp <= d.deadline, "V4TokenFactory: deposit expired, creator must reclaim");
        require(
            d.amount
                == voucher.fee
                    + (voucher.addLiquidityAtLaunch ? voucher.liquidityEthAmount + voucher.creatorBuyEthAmount : 0),
            "V4TokenFactory: deposit does not match voucher amount"
        );

        d.settled = true;
    }

    function _relayedLaunch(LaunchVoucher calldata voucher)
        private
        returns (address token, uint256 liquidity, uint256 lockId, uint256 creatorTokensBought)
    {
        token = Clones.cloneDeterministic(tokenImplementation, _deriveTokenSalt(voucher.creator, voucher.salt));
        bytes32 poolId;

        if (!voucher.addLiquidityAtLaunch) {
            V4LaunchedToken(token).initialize(
                voucher.name, voucher.symbol, voucher.totalSupply, voucher.creator, voucher.creator, address(this)
            );
        } else {
            V4LaunchedToken(token).initialize(
                voucher.name, voucher.symbol, voucher.totalSupply, voucher.creator, address(this), address(this)
            );
            (liquidity, lockId, creatorTokensBought, poolId) = _launchWithLiquidity(
                token,
                voucher.creator,
                voucher.totalSupply,
                voucher.liquidityEthAmount,
                voucher.creatorBuyEthAmount,
                voucher.minCreatorTokensOut
            );
            poolIdOf[token] = poolId;
        }

        creatorOf[token] = voucher.creator;
        _tokensByCreator[voucher.creator].push(token);
        _tokenList.push(token);

        _emitRelayedTokenCreated(token, voucher, poolId);
    }

    function _emitRelayedTokenCreated(address token, LaunchVoucher calldata voucher, bytes32 poolId) private {
        emit TokenCreated(
            token, voucher.creator, voucher.name, voucher.symbol, voucher.totalSupply, voucher.addLiquidityAtLaunch, poolId
        );
    }

    function _settleRelayedFee(bytes32 voucherHash, address token, uint256 feeCollected, uint256 gasStart) internal {
        if (feeCollected == 0) return;

        uint256 gasUsed = (gasStart - gasleft()) + RELAY_GAS_OVERHEAD;
        uint256 gasReimbursement = gasUsed * tx.gasprice;
        if (maxRelayerGasReimbursementWei > 0 && gasReimbursement > maxRelayerGasReimbursementWei) {
            gasReimbursement = maxRelayerGasReimbursementWei;
        }
        if (gasReimbursement > feeCollected) {
            gasReimbursement = feeCollected;
        }

        if (gasReimbursement > 0) {
            (bool sentGas,) = payable(relayer).call{value: gasReimbursement}("");
            require(sentGas, "V4TokenFactory: relayer gas reimbursement failed");
        }

        uint256 netFee = feeCollected - gasReimbursement;
        uint256 toRewards;
        uint256 toTreasury;
        if (netFee > 0) {
            if (rewardsDistributor != address(0)) {
                toRewards = netFee / 2;
                toTreasury = netFee - toRewards;
                if (toRewards > 0) {
                    (bool sentRewards,) = rewardsDistributor.call{value: toRewards}("");
                    require(sentRewards, "V4TokenFactory: rewards transfer failed");
                }
                (bool sent,) = feeTreasury.call{value: toTreasury}("");
                require(sent, "V4TokenFactory: fee transfer failed");
            } else {
                toTreasury = netFee;
                (bool sent,) = feeTreasury.call{value: netFee}("");
                require(sent, "V4TokenFactory: fee transfer failed");
            }
        }

        emit RelayedFeeSettled(voucherHash, token, feeCollected, gasReimbursement, toTreasury, toRewards);
    }

    // ---------------------------------------------------------------
    // Pool creation, seeding and the creator buy-in (shared by both flows)
    // ---------------------------------------------------------------

    /// @dev Replaces V2's duplicated _launchWithLiquidity/_relayedLaunchWithLiquidity
    /// pair with one function parameterized on `creator_`.
    ///
    /// 1. Initialize the (ETH, token) pool at exactly supply : liquidityEth.
    /// 2. Snapshot the tax settings into the hook for this pool.
    /// 3. Hand the whole supply + the liquidity ETH to the locker, which adds a
    ///    full-range position and locks it to the creator. Any rounding dust
    ///    comes back: leftover ETH to the creator, leftover tokens are burned.
    /// 4. Optionally buy in for the creator, through the (now taxed) pool.
    function _launchWithLiquidity(
        address token,
        address creator_,
        uint256 totalSupply_,
        uint256 liquidityEthAmount,
        uint256 creatorBuyEthAmount,
        uint256 minCreatorTokensOut
    ) internal returns (uint256 liquidity, uint256 lockId, uint256 creatorTokensBought, bytes32 poolId) {
        require(platformFeeWallet != address(0), "V4TokenFactory: platform fee wallet not configured");
        require(priceFeed != address(0), "V4TokenFactory: price feed not configured");
        require(liquidityEthAmount > 0, "V4TokenFactory: no ETH sent for liquidity");

        PoolKey memory key = _createPool(token, totalSupply_, liquidityEthAmount);
        poolId = PoolId.unwrap(key.toId());

        uint256 ethUsed;
        uint256 tokenUsed;
        (lockId, liquidity, ethUsed, tokenUsed) = _seed(key, creator_, totalSupply_, liquidityEthAmount);

        if (creatorBuyEthAmount > 0) {
            creatorTokensBought = _creatorBuyIn(
                key, creator_, totalSupply_, creatorBuyEthAmount, ethUsed, tokenUsed, minCreatorTokensOut
            );
        }
    }

    /// @dev Initialize the pool at exactly supply : liquidityEth, snapshot the
    /// tax settings into the hook, and record the pool on the token.
    function _createPool(address token, uint256 totalSupply_, uint256 liquidityEthAmount)
        private
        returns (PoolKey memory key)
    {
        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
        poolManager.initialize(key, _initialSqrtPriceX96(totalSupply_, liquidityEthAmount));
        _configureHook(key);
        V4LaunchedToken(token).registerPool(PoolId.unwrap(key.toId()), address(hook));
    }

    /// @dev Hand the whole supply + the liquidity ETH to the locker, which adds
    /// the full-range position and locks it to the creator. Rounding dust comes
    /// back: leftover ETH to the creator, leftover tokens are burned.
    function _seed(PoolKey memory key, address creator_, uint256 totalSupply_, uint256 liquidityEthAmount)
        private
        returns (uint256 lockId, uint256 liquidity, uint256 ethUsed, uint256 tokenUsed)
    {
        IERC20(Currency.unwrap(key.currency1)).safeTransfer(address(locker), totalSupply_);
        (lockId, liquidity, ethUsed, tokenUsed) = locker.seedAndLock{value: liquidityEthAmount}(
            key, creator_, block.timestamp + lpLockDuration, totalSupply_, address(this)
        );
        _settleSeedDust(Currency.unwrap(key.currency1), creator_, liquidityEthAmount - ethUsed);
        _emitLiquidityAdded(key, creator_, ethUsed, tokenUsed, liquidity, lockId);
    }

    function _settleSeedDust(address token, address creator_, uint256 ethDust) private {
        uint256 tokenDust = IERC20(token).balanceOf(address(this));
        if (tokenDust > 0) V4LaunchedToken(token).burn(tokenDust);
        if (ethDust > 0) _sendEth(creator_, ethDust);
    }

    function _emitLiquidityAdded(
        PoolKey memory key,
        address creator_,
        uint256 ethUsed,
        uint256 tokenUsed,
        uint256 liquidity,
        uint256 lockId
    ) private {
        emit LiquidityAdded(
            Currency.unwrap(key.currency1), creator_, ethUsed, tokenUsed, liquidity, block.timestamp + lpLockDuration, lockId
        );
    }

    function _configureHook(PoolKey memory key) private {
        uint256 effectiveRewardBps = rewardsDistributor != address(0) ? rewardBps : 0;
        uint256 effectiveCreatorRewardBps = creatorRewardsDistributor != address(0) ? creatorRewardBps : 0;
        hook.configurePool(
            key,
            platformFeeWallet,
            feeBps,
            priceFeed,
            graduationTargetUsd,
            maxOracleStaleness,
            rewardsDistributor,
            effectiveRewardBps,
            creatorRewardsDistributor,
            effectiveCreatorRewardBps,
            feeWalletDistributor
        );
    }

    /// @dev sqrtPriceX96 = sqrt(tokens / wei) * 2^96, computed as
    /// sqrt(tokens * 2^96 / wei) * 2^48 so the intermediate never overflows.
    function _initialSqrtPriceX96(uint256 tokenAmount, uint256 ethAmount) private pure returns (uint160) {
        uint256 ratioX96 = FullMath.mulDiv(tokenAmount, 1 << 96, ethAmount);
        return (Math.sqrt(ratioX96) << 48).toUint160();
    }

    function _creatorBuyIn(
        PoolKey memory key,
        address creator_,
        uint256 totalSupply_,
        uint256 ethIn,
        uint256 ethReserve,
        uint256 tokenReserve,
        uint256 callerMinOut
    ) private returns (uint256 tokensOut) {
        uint256 minOut = _effectiveMinBuyOut(ethIn, ethReserve, tokenReserve, callerMinOut);
        bytes memory result = poolManager.unlock(abi.encode(key, ethIn, creator_));
        uint256 ethSpent;
        (ethSpent, tokensOut) = abi.decode(result, (uint256, uint256));

        require(tokensOut >= minOut, "V4TokenFactory: creator buy-in below minimum output");
        require(
            tokensOut <= (totalSupply_ * maxCreatorBuyBps) / 10_000,
            "V4TokenFactory: creator buy-in exceeds max allowed share of supply"
        );
        if (ethIn > ethSpent) _sendEth(creator_, ethIn - ethSpent);
        emit CreatorBought(Currency.unwrap(key.currency1), creator_, ethSpent, tokensOut);
    }

    /// @dev The buy-in swap runs inside the PoolManager's unlock callback.
    /// Only the PoolManager can reach this, and it only ever calls back into
    /// the address that called unlock() -- i.e. this contract, from
    /// _creatorBuyIn.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "V4TokenFactory: only pool manager");
        (PoolKey memory key, uint256 ethIn, address recipient) = abi.decode(data, (PoolKey, uint256, address));

        // Exact-in ETH -> token. The hook skims its tax off the token output
        // inside this swap, so the delta returned here is already net of it.
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

    /// @dev Constant-product quote with the pool's LP fee (1e6 denominator).
    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) private pure returns (uint256) {
        uint256 amountInWithFee = amountIn * (1_000_000 - LP_FEE);
        return (amountInWithFee * reserveOut) / (reserveIn * 1_000_000 + amountInWithFee);
    }

    /// @dev Same idea as V2: the floor is the expected output after the LP fee
    /// AND after the hook's tax (so the tax is never mistaken for hostile
    /// slippage), less buyInSlippageBps; the caller's own minimum wins if
    /// stricter. The seeded position's real reserves are the quote's reserves.
    function _effectiveMinBuyOut(uint256 ethIn, uint256 ethReserve, uint256 tokenReserve, uint256 callerMinOut)
        private
        view
        returns (uint256)
    {
        uint256 grossOut = _getAmountOut(ethIn, ethReserve, tokenReserve);
        uint256 expectedNetOut = grossOut - (grossOut * feeBps) / 10_000;
        uint256 floor = expectedNetOut - (expectedNetOut * buyInSlippageBps) / 10_000;
        return callerMinOut > floor ? callerMinOut : floor;
    }

    function _sendEth(address to, uint256 amount) private {
        (bool ok,) = payable(to).call{value: amount}("");
        require(ok, "V4TokenFactory: ETH refund failed");
    }

    // ---------------------------------------------------------------
    // Views
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

    // ---------------------------------------------------------------
    // Admin (same surface as V2)
    // ---------------------------------------------------------------

    function setDeployFee(uint256 newFee) external onlyOwner {
        deployFee = newFee;
        emit DeployFeeUpdated(newFee);
    }

    function setLaunchFee(uint256 newFee) external onlyOwner {
        launchFee = newFee;
        emit LaunchFeeUpdated(newFee);
    }

    function setLpLockDuration(uint256 newDuration) external onlyOwner {
        lpLockDuration = newDuration;
        emit LpLockDurationUpdated(newDuration);
    }

    function setFeeTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "V4TokenFactory: invalid treasury");
        feeTreasury = newTreasury;
        emit FeeTreasuryUpdated(newTreasury);
    }

    function setMaxCreatorBuyBps(uint256 newBps) external onlyOwner {
        require(newBps <= 10_000, "V4TokenFactory: bps cannot exceed 100%");
        maxCreatorBuyBps = newBps;
        emit MaxCreatorBuyBpsUpdated(newBps);
    }

    function setBuyInSlippageBps(uint256 newBps) external onlyOwner {
        require(newBps >= MIN_SLIPPAGE_BPS, "V4TokenFactory: slippage below 5% floor");
        require(newBps <= MAX_SLIPPAGE_BPS, "V4TokenFactory: slippage above 8% ceiling");
        buyInSlippageBps = newBps;
        emit BuyInSlippageBpsUpdated(newBps);
    }

    /// @notice Exempts (or un-exempts) a swapper -- in practice one of the
    /// platform's distributor contracts -- from the hook's trading tax. See
    /// V4TaxHook.taxExempt.
    function setTaxExempt(address swapper, bool exempt) external onlyOwner {
        hook.setTaxExempt(swapper, exempt);
    }

    function setRewardsDistributor(address newDistributor) external onlyOwner {
        rewardsDistributor = newDistributor;
        emit RewardsDistributorUpdated(newDistributor);
    }

    function setCreatorRewardsDistributor(address newDistributor) external onlyOwner {
        creatorRewardsDistributor = newDistributor;
        emit CreatorRewardsDistributorUpdated(newDistributor);
    }

    function setFeeWalletDistributor(address newDistributor) external onlyOwner {
        feeWalletDistributor = newDistributor;
        emit FeeWalletDistributorUpdated(newDistributor);
    }

    function setRelayer(address newRelayer) external onlyOwner {
        if (newRelayer != address(0)) {
            require(
                maxRelayerGasReimbursementWei > 0,
                "V4TokenFactory: set maxRelayerGasReimbursementWei before enabling a relayer"
            );
        }
        relayer = newRelayer;
        emit RelayerUpdated(newRelayer);
    }

    function setMaxRelayerGasReimbursement(uint256 newCapWei) external onlyOwner {
        require(
            relayer == address(0) || newCapWei > 0,
            "V4TokenFactory: cannot zero the gas reimbursement cap while a relayer is active"
        );
        maxRelayerGasReimbursementWei = newCapWei;
        emit MaxRelayerGasReimbursementUpdated(newCapWei);
    }

    function setTaxDefaults(
        address platformFeeWallet_,
        uint256 feeBps_,
        address priceFeed_,
        uint256 graduationTargetUsd_,
        uint256 maxOracleStaleness_,
        uint256 rewardBps_,
        uint256 creatorRewardBps_
    ) external onlyOwner {
        require(feeBps_ <= MAX_FEE_BPS, "V4TokenFactory: feeBps exceeds MAX_FEE_BPS ceiling");
        require(graduationTargetUsd_ > 0, "V4TokenFactory: graduation target must be > 0");
        require(maxOracleStaleness_ > 0, "V4TokenFactory: oracle staleness must be > 0");
        require(rewardBps_ + creatorRewardBps_ <= feeBps_, "V4TokenFactory: rewardBps+creatorRewardBps cannot exceed feeBps");
        platformFeeWallet = platformFeeWallet_;
        feeBps = feeBps_;
        priceFeed = priceFeed_;
        graduationTargetUsd = graduationTargetUsd_;
        maxOracleStaleness = maxOracleStaleness_;
        rewardBps = rewardBps_;
        creatorRewardBps = creatorRewardBps_;
        emit TaxDefaultsUpdated();
    }

    /// @notice Dead-oracle escape hatch; see V4TaxHook.updatePriceFeed.
    function updateTokenPriceFeed(address token, address newPriceFeed_, uint256 newMaxOracleStaleness_) external onlyOwner {
        bytes32 id = poolIdOf[token];
        require(id != bytes32(0), "V4TokenFactory: token has no pool");
        hook.updatePriceFeed(PoolId.wrap(id), newPriceFeed_, newMaxOracleStaleness_);
        emit TokenPriceFeedUpdated(token, newPriceFeed_, newMaxOracleStaleness_);
    }
}
