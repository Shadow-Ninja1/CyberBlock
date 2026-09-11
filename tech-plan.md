# Black Box Bazaar — Technical Plan

Companion to `plan.md`. That doc is the *why*; this is the *what and how*. Nothing here is built yet.

---

## 0. Changes to the design before building

These are the upgrades to `plan.md` that are worth making. Each one either closes a hole a reviewer would poke in ten seconds or sharpens the pitch. None of them is more than an hour of work; most are minutes.

### 0.1 Reframe what is being sold: the buyer buys *time*, not information

`plan.md` §5.1 (auto-disclosure after settlement) has an economic hole: if every finding goes public after settlement, why would anyone be the first buyer instead of waiting for free? The answer is an **embargo window**. The buyer gets the finding immediately; the public gets it after the window closes. So the product is *early access to a disclosure that is going to happen anyway*.

This is one sentence and it resolves three things at once:

- It kills the §5.3 time-decay vs. severity-pricing tension. Price is derived from attested severity + install base. What the price buys is exclusivity time. No decay curve needed. Cut §5.3.
- It gives the README a crisp "biggest design decision" that is stronger than the one currently drafted.
- It's what vendors actually pay for today (paid early feeds, embargoed CVE pre-notification).

### 0.2 Hash-locked key reveal: make delivery mechanically verifiable, take the oracle out of the delivery question

`plan.md` says "payload released on payment" but never says how, and the dispute section treats "did the seller deliver what was sold" as an oracle question. It doesn't have to be.

- Seller generates symmetric key `K`, encrypts the finding, publishes the ciphertext (see §3 for where).
- At listing time the seller commits `keyHash = keccak(K)` and `contentHash = keccak(plaintext)` on-chain.
- The oracle, when attesting, has verified that `decrypt(ciphertext, K)` hashes to `contentHash`. So the commitments are bound together.
- `deliver()`: seller posts `K` encrypted to the buyer's public key (ECIES). Buyer decrypts, checks `keccak(plaintext) == contentHash`. If it matches, the buyer has *exactly* what the oracle graded. No trust needed.
- `settle()`: seller reveals `K` in plaintext. Contract checks `keccak(K) == keyHash`. This is the public disclosure, and anyone can verify it. If the seller never reveals by the deadline, the buyer claims a refund plus the stake. No oracle involved.

Consequence: **disputes are only ever about the attestation being wrong, never about delivery.** That's a much cleaner story than the current plan tells.

### 0.3 Attestation as a signed voucher, not a separate on-chain call

`plan.md` §6 has `attest()` as an oracle transaction before `list()`. Flip it:

- Seller submits plaintext + `K` to the oracle's API off-chain.
- Oracle runs detection, queries OSV, and returns an **EIP-712 signed attestation** (artifactHash, contentHash, keyHash, severity, class, novel, detectorHash, expiry).
- Seller calls `list(attestation, signature, price)` with stake attached. Contract recovers the signer and checks it's the oracle.

One transaction instead of two, no listing can exist without an attestation, and it mirrors how HackerOne triage actually works (triage happens before the report is priced).

### 0.4 Make the oracle auditable, not just trusted

The single biggest weakness in the plan is "trust one oracle." You can't remove that in two hours, but you can make it *checkable* for nearly free, which is a much better README answer than "we'd add more attestors later."

- npm tarballs are content-addressed (`integrity` sha512 in the registry). The attestation includes `artifactHash`.
- The detector is a deterministic script in the repo. The attestation includes `detectorHash = keccak(detector source)`.
- After public disclosure, **anyone can re-run the detector against the artifact and check that it produces the attested finding.** A lying oracle leaves a permanent, reproducible proof of its lie on-chain.

This turns the limitation from "trust me" into "trust, but every attestation is falsifiable after the fact." The v2 sketch (multiple attestors, slashed when a re-run contradicts them) then follows naturally from what's already built.

### 0.5 Actually do the novelty check. It's one HTTP call.

`plan.md` §7 lists "the oracle can't tell if it's genuinely novel" as the candidate limitation. Don't concede that; OSV has a free public API:

```
POST https://api.osv.dev/v1/query
{"package": {"name": "<pkg>", "ecosystem": "npm"}, "version": "<ver>"}
```

