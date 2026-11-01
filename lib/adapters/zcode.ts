import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import {
  expandHome,
  hashId,
  mapLimit,
  num,
  projectName,
  readLines,
  splitCache,
  walkFiles,
} from "@/lib/adapters/kit";
import { costOf } from "@/lib/pricing";
import type { Adapter, UsageEvent } from "@/lib/types";

const TOOL = "zcode" as const;
const LABEL = "ZCode";
const MAX_EVENTS = 200_000;
const MAX_PER_FILE = 20_000;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

const INPUT_KEYS = ["input_tokens", "inputTokens"];
const INCLUSIVE_INPUT_KEYS = [
  "prompt_tokens",
  "promptTokens",
  "total_input_tokens",
  "totalInputTokens",
];
const CACHED_KEYS = [
  "cache_read_input_tokens",
  "cacheReadInputTokens",
  "cache_read_tokens",
  "cacheReadTokens",
  "cached_input_tokens",
  "cachedInputTokens",
  "cached_tokens",
  "cachedTokens",
  "cacheRead",
  "cache_read",
];
const CACHE_WRITE_KEYS = [
  "cache_creation_input_tokens",
  "cacheCreationInputTokens",
  "cache_write_tokens",
  "cacheWriteTokens",
  "cache_creation_tokens",
  "cacheCreationTokens",
  "cacheWrite",
  "cache_write",
];
const OUTPUT_KEYS = ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"];
const REASONING_KEYS = [
  "reasoning_tokens",
  "reasoningTokens",
  "thinking_tokens",
  "thinkingTokens",
];

export type ZcodeQuota = {
  fiveHourPct: number;
  fiveHourResetAt: number;
  weeklyPct: number;
  weeklyResetAt: number;
};

type Usage = {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
};

type RawEvent = {
  sessionId: string;
  ts: number;
  model: string;
  provider?: string;
  projectPath?: string;
  usage: Usage;
  key: string;
};

function roots(): string[] {
  const env = process.env.ZCODE_HOME;
  const list = env
    ? env
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
    : ["~/.zcode"];
  return [...new Set(list.map(expandHome))];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function toMs(v: unknown): number | undefined {
  const max = Date.now() + 366 * 24 * 60 * 60 * 1000;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    const ms = v < 100_000_000_000 ? Math.round(v * 1000) : Math.round(v);
    return ms >= 1_000_000_000_000 && ms <= max ? ms : undefined;
  }
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return undefined;
    if (/^\d+(\.\d+)?$/.test(s)) return toMs(Number(s));
    const parsed = Date.parse(s);
    return Number.isFinite(parsed) && parsed >= 1_000_000_000_000 && parsed <= max
      ? parsed
      : undefined;
  }
  return undefined;
}

function numberField(o: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "bigint") return Number(v);
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

function modelName(v: unknown): string | undefined {
  const direct = str(v);
  if (direct) return direct;
  if (!isObj(v)) return undefined;
  return str(v.id) ?? str(v.name) ?? str(v.model) ?? str(v.slug);
}

function modelOf(o: Record<string, unknown>): string | undefined {
  return (
    modelName(o.model) ??
    modelName(o.model_id) ??
    modelName(o.modelId) ??
    modelName(o.model_name) ??
    modelName(o.modelName)
  );
}

/** ZCode legacy usage is Claude-shaped: input_tokens excludes cache buckets. */
function usageOf(o: Record<string, unknown>): Usage | null {
  const bareIn = numberField(o, ["input"]);
  const bareOut = numberField(o, ["output"]);
  const exclusiveIn = numberField(o, INPUT_KEYS) ?? (bareOut !== undefined ? bareIn : undefined);
  const inclusiveIn = numberField(o, INCLUSIVE_INPUT_KEYS);
  const output =
    numberField(o, OUTPUT_KEYS) ?? (bareIn !== undefined && bareOut !== undefined ? bareOut : 0);
  const cached = numberField(o, CACHED_KEYS) ?? 0;
  const cacheWrite = numberField(o, CACHE_WRITE_KEYS) ?? 0;
  const reasoning = numberField(o, REASONING_KEYS) ?? 0;

  if (exclusiveIn === undefined && inclusiveIn === undefined && output <= 0) return null;

  let input: number;
  let c: number;
  let w: number;
  if (exclusiveIn === undefined && inclusiveIn !== undefined) {
    const split = splitCache(Math.max(inclusiveIn, 0), cached, cacheWrite);
    input = split.input;
    c = split.cached;
    w = split.cacheWrite;
  } else {
    input = Math.max(exclusiveIn ?? 0, 0);
    c = Math.max(cached, 0);
    w = Math.max(cacheWrite, 0);
  }

  if (input + c + w + output <= 0) return null;
  return {
    input,
    cached: c,
    cacheWrite: w,
    output: Math.max(output, 0),
    reasoning: Math.max(reasoning, 0),
  };
}

