import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import {
  exists,
  expandHome,
  hashId,
  mapLimit,
  num,
  projectName,
  readJson,
  readLines,
  splitCache,
} from "@/lib/adapters/kit";
import { costOf } from "@/lib/pricing";
import type { Adapter, CostSource, Fidelity, UsageEvent } from "@/lib/types";

const ROOT = "~/.gemini/tmp";
const CONCURRENCY = 8;
const MAX_DEPTH = 12;
const UNKNOWN_MODEL = "gemini-unknown";

const META_PATHS = ["~/.gemini/tmp/**/chats/session-*.jsonl"];

const SESSION_FILE = /^session-.*\.(jsonl|json)$/i;

type GeminiTokens = {
  input?: number;
  output?: number;
  cached?: number;
  thoughts?: number;
  tool?: number;
  total?: number;
};

type GeminiRecord = {
  id?: string;
  timestamp?: string;
  type?: string;
  model?: string;
  tokens?: GeminiTokens | null;
  sessionId?: string;
  projectHash?: string;
  startTime?: string;
  kind?: string;
  directories?: string[];
  messages?: unknown[];
};

async function walk(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      files.push(...(await walk(full, depth + 1)));
    } else if (entry.isFile() && SESSION_FILE.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadRecords(file: string): Promise<GeminiRecord[]> {
  if (file.endsWith(".json")) {
    const data = await readJson<unknown>(file);
    if (Array.isArray(data)) {
      return data.filter(isObject) as GeminiRecord[];
    }
    if (isObject(data)) {
      const record = data as GeminiRecord;
      const nested = Array.isArray(record.messages)
        ? (record.messages.filter(isObject) as GeminiRecord[])
        : [];
      return [record, ...nested];
    }
    return [];
  }

  const out: GeminiRecord[] = [];
  for await (const line of readLines(file)) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isObject(parsed)) out.push(parsed as GeminiRecord);
    } catch {
      // malformed line: ignore
    }
  }
  return out;
}

/** Resolve the literal cwd from a sibling `.project_root`, if present. */
async function projectRootFor(
  file: string,
  cache: Map<string, string | null>,
): Promise<string | undefined> {
  const dir = path.dirname(file);
  const candidates = [dir, path.dirname(dir)];

  for (const candidate of candidates) {
    const cached = cache.get(candidate);
    if (cached !== undefined) {
      if (cached) return cached;
      continue;
    }
    let value: string | null = null;
    try {
      const text = (await readFile(path.join(candidate, ".project_root"), "utf8")).trim();
      value = text || null;
    } catch {
      value = null;
    }
    cache.set(candidate, value);
    if (value) return value;
  }

  return undefined;
}

function sessionFallback(file: string): string {
  return path.basename(file).replace(/\.(jsonl|json)$/i, "");
}

function toEvent(
  record: GeminiRecord,
  sessionId: string,
  projectPath: string | undefined,
  index: number,
): { key: string; event: UsageEvent } | null {
  const tokens = record.tokens;
  if (!tokens || typeof tokens !== "object") return null;

  const ts = Date.parse(record.timestamp ?? "");
  if (!Number.isFinite(ts)) return null;

  const cached = num(tokens.cached);
  const rawInput = num(tokens.input);
  // `input` is the full prompt size and already includes cached tokens.
  const split = splitCache(rawInput, cached);

  // Reasoning/thought tokens are billed as output.
  const thoughts = num(tokens.thoughts);
  const output = num(tokens.output) + thoughts;

  if (split.input + split.cached + output === 0) return null;

  const rawModel = typeof record.model === "string" ? record.model.trim() : "";
  const model = rawModel || UNKNOWN_MODEL;

  let costUsd: number | undefined;
  let costSource: CostSource;
  let fidelity: Fidelity;

  if (rawModel) {
    const computed = costOf({
      model: rawModel,
      input: split.input,
      cached: split.cached,
      output,
    });
    costUsd = computed ?? undefined;
    costSource = computed !== null ? "computed" : "unavailable";
    fidelity = computed !== null ? "exact" : "unavailable";
  } else {
    costSource = "unavailable";
    fidelity = "unavailable";
  }

  const recordId =
    typeof record.id === "string" && record.id ? record.id : `${ts}#${index}`;

  const event: UsageEvent = {
    id: hashId("gemini", sessionId, recordId),
    tool: "gemini",
    ts,
    sessionId,
    projectPath,
    projectName: projectName(projectPath),
    provider: "google",
    model,
    inputTokens: split.input,
    outputTokens: output,
    costUsd,
    costSource,
    fidelity,
  };

  if (split.cached > 0) event.cachedInputTokens = split.cached;
  if (thoughts > 0) event.reasoningTokens = Math.min(thoughts, output);

  return { key: `${sessionId}|${recordId}`, event };
}

export const adapter: Adapter = {
  id: "gemini",
  label: "Gemini CLI",
  meta: {
    fidelity: "exact",
    costSource: "computed",
    units: "tokens",
    paths: META_PATHS,
  },

  detect: async () => {
    try {
      return await exists(expandHome(ROOT));
    } catch {
      return false;
    }
  },

  scan: async () => {
    try {
      const root = expandHome(ROOT);
      if (!(await exists(root))) return [];

      const files = (await walk(root)).sort();
      if (files.length === 0) return [];

      const seen = new Map<string, UsageEvent>();
      const rootCache = new Map<string, string | null>();

      await mapLimit(files, CONCURRENCY, async (file) => {
        try {
          const records = await loadRecords(file);
          if (records.length === 0) return;

          const meta = records.find(
            (r) =>
              !r.tokens &&
              typeof r.sessionId === "string" &&
              (Array.isArray(r.directories) ||
                typeof r.startTime === "string" ||
                typeof r.projectHash === "string"),
          );

          const sessionId =
            (typeof meta?.sessionId === "string" && meta.sessionId) ||
            (typeof records[0]?.sessionId === "string" && records[0].sessionId) ||
            sessionFallback(file);

          const declared = Array.isArray(meta?.directories)
            ? meta.directories.find(
                (d): d is string => typeof d === "string" && d.trim().length > 0,
              )
            : undefined;
          const projectPath = declared || (await projectRootFor(file, rootCache));

          records.forEach((record, index) => {
            if (record.type !== "gemini" && record.type !== "assistant") return;
            const hit = toEvent(record, sessionId, projectPath, index);
            if (!hit) return;
            if (!seen.has(hit.key)) seen.set(hit.key, hit.event);
          });
        } catch {
          // unreadable / truncated file: skip it, keep the rest of the scan
        }
      });

      return [...seen.values()].sort((a, b) => a.ts - b.ts);
    } catch {
      return [];
    }
  },
};
