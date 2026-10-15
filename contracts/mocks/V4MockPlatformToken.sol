// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

/// @dev Test-only stand-in for PlatformToken: the same append-only holder registry and balance
/// snapshots, but any address may snapshot (the real token restricts this to owner-approved snapshotters,
/// covered by test/V4PlatformTokenAudit.test.js).
contract V4MockPlatformToken is ERC20, ERC20Burnable {
    // ---------------------------------------------------------------- holder registry

    address[] private _holderList;
    mapping(address => uint256) private _holderIndex; // 1-based; 0 = never held

    /// @notice Number of addresses ever registered (equal to holderCount()). Kept for the
    /// distributors' existing interface.
    uint256 public holderGenerationCounter;

    /// @notice The address's 1-based position in the registry; 0 = never held a balance. Set once.
    mapping(address => uint256) public holderGeneration;

    // ---------------------------------------------------------------- snapshots

    /// @dev One storage slot per checkpoint (id and value packed): a snapshot costs an account one slot
    /// write plus the array length the first time its balance changes afterwards. The constructor caps
    /// the supply at 2^128 - 1, so a balance always fits.
    struct Checkpoint {
        uint128 id;
        uint128 value;
    }

    mapping(address => Checkpoint[]) private _balanceCheckpoints;
    Checkpoint[] private _supplyCheckpoints;

    /// @notice Id of the latest snapshot; 0 = none taken yet.
    uint256 public currentSnapshotId;

    event Snapshot(uint256 id, address indexed by);

    constructor(uint256 supply) ERC20("Platform", "PLAT") {
        _mint(msg.sender, supply);
    }

    // ---------------------------------------------------------------- registry views

    /// @notice How many addresses have ever held a nonzero balance. Never decreases.
    function holderCount() external view returns (uint256) {
        return _holderList.length;
    }

    /// @notice The address at registry index `index`. Indices are stable: an entry never moves.
    function holderAt(uint256 index) external view returns (address) {
        return _holderList[index];
    }

    // ---------------------------------------------------------------- snapshots

    /// @dev Test-only: every address may snapshot, so the many distributor tests need no extra wiring.
    function isSnapshotter(address) external pure returns (bool) { return true; }

    function snapshot() external returns (uint256 id) {
        id = ++currentSnapshotId;
        emit Snapshot(id, msg.sender);
    }

    /// @notice `account`'s balance at the moment snapshot `id` was taken.
    function balanceOfAt(address account, uint256 id) public view returns (uint256) {
        (bool found, uint256 value) = _valueAt(id, _balanceCheckpoints[account]);
        return found ? value : balanceOf(account);
    }

    /// @notice Total supply at the moment snapshot `id` was taken.
    function totalSupplyAt(uint256 id) public view returns (uint256) {
        (bool found, uint256 value) = _valueAt(id, _supplyCheckpoints);
        return found ? value : totalSupply();
    }

    /// @dev The value recorded for the first checkpoint at or after `id`: it is what the account held
    /// when snapshot `id` was taken, because a checkpoint is written (with the old value) just before
    /// the first change after each snapshot. None at or after `id` means nothing changed since, so the
    /// live value is the snapshot value.
    function _valueAt(uint256 id, Checkpoint[] storage c) private view returns (bool, uint256) {
        require(id > 0 && id <= currentSnapshotId, "PlatformToken: invalid snapshot id");
        uint256 low = 0;
        uint256 high = c.length;
        while (low < high) {
            uint256 mid = (low + high) / 2;
            if (c[mid].id >= id) high = mid;
            else low = mid + 1;
        }
        if (low == c.length) return (false, 0);
        return (true, c[low].value);
    }

    function _checkpoint(Checkpoint[] storage c, uint256 valueBefore) private {
        uint256 id = currentSnapshotId;
        if (id == 0) return;
        uint256 n = c.length;
        if (n == 0 || c[n - 1].id < id) c.push(Checkpoint(uint128(id), uint128(valueBefore)));
    }

    // ---------------------------------------------------------------- transfers

    /// @dev Runs on every mint, burn and transfer. Before the balances change it records the old values
    /// for the current snapshot (once per account per snapshot); after, it registers a receiver that has
    /// never held the token. Nothing here can revert a transfer except the arithmetic of the ERC20 itself.
    function _update(address from, address to, uint256 value) internal override(ERC20) {
        if (from != address(0)) _checkpoint(_balanceCheckpoints[from], balanceOf(from));
        if (to != address(0)) _checkpoint(_balanceCheckpoints[to], balanceOf(to));
        if (from == address(0) || to == address(0)) _checkpoint(_supplyCheckpoints, totalSupply());

        super._update(from, to, value);

        if (to != address(0) && _holderIndex[to] == 0 && balanceOf(to) > 0) {
            _holderList.push(to);
            _holderIndex[to] = _holderList.length;
            holderGenerationCounter = _holderList.length;
            holderGeneration[to] = _holderList.length;
        }
    }
}
