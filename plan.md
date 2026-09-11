# Black Box Bazaar — Design Doc

**Vertical:** Supply-chain threat intelligence for developer ecosystems (VS Code extensions, npm packages, MCP servers)

---

## 1. The problem the prompt is actually testing

Information has zero marginal cost to copy and no assessable value until it's been seen.

- A buyer who inspects it no longer needs to pay.
- A seller who is paid first has no reason to deliver anything real.

"Build a marketplace" is scaffolding. The real deliverable is **a mechanism that makes both sides behave honestly despite that asymmetry**, deployed on a public testnet where a stranger can click through it.

### Grading signals

| Signal | What they're checking |
|---|---|
| Product judgment | Is the vertical real, and did you model *its* participants — not generic ones? |
| Credibility of mechanism | Does it survive an obvious attack, or collapse to "trust me"? |
| Finished experience | Can a stranger run the full loop and see txs on a block explorer? |
| Scope discipline | They said 1–2 hours. Overbuilding reads as bad judgment. |

They explicitly said code volume and quality don't matter. **The README questions are the real exam.**

---

## 2. Chosen vertical

Independent researchers find malicious or vulnerable packages, VS Code extensions, and MCP servers before mainstream feeds (NVD, OSV, Snyk) pick them up — those lag by days to weeks. The buyers are security scanners and vendors who want findings ingested automatically, same-day.

**Why this vertical and not a generic "cyber intel" one:**

- **Real participants.** Researchers, vendors, blue teams, scanner products. This trade happens today, badly — via scattered tweets, GitHub issues, and Slack DMs.
- **Evidence is mechanically re-checkable.** "Package X@version Y ships an obfuscated `postinstall` that exfils to domain Z" can be verified by re-downloading and re-scanning. That gives you **deterministic verification**, which is the single hardest part of this assignment. Governance analysis and sports scouting can't give you that — they're stuck with subjective juror votes.
- **Real failure modes.** Duplicate submissions, buyer free-riding after disclosure, low-severity padding, extortion instead of sale.
- **Real incentives.** Severity-tiered pricing, exclusivity windows, embargo periods.

**Risk to manage:** don't let it look like a contract bolted onto existing work. The mechanism must obviously be new. Mention the background once as context, not as the substance.

---

## 3. Core mechanism — the four required decisions

### 3.1 Delivery without pre-inspection
Seller commits `hash(target, version, description, PoC)` on-chain. Buyer pays into escrow. Payload (encrypted blob, IPFS or plain hosted) is released on payment. The commitment is what makes "did you deliver what you sold" provable later.

### 3.2 Seller credibility (ex-ante)
Stake bonded per listing, slashed on bad delivery. Optionally reputation-gated listing size — new sellers capped to low-value findings until they build a record.

### 3.3 Buyer protection (ex-post)
Challenge window of N blocks. Escrow does not release until it closes.

### 3.4 Dispute resolution
Oracle agent re-runs the detection check against the real artifact.
- Match → seller paid, reputation up.
- No match / already public / duplicate → stake slashed, buyer refunded.

---

## 4. The x-factor: pre-purchase attestation

**This is the strongest single addition and it changes the shape of the mechanism.**

Everything in section 3 is damage control — the buyer gets burned, then made whole. That's what most applicants will build. The stronger answer is to make the information **verifiable before purchase without being revealed.**

Before a listing goes live, the oracle runs detection against the target and posts a signed on-chain attestation containing *properties*, never contents:

- Confirmed reproducible against `package@version`
- Severity score (e.g. 8.1)
- Vulnerability class (e.g. RCE via `postinstall`)
- Approximate affected install base
- Novelty: not present in OSV/NVD as of block N
- Content hash `0x...`

The buyer sees all of it and still cannot reconstruct the finding. They're buying a sealed envelope that a neutral verifier has already opened, graded, and resealed.

**Why it's worth the 30–40 lines:**

- **Restructures the mechanism.** Disputes become the fallback, not the primary protection. Directly serves "credibility of mechanism."
- **Unlocks price discovery.** Price no longer has to be a number the seller invents — it can be derived from attested severity. The market prices information it has never seen. Most submissions will have no answer for how anything gets priced.
- **Mirrors reality.** HackerOne triagers validate before a vendor pays; CNAs assign severity before disclosure. You're putting an existing trusted-intermediary role on-chain and making it auditable.
- **Cheap.** You already need the oracle for disputes. You're calling it earlier and writing the result to a struct.

**The cost, which must be owned in the README:** this concentrates trust in the oracle. Name it as the central trust assumption and sketch the exit — multiple independent attestors with staked reputation, majority agreement required, attestors slashed when a challenge proves them wrong. Not built tonight; knowing it's the next problem is what counts.

---

## 5. Supporting ideas (decide later what ships)

### 5.1 Auto-disclosure after settlement — *high value, near-zero cost*
Once the oracle confirms and the challenge window closes, the contract publicly emits the preimage / decryption key. Anyone can pull it free.

