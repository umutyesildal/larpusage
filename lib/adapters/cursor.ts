import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { exists, expandHome, hashId, pick, projectName, splitCache } from "@/lib/adapters/kit";
import { costOf } from "@/lib/pricing";
import type { Adapter, CostSource, UsageEvent } from "@/lib/types";

const TOOL = "cursor" as const;

type Obj = Record<string, unknown>;
type Row = { key?: unknown; value?: unknown };

function obj(v: unknown): Obj | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined;
}

function maybeNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function pickNum(o: Obj | undefined, keys: string[]): number | undefined {
  if (!o) return undefined;
  for (const k of keys) {
    const n = maybeNum(o[k]);
    if (n !== undefined) return n;
  }
  return undefined;
}

/** Accepts epoch seconds, milliseconds, microseconds and nanoseconds, plus ISO strings. */
function toMs(v: unknown): number | undefined {
  const n = maybeNum(v);
  if (n !== undefined) {
    if (n <= 0) return undefined;
    if (n >= 1e17) return Math.round(n / 1e6);
    if (n >= 1e14) return Math.round(n / 1e3);
    if (n < 1e11) return Math.round(n * 1000);
    return Math.round(n);
  }
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

function textOf(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) {
    try {
      return new TextDecoder().decode(v);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function filePath(v: unknown): string | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const value = v.trim();
  if (value.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(value).pathname);
    } catch {
      return value.slice("file://".length);
    }
  }
  if (value.startsWith("/")) return value;
  return undefined;
}

function modelOf(o: Obj): string | undefined {
  const info = obj(o.modelInfo);
  if (info) {
    for (const k of ["modelName", "modelId", "model", "name"]) {
      const v = info[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  for (const k of ["modelName", "modelId", "model"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

function composerMeta(o: Obj): { cwd?: string; ts?: number } {
  const cwd =
    filePath(pick(o, "workspaceIdentifier", "uri")) ??
    filePath(pick(o, "workspaceIdentifier", "path")) ??
    filePath(o.workspaceUri) ??
    filePath(o.workspacePath) ??
    filePath(o.projectPath) ??
    filePath(o.cwd) ??
    filePath(pick(o, "workspace", "path")) ??
    filePath(pick(o, "workspace", "uri"));

  const ts =
    toMs(o.createdAt) ??
    toMs(o.created_at) ??
    toMs(o.timestamp) ??
    toMs(pick(o, "workspaceIdentifier", "createdAt"));

  return { cwd, ts };
}

function dbPath(): string {
  const home = process.env.HOME ?? "";
  return resolve(
    expandHome(join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb")),
  );
}

async function scanDb(path: string, fallbackTs: number): Promise<UsageEvent[]> {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 2000");

      const composers = new Map<string, { cwd?: string; ts?: number }>();
      try {
        const composerStmt = db.prepare(
          "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' LIMIT 50000",
        );
        for (const row of composerStmt.iterate() as unknown as Iterable<Row>) {
          const key = typeof row.key === "string" ? row.key : "";
          const raw = textOf(row.value);
          if (!key || !raw) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            continue;
          }
          const composer = obj(parsed);
          if (!composer) continue;
          const composerId = key.slice("composerData:".length);
          if (composerId) composers.set(composerId, composerMeta(composer));
        }
      } catch {
        // composerData is optional; bubbles alone are enough.
      }

      const out: UsageEvent[] = [];
      const bubbleStmt = db.prepare(
        "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' LIMIT 200000",
      );
      for (const row of bubbleStmt.iterate() as unknown as Iterable<Row>) {
        const key = typeof row.key === "string" ? row.key : "";
        const raw = textOf(row.value);
        if (!key || !raw) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          continue;
        }
        const bubble = obj(parsed);
        if (!bubble) continue;

        // User bubbles never carry assistant usage.
        if (bubble.type === 1 || bubble.type === "1") continue;
        if (typeof bubble.role === "string" && bubble.role.toLowerCase() === "user") continue;

        // Sparse by design: a bubble without tokenCount cannot be costed.
        const tokenCount = obj(bubble.tokenCount);
        if (!tokenCount) continue;

        const inputRaw = pickNum(tokenCount, [
          "inputTokens",
          "input_tokens",
          "prompt_tokens",
          "promptTokens",
          "inputTokenCount",
        ]);
        const output = pickNum(tokenCount, [
          "outputTokens",
          "output_tokens",
          "completion_tokens",
          "completionTokens",
          "outputTokenCount",
        ]) ?? 0;
        const cached = pickNum(tokenCount, [
          "cachedInputTokens",
          "cached_tokens",
          "cacheReadTokens",
          "cache_read_tokens",
          "cacheReads",
        ]) ?? 0;
        const cacheWrite = pickNum(tokenCount, ["cacheWriteTokens", "cache_write_tokens", "cacheWrites"]) ?? 0;

        const split = splitCache(inputRaw ?? 0, cached, cacheWrite);
        const total = split.input + split.cached + split.cacheWrite + output;
        if (total <= 0) continue;

        const model = modelOf(bubble);
        if (!model) continue;

        // Stable id: the SQLite key is unique and never changes for a bubble.
        const id = hashId(TOOL, key);
        const parts = key.split(":");
        const composerId = parts.length >= 3 ? parts[1] : "";
        const meta = composerId ? composers.get(composerId) : undefined;
        const ts = toMs(bubble.createdAt) ?? toMs(bubble.timestamp) ?? meta?.ts ?? fallbackTs;
        const cwd = meta?.cwd;

        const computed = costOf({
          model,
          input: split.input,
          cached: split.cached,
          cacheWrite: split.cacheWrite,
          output,
        });
        const costSource: CostSource = computed !== null ? "estimated" : "unavailable";

        out.push({
          id,
          tool: TOOL,
          ts,
          sessionId: composerId || key,
          projectPath: cwd,
          projectName: projectName(cwd),
          model,
          inputTokens: split.input,
          cachedInputTokens: split.cached,
          cacheWriteTokens: split.cacheWrite,
          outputTokens: output,
          costUsd: computed ?? undefined,
          costSource,
          fidelity: "estimated",
        });
      }

      return out;
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  } catch {
    // Missing driver, locked DB, or a schema that predates cursorDiskKV.
    return [];
  }
}

export const adapter: Adapter = {
  id: TOOL,
  label: "Cursor",
  meta: {
    fidelity: "estimated",
    costSource: "estimated",
    units: "tokens",
    paths: ["~/Library/Application Support/Cursor/User/globalStorage/state.vscdb"],
  },
  detect: async (): Promise<boolean> => {
    try {
      return await exists(dbPath());
    } catch {
      return false;
    }
  },
  scan: async (): Promise<UsageEvent[]> => {
    try {
      const path = dbPath();
      if (!(await exists(path))) return [];
      const st = await stat(path).catch(() => null);
      const events = await scanDb(path, st?.mtimeMs ?? Date.now());
      return events.sort((a, b) => a.ts - b.ts);
    } catch {
      return [];
    }
  },
};
