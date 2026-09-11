# CyberBlock

**A market where the paying buyer's fee funds public disclosure for everyone else — turning private zero-day intel into a coordinated-disclosure bounty rather than a black-market resale, with every finding graded on-chain before anyone can see it.**

Buyers purchase npm supply-chain threat intel they cannot inspect before paying. A neutral oracle grades each sealed finding and signs it *before* it can be listed; the buyer pays from the grade alone; after a short embargo the decryption key is published on-chain and the finding becomes free for every defender. What the buyer actually pays for is **early access** to a disclosure that is going to happen anyway.

- **Live app:** _add your Vercel URL_
- **Contract (Base Sepolia):** [0x8f87d8f4725f7ca9fc5cb972aea1854431eab2e7](https://sepolia.basescan.org/address/0x8f87d8f4725f7ca9fc5cb972aea1854431eab2e7)
- **Demo video:** _add link_

---

## The vertical

Independent researchers routinely find malicious or vulnerable npm packages — install-hook credential exfiltration, obfuscated eval payloads, backdoors — days to weeks before OSV/GHSA/Snyk pick them up. Today that intel moves badly: scattered tweets, GitHub issues, private Slack DMs, and the occasional extortion attempt against the maintainer. Buyers (scanner vendors, blue teams, registries) would pay for same-day, machine-ingestable findings, but there is no venue that protects either side.

Why this vertical and not a generic "cyber intel" one: the evidence is **mechanically re-checkable**. "`pkg@version` ships a `postinstall` that reads `~/.npmrc` and POSTs it to `evil.xyz`" can be verified by re-downloading the tarball and re-scanning it. That gives deterministic verification — the single hardest part of any information market — which governance analysis or sports scouting simply cannot offer.

## How a trade works (six on-chain steps)

1. **`grade`** — The seller seals a finding (XChaCha20) and sends the plaintext + key to the oracle. The oracle re-runs a public detector against the *real* tarball, confirms the seller's claimed indicators actually appear, checks OSV for prior disclosure, and returns an **EIP-712 signed attestation**: artifact hash, content hash, key hash, detector hash, severity, class, novelty, install base. No listing can exist without one.
2. **`list`** — The seller submits the signed attestation + the sealed blob on-chain, bonded by a stake. The price must sit inside a band the contract derives from the attested severity, class, and blast radius. The sealed finding lives in the event log; buyers see only the grade.
3. **`buy`** — A buyer agent decides from the attested metadata alone (never the contents) and pays the price into escrow.
4. **`deliver`** — The seller posts the symmetric key wrapped to the buyer's public key (ECIES). The buyer decrypts and checks `keccak256(plaintext) == contentHash`. Whether delivery was honest is therefore **never** an oracle question.
5. **`settle`** — After a challenge window the escrow releases to the seller. A dispute in that window only ever re-checks the attestation, not the delivery.
6. **`disclose`** — After the embargo, the key is published in an on-chain event. Anyone can now decrypt the finding for free — and re-run the committed detector against the committed artifact hash to confirm the oracle graded it honestly.

## Trust assumptions

- **One oracle grades and adjudicates.** It holds the signing key that gates every listing and resolves every dispute. This is the central trust assumption, stated plainly.
- **But every grade is falsifiable.** The detector is deterministic public code; its `keccak256` is committed inside each attestation, and the npm tarball is content-addressed by `artifactHash`. After disclosure, anyone can fetch the detector (`/api/detector`), re-run it against the artifact, and get a permanent, reproducible contradiction if the oracle ever lied. The app ships a one-click "re-verify the oracle" button that does exactly this. So the model is not "trust the oracle" but "trust, and check" — the honest next step is N independent attestors whose stake is slashed when a re-run contradicts them.
- **The chain never sees plaintext.** It stores only commitments (`contentHash`, `keyHash`) until the seller reveals the key at disclosure.
- **Off-chain availability of the artifact.** Verification and dispute resolution assume the tarball can still be fetched (here, committed demo fixtures; in production, the content-addressed registry copy).

## Biggest design decision

**Verification was moved from an ex-post dispute to an ex-ante signed attestation, and the product was reframed from "buying information" to "buying embargo time."**

Most designs treat this as an escrow problem: pay, receive, and if you got cheated, dispute. That makes the buyer's protection reactive — they get burned, then made whole. Here the oracle grades the sealed finding *before* it can be listed, so the buyer purchases a sealed envelope a neutral verifier has already opened, graded, and resealed. Disputes become the fallback, not the primary protection. This also unlocks on-chain price discovery: the price is a pure function of attested severity, class, and blast radius, not a number the seller invents. And because every finding is disclosed after the embargo, the buyer isn't paying for secrecy — they're paying for a head start on intel that becomes a free coordinated disclosure for everyone. The cost is concentration of trust in the oracle, which the auditability design above is built to contain.

## One important limitation

**Nothing on-chain stops a buyer from leaking the finding during the embargo.** Once the key is delivered, the buyer has the plaintext and could republish it immediately, collapsing the exclusivity the market sells. This is the same limitation every real embargoed-disclosure program lives with (CERT, vendor pre-notification, HackerOne), and it is not solved by cryptography — only by reputation, contracts, and the fact that the finding goes fully public shortly anyway. We chose not to pretend otherwise. (A second, narrower limitation: the detector proves "this pattern exists," and OSV proves "not yet public," but neither proves the *severity number* is objectively right — that judgment still lives in the detector's weights, which is why they are public and re-runnable.)

---

## Architecture

```
Base Sepolia:  CyberBlock.sol  — listings, escrow, stakes, hash-locked reveal, reputation

  seller agent ──seal, list, deliver, disclose──▶ ┐
  buyer agent  ──evaluate, buy, dispute────────▶  │ contract
  oracle       ──sign attestation, resolve─────▶  ┘
                     │ runs a deterministic detector + OSV novelty check

Next.js app (Vercel): reads chain state, drives the agents via API routes,
  shows attested metadata, the live agent console, and the public disclosure feed.
```

- **Contract:** one Solidity file, native ETH, no token. Reputation is a `sold/slashed` counter that gates listing size.
- **Detector (`lib/detector.ts`):** deterministic heuristics for install-hook exfil, obfuscated eval chains, credential-path reads, and known-bad hosts. Its hash is the market's arbiter of record.
- **Payload storage:** the sealed finding rides in the `Listed` event's calldata — a few KB, effectively free on Base Sepolia. No IPFS.
- **Agents:** the oracle and both agents are the same code, invoked by CLI (`npm run demo`) and by the app's API routes. Signing keys stay server-side.
- **Optional AI:** set `ANTHROPIC_API_KEY` and the buyer agent uses Claude to make and explain its purchase decision from the grade; otherwise a deterministic policy runs.

## Run it

```bash
# 1. install
npm install && npm --prefix contracts install

# 2. contract tests + fixtures
npm run contracts:test
npm run fixtures

# 3a. local end-to-end (fast-forwards the time windows)
cd contracts && npx hardhat node        # terminal 1
npx hardhat run scripts/deploy.ts --network localhost   # terminal 2 (writes lib/contract.json)
npx tsx scripts/fund-local.ts           # fund the agents on the local node
BBB_LOG_STDOUT=1 npx tsx scripts/demo.ts   # walks all five scenes on-chain

# 3b. or run the web app
npm run dev                             # http://localhost:3000
```

### Deploy to Base Sepolia

`.env` already holds freshly generated testnet keys (git-ignored). Fund **one** address — the deployer/oracle printed by `scripts/fingerprint.ts` — from a [Base Sepolia faucet](https://docs.base.org/tools/network-faucets), then:

```bash
export ORACLE_ADDRESS=<deployer address from .env>   # deployer == oracle
npm run deploy      # deploys, funds seller+buyer, writes lib/contract.json
```

Copy the printed Basescan link into this README, redeploy the app to Vercel with the same env, and you have a public, self-explanatory app backed by a verified testnet contract.

## Repo layout

| Path | What |
|---|---|
| `contracts/contracts/CyberBlock.sol` | the market |
| `contracts/test/` | 22 tests covering every fund flow |
| `lib/detector.ts` | the deterministic, hashable arbiter |
| `lib/oracle.ts` | grading + dispute adjudication (no LLM) |
| `lib/crypto.ts` | seal / wrap / open, hash-locked key |
| `lib/agents.ts` | seller, buyer, oracle actions |
| `app/` | Next.js dashboard + API routes |
| `scripts/demo.ts` | five-scene end-to-end demo |
| `fixtures/` | demo packages + findings (never published to real npm) |

Testnet only. The demo time windows are compressed to minutes; a production deployment would measure the challenge window in hours and the embargo in days.
