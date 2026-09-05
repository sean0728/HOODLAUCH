// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The one thing CreatorRewardsDistributor needs from a token it
/// holds creator-reward tokens for: who its creator is. Both LaunchedToken
/// and CustomToken already expose this as a public state variable (an
/// implicit getter) — no changes were needed on either contract beyond this
/// interface declaring the same shape, so a creator transfer on CustomToken
/// (transferCreator/acceptCreator) is always reflected here automatically,
/// never a stale snapshot. Same "depend on the minimal shape, not the
/// concrete contract" approach as IPlatformToken.
interface ICreatorAware {
    function creator() external view returns (address);
}
