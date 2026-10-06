// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title V4LaunchedToken
/// @notice The ERC20 every V4 launch deploys as an EIP-1167 clone of this
/// implementation.
///
/// This is deliberately a PLAIN ERC20. The V2 LaunchedToken carried the whole
/// trading tax inside its own _update() override (skimming feeBps on every
/// transfer that touched the pair) because a Uniswap V2 pool has no
/// transaction hooks, so the token itself was the only place a fee could be
/// collected. Uniswap V4 pools DO have hooks, so on V4 the tax lives in
/// V4TaxHook and is taken at the pool, as part of the swap. That means:
///
///  - transfers of this token are never taxed (wallet to wallet, to a CEX,
///    to any other pool, anywhere);
///  - nothing about this token changes when a tax is switched on or off;
///  - there is no auto-activation / pair-detection logic, no oracle, and no
///    graduation state here -- all of it lives in the hook, per pool.
///
/// "Deploy Token" (no liquidity) V4 launches are therefore ordinary untaxed
/// ERC20s for their entire life, exactly like a V2 "Just Launch" token whose
/// creator never routes anything through the platform.
///
/// The only V4-specific state is `poolId` / `hook`, recorded once by the
/// factory when it seeds the token's pool, so front ends and indexers can go
/// from a token address straight to its pool without scanning events.
contract V4LaunchedToken is ERC20 {
    bool private _initialized;

    address public creator;
    address public factory;
    uint256 public launchedAt;
    string private _tokenName;
    string private _tokenSymbol;

    /// @notice The Uniswap V4 PoolId (bytes32) of this token's launch pool and
    /// the hook that taxes it. Both stay zero for a "Deploy Token" launch.
    bytes32 public poolId;
    address public hook;

    /// @notice Same ceiling as the V2 token: 1 quadrillion tokens, 18
    /// decimals. Keeps market-cap arithmetic in the hook far from overflow.
    uint256 public constant MAX_TOTAL_SUPPLY = 1_000_000_000_000_000 * 1e18;

    event TokenInitialized(string name, string symbol, uint256 totalSupply, address indexed creator);
    event PoolRegistered(bytes32 indexed poolId, address indexed hook);
    event TokensBurned(uint256 amount);

    modifier onlyFactory() {
        require(msg.sender == factory, "V4LaunchedToken: caller is not the factory");
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
        address factory_
    ) external {
        require(!_initialized, "V4LaunchedToken: already initialized");
        require(totalSupply_ > 0, "V4LaunchedToken: supply must be > 0");
        require(totalSupply_ <= MAX_TOTAL_SUPPLY, "V4LaunchedToken: supply too large");
        require(creator_ != address(0), "V4LaunchedToken: invalid creator");
        require(mintTo_ != address(0), "V4LaunchedToken: invalid mint recipient");
        require(factory_ != address(0), "V4LaunchedToken: invalid factory");

        _initialized = true;
        _tokenName = name_;
        _tokenSymbol = symbol_;
        creator = creator_;
        factory = factory_;
        launchedAt = block.timestamp;

        _mint(mintTo_, totalSupply_);

        emit TokenInitialized(name_, symbol_, totalSupply_, creator_);
    }

    /// @notice One-time record of the launch pool, called by the factory right
    /// after it initializes the pool. Informational only: it grants nothing
    /// and changes no behaviour of the token.
    function registerPool(bytes32 poolId_, address hook_) external onlyFactory {
        require(poolId == bytes32(0), "V4LaunchedToken: pool already registered");
        require(poolId_ != bytes32(0) && hook_ != address(0), "V4LaunchedToken: invalid pool");
        poolId = poolId_;
        hook = hook_;
        emit PoolRegistered(poolId_, hook_);
    }

    function name() public view override returns (string memory) { return _tokenName; }
    function symbol() public view override returns (string memory) { return _tokenSymbol; }

    /// @notice Permanently destroys `amount` of the caller's own tokens.
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
        emit TokensBurned(amount);
    }

    /// @notice Same as burn(), spending `account`'s allowance first.
    function burnFrom(address account, uint256 amount) external {
        _spendAllowance(account, msg.sender, amount);
        _burn(account, amount);
        emit TokensBurned(amount);
    }
}
