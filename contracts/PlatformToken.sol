// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title PlatformToken
/// @notice Hood Launch's own token: a plain, fixed-supply ERC20 in every way a holder or a DEX ever
/// sees it (no tax, no transfer restrictions, no mint, no pause, no blacklist) with two additions that
/// exist only so the platform's airdrop rounds (V4PlatformTokenRewards, V4PlatformTaxDistributor) can
/// pay holders fairly:
///
///  1. An enumerable, APPEND-ONLY holder registry. An address is added the first time it holds a
///     nonzero balance and is never removed (a holder who sells everything simply holds zero and is
///     paid zero). Indices therefore never move, so a round that walks the registry over several
///     transactions cannot skip a holder or run off the end of the list. holderGeneration is the
///     address's position (1-based) and holderGenerationCounter the number of addresses registered.
///
///  2. Balance snapshots (the same idea as OpenZeppelin's ERC20Snapshot, written out here because
///     this project's pinned OpenZeppelin does not ship one and its Arrays helper needs `mcopy`).
///     An authorised snapshotter (a distributor, authorised by the owner) calls snapshot() when a
///     round starts and then reads balanceOfAt / totalSupplyAt, so every holder is paid for the
///     balance it held at that moment, whatever it does with its tokens while the round is paid out
///     over several transactions. Without this, a holder paid early could send its tokens to another
///     registered wallet that had not been paid yet and be paid twice.
///
/// Powers of the owner: it can authorise or remove snapshotters and nothing else. It cannot move,
/// freeze, mint or burn anyone's tokens. An unauthorised address cannot snapshot (otherwise anyone
/// could force a checkpoint write into every transfer); a rogue snapshotter could only make later
/// transfers cost more gas. Ownership can be renounced once the distributors are authorised.
///
/// Cost to a holder: a transfer writes an account's checkpoint only the first time its balance changes
/// after a snapshot (about 45,000 gas each for the sender and the receiver, once per snapshot), and a
/// transfer to an address that has never held the token also registers it (about 90,000 gas, once ever).
///
/// burn()/burnFrom() (ERC20Burnable) are what the distributors call after every buyback.
contract PlatformToken is ERC20, ERC20Burnable, Ownable2Step {
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

    /// @notice Addresses allowed to call snapshot(). Set by the owner.
    mapping(address => bool) public isSnapshotter;

    event Snapshot(uint256 id, address indexed by);
    event SnapshotterSet(address indexed account, bool allowed);

    /// @param name_ Token name.
    /// @param symbol_ Token symbol.
    /// @param totalSupply_ The entire, fixed supply, minted once, here. There is no mint() anywhere.
    /// @param initialHolder_ Where the full supply lands at construction (the deployer or admin wallet,
    /// who then seeds liquidity as a separate, later step).
    constructor(string memory name_, string memory symbol_, uint256 totalSupply_, address initialHolder_)
        ERC20(name_, symbol_)
        Ownable(msg.sender)
    {
        require(totalSupply_ > 0, "PlatformToken: supply must be > 0");
        require(totalSupply_ <= type(uint128).max, "PlatformToken: supply too large");
        require(initialHolder_ != address(0), "PlatformToken: invalid initial holder");
        _mint(initialHolder_, totalSupply_);
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

    /// @notice Owner only: allow or stop an address (a distributor) from taking snapshots.
    function setSnapshotter(address account, bool allowed) external onlyOwner {
        require(account != address(0), "PlatformToken: invalid snapshotter");
        isSnapshotter[account] = allowed;
        emit SnapshotterSet(account, allowed);
    }

    /// @notice Starts a new snapshot and returns its id. Authorised snapshotters only.
    function snapshot() external returns (uint256 id) {
        require(isSnapshotter[msg.sender], "PlatformToken: not a snapshotter");
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