Empty `vulns` array means not in OSV/GHSA. Attestation records `novel: true/false` and the query timestamp. And it gives you a **second, better bad-faith demo**: a seller tries to list a real, already-public malicious package (e.g. `event-stream@3.3.6`) as fresh intel, and the oracle refuses to attest because OSV already has it. That's a real detector doing a real check on camera, not a rigged string-match failure.

### 0.6 Dispute bond

Without one, a buyer can dispute every purchase for free and grief every seller into a delayed payout. Buyer posts a bond (say 10% of price) to dispute. Oracle upholds seller: bond goes to seller. Oracle upholds buyer: bond returned, stake slashed, price refunded.

### 0.7 On-chain duplicate lock

`mapping(bytes32 artifactHash => uint256 listingId)`. Second listing for the same package@version reverts. Mechanical, zero oracle involvement, and it kills the "resubmit someone else's finding" attack at the contract level.

### 0.8 Decide: cut the blind auction and the cross-agent broadcast

Everything above is cheaper and more defensible than §5.4/§5.5. Don't build them. If ahead of schedule, spend the time on the video instead.

### 0.9 Optional: LLM in the buyer agent, never in the oracle

The prompt heavily encourages AI. The right place for it is the **buyer agent's purchase policy**: give Claude the attested metadata, seller reputation, and a budget, and let it decide whether to buy and log its reasoning to the UI. This makes "autonomous agent" visibly real in the demo.

Keep the oracle deterministic. An LLM in the verifier destroys the auditability argument from §0.4.

---

## 1. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Base Sepolia                                                    │
│   BlackBoxBazaar.sol  (listings, escrow, stakes, reveal, rep)   │
└──────────▲──────────────────────▲──────────────────────▲────────┘
           │ list / deliver /     │ resolve              │ buy / dispute
           │ settle               │                      │
    ┌──────┴──────┐        ┌──────┴──────┐        ┌──────┴──────┐
    │ Seller agent│──────▶ │ Oracle      │        │ Buyer agent │
    │ (script)    │ attest │ (API route) │        │ (script/API)│
    └─────────────┘  req   │ detector +  │        └─────────────┘
                           │ OSV check   │
                           └─────────────┘
    ┌────────────────────────────────────────────────────────────┐
    │ Next.js dashboard (Vercel): reads chain, shows attestations│
    │ agent logs, explorer links; buttons to trigger agent ticks │
    └────────────────────────────────────────────────────────────┘
```

Three actors, one contract, one web app. The oracle and both agents can all live as API routes in the same Next.js app so the whole thing deploys to Vercel as a single unit.

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Chain | **Base Sepolia** | Cheap, fast blocks, Basescan + Blockscout explorers, Coinbase faucet. Chain id 84532. |
| Contracts | **Foundry** (install: `curl -L https://foundry.paradigm.xyz \| bash && foundryup`) | `forge test` is fast, `forge script --broadcast --verify` deploys and verifies in one shot. Fallback if the install fights you: Hardhat + `@nomicfoundation/hardhat-verify`, already fine with Node 22. |
| Chain client | **viem** | Typed, small, works in both Node scripts and the browser. |
| Wallet in UI | **wagmi + injected connector** | Only needed if you want a human to click Buy from MetaMask. Agents sign with private keys from env. |
| Crypto | `@noble/ciphers` (XChaCha20-Poly1305 for payload), `eciesjs` (wrap `K` to buyer pubkey), `viem` for keccak + EIP-712 signing | All pure JS, no native deps, Vercel-safe. |
| Detector | Plain TypeScript: fetch tarball → `tar` extract → regex/AST heuristics | Deterministic, hashable, reviewable. |
| Frontend | **Next.js 15 (app router)**, Tailwind | Deploys to Vercel in one command. |
| Payload storage | **On-chain event** (`Listed(..., bytes ciphertext)`) | Finding JSON is ~1–3 KB. Calldata on Base Sepolia is effectively free. No IPFS, no hosting, and "the sealed envelope is literally on the chain" is a nice line. |
| Repo layout | pnpm monorepo: `contracts/`, `apps/web/`, `packages/core/` (detector, crypto, shared types) | Agents and API routes import the same detector code, so `detectorHash` is honest. |

