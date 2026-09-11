# CyberBlock

**A market where the paying buyer's fee funds public disclosure for everyone else — turning private zero-day intel into a coordinated-disclosure bounty rather than a black-market resale. Every finding is *detonated* in an instrumented sandbox and its observed behaviour signed on-chain before anyone can see it, priced by a Dutch auction, with part of the price riding on the world later confirming the finding.**

Buyers purchase npm supply-chain threat intel they cannot inspect before paying. A neutral oracle runs the seller's reproduction script in a sandbox, records exactly what the package did, and signs those observed effects *before* the finding can be listed. Buyers bid down a Dutch auction on the observed effects and a one-sentence outcome alone — there is no severity score to trust. After a short embargo the decryption key is published on-chain and the finding becomes free for every defender.

- **Live app:** _add your Vercel URL_
- **Contract (Base Sepolia):** [0x5a7bd8c64058996401345a66dad064724afd9e36](https://sepolia.basescan.org/address/0x5a7bd8c64058996401345a66dad064724afd9e36)
- **Demo video:** _add link_

---

## The vertical

Independent researchers routinely find malicious or vulnerable npm packages — install-hook credential exfiltration, obfuscated eval payloads, backdoors — days to weeks before OSV/GHSA/Snyk pick them up. Today that intel moves badly: scattered tweets, GitHub issues, private Slack DMs, and the occasional extortion attempt. Buyers (scanner vendors, blue teams, registries) would pay for same-day, machine-ingestable findings, but there is no venue that protects either side.

Why this vertical and not a generic "cyber intel" one: the evidence is **mechanically re-checkable by execution**. "`pkg@version` reads `~/.npmrc` on install and POSTs it out" can be *reproduced* by detonating the package in a sandbox and watching it happen. That gives deterministic, behaviour-based verification — the single hardest part of any information market — which governance analysis or sports scouting cannot offer.

## How the oracle grades (the core mechanism)

The oracle does **not** pattern-match on source text. The seller submits a `repro` — how to trigger the behaviour (`install`, or `require <file>`) — plus the effects they claim. The oracle **detonates** that repro in [`lib/sandbox.ts`](lib/sandbox.ts): the package's own code runs, but every dangerous syscall it can reach is replaced with an instrumented stub. The filesystem returns **canary credentials**; the network is a **sink** that records egress and inspects payloads (base64 included) for those canaries; child processes, the environment, the clock and randomness are all stubbed. The ordered list of intercepted calls is the **execution trace**.

Because every source of non-determinism is stubbed, the same package + repro always produces the same trace, so its `keccak256` (`traceHash`) is reproducible. The **effects bitmask** (exfiltrates credentials, beacons out, reads sensitive files, runs on install, …) is derived *mechanically* from the trace — that is what gates money. The oracle refuses to sign unless every claimed effect actually appears in the trace, so an inflated writeup fails.

**Verifying the access, not just the effects.** The detonation also retains the *concrete artifacts* the exploit produced — the exfiltrated payload base64-decoded to reveal the actual captured token, the exact command spawned, the dynamically-evaluated second stage of an obfuscated payload, the credential file read. The seller declares an `expectedResult` (the new access the exploit should grant), and Claude checks those captured artifacts against it: *did the run actually obtain this access?* This gates the attestation (`access-not-demonstrated`) when an API key is set, and falls back to a mechanical "at least one concrete artifact was captured" check otherwise. The captures are deterministic, so they are committed inside `traceHash` alongside the trace and reproduced on re-verification. The money-gating effects bitmask stays purely mechanical.

The sandbox's own `keccak256` (`sandboxHash`) is committed in every attestation, so after disclosure **anyone can re-fetch the package, re-run this exact sandbox, and reproduce the trace and effects**. A lying oracle leaves a permanent, falsifiable record. This is why the trust model is "trust, and check" rather than "trust the oracle."

## Act as a real buyer or seller (connect a wallet)

The market is not only driven by the four autonomous agents — anyone can transact on it with their own wallet on Base Sepolia:

- **Sell a finding.** The **Sell** tab lets you author a package (a real, self-contained malicious npm package built from an editable template) and its finding. Your browser packs the tarball, the oracle detonates *those exact bytes* and returns its signature, and then **your wallet** signs `list()` and posts the stake. Nothing is listed without the oracle's signature.
- **Buy a finding.** Open any live listing in the **Market** tab and, under **Act with your wallet**, buy it at the current auction price straight from your wallet. Excess is refunded, so the app quotes the auction's start price as a ceiling to avoid racing the price clock.
- **Deliver, decrypt, settle, disclose.** Once you are the seller or buyer of a listing, the same panel exposes the follow-on steps: the seller delivers the key and later discloses it, the buyer decrypts their copy locally (the app checks it hashes to the on-chain commitment), and anyone may release the base once the challenge window closes.

Connect any injected wallet (MetaMask, Rabby, Coinbase Wallet). The app will add/switch it to Base Sepolia; fund it from a [Base Sepolia faucet](https://docs.base.org/tools/network-faucets). The autonomous-agent buttons remain available on every listing for the scripted demo.

## Agent-native CLI (no browser, your own key)

The web UI is a window onto the market, not the market. Any autonomous agent can trade with its own Base Sepolia key through [`scripts/cli.ts`](scripts/cli.ts). Every command prints one JSON object, so an agent loop can parse it directly:

```bash
export CYBERBLOCK_PRIVATE_KEY=0x…            # the agent's key (fund it from a Base Sepolia faucet)
export CYBERBLOCK_API=https://<deployed-app>  # the oracle host; defaults to http://localhost:3000

npm run cli -- market                         # what is for sale: effects, outcome, live price — never the contents
npm run cli -- buy 3 --max 0.005              # pay the current auction price (excess refunded)
npm run cli -- receive 3                      # unwrap the key, check keccak(plaintext) == contentHash, print the finding
npm run cli -- challenge 3 "trace mismatch"   # re-detonate locally, post a bond and your trace hash

npm run cli -- sell my-finding.json --contingent 60   # seal → oracle detonates + signs → list() from your wallet
npm run cli -- deliver 4 && npm run cli -- settle 4 && npm run cli -- disclose 4
npm run cli -- verify 4                       # anyone: re-run the committed sandbox against the disclosed finding
```

`sell` takes a finding in the [fixture format](fixtures/findings/evil-widget-1.2.0.json); if `target.artifact` is a local `.tgz` the CLI inlines it so the oracle grades exactly those bytes. The seal key is derived from the agent's private key and the finding (and cached in `~/.cyberblock/keys.json`), so `deliver`/`disclose` need nothing but the key. The only off-chain calls are `POST /api/oracle/attest` (grading) and `POST /api/verify`; everything else is a direct contract call signed by the agent.

## Pricing: Dutch auction + two-part contingent

There is no seller-invented price and no severity multiplier. Price is **discovered**:

- **Dutch auction.** The listing opens at the seller's reputation cap and the price falls linearly to a reserve. The first buyer to accept clears at the current price; any excess they send is refunded, so an agent can quote a ceiling without racing the clock. Single transaction, works with one interested buyer, and the decay matches how intel value decays.
- **Two-part contingent split.** The seller chooses what fraction of the clearing price is **contingent** (up to 90%). The base is paid at settlement; the contingent share is escrowed until an external advisory (OSV/GHSA, a registry takedown) confirms the finding after disclosure. If it confirms, the contingent goes to the seller; if the confirmation window passes with nothing, most of it returns to the buyer and a slice stays in a disclosure pool (so a buyer who could suppress an advisory gains nothing by doing so). The split the seller chooses is itself a **credibility signal**: only a seller who believes the finding is real wants a large contingent.

## Disputes: a *stronger* challenge, not a re-run of the oracle

An old design flaw: if a dispute just re-runs the same grader, it always agrees with itself and carries no information. Here the **arbiter is a separate key from the oracle**, and a challenge runs a *stricter* procedure — it re-detonates the repro several times and upholds the seller only if every run reproduces the attested trace and effects, the artifact still hashes to the attested bytes, the sandbox is unchanged, and OSV still has no entry. Anyone (not just the buyer) may challenge by posting a bond and the trace hash their own run produced. A dishonest grade must therefore survive two independent parties.

## Lifecycle (on-chain)

1. **grade** — seller seals the finding (XChaCha20) and sends plaintext + key to the oracle. The oracle detonates the repro, verifies the claimed effects appear, checks OSV, and returns an **EIP-712 attestation**: artifact hash, content hash, key hash, **trace hash, sandbox hash, outcome hash, effects**, novelty, install base. No listing without one.
2. **list** — seller posts the attestation + sealed blob, bonded by a stake, opening a **Dutch auction** with a chosen base/contingent split. Buyers see only the effects and the one-sentence outcome.
3. **buy** — a buyer agent decides from that grade alone and pays the current auction price into escrow (excess refunded).
4. **deliver** — seller posts the key ECIES-wrapped to the buyer. The buyer checks `keccak256(plaintext) == contentHash`, so delivery is never an oracle question.
5. **settle / challenge** — after a challenge window the base releases to the seller. A challenge in that window sends the arbiter to re-detonate.
6. **disclose** — after the embargo the key is published on-chain; anyone can re-run the sandbox to check the oracle.
7. **confirm / expire** — an external advisory releases the contingent share to the seller; otherwise it returns to the buyer.

## Trust assumptions

- **An oracle grades and an arbiter rules — two separate keys.** The oracle signs every attestation; a different party re-detonates to rule on challenges. This is the central trust assumption, stated plainly.
- **But every grade is falsifiable by execution.** The sandbox is deterministic public code; its `keccak256` is committed in each attestation and the npm tarball is content-addressed. After disclosure anyone can fetch the sandbox (`/api/sandbox`), re-detonate the committed package, and get a permanent, reproducible contradiction if the oracle ever lied. The app ships a one-click "re-detonate" button. The honest next steps are N independent detonators slashed when a re-run contradicts them, and running the sandbox inside a zkVM so the grade carries its own proof.
- **The sandbox models behaviour, it does not perfectly emulate a host.** It intercepts the syscalls that matter for supply-chain malware (fs, net, process, env) against canary secrets; a payload that only misbehaves against a real kernel or a live network it cannot reach is out of scope. A production deployment would detonate in a pinned container with a real network sink.
- **Payment identity and delivery key are separate, by necessity.** A browser wallet never exposes the raw private key ECIES would need to decrypt a delivery, so a wallet buyer's browser generates a throwaway secp256k1 "inbox" keypair (kept in local storage) and passes its public key as the buyer key at `buy()`. The seller wraps the decryption key to that inbox key; the browser decrypts with it and still verifies the result against the on-chain `contentHash`. It is the buyer's encrypted-delivery address, like a PGP key, distinct from the wallet that pays.
- **The chain never sees plaintext.** Only commitments (`contentHash`, `keyHash`, `traceHash`) until the seller reveals the key at disclosure.

## Biggest design decision

**Grade observed behaviour, not asserted patterns, and let the market — not a hand-set severity — price it.** The oracle detonates the repro and signs what the package *did*; buyers price that behaviour through a Dutch auction and a contingent split that ties the seller's payout to the finding turning out to be real. This replaces the weakest part of a naive design (a single grader asserting a severity number) with a re-runnable execution trace and market-discovered price.

## One important limitation

**Nothing on-chain stops a buyer from leaking the finding during the embargo.** Once the key is delivered, the buyer has the plaintext and could republish immediately, collapsing the exclusivity the market sells. This is the same limitation every real embargoed-disclosure program lives with (CERT, vendor pre-notification, HackerOne); it is not solved by cryptography, only by reputation and the fact that the finding goes fully public shortly anyway. A second, narrower limitation: the sandbox proves "this behaviour happened under these stubs," not "this behaviour happens on every host," which is why the sandbox is public and re-runnable.

---

## Architecture

```
Base Sepolia:  CyberBlock.sol  — Dutch auction, escrow, stake, hash-locked reveal,
                                 challenge/arbiter, contingent escrow, reputation

  seller agent  ──seal, list, deliver, disclose──▶ ┐
  buyer agent   ──evaluate, buy, challenge───────▶  │ contract
  oracle        ──detonate, sign, confirm────────▶  │
  arbiter       ──re-detonate, resolve───────────▶  ┘
                     │ runs a deterministic instrumented sandbox + OSV novelty check

Next.js app (Vercel): reads chain state, drives the agents via API routes,
  shows the observed effects, the live agent console, and the public disclosure feed.
```

- **Contract (`contracts/contracts/CyberBlock.sol`):** one Solidity file, native ETH, no token. Reputation is `sold / slashed / confirmed / unconfirmed` counters that gate the auction start price.
- **Sandbox (`lib/sandbox.ts`):** deterministic instrumented detonation. Its hash is the market's arbiter of record.
- **Oracle (`lib/oracle.ts`):** detonation grading + challenge adjudication. The severity score is gone; the grade is an observed-effects bitmask over a reproducible trace.
- **Optional AI:** set `ANTHROPIC_API_KEY` and Claude (a) corroborates that a trace substantiates the outcome and (b) makes the buyer's purchase decision from the grade; otherwise deterministic logic runs.

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

Or run the web app: `npm run dev` → http://localhost:3000

### Deploy to Base Sepolia

`.env` holds testnet keys (git-ignored). The deployer is also the oracle; a **separate** `ARBITER_ADDRESS` is required. Fund the deployer/oracle from a [Base Sepolia faucet](https://docs.base.org/tools/network-faucets), then:

```bash
export ORACLE_ADDRESS=<deployer> ARBITER_ADDRESS=<arbiter>
npm run deploy    # deploys, funds seller/buyer/arbiter, writes lib/contract.json
```

## Repo layout

| Path | What |
|---|---|
| `contracts/contracts/CyberBlock.sol` | the market: auction, escrow, challenge/arbiter, contingent |
| `contracts/test/` | 27 tests covering every fund flow |
| `lib/sandbox.ts` | the deterministic, hashable detonation runtime |
| `lib/oracle.ts` | detonation grading + challenge adjudication |
| `lib/crypto.ts` | seal / wrap / open, hash-locked key |
| `lib/agents.ts` | seller, buyer, oracle, arbiter actions |
| `app/` | Next.js dashboard + API routes |
| `scripts/demo.ts` | end-to-end demo |
| `fixtures/` | demo packages + findings + simulated advisory feed |

Testnet only. Demo time windows are compressed to minutes; a production deployment would measure the challenge window in hours, the embargo in days, and the confirmation window in weeks, and detonate in a pinned container.
