/**
 * A tiny in-memory event log shared by the agent actions and read by the UI.
 *
 * The chain is the source of truth for market state; this is only the narrated
 * "agent console" that makes the autonomous actors legible in the demo. It is
 * best-effort and resets on a serverless cold start, which is fine — nothing
 * depends on it for correctness.
 */
import type { LogLine } from "./types";

const MAX = 300;

declare global {
  // eslint-disable-next-line no-var
  var __bbbLog: LogLine[] | undefined;
}

const log: LogLine[] = globalThis.__bbbLog ?? (globalThis.__bbbLog = []);

const ICON: Record<LogLine["level"], string> = { info: "·", ok: "✓", warn: "!", error: "✗" };
const ACTOR_COLOR: Record<LogLine["actor"], string> = {
  oracle: "\x1b[35m",
  seller: "\x1b[33m",
  buyer: "\x1b[36m",
  chain: "\x1b[90m",
  system: "\x1b[32m",
};

export function record(line: Omit<LogLine, "at">): LogLine {
  const full: LogLine = { at: Date.now(), ...line };
  log.push(full);
  if (log.length > MAX) log.splice(0, log.length - MAX);
  // In the CLI demo, echo the agent console to stdout so the narration is visible.
  if (process.env.BBB_LOG_STDOUT) {
    const c = ACTOR_COLOR[full.actor] ?? "";
    console.log(`${c}${ICON[full.level]} ${full.actor.padEnd(6)}\x1b[0m ${full.message}`);
  }
  return full;
}

export function tail(sinceMs = 0): LogLine[] {
  return log.filter((l) => l.at > sinceMs);
}

export function clear() {
  log.length = 0;
}
