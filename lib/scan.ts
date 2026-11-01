import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DATA_DIR, dataPath } from "@/lib/paths";
import type { SourceStatus, UsageEvent } from "@/lib/types";
import { adapters } from "@/lib/adapters";

export type ScanResult = {
  events: UsageEvent[];
  sources: SourceStatus[];
  ms: number;
  at: number;
};

const globalCache = globalThis as unknown as { __scan?: ScanResult };
const DIR = DATA_DIR;
const FILE = dataPath("scan.json");
const TTL = 30 * 60_000;

async function readDisk(): Promise<ScanResult | null> {
  try {
    const raw = await readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as ScanResult;
    if (!parsed?.at || Date.now() - parsed.at > TTL) return null;
    if (!Array.isArray(parsed.events)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeDisk(result: ScanResult): Promise<void> {
  try {
    await mkdir(DIR, { recursive: true });
    await writeFile(FILE, JSON.stringify(result), "utf8");
  } catch {
    /* cache is best-effort */
  }
}

export async function scanAll(opts?: { only?: string[]; maxMs?: number }): Promise<ScanResult> {
  const started = Date.now();
  const events: UsageEvent[] = [];
  const sources: SourceStatus[] = [];

  const list = opts?.only?.length
    ? adapters.filter((a) => opts.only!.includes(a.id))
    : adapters;

  const results = await Promise.all(
    list.map(async (adapter) => {
      const t0 = Date.now();
      let found = false;
      let rows: UsageEvent[] = [];
      const warnings: string[] = [];
      try {
        found = await Promise.race([
          adapter.detect(),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
        ]);
      } catch (err) {
        warnings.push(`detect failed: ${String(err).slice(0, 120)}`);
      }
      if (found) {
        try {
          rows = await Promise.race([
            adapter.scan(),
            new Promise<UsageEvent[]>((resolve) =>
              setTimeout(() => {
                warnings.push("scan timed out after 120s");
                resolve([]);
              }, opts?.maxMs ?? 120_000),
            ),
          ]);
        } catch (err) {
          warnings.push(`scan failed: ${String(err).slice(0, 160)}`);
          rows = [];
        }
      }
      const last = rows.reduce((m, e) => (e.ts > m ? e.ts : m), 0);
      const status: SourceStatus = {
        tool: adapter.id,
        label: adapter.label,
        found,
        path: adapter.meta.paths[0],
        files: 0,
        events: rows.length,
        lastEventAt: last || undefined,
        fidelity: adapter.meta.fidelity,
        costSource: adapter.meta.costSource,
        units: adapter.meta.units,
        warnings,
        ms: Date.now() - t0,
      };
      return { rows, status };
    }),
  );

  for (const r of results) {
    events.push(...r.rows);
    sources.push(r.status);
  }

  sources.sort((a, b) => b.events - a.events || a.label.localeCompare(b.label));

  return { events, sources, ms: Date.now() - started, at: Date.now() };
}

export async function getScan(opts?: { fresh?: boolean }): Promise<ScanResult> {
  if (process.env.VERCEL && !process.env.LARPUSAGE_SCAN) {
    return { events: [], sources: [], ms: 0, at: Date.now() };
  }
  if (!opts?.fresh) {
    if (globalCache.__scan) return globalCache.__scan;
    const disk = await readDisk();
    if (disk) {
      globalCache.__scan = disk;
      return disk;
    }
  }
  const result = await scanAll();
  globalCache.__scan = result;
  await writeDisk(result);
  return result;
}