function makeEvent(raw: RawEvent): UsageEvent {
  const cost = costOf({
    model: raw.model,
    input: raw.usage.input,
    cached: raw.usage.cached,
    cacheWrite: raw.usage.cacheWrite,
    output: raw.usage.output,
  });
  const event: UsageEvent = {
    id: hashId(TOOL, raw.sessionId, raw.key, raw.model),
    tool: TOOL,
    ts: raw.ts,
    sessionId: raw.sessionId,
    model: raw.model,
    inputTokens: raw.usage.input,
    cachedInputTokens: raw.usage.cached,
    cacheWriteTokens: raw.usage.cacheWrite,
    outputTokens: raw.usage.output,
    costSource: cost === null ? "unavailable" : "computed",
    fidelity: "exact",
  };
  if (raw.usage.reasoning > 0) event.reasoningTokens = raw.usage.reasoning;
  if (raw.provider) event.provider = raw.provider;
  if (raw.projectPath) {
    event.projectPath = raw.projectPath;
    event.projectName = projectName(raw.projectPath);
  }
  if (cost !== null) event.costUsd = cost;
  return event;
}

async function scanLegacy(root: string): Promise<RawEvent[]> {
  const projects = path.join(root, "projects");
  if (!existsSync(projects)) return [];

  let files: string[];
  try {
    files = await walkFiles(projects, {
      match: (name) => /\.jsonl(\.zst)?$/i.test(name),
      maxFiles: 20_000,
    });
  } catch {
    return [];
  }
  if (files.length === 0) return [];

  const chunks = await mapLimit(files, 8, async (file): Promise<RawEvent[]> => {
    const out: RawEvent[] = [];
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) return out;

      let fileSession = path.basename(file).replace(/\.jsonl(\.zst)?$/i, "");
      let fileProject: string | undefined;
      const seen = new Set<string>();

      for await (const line of readLines(file)) {
        if (out.length >= MAX_PER_FILE) break;
        const text = line.trim();
        if (!text || text[0] !== "{") continue;

        let record: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(text);
          if (!isObj(parsed)) continue;
          record = parsed;
        } catch {
          continue;
        }

        const recordSession = str(record.sessionId) ?? str(record.session_id);
        if (recordSession) fileSession = recordSession;
        const recordCwd = str(record.cwd) ?? str(record.directory);
        if (recordCwd) fileProject = recordCwd;

        const message = isObj(record.message) ? record.message : undefined;
        const usageNode =
          (message && isObj(message.usage) ? message.usage : undefined) ??
          (isObj(record.usage) ? record.usage : undefined) ??
          (isObj(record.tokens) ? record.tokens : undefined);
        const usage = usageNode ? usageOf(usageNode) : undefined;
        if (!usage) continue;

        const rawModel = modelOf(message ?? {}) ?? modelOf(record);
        if (!rawModel) continue;
        const model = rawModel.replace(/^zai\//i, "").trim();
        if (!model) continue;

        const ts = toMs(record.timestamp) ?? toMs(record.created_at) ?? info.mtimeMs;
        if (!Number.isFinite(ts) || ts <= 0) continue;

        const messageId = message ? str(message.id) : undefined;
        const sessionId = recordSession ?? fileSession;
        const projectPath = recordCwd ?? fileProject;

        const dedupe = messageId ?? `${sessionId}:${ts}:${model}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);

        out.push({
          sessionId,
          ts,
          model,
          provider: str(record.provider) ?? "zai",
          projectPath,
          usage,
          key: messageId ?? `${file}#${out.length}`,
        });
      }
    } catch {
      // unreadable file: skip
    }
    return out;
  });

  return chunks.flat();
}

