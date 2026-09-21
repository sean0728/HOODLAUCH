// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Test-only stand-in for TokenFactory's/CustomTokenFactory's own
/// tax-default getters (see ITokenFactoryTaxDefaults) — every value is
/// freely settable here, including combinations neither real factory's own
/// setTaxDefaults()/configurePlatformTax() would ever allow through (e.g. a
/// feeBps_ above TokenFactory.MAX_FEE_BPS, or a rewardBps_+creatorRewardBps_
/// exceeding feeBps_). Exists purely so tests can exercise
/// LaunchedToken._maybeAutoActivateTax's and CustomToken._activatePoolIfFound
/// / _maybeAutoConfigurePlatformTax's own defensive "skip this time, never
/// revert the caller's transfer" guards directly — the real factories'
/// enforced ceilings make an actually-broken combination unreachable through
/// them in practice, by design.
contract MockTaxDefaultsFactory {
    address public router;
    uint256 public feeBps;
    address public platformFeeWallet;
    address public priceFeed;
    uint256 public graduationTargetUsd = 50_000;
    uint256 public maxOracleStaleness = 3600;
    address public rewardsDistributor;
    uint256 public rewardBps;
    address public creatorRewardsDistributor;
    uint256 public creatorRewardBps;
    address public feeWalletDistributor;

    constructor(address router_) {
        router = router_;
    }

    function setRouter(address v) external { router = v; }
    function setFeeBps(uint256 v) external { feeBps = v; }
    function setPlatformFeeWallet(address v) external { platformFeeWallet = v; }
    function setPriceFeed(address v) external { priceFeed = v; }
    function setGraduationTargetUsd(uint256 v) external { graduationTargetUsd = v; }
    function setMaxOracleStaleness(uint256 v) external { maxOracleStaleness = v; }
    function setRewardsDistributor(address v) external { rewardsDistributor = v; }
    function setRewardBps(uint256 v) external { rewardBps = v; }
    function setCreatorRewardsDistributor(address v) external { creatorRewardsDistributor = v; }
    function setCreatorRewardBps(uint256 v) external { creatorRewardBps = v; }
    function setFeeWalletDistributor(address v) external { feeWalletDistributor = v; }
}
