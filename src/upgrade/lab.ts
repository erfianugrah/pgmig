import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { log } from "../log.ts";
import { seedToSize } from "../rehearsal/seed.ts";
import { SUPABASE_RESERVED_ROLES } from "../steps/bootstrap.ts";
import {
  extrapolateProdDowntime,
  filterGrantsForLab,
  LAB_SUPPORTED_EXTENSIONS,
  PRELOAD_EXTENSIONS,
  renderEstimate,
  SUPABASE_POSTGRES_IMAGES,
  stripUnsupportedExtensions,
} from "./kb.ts";
import { connectSourceOnly } from "./source.ts";

/**
 * `upgrade lab` - the empirical core of the upgrade rehearsal.
 *
 * Spins up a THROWAWAY Docker lab and times a real `pg_upgrade --link` from
 * PG<from> to PG<to>, N times, on production-like data:
 *
 *   pgmig-pgup-old-<from>   holds the pristine pre-upgrade copy (published
 *                             :55440) - the "source" upgrade verify diffs against.
 *   pgmig-pgup-lab-<from>-<to>
 *                             dual-major image. Its old-major cluster is loaded
 *                             with the SAME data, snapshotted, then upgraded
 *                             --link once per run from a fresh copy of the
 *                             snapshot. After the last run the new cluster keeps
 *                             serving on :55441.
 *
 * Two image flavors:
 *
 *   pgdg      plain Debian PGDG image with both majors (lab/Dockerfile.pgupgrade).
 *             Platform extensions with no PGDG binaries (pg_net, pg_graphql,
 *             supabase_vault, pgjwt) are STRIPPED from the restore with a loud
 *             fidelity note. Fast to build; proves the pg_upgrade + data path.
 *   supabase  built FROM the real supabase/postgres:<from> + :<to> images
 *             (lab/Dockerfile.pgupgrade-supabase). The images are nix-based -
 *             the whole /nix/store of the new-major image drops into the old-
 *             major base conflict-free, so the FULL platform extension set has
 *             binaries on both majors and nothing is stripped. pg_upgrade
 *             --check then exercises the exact extension-availability behavior
 *             the managed upgrade will hit. Default when the capture manifest
 *             says the source is Supabase.
 *
 * Data comes from either `upgrade capture` files (--capture-dir) or the
 * rehearsal fixture + size-targeted seed (--seed-gib, pgdg flavor). Seed mode
 * seeds the old container ONCE, then dumps and replays into the lab container,
 * so both sides are byte-identical (seeding twice would produce different
 * random payloads and verify would correctly flag it).
 *
 * Why cp -a (not cp -al) from the snapshot for each run: pg_upgrade --link
 * HARDLINKS the new datadir's files to the old datadir's inodes, and the new
 * cluster then writes through them - the run's old datadir is destroyed by
 * design. The pristine snapshot must not share those inodes.
 */

export const OLD_PORT = 55440;
export const NEW_PORT = 55441;

export type LabFlavor = "pgdg" | "supabase";

/** Pure: container/image names, exported for tests. */
export const oldContainerName = (from: number) => `pgmig-pgup-old-${from}`;
export const labContainerName = (from: number, to: number) => `pgmig-pgup-lab-${from}-${to}`;
export const labImageTag = (from: number, to: number, flavor: LabFlavor = "pgdg") =>
  flavor === "supabase" ? `pgmig-pgupgrade-sb:${from}-${to}` : `pgmig-pgupgrade:${from}-${to}`;

/** Pure: lab connection URLs (host side), for verify + manual poking. */
export const labUrls = () => ({
  source: `postgres://postgres:postgres@localhost:${OLD_PORT}/postgres`,
  target: `postgres://postgres:postgres@localhost:${NEW_PORT}/postgres`,
});

export interface LabRun {
  run: number;
  prepSec: number;
  pgUpgradeSec: number;
  analyzeSec: number;
  totalSec: number;
}

export interface LabReport {
  from: number;
  to: number;
  flavor: LabFlavor;
  dataSource: string;
  labSizeBytes: number;
  prodSizeBytes?: number;
  skippedExtensions?: string[];
  runs: LabRun[];
  medianPgUpgradeSec: number;
  prodEstimate?: { low: string; high: string; assumptions: string[] };
}