async function scanDatabase(root: string): Promise<RawEvent[]> {
  const dbPath = path.join(root, "cli", "db", "db.sqlite");
  if (!existsSync(dbPath)) return [];

  let db: import("node:sqlite").DatabaseSync | null = null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(dbPath, { readOnly: true });

    const tableRows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as unknown as Array<Record<string, unknown>>;
    const tables = new Set<string>();
    for (const row of tableRows) {
      const name = str(row.name);
      if (name) tables.add(name);
    }

    if (!tables.has("model_usage")) {
      // Older ZCode installs kept Claude-shaped transcripts under projects/.
      return scanLegacy(root);
    }

    let hasSessionDirectory = false;
    if (tables.has("session")) {
      try {
        const sessionCols = db
          .prepare('PRAGMA table_info("session")')
          .all() as unknown as Array<Record<string, unknown>>;
        hasSessionDirectory = sessionCols.some((c) => String(c.name ?? "") === "directory");
      } catch {
        hasSessionDirectory = false;
      }
    }

    const sql = hasSessionDirectory
      ? `SELECT m.id, m.session_id, m.started_at, m.model_id, m.provider_id,
                m.input_tokens, m.output_tokens, m.reasoning_tokens,
                m.cache_creation_input_tokens, m.cache_read_input_tokens,
                m.computed_total_tokens, s.directory
         FROM model_usage m LEFT JOIN session s ON s.id = m.session_id
         WHERE m.status='completed' AND m.started_at > 0
         LIMIT ${MAX_EVENTS}`
      : `SELECT m.id, m.session_id, m.started_at, m.model_id, m.provider_id,
                m.input_tokens, m.output_tokens, m.reasoning_tokens,
                m.cache_creation_input_tokens, m.cache_read_input_tokens,
                m.computed_total_tokens, NULL AS directory
         FROM model_usage m
         WHERE m.status='completed' AND m.started_at > 0
         LIMIT ${MAX_EVENTS}`;

    const rows = db.prepare(sql).all() as unknown as Array<Record<string, unknown>>;
    const out: RawEvent[] = [];

    for (const row of rows) {
      if (out.length >= MAX_EVENTS) break;

      const model = String(row.model_id ?? "")
        .replace(/^zai\//i, "")
        .trim();
      if (!model) continue;

      const ts = toMs(row.started_at);
      if (!ts) continue;

      const sessionId = str(row.session_id) ?? (row.id !== undefined ? `zcode-${String(row.id)}` : "");
      if (!sessionId) continue;

      const rawInput = num(row.input_tokens);
      const cacheRead = num(row.cache_read_input_tokens);
      const cacheWrite = num(row.cache_creation_input_tokens);
      const split = splitCache(rawInput, cacheRead, cacheWrite);
      const output = num(row.output_tokens);
      const reasoning = num(row.reasoning_tokens);
      if (split.input + split.cached + split.cacheWrite + output <= 0) continue;

      out.push({
        sessionId,
        ts,
        model,
        provider: str(row.provider_id),
        projectPath: str(row.directory),
        usage: {
          input: split.input,
          cached: split.cached,
          cacheWrite: split.cacheWrite,
          output: Math.max(output, 0),
          reasoning: Math.max(reasoning, 0),
        },
        key: row.id !== undefined ? String(row.id) : `${sessionId}:${ts}:${model}`,
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
}

function clampPct(value: number): number {
  const pct = value > 0 && value < 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, pct));
}

function quotaPct(o: Record<string, unknown>): number | undefined {
  const direct = numberField(o, [
    "percentage",
    "percent",
    "pct",
    "usagePercent",
    "usedPercent",
    "usage_percentage",
    "used_percentage",
    "utilization",
  ]);
  if (direct !== undefined) return clampPct(direct);

  const used = numberField(o, ["used", "usedTokens", "used_tokens", "consumed", "usage"]);
  const limit = numberField(o, ["limit", "total", "quota", "max", "limitTokens"]);
  if (used !== undefined && limit !== undefined && limit > 0) {
    return clampPct((used / limit) * 100);
  }
  const remaining = numberField(o, ["remaining"]);
  if (remaining !== undefined && limit !== undefined && limit > 0) {
    return clampPct(((limit - remaining) / limit) * 100);
  }
  return undefined;
}

function quotaReset(o: Record<string, unknown>): number {
  return (
    toMs(o.nextResetTime) ??
    toMs(o.next_reset_time) ??
    toMs(o.resetTime) ??
    toMs(o.reset_time) ??
    toMs(o.resetAt) ??
    toMs(o.reset_at) ??
    toMs(o.nextResetAt) ??
    toMs(o.expiredAt) ??
    toMs(o.endTime) ??
    0
  );
}

function classifyQuota(o: Record<string, unknown>): "five" | "week" | undefined {
  const text = [o.type, o.name, o.window, o.period, o.scope, o.label]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();
  if (/week|7d|7-day|10080|month|30d|monthly/.test(text)) return "week";
  if (/5h|5-hour|5 hour|five|300|hour|session|short/.test(text)) return "five";

  const minutes = numberField(o, [
    "windowMinutes",
    "window_minutes",
    "durationMinutes",
    "duration_minutes",
    "periodMinutes",
    "minutes",
  ]);
  if (minutes !== undefined) return minutes <= 360 ? "five" : "week";
  return undefined;
}

function collectQuotaEntries(value: unknown, out: Array<Record<string, unknown>>, depth = 0): void {
  if (depth > 6 || out.length >= 50) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isObj(item) && (quotaPct(item) !== undefined || quotaReset(item) > 0)) out.push(item);
      else collectQuotaEntries(item, out, depth + 1);
    }
    return;
  }
  if (!isObj(value)) return;
  for (const child of Object.values(value)) {
    collectQuotaEntries(child, out, depth + 1);
  }
}

