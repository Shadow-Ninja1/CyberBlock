/**
 * The sandbox — a deterministic, instrumented detonation of a package.
 *
 * The seller submits a `repro` (install, or require a file). The oracle runs that
 * repro HERE: the package's own code executes, but every dangerous syscall it can
 * reach — the filesystem, the network, child processes, the environment, the clock,
 * randomness — is replaced with an instrumented stub. The stubs return canary
 * values and RECORD what happened instead of doing real I/O. The ordered list of
 * recordings is the execution trace.
 *
 * Because every source of non-determinism is stubbed, the same tarball + repro
 * always produces the same trace, so its keccak256 (`traceHash`) is reproducible.
 * This file's own keccak256 (`sandboxHash`) goes into every attestation, so after
 * disclosure anyone can re-fetch the artifact, re-run this exact code, and confirm
 * it reproduces the trace and effects the oracle signed. A lying oracle leaves a
 * permanent, falsifiable record — the same auditability the old detector had, but
 * now over real observed behaviour instead of pattern-matching on source text.
 *
 * Safety: no real fs/net/process access is ever performed, so detonating a
 * malicious package cannot touch the host. Determinism: no clock, no randomness,
 * no environment reads escape the stubs.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { runInNewContext } from "node:vm";
import { keccak256, toHex, type Hex } from "viem";
import { Effect, type Capture, type SandboxResult, type Repro, type TraceEvent } from "./types";
import fingerprint from "./sandbox-fingerprint.json";

export const SANDBOX_VERSION = "cyberblock-sandbox/2.0.0";

/** Canary secrets planted in the fake home directory. Their appearance in an
 *  egress payload is proof of exfiltration — not an inference from source text. */
const CANARY_NPMRC = "//registry.npmjs.org/:_authToken=CANARY-npm-a1b2c3d4e5";
const CANARY_ENV_SECRET = "CANARY-env-9f8e7d6c5b";
const HOME = "/home/canary";

/** Hosts that are part of normal package plumbing; egress to these is not flagged. */
const BENIGN_HOSTS = ["registry.npmjs.org", "npmjs.com", "github.com", "githubusercontent.com", "nodejs.org"];

/** The fake home-directory files the package may try to read. */
const FAKE_FILES: Record<string, string> = {
  ".npmrc": CANARY_NPMRC,
  ".ssh/id_rsa": "-----BEGIN OPENSSH PRIVATE KEY-----\nCANARY-ssh-key\n-----END OPENSSH PRIVATE KEY-----",
  ".aws/credentials": "[default]\naws_secret_access_key = CANARY-aws-key",
  ".env": `SECRET=${CANARY_ENV_SECRET}`,
};

/** The fake process environment, seeded with a canary the package might exfiltrate. */
const FAKE_ENV: Record<string, string> = {
  PATH: "/usr/bin:/bin",
  HOME,
  NODE_ENV: "production",
  NPM_TOKEN: "CANARY-npm-token-token",
  AWS_SECRET_ACCESS_KEY: CANARY_ENV_SECRET,
};

// ---------------------------------------------------------------- tar reading

interface TarEntry {
  path: string;
  text: string;
}

/** Minimal reader for the gzipped POSIX tar npm ships. Inlined so `sandboxHash`
 *  covers the whole parse. */
