import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { DATA_DIR, dataPath } from "@/lib/paths";
import type { Snapshot } from "@/lib/types";

const DIR = DATA_DIR;
const FILE = dataPath("snapshot.json");
const TTL = 5 * 60_000;

export async function readCache(): Promise<Snapshot | null> {
  try {
    const s = await stat(FILE);
    if (Date.now() - s.mtimeMs > TTL) return null;
    return JSON.parse(await readFile(FILE, "utf8")) as Snapshot;
  } catch {
    return null;
  }
}

export async function writeCache(snapshot: Snapshot): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(snapshot), "utf8");
}

export async function clearCache(): Promise<void> {
  try {
    await writeFile(FILE, "", "utf8");
  } catch {
    /* ignore */
  }
}