function namedQuota(
  data: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> | undefined {
  for (const key of keys) {
    const v = data[key];
    if (isObj(v)) return v;
  }
  return undefined;
}

function parseQuota(body: unknown): ZcodeQuota | null {
  if (!isObj(body)) return null;
  const data = isObj(body.data) ? body.data : body;

  let five = namedQuota(data, [
    "five_hour",
    "fiveHour",
    "five_hour_limit",
    "fiveHourLimit",
    "five_hour_quota",
    "session",
    "session_limit",
  ]);
  let week = namedQuota(data, [
    "weekly",
    "week",
    "weekly_limit",
    "weeklyLimit",
    "seven_day",
    "sevenDay",
    "week_quota",
  ]);

  const entries: Array<Record<string, unknown>> = [];
  collectQuotaEntries(body, entries);
  for (const entry of entries) {
    const kind = classifyQuota(entry);
    if (kind === "five" && !five) five = entry;
    if (kind === "week" && !week) week = entry;
  }
  if (!five && !week && entries.length > 0) {
    // Window labels were absent; assume short window first, long window second.
    five = entries[0];
    week = entries[1];
  }
  if (!five && !week) return null;

  return {
    fiveHourPct: five ? quotaPct(five) ?? 0 : 0,
    fiveHourResetAt: five ? quotaReset(five) : 0,
    weeklyPct: week ? quotaPct(week) ?? 0 : 0,
    weeklyResetAt: week ? quotaReset(week) : 0,
  };
}

/**
 * Read the GLM coding-plan usage windows. Never called from scan(): the
 * dashboard opts in to network access explicitly.
 */
export async function readZcodeQuota(): Promise<ZcodeQuota | null> {
  const key = process.env.ZAI_API_KEY?.trim();
  if (!key) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(QUOTA_URL, {
      method: "GET",
      headers: { Authorization: key, Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return null;
    return parseQuota(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const adapter: Adapter = {
  id: TOOL,
  label: LABEL,
  meta: {
    fidelity: "exact",
    costSource: "computed",
    units: "tokens",
    paths: ["~/.zcode/cli/db/db.sqlite", "~/.zcode/projects/**/*.jsonl", "$ZCODE_HOME"],
  },
  detect: async () => roots().some((root) => existsSync(root)),
  scan: async () => {
    try {
      const raws: RawEvent[] = [];
      for (const root of roots()) {
        if (!existsSync(root)) continue;
        for (const raw of await scanDatabase(root)) {
          raws.push(raw);
          if (raws.length >= MAX_EVENTS) break;
        }
        if (raws.length >= MAX_EVENTS) break;
      }
      if (raws.length === 0) return [];

      raws.sort((a, b) => a.ts - b.ts);
      const seen = new Set<string>();
      const events: UsageEvent[] = [];
      for (const raw of raws) {
        if (events.length >= MAX_EVENTS) break;
        const event = makeEvent(raw);
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        events.push(event);
      }
      return events;
    } catch {
      return [];
    }
  },
};
