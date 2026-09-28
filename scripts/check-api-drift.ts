#!/usr/bin/env bun
/**
 * Upstream drift-check (ported from sbperf). Asserts that every Supabase
 * Management API endpoint pgmig depends on still exists - with the HTTP
 * method we use - in the canonical OpenAPI spec. CI runs this so an upstream
 * rename/removal fails the build loudly rather than surfacing as a runtime
 * 404 mid-migration (or worse, mid-cutover).
 *
 *   bun run scripts/check-api-drift.ts
 *
 * Two layers:
 *   1. PRIMARY (pass/fail): assert pgmig's endpoints exist in the LIVE spec
 *      (api.supabase.com/api/v1-json) - the ground truth for what the deployed
 *      API actually accepts. Missing endpoint => exit 1.
 *   2. CROSS-CHECK (advisory): diff the live spec against the version-controlled
 *      copy in supabase/supabase (apps/docs/spec). The docs copy is generated
 *      FROM the API and can lag a deploy; a divergence is an early signal that
 *      upstream is mid-change. Never fails the build on its own.
 *
 * Specs are public (no auth). Overrides: PGMIG_API_SPEC_URL (live),
 * PGMIG_API_SPEC_COMPARE_URL (docs copy), PGMIG_NO_CROSSCHECK=1 to skip (2).
 */

const SPEC_URL = process.env.PGMIG_API_SPEC_URL ?? "https://api.supabase.com/api/v1-json";
const COMPARE_URL =
  process.env.PGMIG_API_SPEC_COMPARE_URL ??
  "https://raw.githubusercontent.com/supabase/supabase/master/apps/docs/spec/api_v1_openapi.json";
const CROSS_CHECK = process.env.PGMIG_NO_CROSSCHECK !== "1";
const IN_GHA = process.env.GITHUB_ACTIONS === "true";
const warn = (msg: string): void => console.error(IN_GHA ? `::warning::${msg}` : `warning: ${msg}`);

/** Single source of truth: (method, path) pairs pgmig calls in mgmt.ts / config-sync.ts. */
const ENDPOINTS: ReadonlyArray<{ method: string; path: string; used: string }> = [
  // mgmt.ts
  { method: "get", path: "/v1/organizations", used: "token liveness probe" },
  { method: "post", path: "/v1/projects", used: "sandbox up (create project)" },
  { method: "get", path: "/v1/projects/{ref}", used: "project status (sandbox status/poll)" },
  { method: "delete", path: "/v1/projects/{ref}", used: "sandbox down (teardown)" },
  {
    method: "get",
    path: "/v1/organizations/{slug}/project-claim/{token}",
    used: "claim preview",
  },
  {
    method: "post",
    path: "/v1/organizations/{slug}/project-claim/{token}",
    used: "claim perform",
  },
  { method: "get", path: "/v1/projects/{ref}/advisors/security", used: "verify (advisors)" },
  { method: "get", path: "/v1/projects/{ref}/advisors/performance", used: "verify (advisors)" },
  {
    method: "get",
    path: "/v1/projects/{ref}/config/database/pooler",
    used: "sandbox pooler lookup + config-sync read",
  },
  {
    method: "patch",
    path: "/v1/projects/{ref}/config/database/pooler",
    used: "config-sync write",
  },
  // config-sync.ts sections (read + write)
  { method: "get", path: "/v1/projects/{ref}/config/auth", used: "config-sync read (auth)" },
  { method: "patch", path: "/v1/projects/{ref}/config/auth", used: "config-sync write (auth)" },
  {
    method: "get",
    path: "/v1/projects/{ref}/config/realtime",
    used: "config-sync read (realtime)",
  },
  {
    method: "patch",
    path: "/v1/projects/{ref}/config/realtime",
    used: "config-sync write (realtime)",
  },
  {
    method: "get",
    path: "/v1/projects/{ref}/config/database/postgres",
    used: "config-sync read (dbPostgres)",
  },
  {
    method: "put",
    path: "/v1/projects/{ref}/config/database/postgres",
    used: "config-sync write (dbPostgres)",
  },
  { method: "get", path: "/v1/projects/{ref}/postgrest", used: "config-sync read (postgrest)" },
  { method: "patch", path: "/v1/projects/{ref}/postgrest", used: "config-sync write (postgrest)" },
  { method: "get", path: "/v1/projects/{ref}/config/storage", used: "config-sync read (storage)" },
  {
    method: "patch",
    path: "/v1/projects/{ref}/config/storage",
    used: "config-sync write (storage)",
  },
  {
    method: "get",
    path: "/v1/projects/{ref}/ssl-enforcement",
    used: "config-sync read (sslEnforcement)",
  },
  {
    method: "put",
    path: "/v1/projects/{ref}/ssl-enforcement",
    used: "config-sync write (sslEnforcement)",
  },
  {
    method: "get",
    path: "/v1/projects/{ref}/network-restrictions",
    used: "config-sync read (networkRestrictions)",
  },
  {
    method: "post",
    path: "/v1/projects/{ref}/network-restrictions/apply",
    used: "config-sync write (networkRestrictions)",
  },
  {
    method: "get",
    path: "/v1/projects/{ref}/config/auth/third-party-auth",
    used: "config-sync read (thirdPartyAuth)",
  },
  {
    method: "post",
    path: "/v1/projects/{ref}/config/auth/third-party-auth",
    used: "config-sync write (thirdPartyAuth)",
  },
  {
    method: "get",
    path: "/v1/projects/{ref}/config/auth/sso/providers",
    used: "config-sync read (ssoProviders)",
  },
  {
    method: "post",
    path: "/v1/projects/{ref}/config/auth/sso/providers",
    used: "config-sync write (ssoProviders)",
  },
  { method: "get", path: "/v1/projects/{ref}/secrets", used: "config-sync read (projectSecrets)" },
  {
    method: "post",
    path: "/v1/projects/{ref}/secrets",
    used: "config-sync write (projectSecrets)",
  },
];