/** Pure: median of a numeric list (0 for empty). */
export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0
    ? ((s[mid - 1] as number) + (s[mid] as number)) / 2
    : (s[mid] as number);
}

export interface LabOpts {
  from: number;
  to: number;
  runs: number;
  /** Directory with roles.sql/schema.sql/data.sql (+manifest.json) from `upgrade capture`. */
  captureDir?: string;
  /** Fixture + size-targeted seed instead of a capture (GiB). */
  seedGib?: number;
  /** Lab image flavor: auto = supabase when the capture came from Supabase. */
  image?: "auto" | LabFlavor;
  /** supabase/postgres image overrides for the supabase flavor. */
  fromImage?: string;
  toImage?: string;
  /** Production DB size in bytes, for the extrapolated downtime estimate. */
  prodBytes?: number;
  /** Keep both containers running afterwards (needed for `upgrade verify`). */
  keep: boolean;
  /** Tear down the lab containers and exit. */
  clean: boolean;
  workDir: string;
}

interface CaptureManifest {
  files: string[];
  sizeBytes?: number;
  supabaseSource?: boolean;
  extensions?: { extname: string }[];
}

// ---------------------------------------------------------------------------
// docker / psql plumbing
// ---------------------------------------------------------------------------

async function docker(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out.trim(), err: err.trim() };
}

async function dockerMust(args: string[], label: string): Promise<string> {
  log.detail(`$ docker ${args.join(" ")}`);
  const { code, out, err } = await docker(args);
  if (code !== 0) throw new Error(`${label} failed (exit ${code}): ${err || out}`);
  return out;
}

/** Run a shell command inside a lab container as the postgres user. */
async function labExec(container: string, cmd: string, label: string): Promise<string> {
  return dockerMust(["exec", container, "su", "postgres", "-c", cmd], label);
}

