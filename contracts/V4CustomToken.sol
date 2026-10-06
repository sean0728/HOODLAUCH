// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title V4CustomToken
/// @notice The ERC20 behind V4 "Custom Tax" launches (EIP-1167 clone). It is the
/// V4 counterpart of V2's CustomToken, with one structural difference: on V2
/// the token's own _update() skimmed every transfer that touched the pair and
/// swapped the proceeds on the spot. On V4 the TRADING FEE LIVES IN THE HOOK
/// (V4TaxHook takes it from the token leg of each swap), so this token is a
/// plain ERC20 plus the bookkeeping the fee components need:
///
///   - reflection  : the hook sends the reflection share to this contract and
///                   calls notifyReflection(); holders then claim their share
///                   (in this same token) with claimReflections(), or anyone can
///                   push it to them with claimFor(). Standard "magnified
///                   dividend per share" accounting, O(1) per transfer.
///   - marketing   : paid in-kind straight to marketingWallet (the creator can
///                   change it, see setMarketingWallet).
///   - liquidity   : delivered by the hook to the V4LiquidityCompounder, which
///                   adds it to the pool as permanent liquidity.
///   - burn        : the hook burns it on the spot (burn() below).
///
/// The per-side rates (buyFees / sellFees, each capped at 5.00% in total) are
/// fixed at initialize(), mirrored into the hook for the pool, and can never
/// change. Wallet-to-wallet transfers are never taxed.
///
/// REFLECTION ELIGIBILITY. Holdings of infrastructure (the PoolManager, the
/// liquidity locker, the hook, the compounder, the launching factory, the
/// platform distributors, the dead address, this contract) do not earn
/// reflections: they are "excluded" and their balance is left out of the share
/// base, so reflections are shared among real holders only. The excluded set is
/// fixed at initialize(); the factory can only ever ADD to it (one-way), which
/// it does for the distributors a pool is actually launched with.
///
/// The creator role is the same two-step handoff / renounce as V2. It only
/// controls the marketing wallet; it can never change a rate.
contract V4CustomToken is ERC20 {
    bool private _initialized;

    address public creator;
    address public pendingCreator;
    address public factory;
    uint256 public launchedAt;
    string private _tokenName;
    string private _tokenSymbol;

    /// @notice One side's fee split, in bps of the token amount moved by a swap.
    struct FeeSet {
        uint16 reflectionBps;
        uint16 marketingBps;
        uint16 liquidityBps;
        uint16 burnBps;
    }
    uint16 public constant MAX_TOTAL_BPS = 500; // 5.00% per side, hard cap

    FeeSet public buyFees;
    FeeSet public sellFees;
    address public marketingWallet;
    bool public reflectionsEnabled;

    /// @notice The V4 pool and hook (zero until the factory registers the pool).
    bytes32 public poolId;
    address public hook;

    uint256 public constant MAX_TOTAL_SUPPLY = 1_000_000_000_000_000 * 1e18;

    // ---- reflection accounting ----
    // MAGNITUDE is 2^64, not the usual 2^128: it keeps perShare * balance far
    // from overflowing even in adversarial corner cases (see _flush), at a
    // rounding cost of well under 1 wei per holder per distribution.
    uint256 private constant MAGNITUDE = 2 ** 64;
    uint256 public magnifiedPerShare;
    mapping(address => int256) private _corrections;
    mapping(address => uint256) public withdrawnReflections;
    mapping(address => uint256) public settledReflections; // accrued before an account was excluded
    mapping(address => bool) public isExcludedFromReflections;
    /// @notice Sum of the balances that DO earn reflections.
    uint256 public eligibleSupply;
    /// @notice Reflection tokens received while nobody eligible held any (e.g.
    /// the very first buy); folded into the next distribution.
    uint256 public unallocatedReflections;
    uint256 public totalReflectionsDistributed;
    uint256 public totalReflectionsClaimed;

    event TokenInitialized(string name, string symbol, uint256 totalSupply, address indexed creator);
    event PoolRegistered(bytes32 indexed poolId, address indexed hook);
    event MarketingWalletUpdated(address indexed newWallet);
    event ReflectionsDistributed(uint256 amount, uint256 perShareAfter);
    event ReflectionsClaimed(address indexed holder, uint256 amount);
    event ExcludedFromReflections(address indexed account);
    event TokensBurned(uint256 amount);
    event CreatorTransferStarted(address indexed previousCreator, address indexed newCreator);
    event CreatorTransferred(address indexed previousCreator, address indexed newCreator);
    event CreatorRenounced(address indexed previousCreator);

    error NotFactory();
    error NotCreator();
    error NotHook();

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }
    modifier onlyCreator() {
        if (msg.sender != creator) revert NotCreator();
        _;
    }

    // Runs exactly once, on the implementation the factory clones from.
    constructor() ERC20("", "") {
        _initialized = true;
    }

    function initialize(
        string memory name_,
        string memory symbol_,
        uint256 totalSupply_,
        address creator_,
        address mintTo_,
        address factory_,
        address marketingWallet_,
        FeeSet memory buyFees_,
        FeeSet memory sellFees_,
        address[] memory excluded_
    ) external {
        require(!_initialized, "V4CustomToken: already initialized");
        require(totalSupply_ > 0, "V4CustomToken: supply must be > 0");
        require(totalSupply_ <= MAX_TOTAL_SUPPLY, "V4CustomToken: supply too large");
        require(creator_ != address(0), "V4CustomToken: invalid creator");
        require(mintTo_ != address(0), "V4CustomToken: invalid mint recipient");
        require(factory_ != address(0), "V4CustomToken: invalid factory");

        uint256 buyTotal =
            uint256(buyFees_.reflectionBps) + buyFees_.marketingBps + buyFees_.liquidityBps + buyFees_.burnBps;
        uint256 sellTotal =
            uint256(sellFees_.reflectionBps) + sellFees_.marketingBps + sellFees_.liquidityBps + sellFees_.burnBps;
        require(buyTotal <= MAX_TOTAL_BPS, "V4CustomToken: buy tax exceeds 5%");
        require(sellTotal <= MAX_TOTAL_BPS, "V4CustomToken: sell tax exceeds 5%");
        if (buyFees_.marketingBps > 0 || sellFees_.marketingBps > 0) {
            require(marketingWallet_ != address(0), "V4CustomToken: marketing wallet required");
        }

        _initialized = true;
        _tokenName = name_;
        _tokenSymbol = symbol_;
        creator = creator_;
        factory = factory_;
        launchedAt = block.timestamp;
        buyFees = buyFees_;
        sellFees = sellFees_;
        marketingWallet = marketingWallet_;
        reflectionsEnabled = buyFees_.reflectionBps > 0 || sellFees_.reflectionBps > 0;

        // Always excluded: nobody (mint/burn), this contract, the dead address.
        isExcludedFromReflections[address(0)] = true;
        isExcludedFromReflections[address(this)] = true;
        isExcludedFromReflections[0x000000000000000000000000000000000000dEaD] = true;
        isExcludedFromReflections[factory_] = true;
        for (uint256 i = 0; i < excluded_.length; i++) {
            if (excluded_[i] != address(0)) isExcludedFromReflections[excluded_[i]] = true;
        }

        _mint(mintTo_, totalSupply_);
        emit TokenInitialized(name_, symbol_, totalSupply_, creator_);
    }

    /// @notice One-time record of the launch pool and its hook, by the factory.
    /// Also the moment the hook gains the right to call notifyReflection().
    function registerPool(bytes32 poolId_, address hook_) external onlyFactory {
        require(poolId == bytes32(0), "V4CustomToken: pool already registered");
        require(poolId_ != bytes32(0) && hook_ != address(0), "V4CustomToken: invalid pool");
        poolId = poolId_;
        hook = hook_;
        // The hook holds fee tokens for a moment while burning them.
        _excludeNow(hook_);
        emit PoolRegistered(poolId_, hook_);
    }

    function name() public view override returns (string memory) { return _tokenName; }
    function symbol() public view override returns (string memory) { return _tokenSymbol; }

    // ---------------------------------------------------------------
    // Creator role (operational levers only; never a rate)
    // ---------------------------------------------------------------

    function setMarketingWallet(address newWallet) external onlyCreator {
        require(newWallet != address(0), "V4CustomToken: invalid wallet");
        require(buyFees.marketingBps > 0 || sellFees.marketingBps > 0, "V4CustomToken: marketing fee not active");
        marketingWallet = newWallet;
        emit MarketingWalletUpdated(newWallet);
    }

    function transferCreator(address newCreator) external onlyCreator {
        require(newCreator != address(0), "V4CustomToken: invalid creator");
        pendingCreator = newCreator;
        emit CreatorTransferStarted(creator, newCreator);
    }

    function acceptCreator() external {
        require(msg.sender == pendingCreator, "V4CustomToken: not pending creator");
        address previous = creator;
        creator = pendingCreator;
        pendingCreator = address(0);
        emit CreatorTransferred(previous, creator);
    }

    /// @notice Permanently gives up the creator role. If marketing is active the
    /// wallet stays as it is, forever.
    function renounceCreator() external onlyCreator {
        address previous = creator;
        creator = address(0);
        pendingCreator = address(0);
        emit CreatorRenounced(previous);
    }

    // ---------------------------------------------------------------
    // Burn
    // ---------------------------------------------------------------

    /// @notice Permanently destroys `amount` of the caller's own tokens. The
    /// hook uses this for the burn share of the fee.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
        emit TokensBurned(amount);
    }

    function burnFrom(address account, uint256 amount) external {
        _spendAllowance(account, msg.sender, amount);
        _burn(account, amount);
        emit TokensBurned(amount);
    }

    // ---------------------------------------------------------------
    // Reflections
    // ---------------------------------------------------------------

    /// @notice Called by the hook right after it sent `amount` tokens here.
    function notifyReflection(uint256 amount) external {
        if (msg.sender != hook || hook == address(0)) revert NotHook();
        unallocatedReflections += amount;
        _flush();
    }

    /// @notice Folds any waiting reflection tokens into the share price, if
    /// enough eligible supply exists now. Permissionless.
    function flushReflections() external {
        _flush();
    }

    /// @dev Distributes only once the eligible supply is a meaningful slice of
    /// the total (>= 1e-6), which bounds perShare * balance far below 2^255.
    /// Until then the tokens just wait in unallocatedReflections.
    function _flush() private {
        uint256 amount = unallocatedReflections;
        if (amount == 0) return;
        uint256 eligible = eligibleSupply;
        if (eligible == 0 || eligible < totalSupply() / 1_000_000) return;
        unallocatedReflections = 0;
        magnifiedPerShare += (amount * MAGNITUDE) / eligible;
        totalReflectionsDistributed += amount;
        emit ReflectionsDistributed(amount, magnifiedPerShare);
    }

    function _accumulated(address account) private view returns (uint256) {
        if (isExcludedFromReflections[account]) return 0;
        int256 v = int256(magnifiedPerShare * balanceOf(account)) + _corrections[account];
        return v <= 0 ? 0 : uint256(v) / MAGNITUDE;
    }

    /// @notice Reflection tokens `account` can claim right now.
    function pendingReflections(address account) public view returns (uint256) {
        uint256 acc = _accumulated(account);
        uint256 w = withdrawnReflections[account];
        return (acc > w ? acc - w : 0) + settledReflections[account];
    }

    /// @notice Pays the caller their reflections, in this token.
    function claimReflections() external returns (uint256) {
        return _claim(msg.sender);
    }

    /// @notice Keeper helper: pays each listed holder their own reflections.
    /// Always pays the holder, never the caller.
    function claimFor(address[] calldata holders) external returns (uint256 total) {
        for (uint256 i = 0; i < holders.length; i++) total += _claim(holders[i]);
    }

    function _claim(address account) private returns (uint256 amount) {
        _flush();
        amount = pendingReflections(account);
        if (amount == 0) return 0;
        settledReflections[account] = 0;
        if (!isExcludedFromReflections[account]) withdrawnReflections[account] = _accumulated(account);
        totalReflectionsClaimed += amount;
        // An ordinary balance move from this (excluded) contract: the receiver's
        // correction term absorbs it, so their accrued total is unchanged and
        // the amount just paid is not paid out again.
        _update(address(this), account, amount);
        emit ReflectionsClaimed(account, amount);
    }

    /// @notice One-way: the factory marks an infrastructure address as not
    /// earning reflections (it has no use for them). Anything it had already
    /// accrued stays claimable.
    function excludeFromReflections(address account) external onlyFactory {
        _excludeNow(account);
    }

    function _excludeNow(address account) private {
        if (isExcludedFromReflections[account]) return;
        uint256 acc = _accumulated(account);
        uint256 w = withdrawnReflections[account];
        settledReflections[account] += acc > w ? acc - w : 0;
        withdrawnReflections[account] = 0;
        _corrections[account] = 0;
        eligibleSupply -= balanceOf(account);
        isExcludedFromReflections[account] = true;
        emit ExcludedFromReflections(account);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (value == 0) return;
        uint256 ps = magnifiedPerShare;
        if (!isExcludedFromReflections[from]) {
            _corrections[from] += int256(ps * value);
            eligibleSupply -= value;
        }
        if (!isExcludedFromReflections[to]) {
            _corrections[to] -= int256(ps * value);
            eligibleSupply += value;
        }
    }
}
