import { log } from "./log.ts";

const API_BASE = "https://api.supabase.com/v1";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** One advisor lint as returned by GET /advisors/{security,performance}. */
export type Lint = {
  name: string;
  title: string;
  level: "ERROR" | "WARN" | "INFO";
  categories?: Array<"PERFORMANCE" | "SECURITY">;
  description?: string;
  detail?: string;
  remediation?: string;
  metadata?: { schema?: string; name?: string; entity?: string; type?: string };
  cache_key?: string;
};

export type AdvisorKind = "security" | "performance";

/** A Supabase org plan, lowest → highest. Used to detect a claim downgrade. */
export const PLAN_RANK: Record<string, number> = {
  free: 0,
  pro: 1,
  team: 2,
  enterprise: 3,
  platform: 4,
};

/** Preview block of GET /v1/organizations/:slug/project-claim/:token. */
export interface ClaimPreview {
  valid: boolean;
  warnings: { key: string; message: string }[];
  errors: { key: string; message: string }[];
  info: { key: string; message: string }[];
  members_exceeding_free_project_limit: { name: string; limit: number }[];
  source_subscription_plan: string;
  target_subscription_plan: string;
}

export interface ClaimInfo {
  project: { ref: string; name: string };
  preview: ClaimPreview;
  expires_at: string;
  created_at: string;
  created_by: string;
}

export class MgmtApi {
  constructor(private token: string) {}

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  async get<T = unknown>(
    projectRef: string,
    path: string,
  ): Promise<{ status: number; body: T | null }> {
    const res = await fetch(`${API_BASE}/projects/${projectRef}${path}`, {
      headers: this.headers(),
    });
    const body = res.ok ? ((await res.json()) as T) : null;
    return { status: res.status, body };
  }

  async write(
    projectRef: string,
    path: string,
    method: "PATCH" | "PUT" | "POST",
    payload: unknown,
  ): Promise<{ status: number; text: string }> {
    const res = await fetch(`${API_BASE}/projects/${projectRef}${path}`, {
      method,
      headers: this.headers(true),
      body: JSON.stringify(payload),
    });
    return { status: res.status, text: await res.text() };
  }