async function hostPsql(port: number, args: string[], label: string): Promise<void> {
  const argv = [
    "psql",
    "-h",
    "localhost",
    "-p",
    String(port),
    "-U",
    "postgres",
    "-d",
    "postgres",
    ...args,
  ];
  log.detail(`$ ${argv.join(" ")}`);
  const proc = Bun.spawn(argv, {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, PGPASSWORD: "postgres" },
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${label} failed (exit ${code})`);
}

/**
 * Restore a SQL file into a lab container through a filter pipe. The filter
 * strips `SET transaction_timeout` - a PG17+ session GUC that a newer host
 * pg_dump/pg_dumpall writes into dumps even against PG15 sources, and that
 * PG15 rejects on restore (measured). Removing the no-op SET is harmless on
 * every target version. FK enforcement is deferred via
 * session_replication_role inside the same single transaction.
 */
async function restoreSqlFiltered(
  port: number,
  file: string,
  opts: { strict: boolean; deferFks: boolean },
  label: string,
): Promise<void> {
  const set = opts.deferFks ? `echo "SET session_replication_role = replica;"; ` : "";
  const strict = opts.strict ? `--single-transaction -v ON_ERROR_STOP=1` : `-v ON_ERROR_STOP=0`;
  const cmd =
    `{ ${set}grep -v '^SET transaction_timeout' '${file}'; } | ` +
    `psql -h localhost -p ${port} -U postgres -d postgres ${strict}`;
  log.detail(`$ ${cmd}`);
  const proc = Bun.spawn(["bash", "-c", cmd], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, PGPASSWORD: "postgres" },
  });
  if ((await proc.exited) !== 0) throw new Error(`${label} failed`);
}

async function waitReady(port: number, timeoutSec = 60): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1000;
  for (;;) {
    const proc = Bun.spawn(
      ["pg_isready", "-h", "localhost", "-p", String(port), "-U", "postgres"],
      { stdout: "ignore", stderr: "ignore" },
    );
    if ((await proc.exited) === 0) return;
    if (Date.now() > deadline) throw new Error(`postgres on :${port} did not become ready`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function rmContainers(...names: string[]): Promise<void> {
  for (const n of names) await docker(["rm", "-f", n]);
}

// ---------------------------------------------------------------------------
// cluster bootstrap inside containers
// ---------------------------------------------------------------------------

/**
 * initdb + configure + start a cluster inside a container. The pg_hba line is
 * needed because host connections arrive from the docker bridge gateway, not
 * 127.0.0.1 (initdb's trust lines cover localhost only). Lab-only containers.
 */
async function initdbAndStart(
  container: string,
  bin: string,
  datadir: string,
  logFile: string,
  preload: string[],
): Promise<void> {
  const preloadLine =
    preload.length > 0
      ? ` && echo "shared_preload_libraries = '${preload.join(",")}'" >> ${datadir}/postgresql.conf`
      : "";
  await labExec(
    container,
    `${bin}/initdb -D ${datadir} --auth=trust --encoding=UTF8 --locale=C -U postgres ` +
      `&& echo "listen_addresses = '*'" >> ${datadir}/postgresql.conf ` +
      `&& echo "host all all all trust" >> ${datadir}/pg_hba.conf` +
      preloadLine +
      ` && ${bin}/pg_ctl -D ${datadir} -l ${logFile} -w start`,
    `${container} initdb + start (${datadir})`,
  );
}

// ---------------------------------------------------------------------------
// data loading
// ---------------------------------------------------------------------------

/**
 * Restore a capture into a lab container. Order matters: auth-schema BEFORE
 * schema (user tables FK into auth.users), auth row data under deferred FKs.
 * CREATE EXTENSION statements outside `supported` are stripped (collected into
 * `skippedExts` for the report) - in the pgdg flavor that is the platform set;
 * in the supabase flavor nothing should be stripped.
 */
async function restoreCaptureInto(
  port: number,
  captureDir: string,
  files: string[],
  workDir: string,
  skippedExts: Set<string>,
  supported: Set<string>,
): Promise<void> {
  // Prep: the dump EXCLUDES the managed schemas that host extension objects
  // ('extensions', 'graphql', 'vault'), so the CREATE EXTENSION ... WITH SCHEMA
  // statements have no target schema in the lab; and auth-schema DDL references
  // extension functions (auth uses pgcrypto's crypt/gen_salt) before schema.sql
  // would create them. Create the schemas + pgcrypto up front (the dump's own
  // CREATE EXTENSION IF NOT EXISTS then no-ops or creates in the right place).
  const prep =
    "CREATE SCHEMA IF NOT EXISTS extensions; CREATE SCHEMA IF NOT EXISTS graphql; " +
    "CREATE SCHEMA IF NOT EXISTS vault;" +
    (supported.has("pgcrypto")
      ? ' CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;'
      : "");
  await hostPsql(port, ["-v", "ON_ERROR_STOP=1", "-c", prep], "lab schema prep");
  if (files.includes("roles.sql")) {
    // Lenient: roles partially exist on any fresh cluster. Grants OF platform-
    // reserved roles (GRANT "anon" TO user_role) are commented out - those
    // roles do not exist in the lab (lab-side transform only; on a real
    // Supabase target bootstrap keeps them because the roles DO exist).
    const rolesFiltered = `${workDir}/roles.lab-filtered.sql`;
    writeFileSync(
      rolesFiltered,
      filterGrantsForLab(readFileSync(`${captureDir}/roles.sql`, "utf8"), SUPABASE_RESERVED_ROLES),
    );
    await restoreSqlFiltered(
      port,
      rolesFiltered,
      { strict: false, deferFks: false },
      "roles restore",
    );
  }
  const restoreDdl = async (name: string, label: string) => {
    const { sql, skipped } = stripUnsupportedExtensions(
      readFileSync(`${captureDir}/${name}`, "utf8"),
      supported,
    );
    for (const s of skipped) skippedExts.add(s);
    const filtered = `${workDir}/${name}.lab-filtered.sql`;
    writeFileSync(filtered, sql);
    await restoreSqlFiltered(port, filtered, { strict: true, deferFks: false }, label);
  };
  if (files.includes("auth-schema.sql")) await restoreDdl("auth-schema.sql", "auth schema restore");
  else if (files.includes("auth.sql")) {
    log.warn(
      "capture has auth.sql but no auth-schema.sql (taken before auth-schema dumps existed) - " +
        "re-run 'upgrade capture --with-auth-data'; auth data restore will fail without the DDL",
    );
  }
  await restoreDdl("schema.sql", "schema restore");
  if (files.includes("auth.sql")) {
    await restoreSqlFiltered(
      port,
      `${captureDir}/auth.sql`,
      { strict: true, deferFks: true },
      "auth data restore",
    );
  }
  await restoreSqlFiltered(
    port,
    `${captureDir}/data.sql`,
    { strict: true, deferFks: true },
    "data restore",
  );
}

/** Seed mode: fixture schema + size-targeted seed into the OLD container, then
 *  dump it (in-container pg_dump, matching the server major) and replay into
 *  the LAB container so both are byte-identical. Note: the dump is in-container
 *  but the restore (restoreSqlFiltered) and fixture load use host psql. */
async function seedLab(opts: LabOpts, labSizeBytes: { v: number }): Promise<void> {
  log.step(`upgrade lab: seeding old container to ~${opts.seedGib} GiB (fixture schema)`);
  await hostPsql(
    OLD_PORT,
    ["--single-transaction", "-v", "ON_ERROR_STOP=1", "-f", "src/rehearsal/schema.sql"],
    "fixture schema",
  );
  const targetBytes = Number(opts.seedGib) * 1_073_741_824;
  // Size batches to the TARGET: seedToSize's 80%-guard only limits overshoot
  // near the end - a fixed 50k x 4 volley overshoots a small target massively
  // on the FIRST iteration (measured: 0.25 GiB target -> 2.73 GiB seeded).
  const batchRows = Math.max(500, Math.min(50_000, Math.floor(targetBytes / 6000 / 20)));
  const concurrency = targetBytes >= 2 * 1_073_741_824 ? 4 : 2;
  const db = connectSourceOnly(labUrls().source);
  try {
    await seedToSize(db, { targetBytes, payloadBytes: 6000, batchRows, concurrency });
    const [r] = await db`SELECT pg_database_size(current_database())::bigint AS s`;
    labSizeBytes.v = Number(r?.s ?? 0);
  } finally {
    await db.end({ timeout: 5 });
  }
  log.step("upgrade lab: replaying identical data into the lab container");
  const dumpFile = `${opts.workDir}/seed-dump.sql`;
  // Dump from INSIDE the old container: pg_dump matches the server major (a
  // newer host pg_dump writes PG17+ session GUCs the PG<from> restore target
  // rejects). The restore and fixture load still use host psql.
  const dumpCmd =
    `docker exec ${oldContainerName(opts.from)} pg_dump -U postgres ` +
    `--no-owner --no-privileges -d postgres > '${dumpFile}'`;
  log.detail(`$ ${dumpCmd}`);
  const proc = Bun.spawn(["bash", "-c", dumpCmd], { stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) throw new Error("seed dump failed");
  await restoreSqlFiltered(
    NEW_PORT,
    dumpFile,
    { strict: true, deferFks: true },
    "seed replay into lab",
  );
}

// ---------------------------------------------------------------------------
// main flow
// ---------------------------------------------------------------------------

function readManifest(captureDir: string): CaptureManifest {
  if (!existsSync(`${captureDir}/manifest.json`)) {
    return { files: ["roles.sql", "schema.sql", "data.sql"] };
  }
  return JSON.parse(readFileSync(`${captureDir}/manifest.json`, "utf8")) as CaptureManifest;
}

export async function upgradeLab(opts: LabOpts): Promise<LabReport | null> {
  const oldName = oldContainerName(opts.from);
  const labName = labContainerName(opts.from, opts.to);

  if (opts.clean) {
    log.step(`upgrade lab: tearing down ${oldName} + ${labName}`);
    await rmContainers(oldName, labName);
    log.ok("lab containers removed (images kept - delete manually if unwanted)");
    return null;
  }

  if (!opts.captureDir && !opts.seedGib) {
    throw new Error("upgrade lab needs data: pass --capture-dir <dir> or --seed-gib <n>");
  }
  if (opts.captureDir && !existsSync(`${opts.captureDir}/schema.sql`)) {
    throw new Error(
      `--capture-dir ${opts.captureDir} has no schema.sql - run 'upgrade capture' first`,
    );
  }

  // From here on we touch docker (image build, containers, volumes via the container
  // writable layer): on any failure, clean up rather than leave the lab half-built for a
  // later `upgrade verify` to silently run against stale state.
  try {
    return await upgradeLabBody(opts, oldName, labName);
  } catch (e) {
    log.warn(`upgrade lab failed - removing ${oldName} + ${labName} to avoid stale leftover state`);
    await rmContainers(oldName, labName);
    throw e;
  }
}

async function upgradeLabBody(opts: LabOpts, oldName: string, labName: string): Promise<LabReport> {
  const manifest = opts.captureDir ? readManifest(opts.captureDir) : undefined;
  const flavor: LabFlavor =
    opts.image === "pgdg" || opts.image === "supabase"
      ? opts.image
      : manifest?.supabaseSource
        ? "supabase"
        : "pgdg";
  if (opts.seedGib && flavor === "supabase") {
    log.warn("--seed-gib uses the fixture (no platform extensions) - forcing the pgdg flavor");
  }
  const effectiveFlavor: LabFlavor = opts.seedGib ? "pgdg" : flavor;
  const image = labImageTag(opts.from, opts.to, effectiveFlavor);
  log.detail(`lab flavor: ${effectiveFlavor} (image ${image})`);

  mkdirSync(opts.workDir, { recursive: true });
  await dockerMust(["version", "--format", "{{.Server.Version}}"], "docker daemon");

  // images
  const hasLab = (await docker(["image", "inspect", image])).code === 0;
  if (!hasLab) {
    if (effectiveFlavor === "pgdg") {
      log.step(`upgrade lab: building ${image} (PGDG dual-major, first build downloads packages)`);
      await dockerMust(
        [
          "build",
          "--build-arg",
          `FROM_MAJOR=${opts.from}`,
          "--build-arg",
          `TO_MAJOR=${opts.to}`,
          "-f",
          "lab/Dockerfile.pgupgrade",
          "-t",
          image,
          "lab/",
        ],
        "lab image build",
      );
    } else {
      const fromImage = opts.fromImage ?? SUPABASE_POSTGRES_IMAGES[opts.from];
      const toImage = opts.toImage ?? SUPABASE_POSTGRES_IMAGES[opts.to];
      if (!fromImage || !toImage) {
        throw new Error(
          `no default supabase/postgres image for PG${opts.from}->${opts.to} - ` +
            "pass --from-image/--to-image",
        );
      }
      log.step(`upgrade lab: building ${image} from ${fromImage} + ${toImage} (nix store merge)`);
      await dockerMust(
        [
          "build",
          "--build-arg",
          `FROM_IMAGE=${fromImage}`,
          "--build-arg",
          `TO_IMAGE=${toImage}`,
          "--build-arg",
          `TO_MAJOR=${opts.to}`,
          "-f",
          "lab/Dockerfile.pgupgrade-supabase",
          "-t",
          image,
          "lab/",
        ],
        "supabase lab image build",
      );
    }
  }

  await rmContainers(oldName, labName);

  const manifestExts = (manifest?.extensions ?? []).map((e) => e.extname);
  const preload = manifestExts.filter((e) => PRELOAD_EXTENSIONS.has(e));
  if (preload.length > 0) {
    log.detail(`shared_preload_libraries in lab clusters: ${preload.join(", ")} (from manifest)`);
  }

  // bindir layout per flavor: PGDG is per-major under /usr/lib/postgresql; the
  // supabase images use a flat /usr/lib/postgresql/bin (old) + a nix store path
  // for the new major (discovered from /pg-new-bindir.txt, written at build).
  const fromBin =
    effectiveFlavor === "pgdg" ? `/usr/lib/postgresql/${opts.from}/bin` : "/usr/lib/postgresql/bin";

  log.step(`upgrade lab: starting old container on :${OLD_PORT}`);
  if (effectiveFlavor === "pgdg") {
    const hasOld = (await docker(["image", "inspect", `postgres:${opts.from}`])).code === 0;
    if (!hasOld) await dockerMust(["pull", `postgres:${opts.from}`], "pull postgres image");
    await dockerMust(
      [
        "run",
        "-d",
        "--name",
        oldName,
        "-e",
        "POSTGRES_PASSWORD=postgres",
        "-p",
        `127.0.0.1:55440:5432`,
        `postgres:${opts.from}`,
      ],
      "old container start",
    );
  } else {
    await dockerMust(
      ["run", "-d", "--name", oldName, "-p", `127.0.0.1:55440:5432`, image],
      "old container start",
    );
    await initdbAndStart(oldName, fromBin, "/pgdata/old", "/pgdata/old.log", preload);
  }
  await waitReady(OLD_PORT);

  log.step(`upgrade lab: starting dual-major lab container on :${NEW_PORT}`);
  await dockerMust(
    ["run", "-d", "--name", labName, "-p", `127.0.0.1:55441:5432`, image],
    "lab container start",
  );
  const toBin =
    effectiveFlavor === "pgdg"
      ? `/usr/lib/postgresql/${opts.to}/bin`
      : (
          await dockerMust(["exec", labName, "cat", "/pg-new-bindir.txt"], "read new bindir")
        ).trim();
  await initdbAndStart(labName, fromBin, "/pgdata/old", "/pgdata/old.log", preload);
  await waitReady(NEW_PORT);

  // load data (identical on both sides)
  const labSize = { v: 0 };
  const skippedExts = new Set<string>();
  let dataSource: string;
  let prodBytes = opts.prodBytes;
  if (opts.captureDir && manifest) {
    dataSource = `capture ${opts.captureDir}`;
    // pgdg: contrib allowlist. supabase: the manifest's own set is supported
    // (the image carries those binaries) - nothing should be stripped.
    const supported =
      effectiveFlavor === "supabase"
        ? new Set([...LAB_SUPPORTED_EXTENSIONS, ...manifestExts])
        : LAB_SUPPORTED_EXTENSIONS;
    log.step(`upgrade lab: restoring capture into BOTH containers (${manifest.files.join(", ")})`);
    await restoreCaptureInto(
      OLD_PORT,
      opts.captureDir,
      manifest.files,
      opts.workDir,
      skippedExts,
      supported,
    );
    await restoreCaptureInto(
      NEW_PORT,
      opts.captureDir,
      manifest.files,
      opts.workDir,
      skippedExts,
      supported,
    );
    prodBytes = prodBytes ?? manifest.sizeBytes;
  } else {
    dataSource = `fixture + seed ${opts.seedGib} GiB`;
    await seedLab(opts, labSize);
  }
  if (labSize.v === 0) {
    const db = connectSourceOnly(labUrls().source);
    try {
      const [r] = await db`SELECT pg_database_size(current_database())::bigint AS s`;
      labSize.v = Number(r?.s ?? 0);
    } finally {
      await db.end({ timeout: 5 });
    }
  }
  if (skippedExts.size > 0) {
    log.warn(
      `lab fidelity: stripped CREATE EXTENSION for ${[...skippedExts].sort().join(", ")} - ` +
        "no binaries in the plain-PG lab image (they exist in prod; use --image supabase " +
        "for full extension fidelity)",
    );
  }
  log.ok(`lab data loaded: ${dataSource}, ${(labSize.v / 1_073_741_824).toFixed(2)} GiB`);

  log.step("upgrade lab: snapshotting the pristine pre-upgrade datadir");
  await labExec(labName, `${fromBin}/pg_ctl -D /pgdata/old -w stop`, "stop lab old cluster");
  await labExec(
    labName,
    "rm -rf /pgdata/snapshot-old && cp -a /pgdata/old /pgdata/snapshot-old",
    "snapshot old datadir",
  );

  const preloadLine =
    preload.length > 0
      ? ` && echo "shared_preload_libraries = '${preload.join(",")}'" >> /pgdata/new/postgresql.conf`
      : "";

  const runs: LabRun[] = [];
  for (let i = 1; i <= opts.runs; i++) {
    log.step(`upgrade lab: pg_upgrade run ${i}/${opts.runs} (${opts.from} -> ${opts.to})`);
    const t0 = Date.now();
    await labExec(
      labName,
      "rm -rf /pgdata/old-run /pgdata/new && cp -a /pgdata/snapshot-old /pgdata/old-run " +
        `&& ${toBin}/initdb -D /pgdata/new --auth=trust --encoding=UTF8 --locale=C -U postgres ` +
        `&& echo "listen_addresses = '*'" >> /pgdata/new/postgresql.conf ` +
        `&& echo "host all all all trust" >> /pgdata/new/pg_hba.conf` +
        preloadLine,
      "prep run datadirs",
    );
    const prepSec = (Date.now() - t0) / 1000;
    if (i === 1) {
      await labExec(
        labName,
        `cd /pgdata && ${toBin}/pg_upgrade --check --old-datadir=/pgdata/old-run --new-datadir=/pgdata/new ` +
          `--old-bindir=${fromBin} --new-bindir=${toBin} -U postgres`,
        "pg_upgrade --check",
      );
      log.ok("pg_upgrade --check passed");
    }
    const tUp = Date.now();
    await labExec(
      labName,
      `cd /pgdata && ${toBin}/pg_upgrade --link --old-datadir=/pgdata/old-run --new-datadir=/pgdata/new ` +
        `--old-bindir=${fromBin} --new-bindir=${toBin} -U postgres`,
      "pg_upgrade --link",
    );
    const pgUpgradeSec = (Date.now() - tUp) / 1000;
    const tAn = Date.now();
    await labExec(
      labName,
      `${toBin}/pg_ctl -D /pgdata/new -l /pgdata/new.log -w start`,
      "start new cluster",
    );
    await waitReady(NEW_PORT);
    await labExec(
      labName,
      `${toBin}/vacuumdb --all --analyze-in-stages -h localhost -U postgres`,
      "post-upgrade ANALYZE",
    );
    const analyzeSec = (Date.now() - tAn) / 1000;
    const totalSec = (Date.now() - t0) / 1000;
    runs.push({ run: i, prepSec, pgUpgradeSec, analyzeSec, totalSec });
    log.ok(
      `run ${i}: pg_upgrade ${pgUpgradeSec.toFixed(1)}s + analyze ${analyzeSec.toFixed(1)}s ` +
        `(prep ${prepSec.toFixed(1)}s, total ${totalSec.toFixed(1)}s)`,
    );
    if (i < opts.runs) {
      await labExec(
        labName,
        `${toBin}/pg_ctl -D /pgdata/new -w stop`,
        "stop new cluster for next run",
      );
    }
  }

  const medianSec = median(runs.map((r) => r.pgUpgradeSec));
  const report: LabReport = {
    from: opts.from,
    to: opts.to,
    flavor: effectiveFlavor,
    dataSource,
    labSizeBytes: labSize.v,
    prodSizeBytes: prodBytes,
    skippedExtensions: skippedExts.size > 0 ? [...skippedExts].sort() : undefined,
    runs,
    medianPgUpgradeSec: medianSec,
  };
  if (prodBytes && prodBytes > 0) {
    const est = extrapolateProdDowntime(medianSec, labSize.v, prodBytes);
    report.prodEstimate = {
      low: `${est.totalSecLow}s`,
      high: `${est.totalSecHigh}s`,
      assumptions: est.assumptions,
    };
    log.step("upgrade lab: extrapolated production estimate");
    log.ok(
      `median pg_upgrade ${medianSec.toFixed(1)}s on ${(labSize.v / 1_073_741_824).toFixed(2)} GiB ` +
        `-> prod window ${renderEstimate(est)}`,
    );
    for (const a of est.assumptions) log.detail(`assumption: ${a}`);
  }

  const reportPath = `${opts.workDir}/upgrade-lab-report.json`;
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  log.detail(`report written to ${reportPath}`);

  if (opts.keep) {
    const urls = labUrls();
    log.ok(
      `lab kept running. verify with:\n  SOURCE_DB_URL='${urls.source}' TARGET_DB_URL='${urls.target}' ` +
        `bun start --no-env-file upgrade verify`,
    );
  } else {
    await rmContainers(oldName, labName);
    log.ok("lab torn down (pass --keep to leave it running for `upgrade verify`)");
  }
  return report;
}
