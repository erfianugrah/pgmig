import type { Config, Secrets } from "../config.ts";
import type { Db } from "../db.ts";
import { engineFor, type ReplicationEngine } from "../engine/index.ts";
import { log } from "../log.ts";
import { preflight } from "./preflight.ts";
import type { ReconcileMode } from "./reconcile.ts";

/**
 * Autonomous, non-interactive pipeline runner — the thing you put in a GitHub
 * Action / Lambda / cron instead of hand-chaining the individual steps in bash.
 *
 *   preflight → replicate → watch → reconcile [→ cutover]
 *
 * Idempotent up to reconcile (replicate/watch skip existing objects, reconcile
 * is read-only), so a retried invocation is safe. `cutover` is the only
 * destructive phase and is REFUSED unless the caller explicitly asserts source
 * writes are already stopped (`confirmWritesStopped`). Exit code: 0 = the whole
 * requested range succeeded (and reconcile matched), non-zero otherwise.
 *
 * With `json: true`, emits NDJSON events on stdout (phase_start / phase_end /
 * summary); human step logs go to stderr (see `log.toStderr()`), so stdout
 * stays machine-parseable.
 */
export const PHASES = ["preflight", "replicate", "watch", "reconcile", "cutover"] as const;
export type Phase = (typeof PHASES)[number];

/** Pure: the ordered phases to run, up to and including `through`. */
export function phasesThrough(through: Phase): Phase[] {
  const i = PHASES.indexOf(through);
  if (i < 0) throw new Error(`unknown phase '${through}' (valid: ${PHASES.join(", ")})`);
  return PHASES.slice(0, i + 1) as Phase[];
}

export interface PhaseResult {
  phase: Phase;
  ok: boolean;
  ms: number;
  error?: string;
}
export interface RunResult {
  ok: boolean;
  phases: PhaseResult[];
}

export interface RunOptions {
  through: Phase;
  json?: boolean;
  confirmWritesStopped?: boolean;
  maxLagWaitSec?: number;
  /** L-4: thread outDir through to reconcile so the JSON report goes to the right place. */
  outDir?: string;
  reconcile?: { mode?: ReconcileMode; buckets?: number; maxExamples?: number };
}

export async function run(
  source: Db,
  target: Db,
  cfg: Config,
  secrets: Secrets,
  opts: RunOptions,
): Promise<RunResult> {
  const phases = phasesThrough(opts.through);
  if (phases.includes("cutover") && !opts.confirmWritesStopped) {
    throw new Error(
      "refusing to run the cutover phase without confirmWritesStopped — stop SOURCE writes first, " +
        "then re-run with --confirm-writes-stopped",
    );
  }

  const emit = opts.json
    ? (o: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(o)}\n`)
    : (_o: Record<string, unknown>) => {};

  const engine = engineFor(cfg);
  const results: PhaseResult[] = [];
  for (const phase of phases) {
    emit({ event: "phase_start", phase, ts: new Date().toISOString() });
    const t0 = Date.now();
    try {
      await runPhase(engine, phase, source, target, cfg, secrets, opts);
      const ms = Date.now() - t0;
      results.push({ phase, ok: true, ms });
      emit({ event: "phase_end", phase, ok: true, ms });
    } catch (e) {
      const ms = Date.now() - t0;
      const error = e instanceof Error ? e.message : String(e);
      results.push({ phase, ok: false, ms, error });
      emit({ event: "phase_end", phase, ok: false, ms, error });
      log.err(`phase ${phase} failed after ${ms}ms: ${error}`);
      emit({ event: "summary", ok: false, phases: results });
      return { ok: false, phases: results };
    }
  }
  emit({ event: "summary", ok: true, phases: results });
  log.ok(`run complete through '${opts.through}'`);
  return { ok: true, phases: results };
}

async function runPhase(
  engine: ReplicationEngine,
  phase: Phase,
  source: Db,
  target: Db,
  cfg: Config,
  secrets: Secrets,
  opts: RunOptions,
): Promise<void> {
  switch (phase) {
    // preflight is a pre-check, not a data-plane op - it stays outside the engine seam, but it is
    // also postgres-only today (see preflight.ts): skip it for the Debezium engine rather than
    // let it throw on a source connection that isn't a Postgres wire client, or block the
    // otherwise-working heterogeneous pipeline on a check that doesn't exist yet.
    case "preflight":
      if (engine.kind !== "native-pg") {
        log.warn(`preflight has no Debezium-engine equivalent yet - skipping for '${engine.kind}'`);
        return;
      }
      return preflight(source, target, cfg);
    case "replicate":
      return engine.replicate(source, target, cfg, secrets);
    case "watch":
      return engine.watch(source, target, cfg);
    case "reconcile": {
      const ok = await engine.reconcile(source, target, cfg, {
        ...opts.reconcile,
        outDir: opts.outDir,
      });
      if (!ok) throw new Error("reconcile reported a mismatch");
      return;
    }
    case "cutover":
      return engine.cutover(source, target, cfg, {
        maxLagWaitSec: opts.maxLagWaitSec ?? 300,
        outDir: opts.outDir,
      });
  }
}
