# CyberBlock

**A market for zero-day npm supply-chain intel that buyers cannot inspect before paying. Every finding is *detonated* — actually run — in an instrumented sandbox, and what the code was observed to do is signed on-chain before it can be listed. Price is set by a Dutch auction, part of the payout is contingent on the finding being confirmed later, and after a short embargo the decryption key is published so every defender gets it for free.**

- **Live app:** [cyberblock-market.vercel.app](https://cyberblock-market.vercel.app)
- **Contract (Base Sepolia):** [0x85bc78f3fec1b8e2e4196980fd65acf9924f6987](https://sepolia.basescan.org/address/0x85bc78f3fec1b8e2e4196980fd65acf9924f6987)
- **Demo video:** _add link_

---

## The vertical: malicious npm packages

Independent researchers find malicious npm packages — e.g. a package that, on install, reads your login tokens and uploads them to an attacker's server — days to weeks before the public advisory databases (OSV, GHSA, Snyk) list them. Today that intel moves through tweets, GitHub issues, private DMs and the occasional extortion attempt. Buyers (scanner vendors, corporate defence teams, registries) would pay for same-day, machine-readable findings, but no venue protects either side.

Why this vertical: the evidence is **re-checkable by execution**. "`pkg@version` reads `~/.npmrc` on install and uploads it" can be reproduced by running the package in a sandbox and watching it happen. That gives deterministic, behaviour-based verification — the hardest part of any information market — which governance analysis or sports scouting cannot offer.

## How the oracle grades

The oracle runs the code; it does not read the writeup. The seller submits a `repro` (`install`, or `require <file>`) plus the effects they claim. The oracle **detonates** it in [`lib/sandbox.ts`](lib/sandbox.ts): the package's real code executes, but every dangerous operation — reading files, opening network connections, launching programs, reading environment variables — is swapped for a stand-in that records the call and returns a fake. The filesystem hands back **canary credentials** (fake tokens that exist only to be recognised if they show up later); the network is a dead end that logs every outbound request and scans the payload, base64 included, for those canaries; the clock and random-number generator are pinned. The ordered list of intercepted calls is the **execution trace**.

Because nothing is non-deterministic, the same package + repro always produces the same trace and the same `keccak256` (`traceHash`). The **effects bitmask** — *steals credentials, phones home, reads sensitive files, runs on install, launches a process, writes files* — is computed mechanically from the trace, and that bitmask is what gates money. The oracle refuses to sign unless every claimed effect appears in the trace.

**Verifying the access gained.** The detonation also keeps the concrete artifacts the exploit produced: the uploaded payload decoded to reveal the captured token, the exact command it tried to run, the hidden second stage an obfuscated payload unpacks at runtime. The seller declares an `expectedResult` (the access the exploit should grant) and Claude checks the artifacts against it (`access-not-demonstrated` if not). Without `ANTHROPIC_API_KEY`, a mechanical "at least one artifact captured" check runs instead. Captures are deterministic and committed inside `traceHash`.

The sandbox's own `keccak256` (`sandboxHash`) is committed in every attestation. After disclosure, anyone can re-fetch the package, re-run the exact sandbox, and reproduce the trace. A lying oracle leaves a permanent, falsifiable record.

## Act as a real buyer or seller (connect a wallet)

Anyone can transact with their own wallet on Base Sepolia, not only the four autonomous agents:

- **Sell.** The **Sell** tab lets you author a package (a real malicious npm package from an editable template) and its finding. Your browser packs the tarball, the oracle detonates those exact bytes and returns its signature, then **your wallet** signs `list()` and posts the stake.
- **Buy.** Open a live listing in the **Market** tab and, under **Act with your wallet**, buy at the current auction price. Excess is refunded, so the app quotes the start price as a ceiling.
- **Deliver, decrypt, settle, disclose.** As seller or buyer of a listing, the same panel exposes the follow-on steps: the seller delivers and later discloses the key, the buyer decrypts locally (checked against the on-chain commitment), and anyone may release the base once the challenge window closes.

Works with any injected wallet (MetaMask, Rabby, Coinbase Wallet); the app switches it to Base Sepolia. Fund it from a [faucet](https://docs.base.org/tools/network-faucets).

## Agent-native CLI

The web UI is a window onto the market, not the market. Any agent can trade with its own key through [`scripts/cli.ts`](scripts/cli.ts). Every command prints one JSON object:

```bash
export CYBERBLOCK_PRIVATE_KEY=0x…            # the agent's key
export CYBERBLOCK_API=https://<deployed-app>  # the oracle host; defaults to http://localhost:3000

npm run cli -- market                         # effects, outcome, live price — never the contents
npm run cli -- buy 3 --max 0.005              # pay the current auction price (excess refunded)
npm run cli -- receive 3                      # unwrap the key, check keccak(plaintext) == contentHash, print the finding
npm run cli -- challenge 3 "trace mismatch"   # re-detonate locally, post a bond and your trace hash

npm run cli -- sell my-finding.json --contingent 60   # seal → oracle detonates + signs → list() from your wallet
npm run cli -- deliver 4 && npm run cli -- settle 4 && npm run cli -- disclose 4
npm run cli -- verify 4                       # anyone: re-run the committed sandbox against the disclosed finding
```

`sell` takes a finding in the [fixture format](fixtures/findings/evil-widget-1.2.0.json); a local `.tgz` in `target.artifact` is inlined so the oracle grades those bytes. The seal key is derived from the agent's private key and the finding (cached in `~/.cyberblock/keys.json`). The only off-chain calls are `POST /api/oracle/attest` and `POST /api/verify`; everything else is a contract call signed by the agent.

## Pricing: Dutch auction + contingent split

No seller-set price, no severity multiplier.

- **Dutch auction.** Opens at the seller's reputation cap and falls linearly to a reserve. The first buyer clears at the current price; excess is refunded. One transaction, works with a single buyer, and the decay matches how intel value decays.
- **Contingent split.** The seller chooses what fraction of the price (up to 90%) is **contingent**. The base pays at settlement; the contingent share is escrowed until an external advisory (OSV/GHSA, a registry takedown) confirms the finding. If confirmed it goes to the seller; otherwise most returns to the buyer and a slice goes to a disclosure pool, so a buyer gains nothing by suppressing an advisory. The chosen split is a credibility signal: only a seller who believes the finding is real wants a large contingent.

## Disputes

A dispute that re-runs the same grader carries no information. Here the **arbiter is a separate key from the oracle** and runs a stricter procedure: it re-detonates three times and upholds the seller only if every run reproduces the attested trace and effects, the artifact still hashes to the attested bytes, the sandbox is unchanged, and OSV still has no entry. Anyone may challenge by posting a bond and their own trace hash.

## Lifecycle (on-chain)

1. **grade** — seller seals the finding (XChaCha20-Poly1305) and sends plaintext + key to the oracle. The oracle detonates, verifies the claimed effects, checks OSV for novelty, and returns an **EIP-712 attestation**: artifact hash, content hash, key hash, trace hash, sandbox hash, outcome hash, effects, novelty, install base.
2. **list** — seller posts attestation + sealed blob with a stake, opening a Dutch auction with a chosen base/contingent split. Buyers see only the effects and a one-sentence outcome.
3. **buy** — buyer pays the current price into escrow.
4. **deliver** — seller posts the key ECIES-wrapped to the buyer. The buyer checks `keccak256(plaintext) == contentHash`.
5. **settle / challenge** — after the challenge window the base releases to the seller; a challenge sends the arbiter to re-detonate.
6. **disclose** — after the embargo the key is published on-chain; anyone can re-run the sandbox.
7. **confirm / expire** — an external advisory releases the contingent share to the seller; otherwise it returns to the buyer.

## Trust assumptions

- **One oracle grades, one arbiter rules — two separate keys.** This is the central trust assumption.
- **Every grade is falsifiable by execution.** The sandbox is public, deterministic code; its hash is committed in each attestation and the tarball is content-addressed. After disclosure anyone can fetch the sandbox (`/api/sandbox`), re-detonate, and produce a reproducible contradiction if the oracle lied. The app has a one-click "re-detonate" button. Next steps: N independent detonators slashed on contradiction, then a zkVM so the grade carries its own proof.
- **The sandbox models a host; it is not one.** It intercepts files, network, processes and environment against canary secrets. Payloads that only misbehave against a real OS or live network are out of scope (see the limitation).
- **Payment identity and delivery key are separate.** A browser wallet cannot expose the raw private key ECIES needs, so a wallet buyer's browser generates a throwaway secp256k1 "inbox" keypair (in local storage) and passes its public key at `buy()`. The seller wraps the key to it; the browser decrypts and verifies against `contentHash`.
- **The chain never sees plaintext.** Only commitments until the seller reveals the key at disclosure.

## Biggest design decision

**Verify a finding by running it, not by reading it — and make the run reproducible enough to commit on-chain.**

The naive design has a grader read the writeup or scan the source for suspicious strings, then assert a severity number. That is the weakest link a black-box market cannot afford: the buyer pays on the grader's word, and text-based grading is fooled by an inflated writeup or an obfuscated payload. Static checks answer "does this *look* malicious?"; the buyer needs "does this *do* what the seller says?"

So the oracle is a **dynamic sandbox**: it executes the package with every dangerous operation intercepted, feeds it canary credentials, and records what it actually did — which files it read, where it sent data, what it decoded and ran at runtime, which secrets ended up in an outbound request. Three consequences shape the market:

1. **The grade is derived, not asserted.** The effects bitmask is computed from the trace. The oracle cannot sign "steals credentials" unless a canary literally appeared in an intercepted upload.
2. **The grade is reproducible, so it can be committed and challenged.** Clock, randomness, network and filesystem are pinned, so the same package always yields the same `traceHash`. That hash plus the sandbox's own hash go into the EIP-712 attestation. A challenge is a hash comparison, not an opinion contest.
3. **Price and severity are decoupled.** Buyers get a trustworthy behavioural fingerprint instead of a score, so the Dutch auction and contingent split can price it.

The cost: pinning everything makes the sandbox a model of a host rather than a real one — the limitation below. Still the right trade: a market where the buyer cannot inspect the goods lives or dies on whether the verifier can be checked, and only an execution-based, reproducible verifier can be.

## One important limitation

**The verifier only sees what the sandbox can trigger — and because the sandbox must be public and deterministic to be checkable, an attacker can read it and write malware that behaves innocently inside it.**

The sandbox pins the clock to zero, fixes randomness, and has no real network. Any payload whose trigger lies outside that model produces a clean trace: code that fires only after a certain date, only on a real CI runner, only when a native binary is present, only after a genuine TLS handshake with its command server, or only when it detects it is not being watched. All are common in real npm malware.

This cuts both ways. A genuine finding the sandbox cannot reproduce **cannot be listed** — the market excludes the most evasive, often most valuable, intel. And "graded clean by CyberBlock" must never be read as "safe."

The determinism that makes the oracle auditable is what makes it predictable to evade; the tension is inherent. Mitigations, out of scope here: heterogeneous detonators (a real pinned container with a network sink alongside the deterministic model) whose *agreement* is signed; sandbox variants committed by hash but chosen at grading time; and reputation tied to later advisory confirmation, which the contingent split already partially does.

---

## Architecture

```
Base Sepolia:  CyberBlock.sol  — Dutch auction, escrow, stake, hash-locked reveal,
                                 challenge/arbiter, contingent escrow, reputation

  seller agent  ──seal, list, deliver, disclose──▶ ┐
  buyer agent   ──evaluate, buy, challenge───────▶  │ contract
  oracle        ──detonate, sign, confirm────────▶  │
  arbiter       ──re-detonate, resolve───────────▶  ┘
                     │ deterministic instrumented sandbox + OSV novelty check

Next.js app (Vercel): reads chain state, drives the agents via API routes,
  shows observed effects, the live agent console, and the public disclosure feed.
```

- **Contract (`contracts/contracts/CyberBlock.sol`):** one Solidity file, native ETH, no token. Reputation is `sold / slashed / confirmed / unconfirmed` counters that gate the auction start price.
- **Sandbox (`lib/sandbox.ts`):** deterministic instrumented detonation; its hash is the arbiter of record.
- **Oracle (`lib/oracle.ts`):** grading + challenge adjudication.
- **Optional AI:** with `ANTHROPIC_API_KEY`, Claude checks that captured artifacts demonstrate the seller's `expectedResult` and makes the buyer's purchase decision; otherwise deterministic logic runs.

## Run it

```bash
npm install && npm --prefix contracts install
npm run contracts:test      # 27 tests over every fund flow
npm run fixtures            # build demo tarballs + findings
npx tsx scripts/selftest.ts # crypto + sandbox + oracle, no chain
```

Local end-to-end (fast-forwards the time windows):

```bash
cd contracts && npx hardhat node                              # terminal 1
npx hardhat run scripts/deploy.ts --network localhost         # terminal 2 (writes lib/contract.json)
npx tsx scripts/fund-local.ts                                 # fund the four agents
npx tsx scripts/demo.ts                                       # walks all scenes on-chain
```

Web app: `npm run dev` → http://localhost:3000

### Deploy to Base Sepolia

`.env` holds testnet keys (git-ignored). The deployer is also the oracle; a separate `ARBITER_ADDRESS` is required. Fund the deployer from a [faucet](https://docs.base.org/tools/network-faucets), then:

```bash
export ORACLE_ADDRESS=<deployer> ARBITER_ADDRESS=<arbiter>
npm run deploy    # deploys, tops seller/buyer/arbiter up to 0.015 ETH, writes lib/contract.json
npm run fund      # re-top-up the demo agents if the walkthrough reverts with insufficient funds
```

Verify on Basescan:

```bash
cd contracts && npx hardhat verify --network baseSepolia <address> <oracle> <arbiter>
```

## Repo layout

| Path | What |
|---|---|
| `contracts/contracts/CyberBlock.sol` | the market: auction, escrow, challenge/arbiter, contingent |
| `contracts/test/` | 27 tests covering every fund flow |
| `lib/sandbox.ts` | deterministic, hashable detonation runtime |
| `lib/oracle.ts` | grading + challenge adjudication |
| `lib/crypto.ts` | seal / wrap / open, hash-locked key |
| `lib/agents.ts` | seller, buyer, oracle, arbiter actions |
| `app/` | Next.js dashboard + API routes |
| `scripts/demo.ts` | end-to-end demo |
| `fixtures/` | demo packages + findings + simulated advisory feed |

Testnet only. Demo time windows are compressed to minutes; production would use hours for the challenge window, days for the embargo, weeks for confirmation, and a pinned container for detonation.
