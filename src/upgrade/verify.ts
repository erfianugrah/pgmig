import { ConfigSchema } from "../config.ts";
import type { Db } from "../db.ts";
import { log } from "../log.ts";
import { SUPABASE_MANAGED_SCHEMAS } from "../steps/bootstrap.ts";
import { diffExtensionVersions, type ExtVersionRow } from "../steps/doctor.ts";
import { reconcile } from "../steps/reconcile.ts";
import { filterManagedTables, MD5_ROLES_SQL, USER_TABLES_SQL } from "./kb.ts";

/**
 * `upgrade verify` - prove the upgraded cluster is data-identical to the
 * pre-upgrade copy. Reuses the migration engine's chunked-checksum reconcile
 * verbatim: "source" is the pristine PG<old> copy, "target" is the upgraded
 * PG<new> cluster (typically the `upgrade lab --keep` containers on
 * :55440/:55441, but any two URLs work).
 *
 * Checks, in order:
 *   1. every user table exists on BOTH sides (a table lost in the upgrade is
 *      a hard fail, not a hash diff)
 *   2. chunked-checksum reconcile over every discovered user table
 *   3. extension version diff (a major upgrade bumps extension versions; some
 *      need an explicit ALTER EXTENSION ... UPDATE)
 *   4. auth-schema row-count sanity, when present on both
 *   5. md5-password roles still present on the upgraded cluster (cannot log in)
 */

export interface UpgradeVerifyOpts {
  /** Also diff tables in Supabase-managed schemas (auth/storage/...). */
  includeManaged?: boolean;
  outDir?: string;
  maxExamples?: number;
}

export interface TableSetDiff {
  missingOnTarget: string[];
  extraOnTarget: string[];
  common: string[];
}

/** Pure: diff two table-name lists, optionally filtering managed schemas. */
export function diffTableSets(
  srcNames: string[],
  tgtNames: string[],
  opts: { includeManaged?: boolean } = {},
): TableSetDiff {
  const filter = (names: string[]) =>
    opts.includeManaged ? names : filterManagedTables(names, SUPABASE_MANAGED_SCHEMAS);
  const src = new Set(filter(srcNames));
  const tgt = new Set(filter(tgtNames));
  return {
    missingOnTarget: [...src].filter((t) => !tgt.has(t)).sort(),
    extraOnTarget: [...tgt].filter((t) => !src.has(t)).sort(),
    common: [...src].filter((t) => tgt.has(t)).sort(),
  };
}

async function tablesOn(db: Db): Promise<string[]> {
  const rows = await db.unsafe<{ name: string }[]>(USER_TABLES_SQL);
  return rows.map((r) => r.name);
}

export async function upgradeVerify(
  source: Db,
  target: Db,
  opts: UpgradeVerifyOpts = {},
): Promise<boolean> {
  let ok = true;

  log.step("upgrade verify: table discovery");
  const srcTables = await tablesOn(source);
  const tgtTables = await tablesOn(target);
  const { missingOnTarget, extraOnTarget, common } = diffTableSets(srcTables, tgtTables, opts);
  if (missingOnTarget.length > 0) {
    ok = false;
    log.err(`tables MISSING on the upgraded cluster: ${missingOnTarget.join(", ")}`);
  }
  if (extraOnTarget.length > 0) {
    log.warn(`tables only on the upgraded cluster (unexpected): ${extraOnTarget.join(", ")}`);
  }
  if (common.length === 0) {
    log.err("no common user tables to reconcile");
    return false;
  }
  log.ok(`${common.length} user tables on both sides`);

  log.step("upgrade verify: chunked-checksum reconcile (pre-upgrade copy vs upgraded cluster)");
  // Synthetic config: reconcile() only reads cfg.replication.slot (for a
  // pre-flight lag warning - no such slot exists here, so it no-ops) and
  // cfg.reconcile.tables. Parsing through the schema fills every other default.
  const cfg = ConfigSchema.parse({
    source: { ref: "upgrade-verify-src" },
    target: { ref: "upgrade-verify-tgt" },
    replication: { tables: ["public._upgrade_verify_placeholder"] },
    reconcile: { tables: common.map((name) => ({ name })) },
    watchdog: {},
  });
  const reconcileOk = await reconcile(source, target, cfg, {
    mode: "chunked",
    outDir: opts.outDir ?? "ledger",
    maxExamples: opts.maxExamples ?? 20,
  });
  ok = ok && reconcileOk;

  log.step("upgrade verify: extension versions");
  const srcExts = await source.unsafe<ExtVersionRow[]>(
    "SELECT extname, extversion FROM pg_extension ORDER BY 1",
  );
  const tgtExts = await target.unsafe<ExtVersionRow[]>(
    "SELECT extname, extversion FROM pg_extension ORDER BY 1",
  );
  const tgtNames = new Set(tgtExts.map((e) => e.extname));
  const dropped = srcExts.filter((e) => !tgtNames.has(e.extname)).map((e) => e.extname);
  if (dropped.length > 0)
    log.warn(`extensions NOT present on the upgraded cluster: ${dropped.join(", ")}`);
  const mismatches = diffExtensionVersions(srcExts, tgtExts);
  if (mismatches.length === 0 && dropped.length === 0) {
    log.ok("extension versions identical on both sides");
  }
  for (const m of mismatches) {
    log.warn(
      `extension ${m.extname}: pre-upgrade ${m.source} -> upgraded ${m.target} ` +
        `(expected on a major jump - if the app misbehaves, check for a pending ALTER EXTENSION ${m.extname} UPDATE path)`,
    );
  }

  const srcSchemas = new Set(srcTables.map((t) => t.split(".")[0]));
  const tgtSchemas = new Set(tgtTables.map((t) => t.split(".")[0]));
  if (srcSchemas.has("auth") && tgtSchemas.has("auth")) {
    log.step("upgrade verify: auth schema sanity");
    for (const t of ["auth.users", "auth.identities", "auth.sessions"]) {
      const onSrc = srcTables.includes(t);
      const onTgt = tgtTables.includes(t);
      if (!onSrc && !onTgt) continue;
      if (onSrc !== onTgt) {
        ok = false;
        log.err(`${t}: present ${onSrc ? "only pre-upgrade" : "only on the upgraded cluster"}`);
        continue;
      }
      const [s] = await source.unsafe<{ n: string }[]>(`SELECT count(*)::bigint AS n FROM ${t}`);
      const [g] = await target.unsafe<{ n: string }[]>(`SELECT count(*)::bigint AS n FROM ${t}`);
      const match = String(s?.n) === String(g?.n);
      (match ? log.ok : log.err)(`${t}: pre-upgrade ${s?.n} vs upgraded ${g?.n}`);
      ok = ok && match;
    }
  }

  try {
    const md5 = await target.unsafe<{ rolname: string }[]>(MD5_ROLES_SQL);
    if (md5.length > 0) {
      log.warn(
        `upgraded cluster still has md5-password login roles (cannot connect): ` +
          md5.map((m) => m.rolname).join(", ") +
          " - re-password them to move to scram-sha-256",
      );
    }
  } catch {
    log.detail("md5-role check skipped (pg_authid not readable with these credentials)");
  }

  log.step("upgrade verify: summary");
  ok ? log.ok("VERIFY PASSED - upgraded cluster is data-identical") : log.err("VERIFY FAILED");
  return ok;
}