---

## 3. Contract: `BlackBoxBazaar.sol`

Single contract, native ETH, no token.

### 3.1 State

```solidity
enum Status { Listed, Sold, Delivered, Disputed, Settled, Refunded }

struct Attestation {
    bytes32 artifactHash;   // sha256 of the npm tarball
    bytes32 contentHash;    // keccak(plaintext finding)
    bytes32 keyHash;        // keccak(K)
    bytes32 detectorHash;   // keccak(detector source)
    uint8   severity;       // 0-100 (CVSS*10)
    uint8   vulnClass;      // enum: InstallHookExfil, ObfuscatedEval, CredentialTheft, ...
    bool    novel;          // not in OSV at attestation time
    uint64  expiresAt;      // voucher validity
}

struct Listing {
    address seller;
    address buyer;
    uint96  price;
    uint96  stake;
    uint96  disputeBond;
    Attestation att;
    Status  status;
    uint64  soldAt;
    uint64  deliveredAt;
    bytes   encryptedKeyForBuyer;   // ECIES(K, buyerPubKey)
}

mapping(uint256 => Listing) public listings;
mapping(bytes32 => uint256) public listingByArtifact;   // duplicate lock
mapping(address => Rep) public sellerRep;               // {sold, slashed}
address public oracle;
uint64 public constant CHALLENGE_WINDOW = 10 minutes;   // short for demo
uint64 public constant DELIVERY_DEADLINE = 10 minutes;
```

### 3.2 Functions

| Function | Caller | What it does |
|---|---|---|
| `list(Attestation a, bytes sig, uint96 price, bytes ciphertext) payable` | Seller | Verifies EIP-712 sig from `oracle`, checks `a.expiresAt`, checks duplicate lock, requires `msg.value >= minStake(price)`, stores listing, emits `Listed(id, a, ciphertext)`. |
| `buy(uint256 id, bytes buyerPubKey) payable` | Buyer | `msg.value == price`, status Listed → Sold, records buyer + pubkey, starts delivery deadline. |
| `deliver(uint256 id, bytes encKey)` | Seller | Sold → Delivered, stores `encKey`, starts challenge window. |
| `dispute(uint256 id) payable` | Buyer | Within window, posts bond, Delivered → Disputed. |
| `resolve(uint256 id, bool sellerWins)` | Oracle | Disputed → Settled or Refunded. Moves funds accordingly, updates rep. |
| `settle(uint256 id, bytes32 K)` | Seller (or anyone with K) | After window, `keccak(K) == keyHash`. Pays seller price + stake, rep.sold++, emits `Disclosed(id, K)`. |
| `claimTimeout(uint256 id)` | Buyer | Seller missed delivery or reveal deadline → refund price + stake to buyer, rep.slashed++. |
| `cancel(uint256 id)` | Seller | Only while Listed. Returns stake. |

### 3.3 Fund flows (write these down before coding, they're the thing that gets tested)

| Outcome | Price | Stake | Dispute bond |
|---|---|---|---|
| Settled, no dispute | → seller | → seller | n/a |
| Disputed, seller wins | → seller | → seller | → seller |
| Disputed, buyer wins | → buyer | → buyer | → buyer |
| Seller timeout | → buyer | → buyer | n/a |
| Cancelled before sale | n/a | → seller | n/a |

### 3.4 Tests (Foundry, ~8 tests, 20 minutes)

Happy path, dispute-seller-wins, dispute-buyer-wins, timeout refund, duplicate artifact reverts, bad oracle sig reverts, wrong `K` at settle reverts, expired attestation reverts.

### 3.5 Deploy

`forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify`. Get this done before building agents; the address and explorer link are required deliverables.

---

## 4. `packages/core`: detector, crypto, types

### 4.1 Detector (`detector.ts`)

Input: a tarball (URL or local file). Output: `Finding[]` and a severity.

Heuristics, in priority order (each is a few lines):

