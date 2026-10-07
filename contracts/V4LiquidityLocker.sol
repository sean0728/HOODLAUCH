// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {LiquidityAmounts} from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";

/// @title V4LiquidityLocker
/// @notice The V4 counterpart of LiquidityLocker. In V2 the LP position was an
/// ERC20 (the pair's LP token) and the locker simply held it. A V4 position is
/// not a token: it is an entry inside the singleton PoolManager, keyed by
/// (owner, tickLower, tickUpper, salt). So this contract is both
///
///   - the liquidity MANAGER: the factory hands it the launch ETH and tokens,
///     it adds a full-range position to the pool, and it is the position's
///     on-chain owner (salt = lockId, so every lock is a separate position); and
///   - the TIMELOCK: the creator can't touch the liquidity until unlockTime.
///     After that, withdraw(lockId) removes the whole position and pays the
///     principal AND the trading fees it earned straight to the lock owner.
///
/// Same promise as V2: the creator picks the amount but not when it can come
/// back out. As in V2, LP fees stay in the position until unlock.
///
/// There is deliberately no PositionManager / Permit2 dependency: the locker
/// talks to the PoolManager directly through unlock(), so nobody else can ever
/// hold a handle that moves a locked position.
contract V4LiquidityLocker is Ownable2Step, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    IPoolManager public immutable poolManager;

    /// @notice The only address allowed to create locks. Set once, after
    /// deployment, because the factory's constructor needs this address first.
    address public factory;

    /// @notice Additional launchers (V4CustomTokenFactory, V4CurveFactory) that
    /// may create locks, authorized by the owner. Each lock's position is
    /// keyed by its lockId, so launchers can never touch each other's locks.
    mapping(address => bool) public extraFactories;

    struct Lock {
        address token; // currency1 of the pool (currency0 is always native ETH)
        address hooks;
        uint24 fee;
        int24 tickSpacing;
        address owner;
        uint128 liquidity;
        uint64 unlockTime;
        bool withdrawn;
    }

    Lock[] public locks;
    mapping(address => uint256[]) public locksByOwner;

    enum Action {
        SEED,
        WITHDRAW
    }

    event FactorySet(address indexed factory);
    event ExtraFactorySet(address indexed factory, bool allowed);
    event Locked(
        uint256 indexed lockId, bytes32 indexed poolId, address indexed owner, uint128 liquidity, uint256 unlockTime
    );
    event Withdrawn(uint256 indexed lockId, address indexed owner, uint256 amount0, uint256 amount1);
    /// @dev Emitted after Withdrawn when the owner sent the payout to another address.
    event PayoutRedirected(uint256 indexed lockId, address indexed to);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);
    event EthRescued(address indexed to, uint256 amount);

    modifier onlyFactory() {
        require(
            msg.sender == factory || extraFactories[msg.sender], "V4LiquidityLocker: caller is not the factory"
        );
        _;
    }

    constructor(IPoolManager poolManager_) Ownable(msg.sender) {
        require(address(poolManager_) != address(0), "V4LiquidityLocker: invalid pool manager");
        poolManager = poolManager_;
    }

    function setFactory(address factory_) external onlyOwner {
        require(factory == address(0), "V4LiquidityLocker: factory already set");
        require(factory_ != address(0), "V4LiquidityLocker: invalid factory");
        factory = factory_;
        emit FactorySet(factory_);
    }

    /// @notice Authorize (or revoke) an additional launcher. Revoking one
    /// never affects locks it already created.
    function setExtraFactory(address factory_, bool allowed) external onlyOwner {
        require(factory_ != address(0), "V4LiquidityLocker: invalid factory");
        extraFactories[factory_] = allowed;
        emit ExtraFactorySet(factory_, allowed);
    }

    /// @notice Same safety rail as V2: ownership can't be renounced before a
    /// factory is wired, which would strand this instance forever.
    function renounceOwnership() public virtual override onlyOwner {
        require(factory != address(0), "V4LiquidityLocker: cannot renounce before a factory is wired");
        super.renounceOwnership();
    }

    // ---------------------------------------------------------------
    // Seeding
    // ---------------------------------------------------------------

    /// @notice Adds a full-range position to an already-initialized pool with
    /// msg.value ETH and `tokenAmount` of the pool's token, and locks it for
    /// `owner_` until `unlockTime`. The factory must have transferred
    /// `tokenAmount` of the token to this contract first. Whatever the pool's
    /// price did not need of either side (price-ratio rounding only, since the
    /// factory initializes the pool at exactly this ratio) is returned: ETH to
    /// `refundTo`, tokens to `refundTo` as well.
    function seedAndLock(PoolKey calldata key, address owner_, uint256 unlockTime, uint256 tokenAmount, address refundTo)
        external
        payable
        onlyFactory
        nonReentrant
        returns (uint256 lockId, uint128 liquidity, uint256 ethUsed, uint256 tokenUsed)
    {
        require(owner_ != address(0), "V4LiquidityLocker: invalid owner");
        require(refundTo != address(0), "V4LiquidityLocker: invalid refund recipient");
        require(unlockTime > block.timestamp, "V4LiquidityLocker: unlock time must be in the future");
        // The time is stored as a uint64. Without this check a huge value would
        // silently wrap into the past and create an already-expired lock.
        require(unlockTime <= type(uint64).max, "V4LiquidityLocker: unlock time out of range");
        require(msg.value > 0 && tokenAmount > 0, "V4LiquidityLocker: nothing to seed");
        require(Currency.unwrap(key.currency0) == address(0), "V4LiquidityLocker: currency0 must be native ETH");
        require(
            IERC20(Currency.unwrap(key.currency1)).balanceOf(address(this)) >= tokenAmount,
            "V4LiquidityLocker: tokens not received"
        );

        liquidity = _computeLiquidity(key, msg.value, tokenAmount);
        lockId = _recordLock(key, owner_, liquidity, unlockTime);

        bytes memory result = poolManager.unlock(abi.encode(Action.SEED, abi.encode(key, lockId, liquidity)));
        (ethUsed, tokenUsed) = abi.decode(result, (uint256, uint256));

        emit Locked(lockId, PoolId.unwrap(key.toId()), owner_, liquidity, unlockTime);

        // Hand back the unused remainder (price-rounding dust).
        _refund(Currency.unwrap(key.currency1), refundTo, msg.value - ethUsed, tokenAmount - tokenUsed);
    }

    function _computeLiquidity(PoolKey calldata key, uint256 ethAmount, uint256 tokenAmount)
        private
        view
        returns (uint128 liquidity)
    {
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(key.toId());
        require(sqrtPriceX96 != 0, "V4LiquidityLocker: pool not initialized");
        int24 spacing = key.tickSpacing;
        liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(TickMath.minUsableTick(spacing)),
            TickMath.getSqrtPriceAtTick(TickMath.maxUsableTick(spacing)),
            ethAmount,
            tokenAmount
        );
        require(liquidity > 0, "V4LiquidityLocker: zero liquidity");
    }

    function _recordLock(PoolKey calldata key, address owner_, uint128 liquidity, uint256 unlockTime)
        private
        returns (uint256 lockId)
    {
        lockId = locks.length;
        locks.push(
            Lock({
                token: Currency.unwrap(key.currency1),
                hooks: address(key.hooks),
                fee: key.fee,
                tickSpacing: key.tickSpacing,
                owner: owner_,
                liquidity: liquidity,
                unlockTime: uint64(unlockTime),
                withdrawn: false
            })
        );
        locksByOwner[owner_].push(lockId);
    }

    function _refund(address token, address to, uint256 ethBack, uint256 tokenBack) private {
        if (tokenBack > 0) IERC20(token).safeTransfer(to, tokenBack);
        if (ethBack > 0) {
            (bool ok,) = payable(to).call{value: ethBack}("");
            require(ok, "V4LiquidityLocker: ETH refund failed");
        }
    }

    // ---------------------------------------------------------------
    // Withdrawal
    // ---------------------------------------------------------------

    /// @notice Claim a matured lock. Only the lock's owner, only after
    /// unlockTime. Removes the entire position and sends the principal plus all
    /// accrued trading fees (both ETH and the token) to the owner.
    function withdraw(uint256 lockId) external nonReentrant {
        _withdraw(lockId, msg.sender);
    }

    /// @notice Same as withdraw, but pays out to `to`. For a lock owner that
    /// cannot receive ETH itself (a contract wallet with a reverting receive
    /// hook), whose plain withdraw() would otherwise revert for ever. Only the
    /// lock's owner can call it, so the timelock and the ownership are unchanged.
    function withdrawTo(uint256 lockId, address to) external nonReentrant {
        require(to != address(0) && to != address(this), "V4LiquidityLocker: invalid recipient");
        _withdraw(lockId, to);
    }

    function _withdraw(uint256 lockId, address to) private {
        require(lockId < locks.length, "V4LiquidityLocker: unknown lock");
        Lock storage l = locks[lockId];
        require(msg.sender == l.owner, "V4LiquidityLocker: not lock owner");
        require(block.timestamp >= l.unlockTime, "V4LiquidityLocker: still locked");
        require(!l.withdrawn, "V4LiquidityLocker: already withdrawn");
        l.withdrawn = true;

        PoolKey memory key = _keyOf(l);
        bytes memory result =
            poolManager.unlock(abi.encode(Action.WITHDRAW, abi.encode(key, lockId, uint256(l.liquidity), to)));
        (uint256 amount0, uint256 amount1) = abi.decode(result, (uint256, uint256));
        emit Withdrawn(lockId, msg.sender, amount0, amount1);
        if (to != msg.sender) emit PayoutRedirected(lockId, to);
    }

    // ---------------------------------------------------------------
    // PoolManager callback
    // ---------------------------------------------------------------

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(poolManager), "V4LiquidityLocker: only pool manager");
        (Action action, bytes memory payload) = abi.decode(data, (Action, bytes));

        if (action == Action.SEED) {
            (PoolKey memory key, uint256 lockId, uint128 liquidity) = abi.decode(payload, (PoolKey, uint256, uint128));
            (BalanceDelta delta,) = poolManager.modifyLiquidity(
                key,
                ModifyLiquidityParams({
                    tickLower: TickMath.minUsableTick(key.tickSpacing),
                    tickUpper: TickMath.maxUsableTick(key.tickSpacing),
                    liquidityDelta: int256(uint256(liquidity)),
                    salt: bytes32(lockId)
                }),
                ""
            );
            // Adding liquidity: the position owes the pool both currencies.
            uint256 owed0 = uint256(uint128(-delta.amount0()));
            uint256 owed1 = uint256(uint128(-delta.amount1()));
            if (owed0 > 0) poolManager.settle{value: owed0}();
            if (owed1 > 0) {
                address token = Currency.unwrap(key.currency1);
                poolManager.sync(key.currency1);
                IERC20(token).safeTransfer(address(poolManager), owed1);
                poolManager.settle();
            }
            return abi.encode(owed0, owed1);
        } else {
            (PoolKey memory key, uint256 lockId, uint256 liquidity, address to) =
                abi.decode(payload, (PoolKey, uint256, uint256, address));
            (BalanceDelta delta,) = poolManager.modifyLiquidity(
                key,
                ModifyLiquidityParams({
                    tickLower: TickMath.minUsableTick(key.tickSpacing),
                    tickUpper: TickMath.maxUsableTick(key.tickSpacing),
                    liquidityDelta: -int256(liquidity),
                    salt: bytes32(lockId)
                }),
                ""
            );
            // Removing liquidity: the callerDelta already includes accrued fees.
            uint256 out0 = delta.amount0() > 0 ? uint256(uint128(delta.amount0())) : 0;
            uint256 out1 = delta.amount1() > 0 ? uint256(uint128(delta.amount1())) : 0;
            if (out0 > 0) poolManager.take(key.currency0, to, out0);
            if (out1 > 0) poolManager.take(key.currency1, to, out1);
            return abi.encode(out0, out1);
        }
    }

    // ---------------------------------------------------------------
    // Views / housekeeping
    // ---------------------------------------------------------------

    function _keyOf(Lock storage l) private view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(l.token),
            fee: l.fee,
            tickSpacing: l.tickSpacing,
            hooks: IHooks(l.hooks)
        });
    }

    function locksOf(address owner_) external view returns (uint256[] memory) {
        return locksByOwner[owner_];
    }

    function lockCount() external view returns (uint256) {
        return locks.length;
    }

    /// @notice Recovers tokens sent here by mistake. Locked positions live
    /// inside the PoolManager, not on this contract, so this structurally
    /// cannot reach any lock.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "V4LiquidityLocker: invalid recipient");
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, to, amount);
    }

    /// @notice Same, for stray ETH. This contract never holds ETH between
    /// transactions, so any balance here is a mistake.
    function rescueETH(address payable to, uint256 amount) external onlyOwner {
        require(to != address(0), "V4LiquidityLocker: invalid recipient");
        (bool ok,) = to.call{value: amount}("");
        require(ok, "V4LiquidityLocker: ETH rescue failed");
        emit EthRescued(to, amount);
    }
}
