/**
 * Grow a throwaway project's disk before seeding a large fixture. Without it a
 * multi-GB seed on a new Small project filled the default volume and the
 * platform put the database read-only mid-insert (live run, 2026-11-09:
 * `cannot execute INSERT in a read-only transaction`, SQLSTATE 25006).
 * One POST per project: disk changes have a cooldown of about four hours.
 */
import type { MgmtApi } from "../src/mgmt.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** POST /config/disk with size_gb, then wait until the filesystem reports it. Returns seconds taken. */
export async function growDisk(
  api: MgmtApi,
  ref: string,
  gb: number,
  timeoutMin = 15,
): Promise<number> {
  const t0 = Date.now();
  const cur = await api.get<{ attributes?: Record<string, unknown> }>(ref, "/config/disk");
  const res = await api.write(ref, "/config/disk", "POST", {
    attributes: { ...(cur.body?.attributes ?? {}), size_gb: gb },
  });
  if (res.status >= 300)
    throw new Error(`disk resize ${ref}: HTTP ${res.status} ${res.text.slice(0, 200)}`);
  while (Date.now() - t0 < timeoutMin * 60_000) {
    const u = await api.get<{ metrics?: { fs_size_bytes?: number } }>(ref, "/config/disk/util");
    if ((u.body?.metrics?.fs_size_bytes ?? 0) > (gb - 3) * 1024 ** 3)
      return Math.round((Date.now() - t0) / 1000);
    await sleep(15_000);
  }
  throw new Error(`disk resize ${ref}: filesystem did not reach ${gb} GB in ${timeoutMin} min`);
}