1. **Install hooks**: `preinstall` / `postinstall` / `prepare` in `package.json` scripts → parse the script for `curl`, `wget`, `node -e`, `bash -c`, pipes to `sh`.
2. **Obfuscation**: `eval(`, `new Function(`, long base64 literals (`/[A-Za-z0-9+/]{200,}={0,2}/`), hex-escaped strings, `String.fromCharCode` chains.
3. **Exfil sinks**: `child_process`, `https.request` / `fetch` to a non-registry host, `process.env` read adjacent to a network call, `~/.ssh`, `~/.npmrc`, `.env` file reads.
4. **Known-bad indicators**: a small hardcoded IOC list (domains/IPs) for the demo.

Severity = weighted sum, capped at 100. Class = the top-scoring category. **Must be deterministic**: no timestamps, no randomness, sorted output. `detectorHash = keccak(source of detector.ts)`, computed at build time and included in every attestation.

### 4.2 Novelty (`osv.ts`)

One `POST` to `api.osv.dev/v1/query`. Returns `{ novel: boolean, osvIds: string[], checkedAt }`. Also hit `registry.npmjs.org/<pkg>/<version>` to fetch the `dist.integrity` hash for `artifactHash` when the target is a real package.

### 4.3 Crypto (`crypto.ts`)

- `sealFinding(plaintext) → { K, ciphertext, contentHash, keyHash }`
- `wrapKey(K, buyerPubKey) → encKey` (ECIES over secp256k1)
- `unwrapKey(encKey, buyerPrivKey) → K`
- `openFinding(ciphertext, K) → plaintext`, then verify `keccak(plaintext) == contentHash`

### 4.4 Types

`Attestation`, `Listing`, `Finding`, and the EIP-712 domain/types used by both the oracle (sign) and contract (verify). Generate the contract ABI into this package after deploy.

---

## 5. Agents

All three are small scripts that import `packages/core` and use viem with a private key from env. They can run as CLI (`pnpm agent:seller`) for the video and as Next.js API routes for the deployed site.

### 5.1 Oracle (`/api/oracle/attest`, `/api/oracle/resolve`)

- `attest`: receives `{ target, plaintext, K }`. Runs detector on the target artifact, checks the plaintext's claimed IOCs are a subset of what the detector found, checks OSV, verifies `decrypt(ciphertext, K)` hashes to `contentHash`. If everything passes, returns a signed `Attestation`. If not novel or not reproducible, returns a refusal with the reason (this is the bad-faith demo).
- `resolve`: called when a listing is Disputed. Re-runs the same check, plus reads any evidence the buyer attached (an OSV ID, a prior listing id). Sends `resolve(id, sellerWins)`.

Oracle private key in env. Never in the repo.

### 5.2 Seller agent

- Loads a finding from `fixtures/findings/*.json` (target, description, IOCs, PoC).
- Seals it, requests attestation, calls `list()` with stake.
- Watches for `Sold` events → calls `deliver()` with the wrapped key.
- After the challenge window → calls `settle(K)`.
- Also has a `--bad-faith` mode that tries to list a package already in OSV, to show the refusal on camera.

### 5.3 Buyer agent

- Config: `budget`, `minSeverity`, `requireNovel`, `maxSellerSlashRate`.
- Polls `Listed` events, filters by policy, calls `buy()` with its pubkey.
- Watches for `Delivered` → unwraps `K`, opens the finding, verifies `contentHash`. Logs the decrypted finding.
- Optional: sends the attested metadata + rep to Claude and asks for a buy/skip decision with a one-line reason; logs it. Keep a deterministic fallback if the API call fails.
- Has a `--dispute` flag for the demo that disputes a listing regardless, so the resolve path can be shown.

---

## 6. Frontend (`apps/web`)

One page, three panels. Read-only from chain via viem public client; writes happen through agents or via wagmi if a wallet is connected.

1. **Market**: table of listings. Columns: target, severity, class, novel ✓/✗, price, seller rep (sold/slashed), status, explorer link. Clicking a row shows the full attestation and the ciphertext hash. **Never shows plaintext for anything not Settled.**
2. **Agent console**: streamed logs from the three agents (server-sent events from the API routes or just polled from a small in-memory log). This is where "autonomous" becomes visible.
3. **Disclosure feed**: every `Disclosed` event, with the decrypted finding rendered in full and a "re-verify" button that re-runs the detector client-side (or via API) against the artifact and shows the result matching the attestation. This is §0.4 on screen.

