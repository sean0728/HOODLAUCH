// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev What the token needs to learn from its launcher and the converter.
interface IV4PayoutLauncher {
    function taxSource() external view returns (IV4PayoutTaxSource);
}

interface IV4PayoutTaxSource {
    function reflectionConverter() external view returns (address);
}

interface IV4PayoutConverter {
    /// @dev Reverts unless `token` is an acceptable "pay reflections in this token" target.
    function validateTarget(address token) external view;
}

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
///                   with claimReflections(), or anyone can push it to them
///                   with claimFor() / payBatch(). Standard "magnified dividend
///                   per share" accounting, O(1) per transfer. WHAT it is paid
///                   in is chosen at launch (ReflectionPayout): this same token
///                   (in kind, the default), ETH, or another platform token.
///                   For ETH / another token the reflection tokens wait here
///                   until the platform's V4ReflectionConverter sells them
///                   (and buys the target token), then the proceeds are shared
///                   out by the same per-share accounting.
///   - marketing   : paid in ETH to marketingWallet by the hook's flush (the
///                   creator can change the wallet, see setMarketingWallet).
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
/// fixed at initialize() (the factory passes the whole list there). The factory can
/// still ADD to it afterwards (one-way, excludeFromReflections), though the
/// current factory never needs to.
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
    /// @notice Same bounds the V4TokenFactory applies: keeps the name / symbol that wallets and the
    /// page render, and every event that carries them, a sane size.
    uint256 public constant MAX_NAME_BYTES = 128;
    uint256 public constant MAX_SYMBOL_BYTES = 32;

    // ---- reflection payout (chosen at launch, never changes) ----
    /// @notice What reflections are paid in: 0 = this token (in kind), 1 = ETH, 2 = another token.
    struct ReflectionPayout {
        uint8 mode;
        address token; // mode 2 only: the token holders receive
    }
    uint8 public constant PAYOUT_IN_KIND = 0;
    uint8 public constant PAYOUT_ETH = 1;
    uint8 public constant PAYOUT_TOKEN = 2;
    uint8 public payoutMode;
    address public payoutToken;
    /// @notice The only contract allowed to take reflection tokens out for conversion and to deposit the proceeds.
    address public converter;
    /// @notice (ETH / token payouts) reflection tokens received from the hook that the converter has not sold yet.
    uint256 public pendingConversion;
    /// @notice (ETH / token payouts) payout units held for holders: shared-out but unclaimed, plus unallocated.
    uint256 public payoutHeld;
    /// @dev Gas given to a holder when ETH is pushed to them; stops a hostile holder contract from
    /// burning a batch's gas. A holder that cannot receive within it claims with claimReflectionsTo().
    uint256 private constant PAY_CALL_GAS = 100_000;

    // ---- holder list (ETH / token payouts only): lets payBatch() walk the holders on-chain ----
    // Only accounts holding at least totalSupply / TRACK_DIVISOR are listed (dust holders still accrue
    // and can claim themselves), so filling the list with throwaway wallets is expensive.
    uint256 private constant TRACK_DIVISOR = 10_000_000;
    address[] private _holders;
    mapping(address => uint256) private _holderIdx; // index + 1, 0 = not listed
    /// @notice Where the next payBatch() call starts.
    uint256 public payCursor;
    bool private _locked;

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
    event ReflectionPayoutSet(uint8 mode, address indexed payoutToken, address indexed converter);
    event ReflectionsReleased(uint256 amount);
    event ReflectionsReturned(uint256 amount);
    event PayoutDeposited(uint256 amount, uint256 perShareAfter);
    event PayoutFailed(address indexed holder, uint256 amount);
    event CreatorTransferStarted(address indexed previousCreator, address indexed newCreator);
    event CreatorTransferred(address indexed previousCreator, address indexed newCreator);
    event CreatorRenounced(address indexed previousCreator);

    error NotFactory();
    error NotCreator();
    error NotHook();
    error NotConverter();
    error Locked();
    error PayoutTransferFailed();

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }
    modifier onlyCreator() {
        if (msg.sender != creator) revert NotCreator();
        _;
    }
    modifier onlyConverter() {
        if (msg.sender != converter || converter == address(0)) revert NotConverter();
        _;
    }
    modifier lock() {
        if (_locked) revert Locked();
        _locked = true;
        _;
        _locked = false;
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
        require(bytes(name_).length > 0 && bytes(name_).length <= MAX_NAME_BYTES, "V4CustomToken: invalid name");
        require(bytes(symbol_).length > 0 && bytes(symbol_).length <= MAX_SYMBOL_BYTES, "V4CustomToken: invalid symbol");
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

    /// @notice One-time, by the factory right after initialize(): pays reflections in ETH or another
    /// token instead of in kind. Never called for the default (in kind). Needs the platform's
    /// reflection converter to be set; fixed for the token's whole life.
    function setReflectionPayout(ReflectionPayout calldata p) external onlyFactory {
        require(poolId == bytes32(0) && payoutMode == PAYOUT_IN_KIND, "V4CustomToken: payout already fixed");
        require(p.mode == PAYOUT_ETH || p.mode == PAYOUT_TOKEN, "V4CustomToken: invalid payout mode");
        require(reflectionsEnabled, "V4CustomToken: no reflection fee to pay out");
        address conv = IV4PayoutLauncher(msg.sender).taxSource().reflectionConverter();
        require(conv != address(0), "V4CustomToken: reflection converter not set");
        if (p.mode == PAYOUT_TOKEN) {
            require(p.token != address(0) && p.token != address(this), "V4CustomToken: invalid payout token");
            IV4PayoutConverter(conv).validateTarget(p.token);
            payoutToken = p.token;
        } else {
            require(p.token == address(0), "V4CustomToken: payout token only for mode 2");
        }
        payoutMode = p.mode;
        converter = conv;
        _excludeNow(conv); // the converter holds tokens only in passing and never earns
        emit ReflectionPayoutSet(p.mode, p.token, conv);
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
        if (payoutMode == PAYOUT_IN_KIND) {
            unallocatedReflections += amount;
            _flush();
        } else {
            pendingConversion += amount; // waits for the converter
        }
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

    /// @notice Pays the caller their reflections (in the token's payout asset).
    function claimReflections() external lock returns (uint256) {
        return _claim(msg.sender, msg.sender, true);
    }

    /// @notice Pays the caller's reflections to `to` instead, for a holder contract that cannot
    /// receive ETH (or the payout token) at its own address.
    function claimReflectionsTo(address to) external lock returns (uint256) {
        require(to != address(0) && to != address(this), "V4CustomToken: invalid recipient");
        return _claim(msg.sender, to, true);
    }

    /// @notice Keeper helper: pays each listed holder their own reflections.
    /// Always pays the holder, never the caller. A holder that cannot be paid (e.g. a contract that
    /// rejects ETH) is skipped and keeps what it is owed.
    function claimFor(address[] calldata holders) external lock returns (uint256 total) {
        for (uint256 i = 0; i < holders.length; i++) total += _claim(holders[i], holders[i], false);
    }

    /// @notice Automatic payout, in batches (ETH / token payouts): pays up to `maxHolders` listed
    /// holders from where the last call stopped, skipping anyone owed less than `minPayout` (they keep
    /// accruing). Anyone may call it; it only ever pays holders. Returns how many holders it looked at
    /// and how much it paid out.
    function payBatch(uint256 maxHolders, uint256 minPayout) external lock returns (uint256 processed, uint256 paid) {
        require(payoutMode != PAYOUT_IN_KIND, "V4CustomToken: batches are for ETH / token payouts");
        _flush();
        uint256 n = _holders.length;
        if (n == 0 || maxHolders == 0) return (0, 0);
        if (minPayout == 0) minPayout = 1;
        uint256 idx = payCursor % n;
        processed = maxHolders < n ? maxHolders : n;
        for (uint256 i = 0; i < processed; i++) {
            // Re-read the list every step: paying a holder runs that holder's code, which can move
            // tokens and so shrink `_holders` (swap-and-pop) in the middle of this loop. A cached
            // length would then index past the end and revert, and the same revert would repeat on
            // every retry (the cursor is only saved at the end).
            uint256 len = _holders.length;
            if (len == 0) break;
            if (idx >= len) idx = 0;
            address h = _holders[idx];
            idx++;
            if (pendingReflections(h) >= minPayout) paid += _claim(h, h, false);
        }
        payCursor = idx;
    }

    /// @notice How many holders payBatch() walks through (ETH / token payouts).
    function holderCount() external view returns (uint256) {
        return _holders.length;
    }

    function holderAt(uint256 index) external view returns (address) {
        return _holders[index];
    }

    function _claim(address account, address to, bool strict) private returns (uint256 amount) {
        _flush();
        amount = pendingReflections(account);
        if (amount == 0) return 0;
        settledReflections[account] = 0;
        if (!isExcludedFromReflections[account]) withdrawnReflections[account] = _accumulated(account);
        if (payoutMode == PAYOUT_IN_KIND) {
            totalReflectionsClaimed += amount;
            // An ordinary balance move from this (excluded) contract: the receiver's
            // correction term absorbs it, so their accrued total is unchanged and
            // the amount just paid is not paid out again.
            _update(address(this), to, amount);
            emit ReflectionsClaimed(account, amount);
            return amount;
        }
        payoutHeld -= amount; // effects before the external call
        if (!_payOut(to, amount)) {
            if (strict) revert PayoutTransferFailed();
            payoutHeld += amount;
            settledReflections[account] += amount; // still owed; claim it yourself
            emit PayoutFailed(account, amount);
            return 0;
        }
        totalReflectionsClaimed += amount;
        emit ReflectionsClaimed(account, amount);
    }

    function _payOut(address to, uint256 amount) private returns (bool ok) {
        if (payoutMode == PAYOUT_ETH) {
            (ok,) = payable(to).call{value: amount, gas: PAY_CALL_GAS}("");
        } else {
            bytes memory ret;
            (ok, ret) = payoutToken.call(abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer(address,uint256)
            if (ok && ret.length > 0) ok = abi.decode(ret, (bool));
        }
    }

    // ---------------------------------------------------------------
    // Converter hooks (ETH / token payouts)
    // ---------------------------------------------------------------

    /// @notice Hands `amount` of the waiting reflection tokens to the converter, which sells them.
    function releaseForConversion(uint256 amount) external onlyConverter {
        require(amount > 0 && amount <= pendingConversion, "V4CustomToken: invalid amount");
        pendingConversion -= amount;
        _update(address(this), msg.sender, amount);
        emit ReflectionsReleased(amount);
    }

    /// @notice Takes back tokens the converter could not sell (the pool's price limit was reached).
    function returnUnconverted(uint256 amount) external onlyConverter {
        require(amount > 0, "V4CustomToken: invalid amount");
        pendingConversion += amount;
        _update(msg.sender, address(this), amount);
        emit ReflectionsReturned(amount);
    }

    /// @notice (mode 1) Shares the ETH the converter sends with this call among the holders.
    function depositPayoutEth() external payable onlyConverter {
        require(payoutMode == PAYOUT_ETH && msg.value > 0, "V4CustomToken: not an ETH payout");
        _deposit(msg.value);
    }

    /// @notice (mode 2) Shares whatever payout tokens the converter just sent here among the holders.
    function depositPayoutToken() external onlyConverter returns (uint256 received) {
        require(payoutMode == PAYOUT_TOKEN, "V4CustomToken: not a token payout");
        uint256 bal = _payoutBalance();
        received = bal > payoutHeld ? bal - payoutHeld : 0;
        require(received > 0, "V4CustomToken: nothing received");
        _deposit(received);
    }

    function _payoutBalance() private view returns (uint256) {
        (bool ok, bytes memory ret) = payoutToken.staticcall(abi.encodeWithSelector(0x70a08231, address(this))); // balanceOf
        return ok && ret.length >= 32 ? abi.decode(ret, (uint256)) : 0;
    }

    function _deposit(uint256 amount) private {
        payoutHeld += amount;
        unallocatedReflections += amount;
        _flush();
        emit PayoutDeposited(amount, magnifiedPerShare);
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
        _untrack(account);
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
        if (payoutMode != PAYOUT_IN_KIND) {
            _track(from);
            _track(to);
        }
    }

    // ---- holder list upkeep (ETH / token payouts) ----

    function _track(address a) private {
        if (isExcludedFromReflections[a]) return;
        bool want = balanceOf(a) >= totalSupply() / TRACK_DIVISOR && balanceOf(a) > 0;
        uint256 idx = _holderIdx[a];
        if (want && idx == 0) {
            _holders.push(a);
            _holderIdx[a] = _holders.length;
        } else if (!want && idx != 0) {
            _untrack(a);
        }
    }

    function _untrack(address a) private {
        uint256 idx = _holderIdx[a];
        if (idx == 0) return;
        uint256 last = _holders.length;
        if (idx != last) {
            address moved = _holders[last - 1];
            _holders[idx - 1] = moved;
            _holderIdx[moved] = idx;
        }
        _holders.pop();
        delete _holderIdx[a];
    }
}
