// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CyberBlock
/// @notice A market for supply-chain threat intelligence that buyers cannot inspect
///         before paying.
///
///         A seller submits a finding together with a script that reproduces it.
///         The oracle runs that script in an instrumented sandbox, checks that every
///         effect the seller claims actually shows up in the execution trace, and
///         signs an attestation over the trace hash and the one-sentence outcome the
///         buyer will be shown. Nothing can be listed without that signature.
///
///         Price is discovered by a Dutch auction. The seller chooses what share of
///         the clearing price is contingent: that share is escrowed until an external
///         advisory confirms the finding after disclosure, and otherwise mostly
///         returns to the buyer.
///
/// Lifecycle:
///   list ──buy──▶ Sold ──deliver──▶ Delivered ──(window)──▶ Settled ──(embargo)──▶ Disclosed ──(confirmation)──▶ contingent released | returned
///                                        └──challenge──▶ Challenged ──resolve──▶ Settled | Refunded
contract CyberBlock {
    // ---------------------------------------------------------------- types

    enum Status {
        None,
        Listed,
        Sold,
        Delivered,
        Challenged,
        Settled,
        Disclosed,
        Refunded,
        Cancelled
    }

    enum Contingent {
        None, // not sold, or no contingent share
        Escrowed, // held until an external advisory confirms the finding
        Released, // confirmed: paid to the seller
        Returned // window passed with no advisory: mostly returned to the buyer
    }

    /// @dev Bit flags describing what the sandbox actually observed the package do.
    ///      These are facts the oracle verified by execution, not a risk score.
    uint16 public constant EFFECT_EXFIL_CREDENTIALS = 1; // a credential canary left the machine
    uint16 public constant EFFECT_EXFIL_ENV = 2; // an environment-variable canary left the machine
    uint16 public constant EFFECT_NETWORK_EGRESS = 4; // contacted a host outside normal package plumbing
    uint16 public constant EFFECT_READS_SENSITIVE = 8; // read a credential file from the home directory
    uint16 public constant EFFECT_SPAWNS_PROCESS = 16; // tried to spawn a child process
    uint16 public constant EFFECT_WRITES_FILES = 32; // wrote outside its own package directory
    uint16 public constant EFFECT_RUNS_ON_INSTALL = 64; // the behaviour is triggered by an npm install hook

    /// @dev Signed off-chain by the oracle after it has run the seller's
    ///      reproduction script in the committed sandbox and confirmed that every
    ///      claimed effect is present in the resulting trace.
    struct Attestation {
        bytes32 artifactHash; // sha256 of the package tarball being reported
        bytes32 contentHash; // keccak256 of the plaintext finding (writeup + repro script + claims)
        bytes32 keyHash; // keccak256 of the symmetric key K
        bytes32 traceHash; // keccak256 of the canonical sandbox trace the repro produced
        bytes32 sandboxHash; // keccak256 of the sandbox runtime source that produced the trace
        bytes32 outcomeHash; // keccak256 of the public outcome sentence buyers are shown
        uint16 effects; // EFFECT_* bit flags observed in the trace
        bool novel; // absent from OSV/GHSA at attestation time
        uint32 installBase; // approximate weekly downloads of the affected package
        uint64 expiresAt; // voucher validity deadline
    }

    struct Auction {
        uint96 startPrice; // price at the moment of listing
        uint96 reservePrice; // floor, reached after `duration`
        uint64 startedAt;
        uint64 duration; // seconds to decay linearly from start to reserve
        uint16 contingentBps; // share of the clearing price that is escrowed until confirmation
    }

    struct Listing {
        address seller;
        address buyer;
        address challenger;
        uint96 price; // clearing price, fixed at buy()
        uint96 basePart; // paid to the seller at settlement
        uint96 contingentPart; // escrowed until confirmation or expiry
        uint96 stake; // disclosure bond, returned only on disclose()
        uint96 challengeBond;
        uint64 embargo; // seconds of buyer exclusivity after delivery
        uint64 soldAt;
        uint64 deliveredAt;
        uint64 disclosedAt;
        Status status;
        Contingent contingent;
        Attestation att;
        Auction auction;
    }

    struct Rep {
        uint32 sold;
        uint32 slashed;
        uint32 confirmed; // contingent shares released by an external advisory
        uint32 unconfirmed; // contingent shares that expired without one
    }

    // ------------------------------------------------------------ constants

    uint256 public constant BASE_PRICE_CAP = 0.002 ether; // start-price ceiling for a seller with no track record
    uint256 public constant STAKE_BPS = 5_000; // stake >= 50% of the reserve price
    uint256 public constant CHALLENGE_BOND_BPS = 1_000; // challenge bond = 10% of the clearing price
    uint256 public constant MAX_CONTINGENT_BPS = 9_000; // a seller may put at most 90% at risk
    uint256 public constant POOL_BPS = 2_000; // share of an expired contingent kept by the disclosure pool

    // NOTE: these windows are compressed so the whole lifecycle is walkable live in a
    // demo. Production would measure the auction and challenge window in hours, the
    // embargo in days and the confirmation window in weeks.
    uint64 public constant MIN_AUCTION = 30 seconds;
    uint64 public constant MAX_AUCTION = 30 days;
    uint64 public constant DELIVERY_DEADLINE = 10 minutes;
    uint64 public constant CHALLENGE_WINDOW = 30 seconds;
    uint64 public constant MIN_EMBARGO = 30 seconds; // must be >= CHALLENGE_WINDOW
    uint64 public constant MAX_EMBARGO = 30 days;
    uint64 public constant DISCLOSURE_GRACE = 30 seconds; // after this, anyone with K may claim the bond
    uint64 public constant CONFIRMATION_WINDOW = 30 seconds; // after disclosure, how long an advisory may take

    bytes32 private constant ATTESTATION_TYPEHASH =
        keccak256(
            "Attestation(bytes32 artifactHash,bytes32 contentHash,bytes32 keyHash,bytes32 traceHash,bytes32 sandboxHash,bytes32 outcomeHash,uint16 effects,bool novel,uint32 installBase,uint64 expiresAt)"
        );
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    // ---------------------------------------------------------------- state

    /// @notice Signs attestations and records external advisories. Never rules on a challenge.
    address public immutable oracle;
    /// @notice Rules on challenges by re-executing the repro under a stricter procedure.
    ///         A separate key from the oracle, so a dishonest grade needs two parties to survive.
    address public immutable arbiter;

    uint256 public nextListingId = 1;
    /// @notice Expired contingent shares accumulate here instead of refunding in full, so a
    ///         buyer gains nothing by quietly suppressing an advisory.
    uint256 public disclosurePool;

    mapping(uint256 => Listing) private _listings;
    mapping(bytes32 => uint256) public listingByArtifact; // duplicate lock
    mapping(address => Rep) public sellerRep;

    // --------------------------------------------------------------- events

    event Listed(
        uint256 indexed id,
        address indexed seller,
        bytes32 indexed artifactHash,
        Auction auction,
        uint96 stake,
        uint64 embargo,
        Attestation att,
        string targetLabel,
        string outcome,
        bytes ciphertext
    );
    event Bought(uint256 indexed id, address indexed buyer, uint96 price, uint96 basePart, uint96 contingentPart, bytes buyerPubKey);
    event Delivered(uint256 indexed id, address indexed buyer, bytes encryptedKey, uint64 embargoEndsAt);
    event Challenged(uint256 indexed id, address indexed challenger, bytes32 claimedTraceHash, string reason);
    event Resolved(uint256 indexed id, bool sellerWins, bytes32 rerunTraceHash, string reason);
    event PaidOut(uint256 indexed id, address indexed seller, uint96 amount);
    event Disclosed(uint256 indexed id, address indexed by, bytes32 key, uint96 bondReturned);
    event ContingentReleased(uint256 indexed id, address indexed seller, uint96 amount, string evidence);
    event ContingentReturned(uint256 indexed id, address indexed buyer, uint96 toBuyer, uint96 toPool);
    event Refunded(uint256 indexed id, address indexed buyer, uint256 amount);
    event Cancelled(uint256 indexed id);

    // --------------------------------------------------------------- errors

    error NotOracle();
    error NotArbiter();
    error NotSeller();
    error NotBuyer();
    error BadStatus(Status have, Status want);
    error BadSignature();
    error AttestationExpired();
    error NotNovel();
    error OutcomeMismatch();
    error DuplicateArtifact(uint256 existingId);
    error BadEmbargo();
    error BadAuction();
    error BadContingent();
    error PriceAboveRepCap(uint256 cap, uint256 given);
    error StakeTooLow(uint256 need, uint256 given);
    error WrongPayment(uint256 need, uint256 given);
    error TooEarly(uint64 readyAt);
    error TooLate(uint64 deadline);
    error BadKey();
    error NothingEscrowed();
    error TransferFailed();

    // ---------------------------------------------------------- constructor

    constructor(address _oracle, address _arbiter) {
        oracle = _oracle;
        arbiter = _arbiter;
    }

    // ------------------------------------------------------------- pricing

    /// @notice The Dutch-auction price right now: linear decay from start to reserve.
    function currentPrice(uint256 id) public view returns (uint256) {
        Listing storage l = _listings[id];
        if (l.status != Status.Listed) return l.price;
        return _priceAt(l.auction, uint64(block.timestamp));
    }

    function _priceAt(Auction memory a, uint64 at) private pure returns (uint256) {
        if (at <= a.startedAt) return a.startPrice;
        uint64 elapsed = at - a.startedAt;
        if (elapsed >= a.duration) return a.reservePrice;
        uint256 span = uint256(a.startPrice) - uint256(a.reservePrice);
        return uint256(a.startPrice) - (span * elapsed) / a.duration;
    }

    /// @notice Reputation-gated start price. A new seller cannot open an auction high;
    ///         each clean sale and each externally confirmed finding raises the ceiling,
    ///         each slash lowers it.
    function priceCap(address seller) public view returns (uint256) {
        Rep memory r = sellerRep[seller];
        if (r.slashed >= 3) return 0; // effectively barred
        uint256 wins = uint256(r.sold) + uint256(r.confirmed);
        uint256 shift = wins > 4 ? 4 : wins;
        uint256 cap = BASE_PRICE_CAP << shift;
        return cap / (uint256(r.slashed) + 1);
    }

    function minStake(uint256 reservePrice) public pure returns (uint256) {
        return (reservePrice * STAKE_BPS) / 10_000;
    }

    function challengeBondFor(uint256 price) public pure returns (uint256) {
        return (price * CHALLENGE_BOND_BPS) / 10_000;
    }

    // ----------------------------------------------------------- attestation

    function domainSeparator() public view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    EIP712_DOMAIN_TYPEHASH,
                    keccak256("CyberBlock"),
                    keccak256("2"),
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
                a.traceHash,
                a.sandboxHash,
                a.outcomeHash,
                a.effects,
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
    function _validateListing(
        Attestation calldata att,
        string calldata outcome,
        Auction memory a,
        uint64 embargo
    ) private view {
        if (att.expiresAt < block.timestamp) revert AttestationExpired();
        if (!att.novel) revert NotNovel();
        if (keccak256(bytes(outcome)) != att.outcomeHash) revert OutcomeMismatch();
        if (embargo < MIN_EMBARGO || embargo > MAX_EMBARGO) revert BadEmbargo();
        if (a.reservePrice == 0 || a.reservePrice > a.startPrice) revert BadAuction();
        if (a.duration < MIN_AUCTION || a.duration > MAX_AUCTION) revert BadAuction();
        if (a.contingentBps > MAX_CONTINGENT_BPS) revert BadContingent();

        uint256 existing = listingByArtifact[att.artifactHash];
        if (existing != 0) revert DuplicateArtifact(existing);

        uint256 cap = priceCap(msg.sender);
        if (a.startPrice > cap) revert PriceAboveRepCap(cap, a.startPrice);

        uint256 need = minStake(a.reservePrice);
        if (msg.value < need) revert StakeTooLow(need, msg.value);
    }

    /// @notice List a sealed finding. The oracle's signed attestation is the only way in.
    /// @param att Oracle-signed attestation over the sandbox trace and the public outcome.
    /// @param sig 65-byte oracle signature over `att` (EIP-712).
    /// @param outcome The one-sentence result buyers are shown; must hash to `att.outcomeHash`.
    /// @param startPrice Opening price of the Dutch auction, in wei.
    /// @param reservePrice Floor the auction decays to.
    /// @param duration Seconds over which the price falls from start to reserve.
    /// @param contingentBps Share of the clearing price escrowed until an external advisory confirms the finding.
    /// @param embargo Seconds of buyer exclusivity after delivery, before public disclosure.
    /// @param targetLabel Human-readable target, e.g. "npm:evil-widget@1.2.0".
    /// @param ciphertext The sealed finding itself, carried in the event log.
    function list(
        Attestation calldata att,
        bytes calldata sig,
        string calldata outcome,
        uint96 startPrice,
        uint96 reservePrice,
        uint64 duration,
        uint16 contingentBps,
        uint64 embargo,
        string calldata targetLabel,
        bytes calldata ciphertext
    ) external payable returns (uint256 id) {
        _requireOracleSig(att, sig);
        Auction memory a = Auction({
            startPrice: startPrice,
            reservePrice: reservePrice,
            startedAt: uint64(block.timestamp),
            duration: duration,
            contingentBps: contingentBps
        });
        _validateListing(att, outcome, a, embargo);

        id = nextListingId++;
        listingByArtifact[att.artifactHash] = id;

        Listing storage l = _listings[id];
        l.seller = msg.sender;
        l.stake = uint96(msg.value);
        l.embargo = embargo;
        l.status = Status.Listed;
        l.att = att;
        l.auction = a;

        emit Listed(id, msg.sender, att.artifactHash, a, uint96(msg.value), embargo, att, targetLabel, outcome, ciphertext);
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

    /// @notice Buy at the current auction price. Send at least that much; any excess
    ///         is returned, so a buyer can quote a ceiling without racing the clock.
    /// @param buyerPubKey Uncompressed secp256k1 public key the seller wraps K to.
    function buy(uint256 id, bytes calldata buyerPubKey) external payable {
        Listing storage l = _listings[id];
        if (l.status != Status.Listed) revert BadStatus(l.status, Status.Listed);

        uint256 p = _priceAt(l.auction, uint64(block.timestamp));
        if (msg.value < p) revert WrongPayment(p, msg.value);

        uint96 price = uint96(p);
        uint96 contingentPart = uint96((p * l.auction.contingentBps) / 10_000);
        uint96 basePart = price - contingentPart;

        l.buyer = msg.sender;
        l.price = price;
        l.basePart = basePart;
        l.contingentPart = contingentPart;
        l.contingent = contingentPart > 0 ? Contingent.Escrowed : Contingent.None;
        l.soldAt = uint64(block.timestamp);
        l.status = Status.Sold;

        emit Bought(id, msg.sender, price, basePart, contingentPart, buyerPubKey);
        if (msg.value > p) _send(msg.sender, msg.value - p);
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
        l.contingent = Contingent.None;
        sellerRep[l.seller].slashed += 1;
        delete listingByArtifact[l.att.artifactHash];

        uint256 amount = uint256(l.price) + uint256(l.stake);
        l.stake = 0;
        _send(msg.sender, amount);
        emit Refunded(id, msg.sender, amount);
    }

    // ------------------------------------------------------------ challenge

    /// @notice Anyone may challenge a delivered finding inside the window by posting a
    ///         bond and the trace hash their own sandbox run produced. The buyer holds
    ///         the repro script and can run it; after disclosure so can everyone.
    ///         A challenge is not a re-run of the oracle: the arbiter is a separate
    ///         key and applies a stricter procedure than attestation did.
    function challenge(uint256 id, bytes32 claimedTraceHash, string calldata reason) external payable {
        Listing storage l = _listings[id];
        if (l.status != Status.Delivered) revert BadStatus(l.status, Status.Delivered);
        uint64 deadline = l.deliveredAt + CHALLENGE_WINDOW;
        if (block.timestamp > deadline) revert TooLate(deadline);

        uint256 need = challengeBondFor(l.price);
        if (msg.value != need) revert WrongPayment(need, msg.value);

        l.challenger = msg.sender;
        l.challengeBond = uint96(msg.value);
        l.status = Status.Challenged;
        emit Challenged(id, msg.sender, claimedTraceHash, reason);
    }

    /// @notice The arbiter's ruling. If the seller is upheld, the challenger's bond is
    ///         forfeited to the seller and settlement proceeds. If the challenge is
    ///         upheld, the buyer is made whole, the challenger recovers their bond and
    ///         takes the seller's stake, and the seller is slashed.
    function resolveChallenge(uint256 id, bool sellerWins, bytes32 rerunTraceHash, string calldata reason) external {
        if (msg.sender != arbiter) revert NotArbiter();
        Listing storage l = _listings[id];
        if (l.status != Status.Challenged) revert BadStatus(l.status, Status.Challenged);

        uint96 bond = l.challengeBond;
        l.challengeBond = 0;

        if (sellerWins) {
            l.status = Status.Settled;
            sellerRep[l.seller].sold += 1;
            uint256 amount = uint256(l.basePart) + uint256(bond);
            _send(l.seller, amount);
            emit PaidOut(id, l.seller, uint96(amount));
        } else {
            l.status = Status.Refunded;
            l.contingent = Contingent.None;
            sellerRep[l.seller].slashed += 1;
            delete listingByArtifact[l.att.artifactHash];
            uint96 stake = l.stake;
            l.stake = 0;
            _send(l.buyer, l.price);
            emit Refunded(id, l.buyer, l.price);
            _send(l.challenger, uint256(bond) + uint256(stake));
        }
        emit Resolved(id, sellerWins, rerunTraceHash, reason);
    }

    // ------------------------------------------------------- payment & reveal

    /// @notice Release the base share to the seller once the challenge window closes.
    ///         Callable by anyone so a lazy seller can never block the lifecycle.
    ///         The stake is NOT released here, it is a disclosure bond; the contingent
    ///         share is NOT released here, it waits for an external advisory.
    function claimPayment(uint256 id) external {
        Listing storage l = _listings[id];
        if (l.status != Status.Delivered) revert BadStatus(l.status, Status.Delivered);
        uint64 ready = l.deliveredAt + CHALLENGE_WINDOW;
        if (block.timestamp < ready) revert TooEarly(ready);
        _payout(id, l);
    }

    function _payout(uint256 id, Listing storage l) private {
        l.status = Status.Settled;
        sellerRep[l.seller].sold += 1;
        uint96 base = l.basePart;
        _send(l.seller, base);
        emit PaidOut(id, l.seller, base);
    }

    /// @notice Publish K once the embargo expires. This is what turns a private intel
    ///         sale into coordinated disclosure: the buyer's fee funded a finding that
    ///         now becomes free for every other defender, and anybody can re-run the
    ///         attested repro in the attested sandbox to check the oracle.
    /// @dev The seller recovers the stake by disclosing. After a grace period anyone
    ///      holding K can disclose and claim the bond, so disclosure does not depend
    ///      on the seller's goodwill. Disclosure also starts the confirmation window
    ///      for the contingent share.
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
        l.disclosedAt = uint64(block.timestamp);
        uint96 bond = l.stake;
        l.stake = 0;
        _send(msg.sender, bond);
        emit Disclosed(id, msg.sender, key, bond);
    }

    // --------------------------------------------------------- ground truth

    /// @notice The oracle records that an external source (OSV/GHSA advisory, registry
    ///         takedown) now confirms the disclosed finding. This is bookkeeping of a
    ///         public, checkable fact, not a judgment call. Releases the contingent
    ///         share to the seller.
    function confirmOutcome(uint256 id, string calldata evidence) external {
        if (msg.sender != oracle) revert NotOracle();
        Listing storage l = _listings[id];
        if (l.status != Status.Disclosed) revert BadStatus(l.status, Status.Disclosed);
        if (l.contingent != Contingent.Escrowed) revert NothingEscrowed();
        uint64 deadline = l.disclosedAt + CONFIRMATION_WINDOW;
        if (block.timestamp > deadline) revert TooLate(deadline);

        l.contingent = Contingent.Released;
        sellerRep[l.seller].confirmed += 1;
        uint96 amount = l.contingentPart;
        l.contingentPart = 0;
        _send(l.seller, amount);
        emit ContingentReleased(id, l.seller, amount, evidence);
    }

    /// @notice No advisory arrived inside the window. Most of the contingent share
    ///         returns to the buyer; a slice stays in the disclosure pool so a buyer
    ///         who could influence the advisory has no reason to suppress it.
    ///         Callable by anyone.
    function expireContingent(uint256 id) external {
        Listing storage l = _listings[id];
        if (l.status != Status.Disclosed) revert BadStatus(l.status, Status.Disclosed);
        if (l.contingent != Contingent.Escrowed) revert NothingEscrowed();
        uint64 ready = l.disclosedAt + CONFIRMATION_WINDOW;
        if (block.timestamp <= ready) revert TooEarly(ready);

        l.contingent = Contingent.Returned;
        sellerRep[l.seller].unconfirmed += 1;
        uint96 amount = l.contingentPart;
        l.contingentPart = 0;
        uint96 toPool = uint96((uint256(amount) * POOL_BPS) / 10_000);
        uint96 toBuyer = amount - toPool;
        disclosurePool += toPool;
        _send(l.buyer, toBuyer);
        emit ContingentReturned(id, l.buyer, toBuyer, toPool);
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

    function confirmationEndsAt(uint256 id) external view returns (uint64) {
        Listing storage l = _listings[id];
        if (l.disclosedAt == 0) return 0;
        return l.disclosedAt + CONFIRMATION_WINDOW;
    }

    // --------------------------------------------------------------- internal

    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