Every transaction hash is a Basescan link. Contract address in the header.

Deploy: `vercel --prod`. Env: `ORACLE_PRIVATE_KEY`, `SELLER_PRIVATE_KEY`, `BUYER_PRIVATE_KEY`, `NEXT_PUBLIC_CONTRACT_ADDRESS`, `NEXT_PUBLIC_RPC_URL`, optional `ANTHROPIC_API_KEY`.

---

## 7. Demo fixtures

Do **not** publish anything to real npm. Put tarballs in `fixtures/packages/` and let the detector accept a local path or URL.

1. `evil-widget-1.2.0.tgz`: `postinstall` runs `node -e` that base64-decodes a snippet reading `~/.npmrc` and POSTing to `telemetry-cdn[.]xyz`. Clearly malicious, high severity, novel. **The happy path.**
2. `sneaky-utils-0.4.1.tgz`: obfuscated `eval` chain, medium severity, novel. Second listing so the market table isn't one row.
3. `event-stream@3.3.6` (real, in OSV as GHSA): seller tries to list it as fresh intel. **Oracle refuses: not novel.** Bad-faith path A.
4. A finding whose claimed IOC is not present in the tarball. **Oracle refuses: not reproducible.** Bad-faith path B.
5. One Delivered listing that the buyer agent disputes with `--dispute`, oracle re-runs, seller wins, buyer loses bond. **Dispute path.** (Or flip it: seller delivers a finding the oracle attested but a buyer supplies an OSV ID proving it went public between attestation and sale. Pick whichever is easier to script.)

---

## 8. Build order

Get the required deliverables first, differentiators second, polish last.

| # | Task | Est. | Output |
|---|---|---|---|
| 1 | Init monorepo, install Foundry, `forge init contracts` | 15 min | Skeleton |
| 2 | Write `BlackBoxBazaar.sol` + tests | 45 min | Passing `forge test` |
| 3 | Deploy + verify on Base Sepolia | 15 min | **Contract address + explorer link** ✅ deliverable |
| 4 | `packages/core`: crypto + types + EIP-712 | 20 min | Seal/wrap/open round-trips in a unit test |
| 5 | Detector + OSV check + fixtures | 40 min | `pnpm detect fixtures/packages/evil-widget-1.2.0.tgz` prints a finding |
| 6 | Oracle attest + resolve routes | 25 min | Signed attestation returned for fixture 1, refusals for 3 and 4 |
| 7 | Seller + buyer agents, CLI mode | 40 min | Full loop on testnet, txs on Basescan |
| 8 | Dashboard | 45 min | **Public URL** ✅ deliverable |
| 9 | README (four sections + pitch line) | 20 min | ✅ deliverable |
| 10 | Video, one take, show refusal + dispute + disclosure | 20 min | ✅ deliverable |

Roughly 5 hours end to end if nothing fights you. Steps 1–3 and 9 are non-negotiable. If you're at hour 3 and behind: drop the LLM in the buyer agent, drop the client-side re-verify button, drop fixture 2, and keep going.

**Cut order:** Claude-in-buyer → re-verify button → second happy-path fixture → dispute bond (keep dispute, drop the bond) → OSV check (keep detector). Never cut: signed attestation, hash-locked reveal, public disclosure event, one refusal on camera.

---

## 9. README skeleton (write after step 3, refine after step 10)

```
# Black Box Bazaar — Supply-Chain Threat Intel

> One-line pitch (from plan.md §7, updated for the embargo framing).

Live: <vercel url> · Contract: <basescan link> · Video: <link>

## Vertical
## How a trade works        (6 bullets, one per contract call)
## Trust assumptions        (single oracle, named; how every attestation is falsifiable after disclosure)
## Biggest design decision  (verification moved before the sale; buyer buys embargo time, not information)
## One limitation           (buyer can leak during the embargo; nothing on-chain prevents it)
## Run it locally
```

Pick the limitation that's *not* the oracle, because §0.4 turns the oracle from a limitation into a design point. The leak-during-embargo one is honest, unavoidable, and the same limitation every real embargoed-disclosure program has.
