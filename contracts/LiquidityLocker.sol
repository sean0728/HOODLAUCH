// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title LiquidityLocker
/// @notice Holds LP tokens on a creator's behalf for a fixed period after
/// TokenFactory.addLiquidity() runs, so a creator cannot add liquidity and
/// immediately pull it back out. This is the mechanism that makes
/// "creator-funded liquidity" meaningfully different from an outright rug
/// pull: the creator still chooses the amount, but not when they can
/// withdraw it once it's in.
///
/// This contract intentionally knows nothing about tokenomics or bonding
/// curves — it is a generic timelock for ERC20 balances, keyed by an
/// incrementing lock id, and only TokenFactory is allowed to create new
/// locks.
contract LiquidityLocker is Ownable2Step {
    struct Lock {
        address lpToken;
        address owner;
        uint256 amount;
        uint256 unlockTime;
        bool withdrawn;
    }

    /// @notice The only address allowed to call lock(). Set once, after
    /// deployment, to the TokenFactory address (see deploy script) — kept
    /// as a separate step rather than a constructor argument because
    /// TokenFactory's own constructor needs this locker's address first.
    address public factory;

    Lock[] public locks;
    mapping(address => uint256[]) public locksByOwner;

    /// @notice Running sum of every non-withdrawn lock's amount, per LP
    /// token. Purely a bookkeeping/safety total — lock() checks this
    /// against the token's real balanceOf(this) before recording a new
    /// lock, so a factory bug that tries to over-record a lock beyond what
    /// was actually transferred in gets rejected here rather than silently
    /// accepted. Also what rescueToken() below is not allowed to touch.
    mapping(address => uint256) public totalLocked;

    event FactorySet(address indexed factory);
    event Locked(uint256 indexed lockId, address indexed lpToken, address indexed owner, uint256 amount, uint256 unlockTime);
    event Withdrawn(uint256 indexed lockId, address indexed owner, uint256 amount);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    modifier onlyFactory() {
        require(msg.sender == factory, "LiquidityLocker: caller is not the factory");
        _;
    }

    constructor() Ownable(msg.sender) {}

    /// @notice One-time wiring step: point this locker at the TokenFactory
    /// that's allowed to create locks in it. Callable once by the deployer.
    function setFactory(address factory_) external onlyOwner {
        require(factory == address(0), "LiquidityLocker: factory already set");
        require(factory_ != address(0), "LiquidityLocker: invalid factory");
        factory = factory_;
        emit FactorySet(factory_);
    }

    /// @notice Blocked until a factory is wired, so an out-of-order deploy
    /// mistake (renouncing before setFactory() ever runs) can't strand this
    /// instance permanently — with no owner left, factory would be stuck at
    /// address(0) forever and this locker could never hold anything.
    function renounceOwnership() public virtual override onlyOwner {
        require(factory != address(0), "LiquidityLocker: cannot renounce before a factory is wired");
        super.renounceOwnership();
    }

    function lock(
        address lpToken,
        address owner_,
        uint256 amount,
        uint256 unlockTime
    ) external onlyFactory returns (uint256 lockId) {
        require(lpToken != address(0), "LiquidityLocker: invalid lpToken");
        require(owner_ != address(0), "LiquidityLocker: invalid owner");
        require(amount > 0, "LiquidityLocker: amount must be > 0");
        require(unlockTime > block.timestamp, "LiquidityLocker: unlock time must be in the future");

        // Sanity guard, not a substitute for the factory's own correctness:
        // this contract must actually already hold enough of lpToken to
        // back every outstanding lock plus this new one. The real transfer
        // always happens before lock() is called (LP mints straight here
        // via addLiquidityETH's `to` parameter), so this should never fire
        // in normal operation — it exists purely to reject a miscounted or
        // duplicated lock() call rather than silently recording a claim
        // nothing backs.
        uint256 newTotalLocked = totalLocked[lpToken] + amount;
        require(
            IERC20(lpToken).balanceOf(address(this)) >= newTotalLocked,
            "LiquidityLocker: amount exceeds tokens actually held"
        );
        totalLocked[lpToken] = newTotalLocked;

        lockId = locks.length;
        locks.push(Lock({lpToken: lpToken, owner: owner_, amount: amount, unlockTime: unlockTime, withdrawn: false}));
        locksByOwner[owner_].push(lockId);
        emit Locked(lockId, lpToken, owner_, amount, unlockTime);
    }

    /// @notice Claim back LP tokens from a matured lock. Only the original
    /// creator (recorded at lock time) can call this, and only after
    /// unlockTime has passed.
    function withdraw(uint256 lockId) external {
        Lock storage l = locks[lockId];
        require(msg.sender == l.owner, "LiquidityLocker: not lock owner");
        require(block.timestamp >= l.unlockTime, "LiquidityLocker: still locked");
        require(!l.withdrawn, "LiquidityLocker: already withdrawn");

        l.withdrawn = true;
        totalLocked[l.lpToken] -= l.amount;
        bool sent = IERC20(l.lpToken).transfer(msg.sender, l.amount);
        require(sent, "LiquidityLocker: LP transfer failed");

        emit Withdrawn(lockId, msg.sender, l.amount);
    }

    /// @notice Recovers tokens sitting on this contract that were never
    /// claimed by a real lock() call — e.g. sent here directly by mistake
    /// instead of arriving as the `to` recipient of addLiquidityETH.
    /// Structurally cannot reach into anyone's locked LP: the rescuable
    /// amount is capped at this contract's actual balance minus
    /// totalLocked[token], which only ever covers real, outstanding locks.
    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        require(to != address(0), "LiquidityLocker: invalid recipient");
        uint256 rescuable = IERC20(token).balanceOf(address(this)) - totalLocked[token];
        require(amount <= rescuable, "LiquidityLocker: amount exceeds rescuable balance");

        bool sent = IERC20(token).transfer(to, amount);
        require(sent, "LiquidityLocker: rescue transfer failed");

        emit TokenRescued(token, to, amount);
    }

    function locksOf(address owner_) external view returns (uint256[] memory) {
        return locksByOwner[owner_];
    }

    function lockCount() external view returns (uint256) {
        return locks.length;
    }
}
