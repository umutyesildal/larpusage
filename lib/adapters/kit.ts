import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createZstdDecompress } from "node:zlib";

export function hashId(...parts: Array<string | number | undefined>): string {
  return createHash("sha1")
    .update(parts.filter((p) => p !== undefined && p !== null).join("|"))
    .digest("hex")
    .slice(0, 24);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

export function expandHome(p: string): string {
  return p.startsWith("~") ? p.replace(/^~/, process.env.HOME ?? "") : p;
}

/** Async line reader that transparently handles .zst files. */
export async function* readLines(path: string): AsyncGenerator<string> {
  const isZst = path.endsWith(".zst");
  const stream = isZst
    ? createReadStream(path).pipe(createZstdDecompress())
    : createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream as NodeJS.ReadableStream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line) yield line;
  }
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

export function pick(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export function projectName(path?: string): string | undefined {
  if (!path) return undefined;
  const clean = path.replace(/\/+$/, "");
  const parts = clean.split("/").filter(Boolean);
  return parts[parts.length - 1];
}

/** Normalize cache-inclusive token shapes into exclusive buckets. */
export function splitCache(input: number, cached: number, cacheWrite = 0) {
  const c = Math.min(Math.max(cached, 0), Math.max(input, 0));
  const w = Math.min(Math.max(cacheWrite, 0), Math.max(input - c, 0));
  return { input: Math.max(input - c - w, 0), cached: c, cacheWrite: w };
}

export function dayKey(ts: number, tz = "local"): string {
  const d = new Date(ts);
  if (tz === "utc") return d.toISOString().slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function walkFiles(
  dir: string,
  opts: { match?: (name: string) => boolean; maxFiles?: number; maxDepth?: number } = {},
): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const out: string[] = [];
  const maxFiles = opts.maxFiles ?? 50_000;
  const maxDepth = opts.maxDepth ?? 12;

  async function walk(current: string, depth: number) {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (!opts.match || opts.match(entry.name)) out.push(full);
      }
    }
  }

  await walk(dir, 0);
  return out;
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
