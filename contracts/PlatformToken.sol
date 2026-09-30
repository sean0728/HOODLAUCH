// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title PlatformToken
/// @notice Hood Launch's own token — the one the platform itself launches
/// "in conjunction with the launch of the platform" (the owner's own
/// words). A plain, fixed-supply, ordinary ERC20 in every way a holder or
/// a DEX ever sees it — no tax, no transfer restrictions, nothing that
/// makes it behave differently from any other token someone could launch
/// through this same platform.
///
/// The one thing it adds on top of a stock ERC20Burnable is a live,
/// enumerable holder registry, maintained automatically in _update below,
/// because PlatformRewardsDistributor needs to be able to walk "every
/// current holder" on-chain, in a deterministic order, to push out batched
/// airdrops — see PlatformRewardsDistributor.processAirdropBatch. Nothing
/// about the registry affects transfers, balances, or supply; it's pure
/// bookkeeping alongside the ERC20 state OpenZeppelin already tracks.
///
/// The registry is a small hand-rolled swap-and-pop set (an address array
/// plus a 1-based index mapping) rather than OpenZeppelin's own
/// EnumerableSet.AddressSet — deliberately: the version of EnumerableSet
/// this project's pinned OpenZeppelin release resolves to pulls in
/// Arrays.sol helpers that use the `mcopy` opcode, which isn't available
/// under this project's target EVM version (hardhat.config.js's
/// solidity.settings leaves evmVersion at its pre-Cancun default, matching
/// Robinhood Chain's own EVM support). Avoiding the import sidesteps that
/// entirely; the logic below (append on add, swap-last-into-slot on
/// remove) is the exact same approach EnumerableSet itself uses
/// internally.
///
/// burn()/burnFrom() (via ERC20Burnable) are what PlatformRewardsDistributor
/// calls on its own balance after every buyback, to actually destroy the
/// "burn" half of each round — see PlatformRewardsDistributor._splitAndProcess.
///
/// Alongside the registry itself, holderGeneration/holderGenerationCounter
/// stamp each holder with WHEN it most recently entered the registry. This
/// exists purely so PlatformRewardsDistributor's airdrop rounds can tell a
/// genuine round-start holder apart from one that entered (or re-entered)
/// after a round had already started, even when that address happens to
/// land at a registry index the round would otherwise have treated as
/// "safe" — see holderGenerationCounter's own comment and
/// PlatformRewardsDistributor.processAirdropBatch for the full mechanics.
contract PlatformToken is ERC20, ERC20Burnable, Ownable2Step {
    address[] private _holderList;
    mapping(address => uint256) private _holderIndex; // 1-based index into _holderList; 0 means "not currently a holder"

    /// @notice Monotonically increasing counter, bumped once every time an
    /// address transitions from a zero balance to a nonzero one (i.e. every
    /// time _addHolder actually registers someone new, whether for the
    /// first time ever or re-entering after a previous exit) — see
    /// holderGeneration below and _addHolder. Added specifically so
    /// PlatformRewardsDistributor's airdrop rounds can tell a genuine
    /// round-start holder apart from an address that only entered (or
    /// re-entered) the registry after a round had already started, even
    /// when that address happens to land at a registry INDEX that existed
    /// at round start (which can happen because _removeHolder's swap-and-pop
    /// can hand a freshly-vacated low index to a brand-new holder — see
    /// PlatformRewardsDistributor.processAirdropBatch's own comment on
    /// roundGenerationAtStart for the full reasoning). Starts at 0 (no
    /// holder has ever been registered); the first holder ever added gets
    /// generation 1, matching this file's own existing 1-based
    /// _holderIndex convention.
    uint256 public holderGenerationCounter;

    /// @notice The generation stamped on `account` the most recent time it
    /// was added to the holder registry (see holderGenerationCounter
    /// above). 0 means the address has never been a holder. An address that
    /// drains to zero and is later re-added gets a NEW, higher generation —
    /// deliberately: whatever balance it holds after re-entering has no
    /// relationship to any round's supply snapshot computed before that
    /// re-entry, so it must be treated as a brand-new entrant, not as
    /// continuously eligible since its original, long-ago first entry.
    mapping(address => uint256) public holderGeneration;

    /// @param name_ Token name.
    /// @param symbol_ Token symbol.
    /// @param totalSupply_ The entire, fixed supply — minted once, here,
    /// and never again. There is no mint() function anywhere in this
    /// contract.
    /// @param initialHolder_ Where the full supply lands at construction —
    /// expected to be the deployer/admin wallet, who from there seeds
    /// liquidity (via this same platform's own launch flow or directly
    /// against the DEX router) exactly like any other token's creator
    /// would, entirely as a separate, later step from this deployment.
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 totalSupply_,
        address initialHolder_
    ) ERC20(name_, symbol_) Ownable(msg.sender) {
        require(totalSupply_ > 0, "PlatformToken: supply must be > 0");
        require(initialHolder_ != address(0), "PlatformToken: invalid initial holder");
        _mint(initialHolder_, totalSupply_);
    }

    /// @notice How many distinct addresses currently hold a nonzero
    /// balance. Grows/shrinks automatically as balances cross zero — see
    /// _update below.
    function holderCount() external view returns (uint256) {
        return _holderList.length;
    }

    /// @notice The holder address at a given registry index. Indices are
    /// NOT stable across calls that change the registry (removal is
    /// swap-and-pop, same as OpenZeppelin's EnumerableSet) — callers that
    /// need to walk the whole set across multiple transactions, like
    /// PlatformRewardsDistributor's batched airdrop, must tolerate that a
    /// holder's index can shift if someone else's balance hits zero in
    /// between. See PlatformRewardsDistributor.processAirdropBatch for how
    /// that tradeoff is handled.
    function holderAt(uint256 index) external view returns (address) {
        return _holderList[index];
    }

    /// @dev Maintains the holder registry alongside every mint, burn, and
    /// transfer. Runs after the balance change itself (super._update), so
    /// balanceOf(from)/balanceOf(to) below already reflect the new
    /// balances. Adding an address that's already present, or removing one
    /// that's already absent, is a harmless no-op.
    function _update(address from, address to, uint256 value) internal override(ERC20) {
        super._update(from, to, value);

        if (from != address(0) && balanceOf(from) == 0) {
            _removeHolder(from);
        }
        if (to != address(0) && balanceOf(to) > 0) {
            _addHolder(to);
        }
    }

    function _addHolder(address account) private {
        if (_holderIndex[account] != 0) return; // already registered
        _holderList.push(account);
        _holderIndex[account] = _holderList.length; // 1-based
        holderGenerationCounter += 1;
        holderGeneration[account] = holderGenerationCounter;
    }

    function _removeHolder(address account) private {
        uint256 idx = _holderIndex[account]; // 1-based
        if (idx == 0) return; // not registered

        uint256 lastIndex = _holderList.length; // also 1-based, since length == count
        if (idx != lastIndex) {
            address lastAccount = _holderList[lastIndex - 1];
            _holderList[idx - 1] = lastAccount;
            _holderIndex[lastAccount] = idx;
        }
        _holderList.pop();
        delete _holderIndex[account];
    }
}
