import type { Config, Secrets } from "../config.ts";
import type { Db } from "../db.ts";
import type { ReconcileMode } from "../steps/reconcile.ts";

/** Which data-plane implementation backs a migration. */
export type EngineKind = "native-pg" | "debezium";

export interface ReconcileOpts {
  mode?: ReconcileMode;
  buckets?: number;
  maxExamples?: number;
  outDir?: string;
}

export interface CutoverOpts {
  sequences?: string[];
  maxLagWaitSec?: number;
  /**
   * Directory holding the translated-schema sign-off manifest (heterogeneous sources only —
   * the DebeziumEngine gates cutover on it via `assertSchemaSignedOff`). Mirrors the
   * reconcile/verify out-dir; defaults to `ledger`. Ignored by the native-PG engine.
   */
  outDir?: string;
}

/**
 * The data-plane seam (HETEROGENEOUS.md §3). pgmig's control plane — the `run` state machine
 * and the individual CLI step commands — calls these methods; the *implementation* forks by
 * source engine while the step *vocabulary* survives.
 *
 * Today the only impl is `native-pg`: CREATE SUBSCRIPTION copy_data=true (snapshot + CDC in
 * one), pg_subscription_rel polling, and the row::text byte-hash reconcile. A future
 * `debezium` impl (HETEROGENEOUS.md §5) wraps Debezium for MySQL/SQL Server sources, where
 * reconcile downgrades to count + per-column aggregates. Method names mirror pgmig's
 * existing phases (the §3 fork table), so the engine is a drop-in behind the same commands.
 *
 * Signatures match today's step functions exactly: connections + config are passed per call
 * (not bound at construction), so `native-pg` is a pure delegator with zero behaviour change.
 */
export interface ReplicationEngine {
  readonly kind: EngineKind;
  replicate(source: Db, target: Db, cfg: Config, secrets: Secrets): Promise<void>;
  watch(source: Db, target: Db, cfg: Config): Promise<void>;
  reconcile(source: Db, target: Db, cfg: Config, opts?: ReconcileOpts): Promise<boolean>;
  cutover(source: Db, target: Db, cfg: Config, opts: CutoverOpts): Promise<void>;
  teardown(source: Db, target: Db, cfg: Config): Promise<void>;
}