This is what turns a private intel resale market into **a coordinated-disclosure clock with a bounty attached.** The first buyer subsidizes disclosure for everyone else, the way a bug bounty subsidizes a patch for all users rather than just the reporter. Implementation: emit plaintext or key in an event inside `settle()`.

One sentence in the README does most of the work here.

### 5.2 Real detection logic as the oracle — *highest credibility, moderate cost*
Don't hand-wave the verifier with a toy string match. Run actual static-analysis heuristics: suspicious `postinstall` scripts, obfuscated eval chains, known-bad C2 domains, unexpected network calls. Even stripped down, this means you're not *simulating* verification — you're running a real check as the arbiter. This is where your domain expertise shows up on camera and it's hard for other applicants to match.

### 5.3 Time-decay pricing — *conceptually good, possibly redundant*
Listing price highest in the first N blocks, decaying on a curve after. Encodes the real security fact that a malicious package does damage every day it's undetected, so early disclosure is worth more than late disclosure.

**Tension:** severity-derived pricing from attestation (§4) does overlapping conceptual work. Having both may be redundant rather than additive. Decide by asking which one you can explain more crisply in the video.

### 5.4 Blind auction on attested metadata — *best demo footage, most work*
Multiple buyer agents bid on severity / novelty / install-base without seeing contents. Highest bid wins. Price is *discovered*, not posted.

Makes the "autonomous agents" requirement unmistakably real and is visually excellent in a demo. Only shines if attestation already exists. Build only if ahead of schedule.

### 5.5 Cross-agent broadcast — *cut first*
Several buyer agents representing different vendors watch the same contract; when one settles, §5.1's public reveal alerts all of them simultaneously. Demonstrates the network effect with almost no extra code — run two buyer agents instead of one. Nice 30-second closer for the video, first thing to drop.

---

## 6. Build plan

### Contract (Base Sepolia or similar — cheap, fast, good explorer)
One contract, roughly:

```
attest(target, severity, class, novelty, contentHash)   // oracle, pre-listing
list(contentHash, price, stake)                          // seller
buy(listingId)                                           // escrow
deliver(listingId, key)                                  // seller reveals
dispute(listingId)                                       // buyer, within window
settle(listingId)                                        // release or slash + public reveal
```

Reputation = a mapping of completed vs. slashed counts. **Do not build a token.**

### Off-chain
- Seller agent: publishes findings, posts stake.
- Buyer agent: has a budget and a purchase policy over attested metadata.
- Oracle agent: runs detection, signs attestations, resolves disputes.
- Payload storage: IPFS, or a hosted blob. The hash is what matters.

### Frontend
One page. Listings with attested metadata, buy button, decrypted payload post-purchase, dispute button, explorer links on every tx. Self-explanatory is the requirement; pretty is not.

### Demo data
Seed a deliberately malicious test package with an obvious IOC (suspicious `postinstall` hitting a domain). Also seed one bad-faith listing where the IOC doesn't actually match, so the slash path is demonstrable.

---

## 7. README — write this first, not last

They named four things. Four short sections:

1. **Vertical** — plus one sentence on why this market is broken today.
2. **Trust assumptions** — aggressively honest. "We assume a single honest oracle" is a fine answer. Pretending you have none is a fail.
3. **Biggest design decision** — the strongest available: *verification moved from ex-post dispute to ex-ante attestation, trading decentralization for actual buyer protection.*
4. **One limitation** — best answer is the one they'd find anyway. Candidates:
   - The buyer can resell after decrypting; nothing on-chain prevents leakage.
   - The oracle verifies "does this pattern exist," not "is this genuinely novel." A seller could resell a public CVE as new. Mitigation sketch: check against OSV/NVD timestamps.

Pick one, state it flatly, don't over-mitigate.

**Pitch line for the top of the README:**

> A market where the paying buyer's fee funds public disclosure for everyone after a verification window — turning private zero-day intel into a coordinated-disclosure bounty rather than a black-market resale, with findings graded on-chain before anyone can see them.

---

## 8. Sequencing

| Time | Task |
|---|---|
| 20 min | Lock vertical + mechanism on paper. Don't code until the dispute rule fits in one sentence. |
| 45 min | Contract + deploy + verify on explorer. Get the address early — it's a required deliverable. |
| 45 min | Agents + minimal UI. |
| 20 min | README. |
| Last | Video, one take. |

**Video must show a dispute path, not just the happy path.** That's what proves the mechanism exists.

**Cut order if short on time:** cross-agent broadcast → blind auction → time-decay → auto-disclosure. Attestation and the real oracle are the last things to drop; they're the differentiators.

---

## 9. Honest risk assessment

- **Execution risk is the main threat.** A half-finished ambitious project loses to a clean, complete simple one. They said 1–2 hours and "get your sleep" — that's a judgment test.
- **The video carries most of the differentiation.** A 70%-as-good project that demos flawlessly beats yours if yours stumbles on camera.
- **Overclaiming in the README costs more than the feature gains.** If you claim the oracle solves verification generally and a reviewer spots the hole in ten seconds, you've lost ground.

If you're at hour two with a working boring version and a broken ambitious one: **ship the boring one.**