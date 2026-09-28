import type { PgProvider } from "../db.ts";
import { log } from "../log.ts";
import { checks } from "./checks.ts";
import { providerHints } from "./provider-hints.ts";
import type { CheckItem, Phase, ProviderHintItem } from "./schema.ts";

/**
 * The prep playbook for one managed-Postgres provider, assembled from the KB.
 *
 * `pgmig guide` (docs/GUIDED-MIGRATION.md §5) surfaces "what must I do to use provider X as a
 * migration source / target" as an ordered, provenance-stamped checklist a human can consult
 * *before* they hold live credentials. Each role-section combines two knowledge catalogs:
 *   - enablement hints — provider-specific, informed-class (flip a parameter in a console)
 *   - readiness checks — the universal CheckItems for that phase (wal_level, replica identity,
 *     schema-loaded …), shown with the same guidance + provenance doctor executes
 * Role maps to phase: source → `source-prep`, target → `target-prep`. The live detect/verify of
 * those checks is `doctor`'s job — guide is the reference, doctor the executor.
 */
const ROLE_PHASE: Record<"source" | "target", Phase> = {
  source: "source-prep",
  target: "target-prep",
};

export interface GuideSection {
  role: "source" | "target";
  phase: Phase;
  /** Provider-specific enablement steps (a human flips these in a console). */
  hints: ProviderHintItem[];
  /** Universal readiness checks for this phase (doctor runs them live). */
  checks: CheckItem[];
}

export interface Guide {
  provider: PgProvider;
  /** Only roles with at least one hint or check, source before target. */
  sections: GuideSection[];
  hintCount: number;
  checkCount: number;
}

/** Provider ids that have at least one enablement hint (drives CLI validation + help). */
export function guidableProviders(
  items: readonly ProviderHintItem[] = providerHints,
): PgProvider[] {
  const seen = new Set<PgProvider>();
  for (const i of items) seen.add(i.provider);
  return [...seen];
}

export function buildGuide(
  provider: PgProvider,
  opts: {
    role?: "source" | "target";
    items?: readonly ProviderHintItem[];
    checks?: readonly CheckItem[];
  } = {},
): Guide {
  const allHints = opts.items ?? providerHints;
  const allChecks = opts.checks ?? checks;
  const roles: ("source" | "target")[] = opts.role ? [opts.role] : ["source", "target"];
  const sections: GuideSection[] = roles
    .map((role) => {
      const phase = ROLE_PHASE[role];
      return {
        role,
        phase,
        hints: allHints.filter((i) => i.provider === provider && i.role === role),
        checks: allChecks.filter((c) => c.phase === phase),
      };
    })
    .filter((s) => s.hints.length > 0 || s.checks.length > 0);
  return {
    provider,
    sections,
    hintCount: sections.reduce((n, s) => n + s.hints.length, 0),
    checkCount: sections.reduce((n, s) => n + s.checks.length, 0),
  };
}

/** Human-readable render of a guide via the structured logger. */
export function renderGuide(g: Guide): void {
  log.step(
    `guide: ${g.provider} (${g.hintCount} hint${plural(g.hintCount)}, ${g.checkCount} check${plural(g.checkCount)})`,
  );
  if (g.sections.length === 0) {
    log.info(`no playbook items for '${g.provider}'`);
    return;
  }
  for (const section of g.sections) {
    log.info(`${g.provider} as ${section.role} — phase ${section.phase}:`);
    if (section.hints.length > 0) {
      log.detail("enablement:");
      for (const h of section.hints) {
        log.detail(`  [${h.severity}/${h.klass}] ${h.id}`);
        log.detail(`    ${h.guidance}`);
        log.detail(`    source: ${h.provenance.source} (synced ${h.provenance.lastSynced})`);
      }
    }
    if (section.checks.length > 0) {
      log.detail("readiness checks (run live by `pgmig doctor`):");
      for (const c of section.checks) {
        log.detail(`  [${c.severity}] ${c.id} — ${c.title}`);
        log.detail(`    ${c.guidance}`);
        log.detail(`    source: ${c.provenance.source} (synced ${c.provenance.lastSynced})`);
      }
    }
  }
  log.info("run `pgmig doctor` to execute these checks against your live source/target");
}

function plural(n: number): string {
  return n === 1 ? "" : "s";
}