type Spec = { info?: { version?: string }; paths?: Record<string, Record<string, unknown>> };

async function fetchSpec(url: string): Promise<Spec | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const spec = (await res.json()) as Spec;
    return spec.paths && Object.keys(spec.paths).length ? spec : null;
  } catch {
    return null;
  }
}

/** Advisory: warn (never fail) when the docs-site spec has drifted from live. */
async function crossCheck(livePaths: Record<string, unknown>): Promise<void> {
  const other = await fetchSpec(COMPARE_URL);
  if (!other?.paths) {
    warn(`cross-check skipped - could not fetch docs spec from ${COMPARE_URL}`);
    return;
  }
  const live = new Set(Object.keys(livePaths));
  const docs = new Set(Object.keys(other.paths));
  const onlyLive = [...live].filter((p) => !docs.has(p));
  const onlyDocs = [...docs].filter((p) => !live.has(p));

  // Endpoints pgmig actually uses that disagree between the two = the only
  // actionable signal; warn on those. A divergence confined to paths pgmig
  // never calls (e.g. a new analytics endpoint mid-deploy) is upstream's
  // business - log it as info, not a CI warning annotation.
  const affected = ENDPOINTS.filter((e) => live.has(e.path) !== docs.has(e.path)).map(
    (e) => e.path,
  );
  if (affected.length) {
    warn(
      `endpoints pgmig uses differ between live and docs spec (upstream mid-change?): ${affected.join(", ")}`,
    );
  }

  if (onlyLive.length || onlyDocs.length) {
    const parts: string[] = [];
    if (onlyLive.length) parts.push(`${onlyLive.length} live-only`);
    if (onlyDocs.length) parts.push(`${onlyDocs.length} docs-only`);
    console.log(
      `cross-check: live and docs specs diverge on paths pgmig does not use (${parts.join(", ")}) - informational only`,
    );
  } else {
    console.log(`cross-check: live and docs spec agree (${live.size} paths)`);
  }
}

async function main(): Promise<void> {
  const spec = await fetchSpec(SPEC_URL);
  if (!spec?.paths) {
    console.error(`error: could not fetch a valid spec from ${SPEC_URL}`);
    process.exit(2);
  }
  const paths = spec.paths;

  const missing: string[] = [];
  for (const e of ENDPOINTS) {
    const methods = paths[e.path];
    if (!methods) {
      missing.push(`${e.method.toUpperCase()} ${e.path} - PATH GONE (${e.used})`);
    } else if (!(e.method in methods)) {
      const have = Object.keys(methods).join(",").toUpperCase();
      missing.push(
        `${e.method.toUpperCase()} ${e.path} - METHOD GONE (spec has ${have}) (${e.used})`,
      );
    }
  }

  const v = spec.info?.version ?? "?";
  if (missing.length) {
    console.error(`\nAPI drift detected against Supabase Management API spec v${v}:\n`);
    for (const m of missing) console.error(`  ${m}`);
    console.error(
      "\nUpdate mgmt.ts / config-sync.ts to the new endpoint(s), or pin + document the old ones.",
    );
    process.exit(1);
  }

  console.log(
    `ok: all ${ENDPOINTS.length} (method, path) pairs pgmig uses exist in the live spec (v${v})`,
  );
  if (CROSS_CHECK) await crossCheck(paths);
}

await main();
