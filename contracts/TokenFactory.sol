// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import "./LaunchedToken.sol";
import "./LiquidityLocker.sol";
import "./interfaces/IUniswapV2Router02.sol";

/// @title TokenFactory
/// @notice The entry point for a launch. Every launch starts with
/// createToken(), which picks one of two completely different paths:
///
///  - addLiquidityAtLaunch = false ("Deploy Token"): create + verify only.
///    100% of the supply mints straight into msg.sender's own wallet. No
///    pool, no tax, no further on-chain involvement from this contract at
///    all — the transaction is over the moment it confirms. Adding
///    liquidity anywhere, any time, by whatever means, is entirely the
///    creator's own responsibility from here. Costs a flat deployFee.
///
///  - addLiquidityAtLaunch = true ("Deploy and Add Liquidity (Launch)"):
///    token creation and liquidity provisioning happen atomically, in this
///    same transaction. 100% of the supply is minted to this factory,
///    paired against the creator's ETH into a real DEX pool, and the
///    resulting LP tokens are locked to the creator for lpLockDuration
///    starting right now (see LiquidityLocker) — the creator can never pull
///    it back out early. The token also gets a feeBps transfer tax on
///    trades against that pool, routed to platformFeeWallet, until the
///    pool's live market cap crosses graduationTargetUsd, at which point
///    the tax permanently disables itself (see LaunchedToken). An optional
///    creatorBuyEthAmount, on top of the liquidity, executes an ordinary
///    buy against the pool in this same transaction — guaranteed to be the
///    first trade against it, but capped at maxCreatorBuyBps of totalSupply
///    (default 5%) as an anti-rug safeguard: a buy-in that would land above
///    the cap reverts the whole launch instead of partially executing.
///    Costs a flat launchFee, separate from (and normally higher than)
///    deployFee, on top of the liquidity/buy-in ETH.
///
/// deployFee and launchFee are each a fixed wei amount set by the owner
/// (see setDeployFee/setLaunchFee) — this contract has no live USD/ETH
/// price awareness of its own, so keeping them tracking a USD target (e.g.
/// $50 / $100) as ETH's price moves is an off-chain job: the front end
/// reads these values live before building a transaction, and the owner
/// (or a scheduled script — see scripts/updateFees.js) is expected to
/// update them periodically against a live ETH/USD price.
contract TokenFactory is Ownable2Step, ReentrancyGuard {
    address public immutable tokenImplementation;
    IUniswapV2Router02 public immutable router;
    LiquidityLocker public immutable locker;

    uint256 public deployFee; // "Deploy Token" — create + verify only, no liquidity
    uint256 public launchFee; // "Deploy and Add Liquidity (Launch)" — atomic creation + pool
    address public feeTreasury;
    uint256 public lpLockDuration;

    // ---- transfer-tax defaults, applied to every "Launch + Add Liquidity"
    // pool created after a change (existing pools keep whatever they were
    // created with — see LaunchedToken.configureTax) ----
    address public platformFeeWallet;
    uint256 public feeBps = 25; // 0.25%
    address public priceFeed;
    uint256 public graduationTargetUsd = 80_000; // whole dollars; tax permanently disables once a pool's live market cap crosses this
    uint256 public maxOracleStaleness = 1 hours;

    /// @notice PlatformRewardsDistributor's address — the platform's own
    /// buyback/burn/holder-airdrop contract. address(0) (the default)
    /// disables this entirely: every deployFee/launchFee stays 100%
    /// feeTreasury (see _finalizeLaunch below), and every launch from here
    /// on configures its token with no reward diversion at all (see
    /// LaunchedToken.configureTax). Set once, via setRewardsDistributor,
    /// whenever the platform token itself launches — nothing about
    /// flipping this on ever touches a token or launch that already
    /// happened.
    address public rewardsDistributor;

    /// @notice Out of feeBps (the platform's ongoing 0.25% trading tax),
    /// how much (in absolute bps, e.g. 10 = 0.10%) gets diverted to
    /// rewardsDistributor instead of platformFeeWallet — carved OUT OF
    /// feeBps, never added on top of it. Must stay <= feeBps (enforced in
    /// setTaxDefaults); has no effect at all while rewardsDistributor is
    /// unset. Snapshotted per-token at launch, same as every other tax
    /// default here.
    uint256 public rewardBps = 10; // 0.10%

    /// @notice CreatorRewardsDistributor's address — pays a slice of the
    /// ongoing trading tax back to each token's own creator, in native ETH,
    /// claimable per token (see CreatorRewardsDistributor.sol). address(0)
    /// (the default) disables this entirely: every launch from here on
    /// configures its token with no creator-reward diversion at all. Set
    /// once, via setCreatorRewardsDistributor — nothing about flipping this
    /// on ever touches a token or launch that already happened, same
    /// convention as rewardsDistributor above.
    address public creatorRewardsDistributor;

    /// @notice Out of feeBps, how much (absolute bps) gets diverted to
    /// creatorRewardsDistributor instead of platformFeeWallet — carved OUT
    /// OF feeBps, never added on top of it, and never overlapping
    /// rewardBps above (rewardBps + creatorRewardBps must stay <= feeBps,
    /// enforced in setTaxDefaults). Has no effect at all while
    /// creatorRewardsDistributor is unset. Snapshotted per-token at launch,
    /// same as every other tax default here.
    uint256 public creatorRewardBps = 5; // 0.05%

    // ---- anti-rug safeguard on the creator's own same-transaction buy-in
    // (see _launchWithLiquidity) ----
    uint256 public maxCreatorBuyBps = 500; // 5.00% of totalSupply_ by default

    /// @notice Slippage tolerance applied to addLiquidityETH()'s own
    /// amountTokenMin/amountETHMin — protects the initial liquidity seed
    /// against a bot that manipulates the pair's reserves between when this
    /// transaction is submitted and when it actually lands (e.g. donating
    /// tokens/ETH straight to the pair, or racing another swap into the
    /// same block), which would otherwise let the router accept a far worse
    /// price than the creator intended with the old amountTokenMin=0/
    /// amountETHMin=0. Router itself still reverts the whole launch
    /// (liquidity add included) if the actual amounts land outside this
    /// band, rather than silently accepting a bad fill. Owner-adjustable
    /// within a fixed 5.00%–8.00% band (see setLiquiditySlippageBps) — wide
    /// enough to absorb ordinary reserve noise, never so wide it stops
    /// meaning anything.
    uint256 public liquiditySlippageBps = 600; // 6.00% default, i.e. the midpoint of the allowed band
    uint256 public constant MIN_LIQUIDITY_SLIPPAGE_BPS = 500; // 5.00%
    uint256 public constant MAX_LIQUIDITY_SLIPPAGE_BPS = 800; // 8.00%

    /// @dev floor = amount minus liquiditySlippageBps of it, i.e. the
    /// smallest amount addLiquidityETH is allowed to actually use.
    function _minWithSlippage(uint256 amount) private view returns (uint256) {
        return amount - (amount * liquiditySlippageBps) / 10_000;
    }

    /// @notice Same protection as liquiditySlippageBps, applied to the
    /// creator's own same-transaction buy-in instead of the liquidity add —
    /// that swap trades against a pool that now genuinely has reserves, so
    /// unlike a virgin addLiquidityETH call, it's a real, sandwichable
    /// trade. Owner-adjustable within the same fixed 5.00%–8.00% band (see
    /// setBuyInSlippageBps). This is a FLOOR only: the caller-supplied
    /// minCreatorTokensOut still applies too, whichever is stricter wins
    /// (see _effectiveMinBuyOut) — this never loosens a caller's own tighter
    /// request, only backstops a missing or lazy one (the front end
    /// currently always sends 0).
    uint256 public buyInSlippageBps = 600; // 6.00% default, i.e. the midpoint of the allowed band

    /// @dev Standard Uniswap V2 constant-product quote (0.30% swap fee
    /// baked into the 997/1000 constants — the near-universal fee for a
    /// V2-style router, which is what this contract's IUniswapV2Router02
    /// interface targets). Used only to derive a slippage floor below,
    /// never to execute anything — a router charging a different fee makes
    /// this an approximation of the real quote, which is fine since it only
    /// ever sets a protective floor, not the trade itself.
    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) private pure returns (uint256) {
        uint256 amountInWithFee = amountIn * 997;
        uint256 numerator = amountInWithFee * reserveOut;
        uint256 denominator = reserveIn * 1000 + amountInWithFee;
        return numerator / denominator;
    }

    /// @dev Computes the buy-in's protective floor from the pool's own
    /// just-added reserves (known exactly — this is always that pool's
    /// first-ever liquidity), nets out feeBps first (the tax this exact
    /// trade will pay, so the tax itself is never mistaken for hostile
    /// slippage), then applies buyInSlippageBps — and returns whichever is
    /// stricter, that floor or the caller's own minCreatorTokensOut.
    function _effectiveMinBuyOut(
        uint256 creatorBuyEthAmount,
        uint256 ethReserve,
        uint256 tokenReserve,
        uint256 callerMinOut
    ) private view returns (uint256) {
        uint256 grossOut = _getAmountOut(creatorBuyEthAmount, ethReserve, tokenReserve);
        uint256 expectedNetOut = grossOut - (grossOut * feeBps) / 10_000;
        uint256 floor = expectedNetOut - (expectedNetOut * buyInSlippageBps) / 10_000;
        return callerMinOut > floor ? callerMinOut : floor;
    }

    mapping(address => address) public creatorOf;
    mapping(address => address) public pairOf; // token => its DEX pair, or address(0) for a "Just Launch" token
    address[] private _tokenList;
    mapping(address => address[]) private _tokensByCreator;

    // ---- gasless relayed launches ----
    //
    // Normal flow (createToken above): the creator's own wallet submits the
    // deploy transaction directly and pays its gas out of pocket, same as
    // any blockchain transaction — that gas is separate from and in
    // addition to deployFee/launchFee.
    //
    // Relayed flow (below): the creator instead (1) signs a LaunchVoucher
    // off-chain — free, no gas, an EIP-712 typed message committing to the
    // exact launch parameters — then (2) sends ONE plain ETH transfer into
    // escrow via depositForRelayedLaunch (a cheap, simple deposit, NOT the
    // expensive deploy/liquidity transaction). A trusted `relayer` address
    // (a platform-operated hot wallet, see setRelayer) then calls
    // relayedCreateToken, paying gas out of ITS OWN balance to actually
    // perform the deploy (and, for the liquidity path, the pool seeding).
    // In that same transaction, the contract measures the gas the relayer
    // just spent, reimburses exactly that (capped — see
    // maxRelayerGasReimbursementWei) back to the relayer out of the
    // escrowed fee, and only THEN splits the true remainder 50/50 between
    // feeTreasury and rewardsDistributor (or 100% feeTreasury if
    // rewardsDistributor is unset) — identical payout rule to
    // _finalizeLaunch, just applied to what's left after gas rather than
    // the raw fee.
    //
    // If the relayer never processes a deposit before its own deadline
    // (e.g. the relayer service is down), the depositor — and only the
    // depositor — can pull their full escrowed ETH back via
    // reclaimDeposit(). Deposits are keyed by (depositor address, voucher
    // hash) specifically so no one else can ever front-run or squat a
    // voucher hash that isn't theirs — a deposit under any other address
    // simply lives in a different storage slot and can never collide with
    // or block the real creator's own deposit.

    /// @notice The platform's relayer hot wallet — the only address allowed
    /// to call relayedCreateToken. address(0) (the default) disables the
    /// entire relayed-launch feature; depositForRelayedLaunch/
    /// reclaimDeposit still work either way, so a deposit made while no
    /// relayer is configured can simply be reclaimed once its deadline
    /// passes.
    address public relayer;

    /// @notice Safety cap, in wei, on how much gas reimbursement a single
    /// relayedCreateToken call can pay itself out of one voucher's fee — a
    /// circuit breaker against a compromised or malfunctioning relayer key
    /// inflating tx.gasprice to drain more than a real deploy could ever
    /// cost. 0 (the default) means no cap.
    uint256 public maxRelayerGasReimbursementWei;

    /// @dev Flat gas-unit buffer added on top of the gas actually measured
    /// via gasleft() inside relayedCreateToken, to account for the
    /// intrinsic per-transaction cost (base 21,000 + calldata) that isn't
    /// visible to gasleft() diffing from inside the call itself.
    uint256 public constant RELAY_GAS_OVERHEAD = 60_000;

    struct Deposit {
        uint256 amount;
        uint256 deadline;
        bool settled;
        bool reclaimed;
    }

    /// @notice creator => voucher hash => their escrowed deposit. Keying by
    /// creator address (rather than a flat hash => Deposit map) is what
    /// makes the whole scheme front-running-proof: depositing under someone
    /// else's address is impossible, so no one can ever claim or block a
    /// voucher hash that isn't rightfully theirs.
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
        uint256 fee; // deployFee or launchFee the creator locked in and escrowed at deposit time
        uint256 salt; // front-end-generated randomness, purely to keep two otherwise-identical vouchers from hashing the same
        uint256 deadline; // both the voucher's and the matching deposit's expiry
    }

    bytes32 private constant LAUNCH_VOUCHER_TYPEHASH = keccak256(
        "LaunchVoucher(address creator,string name,string symbol,uint256 totalSupply,bool addLiquidityAtLaunch,uint256 liquidityEthAmount,uint256 creatorBuyEthAmount,uint256 minCreatorTokensOut,uint256 fee,uint256 salt,uint256 deadline)"
    );

    // Hand-rolled EIP-712 domain separator rather than pulling in
    // OpenZeppelin's EIP712 base: that base (via MessageHashUtils ->
    // Strings -> Bytes) uses the `mcopy` opcode, which only exists from the
    // Cancun hardfork on — a hard, silent requirement this contract has no
    // business imposing on whichever EVM Robinhood Chain actually runs.
    // This does the identical ERC-5267 domain-separator construction with
    // nothing but keccak256/abi.encode, which every EVM version supports.
    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
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

    modifier onlyRelayer() {
        require(msg.sender == relayer, "TokenFactory: caller is not the relayer");
        _;
    }

    event TokenCreated(
        address indexed token,
        address indexed creator,
        string name,
        string symbol,
        uint256 totalSupply,
        bool launchedWithLiquidity,
        address pair
    );
    event LiquidityAdded(
        address indexed token,
        address indexed creator,
        uint256 ethAmount,
        uint256 tokenAmount,
        uint256 lpAmount,
        uint256 unlockTime,
        uint256 indexed lockId,
        address pair
    );
    event CreatorBought(address indexed token, address indexed creator, uint256 ethIn, uint256 tokensOut);
    event DeployFeeUpdated(uint256 newFee);
    event LaunchFeeUpdated(uint256 newFee);
    event LpLockDurationUpdated(uint256 newDuration);
    event FeeTreasuryUpdated(address newTreasury);
    event TaxDefaultsUpdated();
    event MaxCreatorBuyBpsUpdated(uint256 newBps);
    event LiquiditySlippageBpsUpdated(uint256 newBps);
    event BuyInSlippageBpsUpdated(uint256 newBps);
    event RewardsDistributorUpdated(address newDistributor);
    event CreatorRewardsDistributorUpdated(address newDistributor);
    event TokenPriceFeedUpdated(address indexed token, address newPriceFeed, uint256 newMaxOracleStaleness);

    constructor(
        address tokenImplementation_,
        address router_,
        address locker_,
        uint256 deployFee_,
        uint256 launchFee_,
        address feeTreasury_,
        uint256 lpLockDuration_,
        address platformFeeWallet_,
        address priceFeed_
    ) Ownable(msg.sender) {
        require(tokenImplementation_ != address(0), "TokenFactory: invalid token implementation");
        require(router_ != address(0), "TokenFactory: invalid router");
        require(locker_ != address(0), "TokenFactory: invalid locker");
        require(feeTreasury_ != address(0), "TokenFactory: invalid treasury");

        tokenImplementation = tokenImplementation_;
        router = IUniswapV2Router02(router_);
        locker = LiquidityLocker(locker_);
        deployFee = deployFee_;
        launchFee = launchFee_;
        feeTreasury = feeTreasury_;
        lpLockDuration = lpLockDuration_;
        platformFeeWallet = platformFeeWallet_;
        priceFeed = priceFeed_;

        _domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("HoodLaunchTokenFactory")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /// @dev See the comment on _domainSeparator for why this is hand-rolled
    /// instead of OpenZeppelin's EIP712._hashTypedDataV4.
    function _hashTypedDataV4(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator, structHash));
    }

    /// @notice Deploy a new token, in either mode. msg.value must equal
    /// deployFee exactly for "Deploy Token", or launchFee +
    /// liquidityEthAmount + creatorBuyEthAmount for "Deploy and Add
    /// Liquidity (Launch)" — liquidityEthAmount and creatorBuyEthAmount are
    /// both ignored (and must be 0) in "Deploy Token" mode.
    function createToken(
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        bool addLiquidityAtLaunch,
        uint256 liquidityEthAmount,
        uint256 creatorBuyEthAmount,
        uint256 minCreatorTokensOut
    ) external payable nonReentrant returns (address token, uint256 lpAmount, uint256 lockId, uint256 creatorTokensBought) {
        require(bytes(name_).length > 0, "TokenFactory: name required");
        require(bytes(symbol_).length > 0, "TokenFactory: symbol required");
        require(totalSupply_ > 0, "TokenFactory: supply must be > 0");

        token = Clones.clone(tokenImplementation);
        address pair;
        uint256 feeCollected;

        if (!addLiquidityAtLaunch) {
            require(msg.value == deployFee, "TokenFactory: incorrect ETH sent for Deploy Token");
            feeCollected = deployFee;
            LaunchedToken(token).initialize(name_, symbol_, totalSupply_, msg.sender, msg.sender, address(this));
        } else {
            (lpAmount, lockId, creatorTokensBought, pair) = _createWithLiquidity(
                token,
                name_,
                symbol_,
                totalSupply_,
                liquidityEthAmount,
                creatorBuyEthAmount,
                minCreatorTokensOut
            );
            pairOf[token] = pair;
            feeCollected = launchFee;
        }

        _finalizeLaunch(token, feeCollected);

        emit TokenCreated(token, msg.sender, name_, symbol_, totalSupply_, addLiquidityAtLaunch, pair);
    }

    /// @dev Validates the ETH split and runs LaunchedToken.initialize() for
    /// the "Deploy and Add Liquidity (Launch)" path, then hands off to
    /// _launchWithLiquidity() for the rest. Split out purely to keep
    /// createToken()'s own stack shallow enough to compile.
    function _createWithLiquidity(
        address token,
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        uint256 liquidityEthAmount,
        uint256 creatorBuyEthAmount,
        uint256 minCreatorTokensOut
    ) internal returns (uint256 lpAmount, uint256 lockId, uint256 creatorTokensBought, address pair) {
        require(msg.value >= launchFee, "TokenFactory: launch fee not met");
        require(
            msg.value - launchFee == liquidityEthAmount + creatorBuyEthAmount,
            "TokenFactory: msg.value doesn't match liquidity + buy-in"
        );
        LaunchedToken(token).initialize(name_, symbol_, totalSupply_, msg.sender, address(this), address(this));
        (lpAmount, lockId, creatorTokensBought, pair) = _launchWithLiquidity(
            token,
            totalSupply_,
            liquidityEthAmount,
            creatorBuyEthAmount,
            minCreatorTokensOut
        );
    }

    function _finalizeLaunch(address token, uint256 feeCollected) internal {
        // Effects before interactions: every piece of this factory's own
        // state for `token` is finalized before the external call(s)
        // below, so a reentrant call during a fee transfer (e.g. a
        // malicious or buggy feeTreasury/rewardsDistributor) can never
        // observe this launch half-recorded.
        creatorOf[token] = msg.sender;
        _tokensByCreator[msg.sender].push(token);
        _tokenList.push(token);

        if (feeCollected == 0) return;

        // 50% of every deployFee/launchFee stays platform profit exactly as
        // before; the other 50% funds the platform's own buyback/burn/
        // holder-rewards contract, once one is configured. While
        // rewardsDistributor is unset, this is 100% feeTreasury, byte-for-
        // byte the same behavior this contract has always had.
        if (rewardsDistributor != address(0)) {
            uint256 toRewards = feeCollected / 2;
            uint256 toTreasury = feeCollected - toRewards;
            if (toRewards > 0) {
                (bool sentRewards, ) = rewardsDistributor.call{value: toRewards}("");
                require(sentRewards, "TokenFactory: rewards transfer failed");
            }
            (bool sent, ) = feeTreasury.call{value: toTreasury}("");
            require(sent, "TokenFactory: fee transfer failed");
        } else {
            (bool sent, ) = feeTreasury.call{value: feeCollected}("");
            require(sent, "TokenFactory: fee transfer failed");
        }
    }

    /// @notice Computes the exact EIP-712 digest a creator must sign to
    /// authorize a relayed launch. Front ends call this (or reproduce it
    /// off-chain with an identical typed-data structure) to build the
    /// eth_signTypedData_v4 payload, and it's recomputed here again inside
    /// relayedCreateToken to check the relayer-submitted voucher against
    /// that signature.
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

    /// @notice Step 2 of a relayed launch (step 1 is signing the voucher
    /// off-chain, for free): the creator sends exactly
    /// voucher.fee + (liquidity + buy-in, if addLiquidityAtLaunch) as a
    /// plain ETH transfer, keyed by their own address and this exact
    /// voucher's hash. Cheap — an ordinary transfer plus one storage write,
    /// nowhere near the gas a real deploy (let alone deploy + seed
    /// liquidity) costs. msg.sender is always the escrow's owner for this
    /// hash: depositing under someone else's address is impossible, so a
    /// deposit here can never be front-run or squatted by anyone but the
    /// creator themselves.
    function depositForRelayedLaunch(bytes32 voucherHash, uint256 deadline) external payable nonReentrant {
        require(msg.value > 0, "TokenFactory: no ETH sent");
        require(deadline > block.timestamp, "TokenFactory: deadline already passed");
        Deposit storage d = deposits[msg.sender][voucherHash];
        require(d.amount == 0, "TokenFactory: voucher already funded");
        d.amount = msg.value;
        d.deadline = deadline;
        emit LaunchDeposited(voucherHash, msg.sender, msg.value, deadline);
    }

    /// @notice Lets a depositor pull their full escrowed ETH back once its
    /// deadline has passed without being relayed — the safety valve if the
    /// relayer service never picks up a deposit (down, misconfigured, or
    /// simply never launched because relayer is unset).
    function reclaimDeposit(bytes32 voucherHash) external nonReentrant {
        Deposit storage d = deposits[msg.sender][voucherHash];
        require(d.amount > 0, "TokenFactory: no such deposit");
        require(!d.settled, "TokenFactory: voucher already relayed");
        require(!d.reclaimed, "TokenFactory: already reclaimed");
        require(block.timestamp > d.deadline, "TokenFactory: deadline has not passed yet");
        d.reclaimed = true;
        uint256 amount = d.amount;
        (bool sent, ) = payable(msg.sender).call{value: amount}("");
        require(sent, "TokenFactory: refund transfer failed");
        emit DepositReclaimed(voucherHash, msg.sender, amount);
    }

    /// @notice Step 3 of a relayed launch, called only by the trusted
    /// relayer: verifies the creator's signature over `voucher` and that a
    /// matching, unexpired, unsettled deposit of exactly the right amount
    /// exists, then performs the identical deploy (and, for the liquidity
    /// path, pool-seeding) logic createToken() runs — with `voucher.creator`
    /// standing in everywhere createToken() would otherwise have used
    /// msg.sender, since here msg.sender is the relayer, not the creator.
    /// Ends by reimbursing the relayer's own gas cost out of the escrowed
    /// fee and splitting the true remainder exactly as _finalizeLaunch
    /// does. The relayer pays this call's gas from its own wallet; the
    /// creator touches no gas at any point in a relayed launch.
    function relayedCreateToken(
        LaunchVoucher calldata voucher,
        bytes calldata signature
    ) external onlyRelayer nonReentrant returns (address token, uint256 lpAmount, uint256 lockId, uint256 creatorTokensBought) {
        uint256 gasStart = gasleft();

        require(block.timestamp <= voucher.deadline, "TokenFactory: voucher expired");
        require(bytes(voucher.name).length > 0, "TokenFactory: name required");
        require(bytes(voucher.symbol).length > 0, "TokenFactory: symbol required");
        require(voucher.totalSupply > 0, "TokenFactory: supply must be > 0");

        bytes32 voucherHash = hashLaunchVoucher(voucher);
        address signer = ECDSA.recover(voucherHash, signature);
        require(signer == voucher.creator, "TokenFactory: signature does not match voucher creator");

        Deposit storage d = deposits[voucher.creator][voucherHash];
        require(d.amount > 0, "TokenFactory: no matching deposit");
        require(!d.settled, "TokenFactory: voucher already relayed");
        require(!d.reclaimed, "TokenFactory: deposit already reclaimed");
        require(block.timestamp <= d.deadline, "TokenFactory: deposit expired, creator must reclaim");

        uint256 expectedDeposit = voucher.fee +
            (voucher.addLiquidityAtLaunch ? voucher.liquidityEthAmount + voucher.creatorBuyEthAmount : 0);
        require(d.amount == expectedDeposit, "TokenFactory: deposit does not match voucher amount");

        d.settled = true; // effects before interactions, same discipline as _finalizeLaunch

        token = Clones.clone(tokenImplementation);
        address pair;

        if (!voucher.addLiquidityAtLaunch) {
            LaunchedToken(token).initialize(
                voucher.name, voucher.symbol, voucher.totalSupply, voucher.creator, voucher.creator, address(this)
            );
        } else {
            LaunchedToken(token).initialize(
                voucher.name, voucher.symbol, voucher.totalSupply, voucher.creator, address(this), address(this)
            );
            (lpAmount, lockId, creatorTokensBought, pair) = _relayedLaunchWithLiquidity(
                token,
                voucher.creator,
                voucher.totalSupply,
                voucher.liquidityEthAmount,
                voucher.creatorBuyEthAmount,
                voucher.minCreatorTokensOut
            );
            pairOf[token] = pair;
        }

        creatorOf[token] = voucher.creator;
        _tokensByCreator[voucher.creator].push(token);
        _tokenList.push(token);

        emit TokenCreated(token, voucher.creator, voucher.name, voucher.symbol, voucher.totalSupply, voucher.addLiquidityAtLaunch, pair);

        _settleRelayedFee(voucherHash, token, voucher.fee, gasStart);
    }

    /// @dev Relayed counterpart to _launchWithLiquidity — identical
    /// behavior, just parameterized on an explicit `creator_` everywhere
    /// the original used msg.sender, since the relayer (not the creator) is
    /// msg.sender for this call.
    function _relayedLaunchWithLiquidity(
        address token,
        address creator_,
        uint256 totalSupply_,
        uint256 liquidityEthAmount,
        uint256 creatorBuyEthAmount,
        uint256 minCreatorTokensOut
    ) internal returns (uint256 lpAmount, uint256 lockId, uint256 creatorTokensBought, address pair) {
        require(platformFeeWallet != address(0), "TokenFactory: platform fee wallet not configured");
        require(priceFeed != address(0), "TokenFactory: price feed not configured");
        require(liquidityEthAmount > 0, "TokenFactory: no ETH sent for liquidity");

        IERC20(token).approve(address(router), totalSupply_);
        (uint256 amountTokenUsed, uint256 amountETHUsed, uint256 lpAmountAdded) = router.addLiquidityETH{value: liquidityEthAmount}(
            token,
            totalSupply_,
            _minWithSlippage(totalSupply_),
            _minWithSlippage(liquidityEthAmount),
            address(locker),
            block.timestamp + 15 minutes
        );
        lpAmount = lpAmountAdded;

        pair = IUniswapV2FactoryMinimal(router.factory()).getPair(token, router.WETH());
        require(pair != address(0), "TokenFactory: pair not found after addLiquidityETH");

        uint256 effectiveRewardBps = rewardsDistributor != address(0) ? rewardBps : 0;
        uint256 effectiveCreatorRewardBps = creatorRewardsDistributor != address(0) ? creatorRewardBps : 0;
        LaunchedToken(token).configureTax(
            pair, platformFeeWallet, feeBps, priceFeed, graduationTargetUsd, maxOracleStaleness,
            rewardsDistributor, effectiveRewardBps, creatorRewardsDistributor, effectiveCreatorRewardBps
        );

        uint256 unlockTime = block.timestamp + lpLockDuration;
        lockId = locker.lock(pair, creator_, lpAmount, unlockTime);

        emit LiquidityAdded(token, creator_, liquidityEthAmount, totalSupply_, lpAmount, unlockTime, lockId, pair);

        if (creatorBuyEthAmount > 0) {
            address[] memory path = new address[](2);
            path[0] = router.WETH();
            path[1] = token;
            uint256 effectiveMinOut = _effectiveMinBuyOut(creatorBuyEthAmount, amountETHUsed, amountTokenUsed, minCreatorTokensOut);
            uint256 balBefore = IERC20(token).balanceOf(creator_);
            router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: creatorBuyEthAmount}(
                effectiveMinOut,
                path,
                creator_,
                block.timestamp + 15 minutes
            );
            creatorTokensBought = IERC20(token).balanceOf(creator_) - balBefore;
            require(
                creatorTokensBought <= (totalSupply_ * maxCreatorBuyBps) / 10_000,
                "TokenFactory: creator buy-in exceeds max allowed share of supply"
            );
            emit CreatorBought(token, creator_, creatorBuyEthAmount, creatorTokensBought);
        }
    }

    /// @dev Gas-then-split settlement for a relayed launch. First
    /// reimburses the relayer for the gas it just spent submitting this
    /// very transaction (measured via gasleft() diffing, plus a flat
    /// per-tx overhead buffer, capped at maxRelayerGasReimbursementWei as a
    /// circuit breaker) — this is the "gas fees are taken from that [fee]"
    /// step. Only the true remainder after that gets split 50/50 between
    /// feeTreasury and rewardsDistributor, or 100% feeTreasury if
    /// rewardsDistributor is unset — identical rule to _finalizeLaunch,
    /// just applied to the post-gas remainder instead of the raw fee.
    function _settleRelayedFee(bytes32 voucherHash, address token, uint256 feeCollected, uint256 gasStart) internal {
        if (feeCollected == 0) return;

        uint256 gasUsed = (gasStart - gasleft()) + RELAY_GAS_OVERHEAD;
        uint256 gasReimbursement = gasUsed * tx.gasprice;
        if (maxRelayerGasReimbursementWei > 0 && gasReimbursement > maxRelayerGasReimbursementWei) {
            gasReimbursement = maxRelayerGasReimbursementWei;
        }
        if (gasReimbursement > feeCollected) {
            gasReimbursement = feeCollected; // relayer eats any shortfall rather than the launch reverting over it
        }

        if (gasReimbursement > 0) {
            (bool sentGas, ) = payable(relayer).call{value: gasReimbursement}("");
            require(sentGas, "TokenFactory: relayer gas reimbursement failed");
        }

        uint256 netFee = feeCollected - gasReimbursement;
        uint256 toRewards;
        uint256 toTreasury;
        if (netFee > 0) {
            if (rewardsDistributor != address(0)) {
                toRewards = netFee / 2;
                toTreasury = netFee - toRewards;
                if (toRewards > 0) {
                    (bool sentRewards, ) = rewardsDistributor.call{value: toRewards}("");
                    require(sentRewards, "TokenFactory: rewards transfer failed");
                }
                (bool sent, ) = feeTreasury.call{value: toTreasury}("");
                require(sent, "TokenFactory: fee transfer failed");
            } else {
                toTreasury = netFee;
                (bool sent, ) = feeTreasury.call{value: netFee}("");
                require(sent, "TokenFactory: fee transfer failed");
            }
        }

        emit RelayedFeeSettled(voucherHash, token, feeCollected, gasReimbursement, toTreasury, toRewards);
    }

    /// @dev Everything specific to seeding the pool itself, split out of
    /// _createWithLiquidity() to keep stack depth shallow. Seeds the pool
    /// with the full token supply, points the token's tax at the resulting
    /// pair, locks the LP to the creator, and optionally executes the
    /// creator's same-transaction buy-in — capped at maxCreatorBuyBps of
    /// totalSupply_ as an anti-rug safeguard (see the require below).
    function _launchWithLiquidity(
        address token,
        uint256 totalSupply_,
        uint256 liquidityEthAmount,
        uint256 creatorBuyEthAmount,
        uint256 minCreatorTokensOut
    ) internal returns (uint256 lpAmount, uint256 lockId, uint256 creatorTokensBought, address pair) {
        require(platformFeeWallet != address(0), "TokenFactory: platform fee wallet not configured");
        require(priceFeed != address(0), "TokenFactory: price feed not configured");
        require(liquidityEthAmount > 0, "TokenFactory: no ETH sent for liquidity");

        IERC20(token).approve(address(router), totalSupply_);
        (uint256 amountTokenUsed, uint256 amountETHUsed, uint256 lpAmountAdded) = router.addLiquidityETH{value: liquidityEthAmount}(
            token,
            totalSupply_,
            _minWithSlippage(totalSupply_), // 5–8% slippage tolerance — see liquiditySlippageBps
            _minWithSlippage(liquidityEthAmount),
            address(locker), // LP tokens mint straight to the locker — never pass through this factory
            block.timestamp + 15 minutes
        );
        lpAmount = lpAmountAdded;

        pair = IUniswapV2FactoryMinimal(router.factory()).getPair(token, router.WETH());
        require(pair != address(0), "TokenFactory: pair not found after addLiquidityETH");

        // rewardBps only ever actually applies once rewardsDistributor is
        // set — netting it to 0 here (rather than trusting the stored
        // default) means rewardBps can safely be pre-configured (its
        // default above is nonzero) well before the platform token or its
        // distributor exist, with zero effect on any launch until
        // setRewardsDistributor is actually called.
        uint256 effectiveRewardBps = rewardsDistributor != address(0) ? rewardBps : 0;
        uint256 effectiveCreatorRewardBps = creatorRewardsDistributor != address(0) ? creatorRewardBps : 0;
        LaunchedToken(token).configureTax(
            pair, platformFeeWallet, feeBps, priceFeed, graduationTargetUsd, maxOracleStaleness,
            rewardsDistributor, effectiveRewardBps, creatorRewardsDistributor, effectiveCreatorRewardBps
        );

        uint256 unlockTime = block.timestamp + lpLockDuration;
        lockId = locker.lock(pair, msg.sender, lpAmount, unlockTime);

        emit LiquidityAdded(token, msg.sender, liquidityEthAmount, totalSupply_, lpAmount, unlockTime, lockId, pair);

        // Optional creator buy-in: an ordinary swap against the pool that
        // was just created above, in the same transaction, sent to
        // msg.sender like any other buyer's swap would be — including
        // paying the tax just configured above, same as anyone else's buy
        // would. Nothing here mints tokens or bypasses the pool's pricing.
        //
        // Anti-rug cap: capped at maxCreatorBuyBps of totalSupply_, checked
        // against the actual net tokens the creator received (post-tax),
        // not an estimate — so there's no way to structure a buy-in that
        // lands over the cap. A buy-in that would exceed it reverts the
        // entire launch (liquidity add included), rather than silently
        // clamping the swap or letting it through — the creator resubmits
        // with a smaller buyEthAmount instead.
        if (creatorBuyEthAmount > 0) {
            address[] memory path = new address[](2);
            path[0] = router.WETH();
            path[1] = token;
            uint256 effectiveMinOut = _effectiveMinBuyOut(creatorBuyEthAmount, amountETHUsed, amountTokenUsed, minCreatorTokensOut);
            uint256 balBefore = IERC20(token).balanceOf(msg.sender);
            router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: creatorBuyEthAmount}(
                effectiveMinOut,
                path,
                msg.sender,
                block.timestamp + 15 minutes
            );
            creatorTokensBought = IERC20(token).balanceOf(msg.sender) - balBefore;
            require(
                creatorTokensBought <= (totalSupply_ * maxCreatorBuyBps) / 10_000,
                "TokenFactory: creator buy-in exceeds max allowed share of supply"
            );
            emit CreatorBought(token, msg.sender, creatorBuyEthAmount, creatorTokensBought);
        }
    }

    function tokensOf(address creator_) external view returns (address[] memory) {
        return _tokensByCreator[creator_];
    }

    function allTokens() external view returns (address[] memory) {
        return _tokenList;
    }

    // ---- admin ----

    /// @notice Updates the flat fee for "Deploy Token" (no liquidity). See
    /// the contract-level note above on why this is a fixed wei amount —
    /// keeping it near a USD target (e.g. $50) as ETH's price moves is the
    /// caller's job, typically via scripts/updateFees.js on a schedule.
    function setDeployFee(uint256 newFee) external onlyOwner {
        deployFee = newFee;
        emit DeployFeeUpdated(newFee);
    }

    /// @notice Updates the flat fee for "Deploy and Add Liquidity (Launch)",
    /// charged on top of the liquidity/buy-in ETH. See setDeployFee.
    function setLaunchFee(uint256 newFee) external onlyOwner {
        launchFee = newFee;
        emit LaunchFeeUpdated(newFee);
    }

    function setLpLockDuration(uint256 newDuration) external onlyOwner {
        lpLockDuration = newDuration;
        emit LpLockDurationUpdated(newDuration);
    }

    function setFeeTreasury(address newTreasury) external onlyOwner {
        require(newTreasury != address(0), "TokenFactory: invalid treasury");
        feeTreasury = newTreasury;
        emit FeeTreasuryUpdated(newTreasury);
    }

    /// @notice Updates the anti-rug ceiling on a creator's own
    /// same-transaction buy-in, in bps of totalSupply_ (500 = 5.00%).
    /// Applies to launches from this point forward — a launch already
    /// mined keeps whatever cap was in effect when it ran, same as every
    /// other "applies going forward" setting here.
    function setMaxCreatorBuyBps(uint256 newBps) external onlyOwner {
        require(newBps <= 10_000, "TokenFactory: bps cannot exceed 100%");
        maxCreatorBuyBps = newBps;
        emit MaxCreatorBuyBpsUpdated(newBps);
    }

    /// @notice Adjusts the addLiquidityETH slippage tolerance, kept to a
    /// fixed 5.00%–8.00% band on purpose — narrow enough that it never
    /// stops meaning anything, wide enough to cover ordinary reserve noise
    /// without the launch spuriously reverting. Applies to every launch
    /// (direct or gasless-relayed) from this point forward; a launch
    /// already in flight uses whatever value was in effect when it read it.
    function setLiquiditySlippageBps(uint256 newBps) external onlyOwner {
        require(newBps >= MIN_LIQUIDITY_SLIPPAGE_BPS, "TokenFactory: slippage below 5% floor");
        require(newBps <= MAX_LIQUIDITY_SLIPPAGE_BPS, "TokenFactory: slippage above 8% ceiling");
        liquiditySlippageBps = newBps;
        emit LiquiditySlippageBpsUpdated(newBps);
    }

    /// @notice Adjusts the creator buy-in's slippage tolerance, same fixed
    /// 5.00%–8.00% band as setLiquiditySlippageBps, for the same reasons.
    function setBuyInSlippageBps(uint256 newBps) external onlyOwner {
        require(newBps >= MIN_LIQUIDITY_SLIPPAGE_BPS, "TokenFactory: slippage below 5% floor");
        require(newBps <= MAX_LIQUIDITY_SLIPPAGE_BPS, "TokenFactory: slippage above 8% ceiling");
        buyInSlippageBps = newBps;
        emit BuyInSlippageBpsUpdated(newBps);
    }

    /// @notice Points deployFee/launchFee's 50% rewards share, and every
    /// future launch's per-token reward diversion, at a
    /// PlatformRewardsDistributor. address(0) disables the entire feature
    /// (see _finalizeLaunch and rewardBps above) — fully reversible, and
    /// never touches a token or launch that already happened.
    function setRewardsDistributor(address newDistributor) external onlyOwner {
        rewardsDistributor = newDistributor;
        emit RewardsDistributorUpdated(newDistributor);
    }

    /// @notice See setRewardsDistributor above — identical convention,
    /// separate distributor. Wired once, whenever CreatorRewardsDistributor
    /// is deployed; nothing about flipping this on ever touches a token or
    /// launch that already happened.
    function setCreatorRewardsDistributor(address newDistributor) external onlyOwner {
        creatorRewardsDistributor = newDistributor;
        emit CreatorRewardsDistributorUpdated(newDistributor);
    }

    /// @notice Points relayedCreateToken's onlyRelayer gate at the
    /// platform's relayer hot wallet. address(0) (the default) disables
    /// gasless relayed launches entirely — depositForRelayedLaunch still
    /// accepts deposits either way, so anything deposited while this is
    /// unset just sits there reclaimable once its deadline passes, rather
    /// than being stuck. Fully reversible, and never touches a launch that
    /// already happened.
    function setRelayer(address newRelayer) external onlyOwner {
        relayer = newRelayer;
        emit RelayerUpdated(newRelayer);
    }

    /// @notice Updates the circuit-breaker cap on how much gas
    /// reimbursement a single relayedCreateToken call can pay itself, in
    /// wei. 0 means no cap. Protects against a compromised or
    /// malfunctioning relayer key inflating tx.gasprice to drain more than
    /// a real deploy could plausibly cost.
    function setMaxRelayerGasReimbursement(uint256 newCapWei) external onlyOwner {
        maxRelayerGasReimbursementWei = newCapWei;
        emit MaxRelayerGasReimbursementUpdated(newCapWei);
    }

    /// @notice Update the tax defaults applied to pools created from this
    /// point forward. Existing tokens are unaffected — each one snapshots
    /// these values into its own storage the moment configureTax() runs.
    /// platformFeeWallet_ and priceFeed_ may still be set to address(0)
    /// deliberately — that's the documented way to leave the platform tax
    /// unconfigured for launches going forward (_launchWithLiquidity simply
    /// refuses to launch until both are set again). feeBps_,
    /// graduationTargetUsd_, and maxOracleStaleness_ get real bounds below
    /// so a mistyped value can't silently brick every future launch's
    /// transfers (feeBps_ above 10,000) or defeat the tax from block one
    /// (graduationTargetUsd_ == 0) — mirrors the same-style bound already
    /// enforced on setMaxCreatorBuyBps. rewardBps_ is the new addition: how
    /// much of feeBps_ gets carved off to rewardsDistributor going
    /// forward — must never exceed feeBps_ itself, same reasoning as every
    /// other bound here.
    function setTaxDefaults(
        address platformFeeWallet_,
        uint256 feeBps_,
        address priceFeed_,
        uint256 graduationTargetUsd_,
        uint256 maxOracleStaleness_,
        uint256 rewardBps_,
        uint256 creatorRewardBps_
    ) external onlyOwner {
        require(feeBps_ <= 10_000, "TokenFactory: feeBps cannot exceed 100%");
        require(graduationTargetUsd_ > 0, "TokenFactory: graduation target must be > 0");
        require(maxOracleStaleness_ > 0, "TokenFactory: oracle staleness must be > 0");
        require(rewardBps_ + creatorRewardBps_ <= feeBps_, "TokenFactory: rewardBps+creatorRewardBps cannot exceed feeBps");
        platformFeeWallet = platformFeeWallet_;
        feeBps = feeBps_;
        priceFeed = priceFeed_;
        graduationTargetUsd = graduationTargetUsd_;
        maxOracleStaleness = maxOracleStaleness_;
        rewardBps = rewardBps_;
        creatorRewardBps = creatorRewardBps_;
        emit TaxDefaultsUpdated();
    }

    /// @notice Escape hatch for an already-launched token whose price feed
    /// has gone permanently stale or was never a real, maintained feed —
    /// see LaunchedToken.updatePriceFeed. Owner-only, and deliberately
    /// narrow: this can only repoint that one token's oracle inputs, never
    /// its fee rate, fee wallet, pair, or taxActive directly. Graduation
    /// still requires the same market-cap/confirmation-window check as
    /// ever; this only unblocks that path from behind a dead oracle.
    function updateTokenPriceFeed(address token, address newPriceFeed_, uint256 newMaxOracleStaleness_) external onlyOwner {
        LaunchedToken(token).updatePriceFeed(newPriceFeed_, newMaxOracleStaleness_);
        emit TokenPriceFeedUpdated(token, newPriceFeed_, newMaxOracleStaleness_);
    }
}
