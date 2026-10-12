// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {V4CustomToken} from "./V4CustomToken.sol";
import {V4CustomTokenFactory} from "./V4CustomTokenFactory.sol";
import {V4CurveFactory} from "./V4CurveFactory.sol";

/// @dev The two reads the relay needs from V4TokenFactory (the platform's "tax
/// source"), so the launch-fee split follows the same recipients as every other
/// V4 launch.
interface IV4RelayTaxSource {
    function rewardsDistributor() external view returns (address);
    function feeTreasury() external view returns (address);
}

/// @title V4LaunchRelay
/// @notice Gasless launches for the three V4 modes that V4TokenFactory does not
/// relay itself: custom tax (V4CustomTokenFactory) and the plain and custom-tax
/// bonding curves (V4CurveFactory). It is the same scheme V4TokenFactory uses
/// for plain tokens, in one separate contract so the (size-limited) curve
/// factory does not have to carry the escrow and signature code:
///
///   1. The creator signs an EIP-712 voucher describing the exact launch.
///   2. The creator deposits fee + liquidity + buy-in here, keyed by the
///      voucher's hash (depositForRelayedLaunch). The deposit is refundable by
///      the creator after its deadline if the launch never happens.
///   3. The relayer submits the voucher and signature. The relay checks both and
///      the deposit, calls the factory's ordinary launch function with only the
///      liquidity + buy-in ETH and the creator's address appended to the calldata
///      (the factory trusts that suffix from this relay alone, see
///      V4PoolLauncher._creator), and keeps the launch fee.
///   4. The relay repays the relayer's gas out of that fee (capped by
///      maxRelayerGasReimbursementWei) and splits the rest 50/50 between the
///      platform rewards distributor (if one is set) and the treasury, the same
///      rule as V4TokenFactory._settleRelayedFee.
///
/// The creator receives everything a direct launch gives them: the token, the
/// locked LP, the buy-in tokens and any ETH dust. The relay never holds a token.
/// A launch fee below the factory's current fee is refused, so a stale or
/// zero-fee voucher cannot launch for free and leave the relayer paying gas.
contract V4LaunchRelay is Ownable2Step, ReentrancyGuard {
    V4CustomTokenFactory public immutable customFactory;
    V4CurveFactory public immutable curveFactory;
    IV4RelayTaxSource public immutable taxSource;

    address public relayer;
    uint256 public maxRelayerGasReimbursementWei;
    uint256 public constant RELAY_GAS_OVERHEAD = 60_000;
    /// @dev Gas given to the relayer when repaying its gas; same bound the
    /// factories use for fee recipients.
    uint256 private constant PAY_GAS = 300_000;

    struct Deposit {
        uint256 amount;
        uint256 deadline;
        bool settled;
        bool reclaimed;
    }

    mapping(address => mapping(bytes32 => Deposit)) public deposits;

    // ---- vouchers ----

    struct CustomVoucher {
        address creator;
        string name;
        string symbol;
        uint256 totalSupply;
        V4CustomToken.FeeSet buyFees;
        V4CustomToken.FeeSet sellFees;
        V4CustomToken.ReflectionPayout payout;
        address marketingWallet;
        uint256 liquidityEthAmount;
        uint256 creatorBuyEthAmount;
        uint256 minCreatorTokensOut;
        uint256 fee;
        uint256 salt;
        uint256 deadline;
    }

    struct CurveVoucher {
        address creator;
        string name;
        string symbol;
        uint256 totalSupply;
        uint256 creatorBuyEthAmount;
        uint256 minCreatorTokensOut;
        uint256 fee;
        uint256 salt;
        uint256 deadline;
    }

    struct CustomCurveVoucher {
        address creator;
        string name;
        string symbol;
        uint256 totalSupply;
        V4CustomToken.FeeSet buyFees;
        V4CustomToken.FeeSet sellFees;
        V4CustomToken.ReflectionPayout payout;
        address marketingWallet;
        uint256 creatorBuyEthAmount;
        uint256 minCreatorTokensOut;
        uint256 fee;
        uint256 salt;
        uint256 deadline;
    }

    bytes32 private constant FEESET_TYPEHASH =
        keccak256("FeeSet(uint16 reflectionBps,uint16 marketingBps,uint16 liquidityBps,uint16 burnBps)");
    bytes32 private constant PAYOUT_TYPEHASH = keccak256("ReflectionPayout(uint8 mode,address token)");
    bytes32 private constant CUSTOM_VOUCHER_TYPEHASH = keccak256(
        "CustomLaunchVoucher(address creator,string name,string symbol,uint256 totalSupply,FeeSet buyFees,FeeSet sellFees,ReflectionPayout payout,address marketingWallet,uint256 liquidityEthAmount,uint256 creatorBuyEthAmount,uint256 minCreatorTokensOut,uint256 fee,uint256 salt,uint256 deadline)FeeSet(uint16 reflectionBps,uint16 marketingBps,uint16 liquidityBps,uint16 burnBps)ReflectionPayout(uint8 mode,address token)"
    );
    bytes32 private constant CURVE_VOUCHER_TYPEHASH = keccak256(
        "CurveLaunchVoucher(address creator,string name,string symbol,uint256 totalSupply,uint256 creatorBuyEthAmount,uint256 minCreatorTokensOut,uint256 fee,uint256 salt,uint256 deadline)"
    );
    bytes32 private constant CUSTOM_CURVE_VOUCHER_TYPEHASH = keccak256(
        "CustomCurveLaunchVoucher(address creator,string name,string symbol,uint256 totalSupply,FeeSet buyFees,FeeSet sellFees,ReflectionPayout payout,address marketingWallet,uint256 creatorBuyEthAmount,uint256 minCreatorTokensOut,uint256 fee,uint256 salt,uint256 deadline)FeeSet(uint16 reflectionBps,uint16 marketingBps,uint16 liquidityBps,uint16 burnBps)ReflectionPayout(uint8 mode,address token)"
    );
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
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
        require(msg.sender == relayer, "V4LaunchRelay: caller is not the relayer");
        _;
    }

    constructor(address customFactory_, address curveFactory_, address taxSource_) Ownable(msg.sender) {
        require(customFactory_ != address(0), "V4LaunchRelay: invalid custom factory");
        require(curveFactory_ != address(0), "V4LaunchRelay: invalid curve factory");
        require(taxSource_ != address(0), "V4LaunchRelay: invalid tax source");
        customFactory = V4CustomTokenFactory(payable(customFactory_));
        curveFactory = V4CurveFactory(payable(curveFactory_));
        taxSource = IV4RelayTaxSource(taxSource_);
        _domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("HoodLaunchV4Relay")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice Ownership can never be renounced (it is the only way to change the
    /// relayer or its gas cap). Hand it over with the two-step transferOwnership.
    function renounceOwnership() public view override onlyOwner {
        revert("V4LaunchRelay: ownership cannot be renounced");
    }

    // ---------------------------------------------------------------
    // Settings
    // ---------------------------------------------------------------

    function setRelayer(address newRelayer) external onlyOwner {
        if (newRelayer != address(0)) {
            require(
                maxRelayerGasReimbursementWei > 0, "V4LaunchRelay: set maxRelayerGasReimbursementWei before enabling a relayer"
            );
        }
        relayer = newRelayer;
        emit RelayerUpdated(newRelayer);
    }

    function setMaxRelayerGasReimbursement(uint256 newCapWei) external onlyOwner {
        require(
            relayer == address(0) || newCapWei > 0,
            "V4LaunchRelay: cannot zero the gas reimbursement cap while a relayer is active"
        );
        maxRelayerGasReimbursementWei = newCapWei;
        emit MaxRelayerGasReimbursementUpdated(newCapWei);
    }

    // ---------------------------------------------------------------
    // Voucher hashing (EIP-712)
    // ---------------------------------------------------------------

    function _hashTypedData(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator, structHash));
    }

    function _feeSetHash(V4CustomToken.FeeSet calldata f) private pure returns (bytes32) {
        return keccak256(
            abi.encode(FEESET_TYPEHASH, f.reflectionBps, f.marketingBps, f.liquidityBps, f.burnBps)
        );
    }

    function _payoutHash(V4CustomToken.ReflectionPayout calldata p) private pure returns (bytes32) {
        return keccak256(abi.encode(PAYOUT_TYPEHASH, p.mode, p.token));
    }

    function hashCustomVoucher(CustomVoucher calldata v) public view returns (bytes32) {
        // One flat EIP-712 struct hash; encoded in two chunks only to keep the stack shallow.
        bytes memory head = abi.encode(
            CUSTOM_VOUCHER_TYPEHASH,
            v.creator,
            keccak256(bytes(v.name)),
            keccak256(bytes(v.symbol)),
            v.totalSupply,
            _feeSetHash(v.buyFees),
            _feeSetHash(v.sellFees),
            _payoutHash(v.payout),
            v.marketingWallet
        );
        bytes memory tail =
            abi.encode(v.liquidityEthAmount, v.creatorBuyEthAmount, v.minCreatorTokensOut, v.fee, v.salt, v.deadline);
        return _hashTypedData(keccak256(bytes.concat(head, tail)));
    }

    function hashCurveVoucher(CurveVoucher calldata v) public view returns (bytes32) {
        return _hashTypedData(
            keccak256(
                abi.encode(
                    CURVE_VOUCHER_TYPEHASH,
                    v.creator,
                    keccak256(bytes(v.name)),
                    keccak256(bytes(v.symbol)),
                    v.totalSupply,
                    v.creatorBuyEthAmount,
                    v.minCreatorTokensOut,
                    v.fee,
                    v.salt,
                    v.deadline
                )
            )
        );
    }

    function hashCustomCurveVoucher(CustomCurveVoucher calldata v) public view returns (bytes32) {
        bytes memory head = abi.encode(
            CUSTOM_CURVE_VOUCHER_TYPEHASH,
            v.creator,
            keccak256(bytes(v.name)),
            keccak256(bytes(v.symbol)),
            v.totalSupply,
            _feeSetHash(v.buyFees),
            _feeSetHash(v.sellFees),
            _payoutHash(v.payout),
            v.marketingWallet
        );
        bytes memory tail = abi.encode(v.creatorBuyEthAmount, v.minCreatorTokensOut, v.fee, v.salt, v.deadline);
        return _hashTypedData(keccak256(bytes.concat(head, tail)));
    }

    // ---------------------------------------------------------------
    // Deposits
    // ---------------------------------------------------------------

    function depositForRelayedLaunch(bytes32 voucherHash, uint256 deadline) external payable nonReentrant {
        require(msg.value > 0, "V4LaunchRelay: no ETH sent");
        require(deadline > block.timestamp, "V4LaunchRelay: deadline already passed");
        Deposit storage d = deposits[msg.sender][voucherHash];
        require(d.amount == 0, "V4LaunchRelay: voucher already funded");
        d.amount = msg.value;
        d.deadline = deadline;
        emit LaunchDeposited(voucherHash, msg.sender, msg.value, deadline);
    }

    function reclaimDeposit(bytes32 voucherHash) external nonReentrant {
        Deposit storage d = deposits[msg.sender][voucherHash];
        require(d.amount > 0, "V4LaunchRelay: no such deposit");
        require(!d.settled, "V4LaunchRelay: voucher already relayed");
        require(!d.reclaimed, "V4LaunchRelay: already reclaimed");
        require(block.timestamp > d.deadline, "V4LaunchRelay: deadline has not passed yet");
        d.reclaimed = true;
        uint256 amount = d.amount;
        (bool sent,) = payable(msg.sender).call{value: amount}("");
        require(sent, "V4LaunchRelay: refund transfer failed");
        emit DepositReclaimed(voucherHash, msg.sender, amount);
    }

    /// @dev Checks the signature, the deadline and the escrowed deposit, and
    /// marks the deposit settled (effects before interactions).
    function _consume(
        address creator,
        bytes32 voucherHash,
        bytes calldata signature,
        uint256 voucherDeadline,
        uint256 fee,
        uint256 currentFee,
        uint256 forwarded
    ) private {
        require(block.timestamp <= voucherDeadline, "V4LaunchRelay: voucher expired");
        // The direct entry points make the sender pay the platform's fee; here it
        // comes from the deposit, so the fee the creator signed must not be below it.
        require(fee >= currentFee, "V4LaunchRelay: voucher fee below the current launch fee");
        require(
            ECDSA.recover(voucherHash, signature) == creator, "V4LaunchRelay: signature does not match voucher creator"
        );
        Deposit storage d = deposits[creator][voucherHash];
        require(d.amount > 0, "V4LaunchRelay: no matching deposit");
        require(!d.settled, "V4LaunchRelay: voucher already relayed");
        require(!d.reclaimed, "V4LaunchRelay: deposit already reclaimed");
        require(block.timestamp <= d.deadline, "V4LaunchRelay: deposit expired, creator must reclaim");
        require(d.amount == fee + forwarded, "V4LaunchRelay: deposit does not match voucher amount");
        d.settled = true;
    }

    // ---------------------------------------------------------------
    // Relayed launches
    // ---------------------------------------------------------------

    function relayedCreateCustomToken(CustomVoucher calldata v, bytes calldata signature)
        external
        onlyRelayer
        nonReentrant
        returns (address token)
    {
        uint256 gasStart = gasleft();
        bytes32 voucherHash = hashCustomVoucher(v);
        uint256 forwarded = v.liquidityEthAmount + v.creatorBuyEthAmount;
        _consume(v.creator, voucherHash, signature, v.deadline, v.fee, customFactory.launchFee(), forwarded);

        _forward(
            address(customFactory),
            forwarded,
            abi.encodeCall(
                V4CustomTokenFactory.createCustomToken,
                (
                    v.name,
                    v.symbol,
                    v.totalSupply,
                    v.buyFees,
                    v.sellFees,
                    v.payout,
                    v.marketingWallet,
                    v.liquidityEthAmount,
                    v.creatorBuyEthAmount,
                    v.minCreatorTokensOut,
                    v.salt
                )
            ),
            v.creator
        );
        token = customFactory.predictTokenAddress(v.creator, v.salt);
        _settleRelayedFee(voucherHash, token, v.fee, gasStart);
    }

    function relayedCreateCurveToken(CurveVoucher calldata v, bytes calldata signature)
        external
        onlyRelayer
        nonReentrant
        returns (address token, uint256 creatorTokensBought)
    {
        uint256 gasStart = gasleft();
        bytes32 voucherHash = hashCurveVoucher(v);
        _consume(v.creator, voucherHash, signature, v.deadline, v.fee, curveFactory.curveLaunchFee(), v.creatorBuyEthAmount);

        bytes memory ret = _forward(
            address(curveFactory),
            v.creatorBuyEthAmount,
            abi.encodeCall(
                V4CurveFactory.createCurveToken,
                (v.name, v.symbol, v.totalSupply, v.creatorBuyEthAmount, v.minCreatorTokensOut, v.salt)
            ),
            v.creator
        );
        (token, creatorTokensBought) = abi.decode(ret, (address, uint256));
        _settleRelayedFee(voucherHash, token, v.fee, gasStart);
    }

    function relayedCreateCustomCurveToken(CustomCurveVoucher calldata v, bytes calldata signature)
        external
        onlyRelayer
        nonReentrant
        returns (address token, uint256 creatorTokensBought)
    {
        uint256 gasStart = gasleft();
        bytes32 voucherHash = hashCustomCurveVoucher(v);
        _consume(v.creator, voucherHash, signature, v.deadline, v.fee, curveFactory.curveLaunchFee(), v.creatorBuyEthAmount);

        bytes memory ret = _forward(
            address(curveFactory),
            v.creatorBuyEthAmount,
            abi.encodeCall(
                V4CurveFactory.createCustomCurveToken,
                (
                    v.name,
                    v.symbol,
                    v.totalSupply,
                    v.buyFees,
                    v.sellFees,
                    v.payout,
                    v.marketingWallet,
                    v.creatorBuyEthAmount,
                    v.minCreatorTokensOut,
                    v.salt
                )
            ),
            v.creator
        );
        (token, creatorTokensBought) = abi.decode(ret, (address, uint256));
        _settleRelayedFee(voucherHash, token, v.fee, gasStart);
    }

    /// @dev Calls the factory's ordinary launch function with the verified
    /// creator's address appended to the calldata (the factory only honours that
    /// suffix when the caller is this relay), and bubbles up any revert reason.
    function _forward(address factory, uint256 value, bytes memory callData, address creator)
        private
        returns (bytes memory ret)
    {
        bool ok;
        (ok, ret) = factory.call{value: value}(abi.encodePacked(callData, creator));
        if (!ok) {
            if (ret.length == 0) revert("V4LaunchRelay: launch failed");
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    /// @dev Repays the relayer's gas out of the launch fee (capped), then splits
    /// the rest 50/50 between the rewards distributor and the treasury, or sends
    /// all of it to the treasury when no distributor is set.
    function _settleRelayedFee(bytes32 voucherHash, address token, uint256 feeCollected, uint256 gasStart) private {
        if (feeCollected == 0) return;

        uint256 gasUsed = (gasStart - gasleft()) + RELAY_GAS_OVERHEAD;
        uint256 gasReimbursement = gasUsed * tx.gasprice;
        if (maxRelayerGasReimbursementWei > 0 && gasReimbursement > maxRelayerGasReimbursementWei) {
            gasReimbursement = maxRelayerGasReimbursementWei;
        }
        if (gasReimbursement > feeCollected) gasReimbursement = feeCollected;

        if (gasReimbursement > 0) {
            (bool sentGas,) = payable(relayer).call{value: gasReimbursement, gas: PAY_GAS}("");
            require(sentGas, "V4LaunchRelay: relayer gas reimbursement failed");
        }

        uint256 netFee = feeCollected - gasReimbursement;
        uint256 toRewards;
        uint256 toTreasury;
        if (netFee > 0) {
            address rd = taxSource.rewardsDistributor();
            address treasury = taxSource.feeTreasury();
            if (rd != address(0)) {
                toRewards = netFee / 2;
                toTreasury = netFee - toRewards;
                if (toRewards > 0) {
                    (bool sentRewards,) = rd.call{value: toRewards}("");
                    require(sentRewards, "V4LaunchRelay: rewards transfer failed");
                }
            } else {
                toTreasury = netFee;
            }
            (bool sent,) = treasury.call{value: toTreasury}("");
            require(sent, "V4LaunchRelay: fee transfer failed");
        }

        emit RelayedFeeSettled(voucherHash, token, feeCollected, gasReimbursement, toTreasury, toRewards);
    }
}