  /** POST /v1/projects — creates a new project; returns the project ref. */
  // `postgresEngine` ("15", "17") picks an older major for upgrade rehearsals:
  // typed deprecated in the OpenAPI document but honoured (supabase-lab
  // upgrade-integrity UI01, 2026-10-23). Both options are sent only when set.
  async createProject(
    name: string,
    organizationId: string,
    dbPass: string,
    region: string,
    opts: { postgresEngine?: string; instanceSize?: string } = {},
  ): Promise<string> {
    const res = await fetch(`${API_BASE}/projects`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({
        name,
        organization_id: organizationId,
        db_pass: dbPass,
        region,
        ...(opts.postgresEngine ? { postgres_engine: opts.postgresEngine } : {}),
        ...(opts.instanceSize ? { desired_instance_size: opts.instanceSize } : {}),
      }),
    });
    if (!res.ok) throw new Error(`createProject failed: HTTP ${res.status} ${await res.text()}`);
    const { ref } = (await res.json()) as { ref: string };
    return ref;
  }

  /** GET /v1/projects/:ref — returns the raw project object (status, region, etc.). */
  async getProject(ref: string): Promise<{ status: string; [k: string]: unknown }> {
    const res = await fetch(`${API_BASE}/projects/${ref}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`getProject ${ref}: HTTP ${res.status}`);
    return res.json() as Promise<{ status: string }>;
  }

  /** Poll until every ref reaches ACTIVE_HEALTHY (default 10 min). */
  async waitHealthy(
    refs: string[],
    opts: { pollSec?: number; timeoutMin?: number } = {},
  ): Promise<void> {
    const { pollSec = 15, timeoutMin = 10 } = opts;
    const deadline = Date.now() + timeoutMin * 60_000;
    for (;;) {
      // L-3: tolerate transient 503s during the provision poll — a network blip
      // during a 10-minute wait should not abort the entire harness.
      let statuses: string[];
      try {
        statuses = await Promise.all(refs.map((r) => this.getProject(r).then((p) => p.status)));
      } catch (e) {
        log.warn(
          `waitHealthy: transient error polling project status — ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        if (Date.now() >= deadline) throw new Error("timed out waiting for ACTIVE_HEALTHY");
        await sleep(pollSec * 1_000);
        continue;
      }
      if (statuses.every((s) => s === "ACTIVE_HEALTHY")) return;
      if (Date.now() >= deadline) throw new Error("timed out waiting for ACTIVE_HEALTHY");
      log.detail(`waiting for ACTIVE_HEALTHY — ${statuses.join(", ")}`);
      await sleep(pollSec * 1_000);
    }
  }

  /** GET /v1/projects/:ref/config/database/pooler — returns session-pooler host+user. */
  async getPooler(ref: string): Promise<{ host: string; user: string }> {
    const { body } = await this.get<Array<{ db_host: string; db_user: string }>>(
      ref,
      "/config/database/pooler",
    );
    if (!body?.[0]) throw new Error(`No pooler config for project ${ref}`);
    return { host: body[0].db_host, user: body[0].db_user };
  }

  /**
   * GET /v1/organizations/:slug/project-claim/:token — preview of moving a
   * project INTO this org. This is the ONLY org-level migration primitive the
   * Management API exposes: org settings, members + roles, and entitlements are
   * all read-only (no write endpoint), so they are NOT migratable — they're
   * dashboard-only. Use claim when the goal is "same project, different org"
   * rather than the new-project + logical-replication path.
   */
  async getClaimPreview(
    slug: string,
    token: string,
  ): Promise<{ status: number; body: ClaimInfo | null }> {
    const res = await fetch(`${API_BASE}/organizations/${slug}/project-claim/${token}`, {
      headers: this.headers(),
    });
    const body = res.ok ? ((await res.json()) as ClaimInfo) : null;
    return { status: res.status, body };
  }

  /** POST /v1/organizations/:slug/project-claim/:token — performs the claim (204). */
  async claimProject(slug: string, token: string): Promise<{ status: number; text: string }> {
    const res = await fetch(`${API_BASE}/organizations/${slug}/project-claim/${token}`, {
      method: "POST",
      headers: this.headers(),
    });
    return { status: res.status, text: await res.text() };
  }

  /** DELETE /v1/projects/:ref — best-effort teardown; ignores 404. */
  async deleteProject(ref: string): Promise<void> {
    const res = await fetch(`${API_BASE}/projects/${ref}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 404) {
      log.warn(`deleteProject ${ref}: HTTP ${res.status} (ignored)`);
    }
  }

  /**
   * GET /v1/projects/:ref/advisors/{security,performance} — the hosted output
   * of Supabase's lint engine. Used by the `verify` post-migration health gate.
   *
   * DEPRECATION NOTE: these endpoints are flagged DEPRECATED / experimental in
   * the Management API reference. They are still the only HOSTED source of the
   * lint engine. If they are removed, swap the fetch here for the open-source
   * "splinter" lint SQL run directly against the target DB — that path works for
   * generic PG too and needs no access token. Callers only see `{ ok, lints }`
   * so `verify` does not care which path produced the lints. The `ok=false`
   * return on non-200 is load-bearing: it lets `verify` fail CLOSED rather than
   * report a false green if the endpoint disappears.
   */
  async getAdvisors(
    ref: string,
    kind: AdvisorKind,
  ): Promise<{ ok: boolean; status: number; lints: Lint[] }> {
    // security advisor takes an optional lint_type; sql is the documented value.
    const path = kind === "security" ? "/advisors/security?lint_type=sql" : "/advisors/performance";
    const { status, body } = await this.get<{ lints: Lint[] }>(ref, path);
    if (status !== 200 || !body) {
      log.warn(`GET advisors/${kind} failed (HTTP ${status})`);
      return { ok: false, status, lints: [] };
    }
    return { ok: true, status, lints: body.lints ?? [] };
  }

  /**
   * Lightweight token liveness probe: GET /v1/organizations succeeds for any
   * valid PAT and 401s for an expired/revoked one, without needing a project ref
   * (so it works during prep, before the target exists). Never throws - returns
   * the status so callers (doctor) can downgrade to a warning rather than fail.
   */
  async validateToken(): Promise<{ ok: boolean; status: number }> {
    try {
      const res = await fetch(`${API_BASE}/organizations`, { headers: this.headers() });
      return { ok: res.ok, status: res.status };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  /** Sanity check: token valid and both refs visible to this account. */
  async assertAccess(refs: string[]): Promise<void> {
    for (const ref of refs) {
      const { status } = await this.get(ref, "");
      if (status === 401) throw new Error("Management API 401 — SUPABASE_ACCESS_TOKEN invalid.");
      if (status === 403 || status === 404) {
        throw new Error(`No Owner/Admin access to project ${ref} (HTTP ${status}).`);
      }
      log.detail(`project ${ref} reachable (HTTP ${status})`);
    }
  }
}