export function readTarball(buf: Buffer): TarEntry[] {
  const raw = buf[0] === 0x1f && buf[1] === 0x8b ? Buffer.from(gunzipSync(buf)) : buf;
  const entries: TarEntry[] = [];
  let off = 0;
  let longName: string | null = null;

  while (off + 512 <= raw.length) {
    const header = raw.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;

    const nameField = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const sizeOctal = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeOctal || "0", 8) || 0;
    const typeFlag = String.fromCharCode(header[156]);
    const blocks = Math.ceil(size / 512);
    const body = raw.subarray(off + 512, off + 512 + size);
    off += 512 + blocks * 512;

    if (typeFlag === "L") {
      longName = body.toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    const path = longName ?? (prefix ? `${prefix}/${nameField}` : nameField);
    longName = null;
    if (typeFlag === "0" || typeFlag === "\0") {
      entries.push({ path: normalize(path), text: body.toString("utf8") });
    }
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

/** npm tarballs nest everything under `package/`. Strip it for readable paths. */
function normalize(p: string): string {
  return p.replace(/^\.?\/*/, "").replace(/^package\//, "");
}

export function sha256Hex(buf: Buffer): Hex {
  return `0x${createHash("sha256").update(buf).digest("hex")}`;
}

// --------------------------------------------------------------- detonation

/** Which canary secrets does this string carry? Used to prove exfiltration.
 *  Searches the raw string AND any base64-decoded view of it, because malware
 *  almost always base64-encodes a payload before it beacons out. */
function canariesIn(s: string): string[] {
  const SECRETS: Record<string, string> = {
    ".npmrc-token": "CANARY-npm-a1b2c3d4e5",
    "env-secret": CANARY_ENV_SECRET,
    "aws-key": "CANARY-aws-key",
    "ssh-key": "CANARY-ssh-key",
  };
  // Views to search: the string itself, plus a base64-decode of it and of every
  // long base64-looking token inside it.
  const views = [s];
  const tryDecode = (t: string) => {
    try { const d = Buffer.from(t, "base64").toString("utf8"); if (d && /[\x20-\x7e]/.test(d)) views.push(d); } catch { /* ignore */ }
  };
  tryDecode(s.replace(/\s+/g, ""));
  for (const m of s.matchAll(/[A-Za-z0-9+/]{24,}={0,2}/g)) tryDecode(m[0]);
  const found: string[] = [];
  for (const [label, secret] of Object.entries(SECRETS)) {
    if (views.some((v) => v.includes(secret))) found.push(label);
  }
  return [...new Set(found)];
}

function hostOf(url: string): string {
  const m = url.match(/^[a-z]+:\/\/([^/:]+)/i);
  return m ? m[1].toLowerCase() : url.toLowerCase();
}

/** Render an exfiltrated payload as the attacker would see it: base64-decoded when
 *  it is base64, always truncated. Deterministic. */
function readablePayload(body: string): string {
  let out = body;
  const compact = body.replace(/\s+/g, "");
  if (/^[A-Za-z0-9+/]{24,}={0,2}$/.test(compact)) {
    try { const d = Buffer.from(compact, "base64").toString("utf8"); if (/[\x20-\x7e]/.test(d)) out = `base64→ ${d}`; } catch { /* keep raw */ }
  }
  return out.length > 400 ? `${out.slice(0, 400)}…` : out;
}

/**
 * Build the instrumented module environment and run the repro. Returns the ordered
 * trace. All package code runs against these stubs; nothing reaches the real host.
 */
function detonate(entries: TarEntry[], repro: Repro): { trace: TraceEvent[]; captures: Capture[] } {
  const trace: TraceEvent[] = [];
  const captures: Capture[] = [];
  const push = (op: string, target: string, detail?: string[]) => trace.push(detail?.length ? { op, target, detail } : { op, target });
  const pushCap = (c: Capture) => captures.push(c);
  const byPath = new Map(entries.map((e) => [e.path, e.text]));

  // Callback the in-sandbox shim calls to record dynamically-evaluated code — the
  // decoded second stage of an obfuscated payload, which is the concrete "new
  // access" an eval-based exploit obtains.
  const capEval = (source: string) => {
    const flat = source.replace(/\s+/g, " ").trim();
    pushCap({ kind: "code-exec", summary: "evaluated dynamically-constructed code", data: flat.length > 300 ? `${flat.slice(0, 300)}…` : flat });
  };
  // Prepended to every executed source: shims Function()/eval() in the vm context so
  // the decoded payload is captured before it runs, then delegates to the real one
  // (which still compiles inside this sandbox, against the instrumented globals).
  const PRELUDE =
    ";(function(g){try{var _F=g.Function;g.Function=function(){try{g.__cap(String(arguments[arguments.length-1]||''));}catch(e){}return _F.apply(null,arguments);};g.Function.prototype=_F.prototype;var _e=g.eval;g.eval=function(x){try{g.__cap(String(x));}catch(e){}return _e(x);};}catch(e){}})(typeof globalThis!=='undefined'?globalThis:this);\n";

  // A network sink: records the request, captures anything written to it, and on
  // end() inspects the accumulated body for canaries. Never opens a socket.
  function makeRequest(rawUrl: string, method: string) {
    const host = hostOf(rawUrl);
    let body = "";
    const flag = () => {
      const found = canariesIn(body);
      const benign = BENIGN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
      push("net.egress", host, [method, benign ? "benign-host" : "external-host", ...found.map((f) => `leaks:${f}`)]);
      if (!benign && (found.length > 0 || body.length > 0)) {
        pushCap({
          kind: "exfiltration",
          host,
          summary: found.length > 0 ? `${method} to ${host} carrying ${found.join(", ")}` : `${method} beacon to ${host}`,
          data: body ? readablePayload(body) : undefined,
          secretsLeaked: found,
        });
      }
    };
    return {
      write: (chunk: unknown) => { body += String(chunk); return true; },
      end: (chunk?: unknown) => { if (chunk !== undefined) body += String(chunk); flag(); },
      on: () => {}, once: () => {}, setHeader: () => {}, abort: () => {},
    };
  }
  const netModule = {
    request: (url: unknown, opts: any, cb?: any) => {
      const method = (typeof opts === "object" && opts?.method) || "GET";
      return makeRequest(String(typeof url === "object" ? (url as any)?.href ?? "" : url), String(method));
    },
    get: (url: unknown) => { const r = makeRequest(String(url), "GET"); r.end(); return r; },
  };

  // Instrumented fs: reads return canary contents and are recorded; writes are
  // recorded, never performed.
  const fsModule = {
    readFileSync: (p: unknown) => {
      const path = String(p);
      const rel = path.replace(`${HOME}/`, "").replace(/^~\//, "");
      // A package file the repro pulls in (e.g. its own bundled payload).
      if (byPath.has(normalize(path))) return byPath.get(normalize(path))!;
      for (const [f, contents] of Object.entries(FAKE_FILES)) {
        if (rel === f || path.endsWith(`/${f}`) || path.endsWith(f)) {
          push("fs.read", f, ["sensitive"]);
          pushCap({ kind: "file-read", summary: `read credential file ~/${f}`, data: contents.length > 200 ? `${contents.slice(0, 200)}…` : contents });
          return contents;
        }
      }
      push("fs.read", rel || path);
      return "";
    },
    writeFileSync: (p: unknown) => push("fs.write", String(p)),
    existsSync: () => true,
    readFile: (p: unknown, cb?: any) => { const c = typeof cb === "function" ? cb : undefined; push("fs.read", String(p)); c?.(null, ""); },
  };

  const osModule = {
    homedir: () => HOME,
    hostname: () => "canary-host",
    userInfo: () => ({ username: "canary", homedir: HOME }),
    platform: () => "linux",
    type: () => "Linux",
  };

  const spawnCap = (cmd: string) => { push("process.spawn", cmd.slice(0, 120)); pushCap({ kind: "process", summary: `spawned a child process`, data: cmd.slice(0, 200) }); };
  const childProcess = {
    exec: (cmd: unknown) => spawnCap(String(cmd)),
    execSync: (cmd: unknown) => { spawnCap(String(cmd)); return Buffer.from(""); },
    spawn: (cmd: unknown, args: unknown) => { spawnCap(`${cmd} ${Array.isArray(args) ? args.join(" ") : ""}`.trim()); return { on: () => {}, stdout: { on: () => {} }, stderr: { on: () => {} } }; },
    spawnSync: (cmd: unknown) => { spawnCap(String(cmd)); return { stdout: Buffer.from("") }; },
    fork: (mod: unknown) => { spawnCap(`fork ${mod}`); return { on: () => {} }; },
  };

  const fakeProcess = {
    env: new Proxy({ ...FAKE_ENV }, {
      get: (t, k) => { if (typeof k === "string") push("env.read", k); return (t as any)[k]; },
    }),
    platform: "linux", version: "v20.0.0", cwd: () => "/pkg", argv: ["node", "/pkg"],
    exit: () => {}, on: () => {}, nextTick: (f: () => void) => f(),
  };

  // Instrumented require: node builtins map to the stubs above; a package-local
  // path executes that file's source in the same instrumented context (so bundled
  // payloads detonate too); anything else is an inert stub.
  const requireStack: string[] = [];
  function instrumentedRequire(spec: string): unknown {
    const s = spec.replace(/^node:/, "");
    if (s === "fs" || s === "fs/promises") return fsModule;
    if (s === "os") return osModule;
    if (s === "https" || s === "http" || s === "net") return netModule;
    if (s === "child_process") return childProcess;
    if (s === "path") return { join: (...a: string[]) => a.join("/"), resolve: (...a: string[]) => a.join("/"), dirname: (p: string) => p.split("/").slice(0, -1).join("/"), basename: (p: string) => p.split("/").pop() };
    if (s === "crypto") return { randomBytes: (n: number) => Buffer.alloc(n, 7), createHash: () => ({ update: () => ({ digest: () => "canaryhash" }) }) };
    if (s === "dns") return { lookup: (h: unknown, cb?: any) => (typeof cb === "function" ? cb(null, "127.0.0.1") : undefined) };
    // Relative require of a bundled file: run it in-sandbox.
    if (s.startsWith(".")) {
      const rel = normalize(s.replace(/^\.\//, ""));
      const candidates = [rel, `${rel}.js`, `${rel}/index.js`];
      for (const c of candidates) if (byPath.has(c)) return runFile(c);
    }
    push("require", s); // external dependency: inert
    return {};
  }

  function runFile(path: string): unknown {
    if (requireStack.includes(path)) return {}; // cycle guard
    requireStack.push(path);
    push("require", path);
    const src = byPath.get(path) ?? "";
    const module = { exports: {} as Record<string, unknown> };
    const sandboxGlobals = {
      require: instrumentedRequire,
      module,
      exports: module.exports,
      process: fakeProcess,
      Buffer,
      console: { log: () => {}, error: () => {}, warn: () => {} },
      // Deterministic clock and randomness so traces are reproducible.
      Date: class extends Date { constructor() { super(0); } static now() { return 0; } },
      Math: Object.assign(Object.create(Math), { random: () => 0.42 }),
      setTimeout: (f: () => void) => { f(); return 0; },
      setInterval: () => 0, clearTimeout: () => {}, clearInterval: () => {},
      global: {} as Record<string, unknown>,
      __dirname: "/pkg", __filename: `/pkg/${path}`,
      __cap: capEval,
    };
    (sandboxGlobals.global as any).process = fakeProcess;
    try {
      runInNewContext(PRELUDE + src, sandboxGlobals, { timeout: 1000, filename: path });
    } catch (e) {
      push("error", path, [e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)]);
    }
    requireStack.pop();
    return module.exports;
  }

  // --- drive the repro -----------------------------------------------------
  if (repro.trigger === "install") {
    const pkgJson = byPath.get("package.json");
    let scripts: Record<string, string> = {};
    try { scripts = JSON.parse(pkgJson ?? "{}")?.scripts ?? {}; } catch { /* ignore */ }
    for (const hook of ["preinstall", "install", "postinstall"]) {
      const body = scripts[hook];
      if (typeof body !== "string") continue;
      push("install.hook", hook, [body.slice(0, 120)]);
      runInstallCommand(body);
    }
  } else if (repro.trigger === "require") {
    const entry = normalize(repro.entry ?? "index.js");
    if (!byPath.has(entry)) push("error", entry, ["repro entry not found in tarball"]);
    else runFile(entry);
  }

  /** A shell command from an install hook. We do not run a shell; we detect the
   *  common `node -e "<code>"` / `node <file>` patterns and detonate their code
   *  in-sandbox, and record anything else as a spawned command. */
  function runInstallCommand(cmd: string) {
    const eval1 = cmd.match(/node\s+(?:-e|--eval)\s+(['"])([\s\S]*?)\1/);
    if (eval1) {
      const module = { exports: {} as Record<string, unknown> };
      const g = {
        require: instrumentedRequire, module, exports: module.exports, process: fakeProcess, Buffer,
        console: { log: () => {}, error: () => {}, warn: () => {} },
        Date: class extends Date { constructor() { super(0); } static now() { return 0; } },
        Math: Object.assign(Object.create(Math), { random: () => 0.42 }),
        setTimeout: (f: () => void) => { f(); return 0; }, setInterval: () => 0, clearTimeout: () => {}, clearInterval: () => {},
        global: {} as Record<string, unknown>, __dirname: "/pkg", __filename: "/pkg/install", __cap: capEval,
      };
      try { runInNewContext(PRELUDE + eval1[2], g, { timeout: 1000, filename: `${cmd.slice(0, 40)}` }); }
      catch (e) { push("error", "install-eval", [e instanceof Error ? e.message.slice(0, 80) : String(e)]); }
      return;
    }
    const file = cmd.match(/node\s+(?:\.\/)?([\w./-]+\.js)/);
    if (file) { const p = normalize(file[1]); if (byPath.has(p)) { runFile(p); return; } }
    push("process.spawn", cmd.slice(0, 120));
  }

  return { trace, captures };
}

/** Effects bitmask derived MECHANICALLY from the trace. The oracle signs this. */
export function effectsOf(trace: TraceEvent[]): number {
  let e = 0;
  for (const ev of trace) {
    if (ev.op === "install.hook") e |= Effect.RunsOnInstall;
    if (ev.op === "fs.read" && ev.detail?.includes("sensitive")) e |= Effect.ReadsSensitive;
    if (ev.op === "fs.write") e |= Effect.WritesFiles;
    if (ev.op === "process.spawn") e |= Effect.SpawnsProcess;
    if (ev.op === "net.egress") {
      if (ev.detail?.includes("external-host")) e |= Effect.NetworkEgress;
      for (const d of ev.detail ?? []) {
        if (d.startsWith("leaks:.npmrc") || d.startsWith("leaks:ssh") || d.startsWith("leaks:aws")) e |= Effect.ExfilCredentials;
        if (d.startsWith("leaks:env")) e |= Effect.ExfilEnv;
      }
    }
  }
  return e;
}

/** Canonical JSON of the trace + captures, in execution order, stable key order.
 *  Both are deterministic, so the committed hash covers the concrete artifacts too. */
export function canonicalTrace(trace: TraceEvent[], captures: Capture[] = []): string {
  return JSON.stringify({
    trace: trace.map((e) => ({ op: e.op, target: e.target, detail: e.detail ?? [] })),
    captures: captures.map((c) => ({ kind: c.kind, summary: c.summary, host: c.host ?? "", data: c.data ?? "", secretsLeaked: c.secretsLeaked ?? [] })),
  });
}

// -------------------------------------------------------------------- public

export function sandboxHash(): Hex {
  return fingerprint.sandboxHash as Hex;
}

export function sandboxSource(): { source: string; sandboxHash: Hex; bytes: number } {
  return { source: fingerprint.source, sandboxHash: fingerprint.sandboxHash as Hex, bytes: fingerprint.bytes };
}

export function computeSandboxHash(source: string | Buffer): Hex {
  return keccak256(toHex(typeof source === "string" ? Buffer.from(source, "utf8") : source));
}

/** Detonate a tarball under a repro and return the full, reproducible result. */
export function run(tarball: Buffer, repro: Repro): SandboxResult {
  const entries = readTarball(tarball);
  let trace: TraceEvent[];
  let captures: Capture[] = [];
  try {
    ({ trace, captures } = detonate(entries, repro));
  } catch (e) {
    trace = [{ op: "error", target: "detonate", detail: [e instanceof Error ? e.message : String(e)] }];
  }
  const canon = canonicalTrace(trace, captures);
  const hadError = trace.length === 0 || trace.every((t) => t.op === "error" || t.op === "install.hook" || t.op === "require");
  return {
    artifactHash: sha256Hex(tarball),
    trace,
    captures,
    traceHash: keccak256(toHex(Buffer.from(canon, "utf8"))),
    effects: effectsOf(trace),
    sandboxHash: sandboxHash(),
    sandboxVersion: SANDBOX_VERSION,
    error: hadError && effectsOf(trace) === 0 ? "no observable effect" : undefined,
  };
}

export function runFileTarball(path: string, repro: Repro): SandboxResult {
  return run(readFileSync(path), repro);
}
