// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CyberBlock
/// @notice A market for supply-chain threat intelligence that buyers cannot inspect
///         before paying. Findings are graded by a signed oracle attestation before
///         they can be listed, delivered under a hash-locked key, and publicly
///         disclosed after an embargo. The seller's stake is a disclosure bond.
///
/// Lifecycle:
///   list ──buy──▶ Sold ──deliver──▶ Delivered ──(challenge window)──▶ Settled ──(embargo)──▶ Disclosed
///                                        └──dispute──▶ Disputed ──resolve──▶ Settled | Refunded
contract CyberBlock {
    // ---------------------------------------------------------------- types

    enum Status {
        None,
        Listed,
        Sold,
        Delivered,
        Disputed,
        Settled,
        Disclosed,
        Refunded,
        Cancelled
    }

    enum VulnClass {
        Unknown,
        InstallHookExfil,
        ObfuscatedEval,
        CredentialTheft,
        NetworkBackdoor,
        DependencyConfusion
    }

    /// @dev Signed off-chain by the oracle after it has (a) re-run the detector
    ///      against the real artifact, (b) confirmed the plaintext decrypts under K
    ///      to `contentHash`, and (c) checked OSV for prior disclosure.
    struct Attestation {
        bytes32 artifactHash; // sha256 of the package tarball being reported
        bytes32 contentHash; // keccak256 of the plaintext finding
        bytes32 keyHash; // keccak256 of the symmetric key K
        bytes32 detectorHash; // keccak256 of the detector source that produced the grade
        uint8 severity; // 0..100 (CVSS x10)
        uint8 vulnClass; // VulnClass
        bool novel; // absent from OSV/GHSA at attestation time
        uint32 installBase; // approximate weekly downloads of the affected package
        uint64 expiresAt; // voucher validity deadline
    }

    struct Listing {
        address seller;
        address buyer;
        uint96 price;
        uint96 stake; // disclosure bond, returned only on disclose()
        uint96 disputeBond;
        uint64 embargo; // seconds of buyer exclusivity after delivery
        uint64 soldAt;
        uint64 deliveredAt;
        Status status;
        bool paidOut;
        Attestation att;
    }

    struct Rep {
        uint32 sold;
        uint32 slashed;
    }

    // ------------------------------------------------------------ constants

    uint256 public constant BASE_UNIT = 0.0004 ether; // price of a severity-100 finding before multipliers
    uint256 public constant BASE_PRICE_CAP = 0.002 ether; // ceiling for a seller with no track record
    uint256 public constant STAKE_BPS = 5_000; // stake >= 50% of price
    uint256 public constant DISPUTE_BOND_BPS = 1_000; // dispute bond = 10% of price
    uint256 public constant PRICE_BAND_LO_BPS = 5_000; // price >= 50% of attested fair value
    uint256 public constant PRICE_BAND_HI_BPS = 15_000; // price <= 150% of attested fair value

    // NOTE: these windows are compressed so the whole lifecycle is walkable live in a
    // demo. A production deployment would measure the challenge window in hours and the
    // embargo in days (coordinated-disclosure norms), not minutes.
    uint64 public constant DELIVERY_DEADLINE = 10 minutes;
    uint64 public constant CHALLENGE_WINDOW = 1 minutes;
    uint64 public constant MIN_EMBARGO = 2 minutes; // must exceed CHALLENGE_WINDOW, so the buyer
    //                                                  gets real exclusivity after payment clears
    uint64 public constant MAX_EMBARGO = 30 days;
    uint64 public constant DISCLOSURE_GRACE = 2 minutes; // after this, anyone with K may claim the bond

    bytes32 private constant ATTESTATION_TYPEHASH =
        keccak256(
            "Attestation(bytes32 artifactHash,bytes32 contentHash,bytes32 keyHash,bytes32 detectorHash,uint8 severity,uint8 vulnClass,bool novel,uint32 installBase,uint64 expiresAt)"
        );
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    // ---------------------------------------------------------------- state

    address public immutable oracle;
    uint256 public nextListingId = 1;

    mapping(uint256 => Listing) private _listings;
    mapping(bytes32 => uint256) public listingByArtifact; // duplicate lock
    mapping(address => Rep) public sellerRep;

    // --------------------------------------------------------------- events

    event Listed(
        uint256 indexed id,
        address indexed seller,
        bytes32 indexed artifactHash,
        uint96 price,
        uint96 stake,
        uint64 embargo,
        Attestation att,
        string targetLabel,
        bytes ciphertext
    );
    event Bought(uint256 indexed id, address indexed buyer, uint96 price, bytes buyerPubKey);
    event Delivered(uint256 indexed id, address indexed buyer, bytes encryptedKey, uint64 embargoEndsAt);
    event Disputed(uint256 indexed id, address indexed buyer, string reason);
    event Resolved(uint256 indexed id, bool sellerWins, string reason);
    event PaidOut(uint256 indexed id, address indexed seller, uint96 amount);
    event Disclosed(uint256 indexed id, address indexed by, bytes32 key, uint96 bondReturned);
    event Refunded(uint256 indexed id, address indexed buyer, uint256 amount);
    event Cancelled(uint256 indexed id);

    // --------------------------------------------------------------- errors

    error NotOracle();
    error NotSeller();
    error NotBuyer();
    error BadStatus(Status have, Status want);
    error BadSignature();
    error AttestationExpired();
    error NotNovel();
    error DuplicateArtifact(uint256 existingId);
    error BadEmbargo();
    error PriceOutOfBand(uint256 fair, uint256 given);
    error PriceAboveRepCap(uint256 cap, uint256 given);
    error StakeTooLow(uint256 need, uint256 given);
    error WrongPayment(uint256 need, uint256 given);
    error TooEarly(uint64 readyAt);
    error TooLate(uint64 deadline);
    error BadKey();
    error TransferFailed();

    // ---------------------------------------------------------- constructor

    constructor(address _oracle) {
        oracle = _oracle;
    }

    // ------------------------------------------------------------- pricing

    /// @notice Multiplier (percent) applied to a finding's base price by class.
    function classWeight(uint8 vulnClass) public pure returns (uint256) {
        if (vulnClass == uint8(VulnClass.CredentialTheft)) return 140;
        if (vulnClass == uint8(VulnClass.InstallHookExfil)) return 130;
        if (vulnClass == uint8(VulnClass.NetworkBackdoor)) return 125;
        if (vulnClass == uint8(VulnClass.ObfuscatedEval)) return 110;
        if (vulnClass == uint8(VulnClass.DependencyConfusion)) return 100;
        return 80;
    }

    /// @notice The market's pricing rule, on-chain and auditable: a finding's fair
    ///         value is a pure function of its attested severity, class, blast
    ///         radius and the exclusivity window the buyer is purchasing.
    /// @dev Non-novel findings are worth nothing here — they are already public.
    function fairPrice(Attestation memory a, uint64 embargo) public pure returns (uint256) {
        if (!a.novel || a.severity == 0) return 0;
        uint256 p = (BASE_UNIT * a.severity) / 100;
        p = (p * classWeight(a.vulnClass)) / 100;

        // Blast radius: up to 2x at >= 1,000,000 weekly downloads.
        uint256 reach = uint256(a.installBase) / 10_000;
        if (reach > 100) reach = 100;
        p = (p * (100 + reach)) / 100;

        // Exclusivity: 1x at the minimum embargo, 2x at the maximum.
        uint64 span = MAX_EMBARGO - MIN_EMBARGO;
        uint256 extra = (100 * uint256(embargo - MIN_EMBARGO)) / span;
        p = (p * (100 + extra)) / 100;

        return p;
    }

    /// @notice Reputation-gated listing size. New sellers cannot list expensive
    ///         findings; each clean sale doubles the ceiling, each slash divides it.
    function priceCap(address seller) public view returns (uint256) {
        Rep memory r = sellerRep[seller];
        if (r.slashed >= 3) return 0; // effectively barred
        uint256 shift = r.sold > 4 ? 4 : r.sold;
        uint256 cap = BASE_PRICE_CAP << shift;
        return cap / (uint256(r.slashed) + 1);
    }

    function minStake(uint256 price) public pure returns (uint256) {
        return (price * STAKE_BPS) / 10_000;
    }

    function disputeBondFor(uint256 price) public pure returns (uint256) {
        return (price * DISPUTE_BOND_BPS) / 10_000;
    }

    // ----------------------------------------------------------- attestation

    function domainSeparator() public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    EIP712_DOMAIN_TYPEHASH,
                    keccak256("CyberBlock"),
                    keccak256("1"),
                    block.chainid,
                    address(this)
                )
            );
    }

    function hashAttestation(Attestation memory a) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                a.artifactHash,
                a.contentHash,
                a.keyHash,
                a.detectorHash,
                a.severity,
                a.vulnClass,
                a.novel,
                a.installBase,
                a.expiresAt
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _requireOracleSig(Attestation memory a, bytes calldata sig) private view {
        if (sig.length != 65) revert BadSignature();
        bytes32 digest = hashAttestation(a);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0) || signer != oracle) revert BadSignature();
    }

    // -------------------------------------------------------------- listing

    /// @dev All the reasons a listing can be refused, in one place.
    function _validateListing(Attestation calldata att, uint96 price, uint64 embargo) private view {
        if (att.expiresAt < block.timestamp) revert AttestationExpired();
        if (!att.novel) revert NotNovel();
        if (embargo < MIN_EMBARGO || embargo > MAX_EMBARGO) revert BadEmbargo();

        uint256 existing = listingByArtifact[att.artifactHash];
        if (existing != 0) revert DuplicateArtifact(existing);

        uint256 fair = fairPrice(att, embargo);
        if (price < (fair * PRICE_BAND_LO_BPS) / 10_000 || price > (fair * PRICE_BAND_HI_BPS) / 10_000) {
            revert PriceOutOfBand(fair, price);
        }

        uint256 cap = priceCap(msg.sender);
        if (price > cap) revert PriceAboveRepCap(cap, price);

        uint256 need = minStake(price);
        if (msg.value < need) revert StakeTooLow(need, msg.value);
    }

    /// @notice List a sealed finding. The oracle's signed grade is the only way in.
    /// @param att Oracle-signed grade of the sealed finding.
    /// @param sig 65-byte oracle signature over `att` (EIP-712).
    /// @param price Asking price in wei; must sit inside the attested fair-value band.
    /// @param embargo Seconds of buyer exclusivity after delivery, before public disclosure.
    /// @param targetLabel Human-readable target, e.g. "npm:evil-widget@1.2.0".
    /// @param ciphertext The sealed finding itself, carried in the event log.
    function list(
        Attestation calldata att,
        bytes calldata sig,
        uint96 price,
        uint64 embargo,
        string calldata targetLabel,
        bytes calldata ciphertext
    ) external payable returns (uint256 id) {
        _requireOracleSig(att, sig);
        _validateListing(att, price, embargo);

        id = nextListingId++;
        listingByArtifact[att.artifactHash] = id;

        Listing storage l = _listings[id];
        l.seller = msg.sender;
        l.price = price;
        l.stake = uint96(msg.value);
        l.embargo = embargo;
        l.status = Status.Listed;
        l.att = att;

        emit Listed(id, msg.sender, att.artifactHash, price, uint96(msg.value), embargo, att, targetLabel, ciphertext);
    }

    function cancel(uint256 id) external {
        Listing storage l = _listings[id];
        if (l.seller != msg.sender) revert NotSeller();
        if (l.status != Status.Listed) revert BadStatus(l.status, Status.Listed);
        l.status = Status.Cancelled;
        delete listingByArtifact[l.att.artifactHash];
        uint96 stake = l.stake;
        l.stake = 0;
        _send(msg.sender, stake);
        emit Cancelled(id);
    }

    // ------------------------------------------------------------------ buy

    /// @param buyerPubKey Uncompressed secp256k1 public key the seller wraps K to.
    function buy(uint256 id, bytes calldata buyerPubKey) external payable {
        Listing storage l = _listings[id];
        if (l.status != Status.Listed) revert BadStatus(l.status, Status.Listed);
        if (msg.value != l.price) revert WrongPayment(l.price, msg.value);

        l.buyer = msg.sender;
        l.soldAt = uint64(block.timestamp);
        l.status = Status.Sold;

        emit Bought(id, msg.sender, l.price, buyerPubKey);
    }

    /// @notice Seller hands over K, wrapped to the buyer's public key. The buyer can
    ///         check `keccak256(plaintext) == att.contentHash` themselves, so whether
    ///         delivery was correct is never an oracle question.
    function deliver(uint256 id, bytes calldata encryptedKey) external {
        Listing storage l = _listings[id];
        if (l.seller != msg.sender) revert NotSeller();
        if (l.status != Status.Sold) revert BadStatus(l.status, Status.Sold);
        uint64 deadline = l.soldAt + DELIVERY_DEADLINE;
        if (block.timestamp > deadline) revert TooLate(deadline);

        l.deliveredAt = uint64(block.timestamp);
        l.status = Status.Delivered;

        emit Delivered(id, l.buyer, encryptedKey, l.deliveredAt + l.embargo);
    }

    /// @notice Buyer refund when the seller goes dark after being paid.
    function claimTimeout(uint256 id) external {
        Listing storage l = _listings[id];
        if (l.buyer != msg.sender) revert NotBuyer();
        if (l.status != Status.Sold) revert BadStatus(l.status, Status.Sold);
        uint64 deadline = l.soldAt + DELIVERY_DEADLINE;
        if (block.timestamp <= deadline) revert TooEarly(deadline);

        l.status = Status.Refunded;
        sellerRep[l.seller].slashed += 1;
        delete listingByArtifact[l.att.artifactHash];

        uint256 amount = uint256(l.price) + uint256(l.stake);
        l.stake = 0;
        _send(msg.sender, amount);
        emit Refunded(id, msg.sender, amount);
    }

    // -------------------------------------------------------------- dispute

    /// @notice The only thing a dispute can ever be about is the attestation being
    ///         wrong: not reproducible, already public, or mis-graded.
    function dispute(uint256 id, string calldata reason) external payable {
        Listing storage l = _listings[id];
        if (l.buyer != msg.sender) revert NotBuyer();
        if (l.status != Status.Delivered) revert BadStatus(l.status, Status.Delivered);
        uint64 deadline = l.deliveredAt + CHALLENGE_WINDOW;
        if (block.timestamp > deadline) revert TooLate(deadline);

        uint256 need = disputeBondFor(l.price);
        if (msg.value != need) revert WrongPayment(need, msg.value);

        l.disputeBond = uint96(msg.value);
        l.status = Status.Disputed;
        emit Disputed(id, msg.sender, reason);
    }

    function resolve(uint256 id, bool sellerWins, string calldata reason) external {
        if (msg.sender != oracle) revert NotOracle();
        Listing storage l = _listings[id];
        if (l.status != Status.Disputed) revert BadStatus(l.status, Status.Disputed);

        uint96 bond = l.disputeBond;
        l.disputeBond = 0;

        if (sellerWins) {
            // Griefing costs money: the bond goes to the seller, payment proceeds,
            // and the stake stays locked until disclosure.
            l.status = Status.Settled;
            l.paidOut = true;
            sellerRep[l.seller].sold += 1;
            uint256 amount = uint256(l.price) + uint256(bond);
            _send(l.seller, amount);
            emit PaidOut(id, l.seller, uint96(amount));
        } else {
            l.status = Status.Refunded;
            sellerRep[l.seller].slashed += 1;
            delete listingByArtifact[l.att.artifactHash];
            uint256 amount = uint256(l.price) + uint256(l.stake) + uint256(bond);
            l.stake = 0;
            _send(l.buyer, amount);
            emit Refunded(id, l.buyer, amount);
        }
        emit Resolved(id, sellerWins, reason);
    }

    // ------------------------------------------------------- payment & reveal

    /// @notice Release the price to the seller once the challenge window closes.
    ///         Callable by anyone so a lazy seller can never block the lifecycle.
    ///         The stake is NOT released here — it is a disclosure bond.
    function claimPayment(uint256 id) external {
        Listing storage l = _listings[id];
        if (l.status != Status.Delivered) revert BadStatus(l.status, Status.Delivered);
        uint64 ready = l.deliveredAt + CHALLENGE_WINDOW;
        if (block.timestamp < ready) revert TooEarly(ready);
        _payout(id, l);
    }

    function _payout(uint256 id, Listing storage l) private {
        l.status = Status.Settled;
        l.paidOut = true;
        sellerRep[l.seller].sold += 1;
        uint96 price = l.price;
        _send(l.seller, price);
        emit PaidOut(id, l.seller, price);
    }

    /// @notice Publish K once the embargo expires. This is what turns a private intel
    ///         sale into coordinated disclosure: the buyer's fee funded a finding that
    ///         now becomes free for every other defender, and anybody can re-run the
    ///         attested detector against the attested artifact to check the oracle.
    /// @dev The seller recovers the stake by disclosing. After a grace period anyone
    ///      holding K — the buyer, for instance — can disclose and claim the bond,
    ///      so disclosure does not depend on the seller's goodwill.
    function disclose(uint256 id, bytes32 key) external {
        Listing storage l = _listings[id];
        if (l.status == Status.Delivered) {
            uint64 ready = l.deliveredAt + CHALLENGE_WINDOW;
            if (block.timestamp < ready) revert TooEarly(ready);
            _payout(id, l);
        }
        if (l.status != Status.Settled) revert BadStatus(l.status, Status.Settled);

        uint64 embargoEnd = l.deliveredAt + l.embargo;
        if (block.timestamp < embargoEnd) revert TooEarly(embargoEnd);
        if (keccak256(abi.encodePacked(key)) != l.att.keyHash) revert BadKey();

        if (msg.sender != l.seller && block.timestamp < embargoEnd + DISCLOSURE_GRACE) {
            revert TooEarly(embargoEnd + DISCLOSURE_GRACE);
        }

        l.status = Status.Disclosed;
        uint96 bond = l.stake;
        l.stake = 0;
        _send(msg.sender, bond);
        emit Disclosed(id, msg.sender, key, bond);
    }

    // ---------------------------------------------------------------- views

    function getListing(uint256 id) external view returns (Listing memory) {
        return _listings[id];
    }

    function embargoEndsAt(uint256 id) external view returns (uint64) {
        Listing storage l = _listings[id];
        if (l.deliveredAt == 0) return 0;
        return l.deliveredAt + l.embargo;
    }

    // --------------------------------------------------------------- internal

    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
