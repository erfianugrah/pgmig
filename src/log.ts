/** Minimal structured logger with level colours + optional durable file sink. No deps. */

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
} as const;

function hhmmss(): string {
  return new Date().toISOString().slice(11, 19);
}

// Non-error logs go here; flipped to stderr by `log.toStderr()` so a command
// emitting machine-readable JSON on stdout (e.g. `run --json`) stays parseable.
let out: NodeJS.WriteStream = process.stdout;

// Optional durable sink. A migration spans hours; terminal output dies with the
// SSH session, so we mirror EVERY log line (ANSI-stripped, full ISO timestamp,
// with a level tag) to an append-only file for the audit trail.
let fileSink: WriteStream | null = null;
let sinkPath: string | null = null;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI colour codes requires the ESC (\x1b) control char
const ANSI = /\x1b\[[0-9;]*m/g;

/** Mirror one line to the file sink: strip colour, prepend full ISO ts + level. */
function toFileSink(level: string, msg: string): void {
  if (!fileSink) return;
  const clean = msg.replace(ANSI, "");
  fileSink.write(`${new Date().toISOString()} ${level.padEnd(6)} ${clean}\n`);
}

export const log = {
  /** Route all human logs to stderr, keeping stdout for machine output. */
  toStderr() {
    out = process.stderr;
  },
  /**
   * Begin mirroring all logs to an append-only file. Creates parent dirs.
   * Idempotent-ish: a second call closes the prior sink and opens the new path.
   * Returns the resolved path (for the caller to echo to the user).
   */
  toFile(path: string): string {
    if (fileSink && sinkPath === path) return path;
    if (fileSink) fileSink.end();
    mkdirSync(dirname(path), { recursive: true });
    fileSink = createWriteStream(path, { flags: "a" });
    sinkPath = path;
    fileSink.write(`\n${new Date().toISOString()} ----   pgmig log opened (pid ${process.pid})\n`);
    return path;
  },
  /** Current sink path, if any. */
  filePath(): string | null {
    return sinkPath;
  },
  /** Flush + close the file sink (best-effort; call before process exit). */
  async closeFile(): Promise<void> {
    if (!fileSink) return;
    const s = fileSink;
    fileSink = null;
    sinkPath = null;
    await new Promise<void>((resolve) => s.end(resolve));
  },
  step(name: string) {
    out.write(
      `\n${COLORS.cyan}━━ ${name} ${COLORS.reset}${COLORS.dim}${hhmmss()}${COLORS.reset}\n`,
    );
    toFileSink("STEP", `== ${name}`);
  },
  info(msg: string) {
    out.write(`${COLORS.dim}${hhmmss()}${COLORS.reset} ${msg}\n`);
    toFileSink("INFO", msg);
  },
  ok(msg: string) {
    out.write(`${COLORS.green}✓${COLORS.reset} ${msg}\n`);
    toFileSink("OK", msg);
  },
  warn(msg: string) {
    out.write(`${COLORS.yellow}⚠${COLORS.reset} ${msg}\n`);
    toFileSink("WARN", msg);
  },
  err(msg: string) {
    process.stderr.write(`${COLORS.red}✗${COLORS.reset} ${msg}\n`);
    toFileSink("ERROR", msg);
  },
  detail(msg: string) {
    out.write(`  ${COLORS.dim}${msg}${COLORS.reset}\n`);
    toFileSink("DETAIL", msg);
  },
};
