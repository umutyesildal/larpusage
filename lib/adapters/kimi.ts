import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import {
  expandHome,
  hashId,
  mapLimit,
  num,
  projectName,
  readJson,
  readLines,
  splitCache,
  walkFiles,
} from "@/lib/adapters/kit";
import { costOf } from "@/lib/pricing";
import type { Adapter, UsageEvent } from "@/lib/types";

const TOOL = "kimi" as const;
const LABEL = "Kimi";
const MAX_EVENTS = 200_000;
const MAX_PER_FILE = 20_000;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_DEPTH = 8;

const SESSION_KEYS = [
  "session_id",
  "sessionId",
  "conversation_id",
  "conversationId",
  "thread_id",
  "threadId",
  "chat_id",
  "chatId",
  "session",
];
const PROJECT_KEYS = [
  "cwd",
  "directory",
  "projectPath",
  "project_path",
  "workspace",
  "workspacePath",
  "workingDirectory",
  "working_directory",
];
const TS_KEYS = [
  "timestamp",
  "ts",
  "time",
  "created_at",
  "createdAt",
  "created",
  "created_timestamp",
  "createdTimestamp",
  "started_at",
  "startedAt",
  "start_time",
  "startTime",
  "event_time",
  "eventTime",
  "date",
];
const CONTAINER_KEYS = [
  "message",
  "response",
  "data",
  "result",
  "event",
  "entry",
  "step",
  "turn",
  "assistant",
  "completion",
  "chunk",
];
const USAGE_KEYS = [
  "usage",
  "tokens",
  "token_counts",
  "tokenCounts",
  "token_usage",
  "tokenUsage",
  "usage_stats",
  "usageStats",
  "usage_metadata",
  "usageMetadata",
  "token_count",
  "tokenCount",
];
const USAGE_KEY_SET = new Set(USAGE_KEYS);
const CHILD_ARRAY_KEYS = [
  "messages",
  "turns",
  "events",
  "entries",
  "steps",
  "items",
  "history",
  "chunks",
  "records",
  "data",
  "parts",
];
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
const ANTHROPIC_CACHE_KEYS = [
  "cache_read_input_tokens",
  "cacheReadInputTokens",
  "cache_read_tokens",
  "cacheReadTokens",
  "cacheRead",
  "cache_read",
  "cache_creation_input_tokens",
  "cacheCreationInputTokens",
  "cache_write_tokens",
  "cacheWriteTokens",
  "cacheWrite",
  "cache_write",
];
const OUTPUT_KEYS = ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"];
const REASONING_KEYS = [
  "reasoning_tokens",
  "reasoningTokens",
  "thinking_tokens",
  "thinkingTokens",
  "thoughts_tokens",
];
const COST_KEYS = ["cost_usd", "costUsd", "costUSD", "total_cost_usd", "totalCostUsd"];

type Usage = {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  costUsd?: number;
};

type RawEvent = {
  sessionId: string;
  ts: number;
  model: string;
  provider?: string;
  projectPath?: string;
  usage: Usage;
  key: string;
  recordKey?: string;
};

type Base = {
  sessionId: string;
  ts: number;
  projectPath?: string;
  fileKey: string;
};

function roots(): string[] {
  return [...new Set(["~/.kimi", "~/.kimi-code"].map(expandHome))];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function firstStr(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = str(o[k]);
    if (v) return v;
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
  const direct =
    modelName(o.model) ??
    modelName(o.model_id) ??
    modelName(o.modelId) ??
    modelName(o.modelID) ??
    modelName(o.model_name) ??
    modelName(o.modelName);
  if (direct) return direct;
  for (const key of ["settings", "config", "metadata", "options", "params"]) {
    const nested = o[key];
    if (!isObj(nested)) continue;
    const m =
      modelName(nested.model) ??
      modelName(nested.model_id) ??
      modelName(nested.modelId) ??
      modelName(nested.model_name);
    if (m) return m;
  }
  return undefined;
}

function providerOf(o: Record<string, unknown>): string | undefined {
  return firstStr(o, ["provider", "provider_id", "providerId", "vendor", "model_provider"]);
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

function firstMs(o: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const ms = toMs(o[k]);
    if (ms !== undefined) return ms;
  }
  return undefined;
}

function numberField(o: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

function detailCached(o: Record<string, unknown>): number {
  const details = o.prompt_tokens_details ?? o.input_tokens_details;
  if (!isObj(details)) return 0;
  return num(details.cached_tokens ?? details.cachedTokens);
}

function usageOf(o: Record<string, unknown>): Usage | null {
  const bareIn = numberField(o, ["input"]);
  const bareOut = numberField(o, ["output"]);
  const exclusiveIn = numberField(o, INPUT_KEYS) ?? (bareOut !== undefined ? bareIn : undefined);
  const inclusiveIn = numberField(o, INCLUSIVE_INPUT_KEYS);
  const output =
    numberField(o, OUTPUT_KEYS) ?? (bareIn !== undefined && bareOut !== undefined ? bareOut : 0);
  const explicitCached = numberField(o, CACHED_KEYS);
  const detailsCached = detailCached(o);
  const cached = explicitCached ?? detailsCached;
  const cacheWrite = numberField(o, CACHE_WRITE_KEYS) ?? 0;
  const hasAnthropicCache = ANTHROPIC_CACHE_KEYS.some((k) => o[k] !== undefined);
  // OpenAI Responses reports input_tokens inclusive of input_tokens_details.cached_tokens;
  // Anthropic-style cache_read_input_tokens is reported outside of input_tokens.
  const inclusiveShape =
    inclusiveIn !== undefined ||
    (exclusiveIn !== undefined && detailsCached > 0 && !hasAnthropicCache);
  const reasoning = numberField(o, REASONING_KEYS) ?? 0;
  const costUsd = numberField(o, COST_KEYS);

  if (exclusiveIn === undefined && inclusiveIn === undefined && output <= 0) return null;

  let input: number;
  let c: number;
  let w: number;
  if (inclusiveShape) {
    const split = splitCache(Math.max(inclusiveIn ?? exclusiveIn ?? 0, 0), cached, cacheWrite);
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
    costUsd,
  };
}

function nestedUsage(o: Record<string, unknown>): Usage | null {
  for (const key of USAGE_KEYS) {
    const v = o[key];
    if (!isObj(v)) continue;
    const usage = usageOf(v);
    if (usage) return usage;
  }
  return null;
}

function containerList(o: Record<string, unknown>): Array<Record<string, unknown>> {
  const list: Array<Record<string, unknown>> = [];
  for (const key of CONTAINER_KEYS) {
    const v = o[key];
    if (isObj(v)) list.push(v);
  }
  list.push(o);
  return list;
}

type Hit = {
  usage: Usage;
  model: string;
  provider?: string;
  key?: string;
  direct: boolean;
};

function extract(o: Record<string, unknown>): Hit | null {
  const containers = containerList(o);
  let model = "";
  for (const c of containers) {
    const m = modelOf(c);
    if (m) {
      model = m;
      break;
    }
  }
  if (!model) return null;

  for (const c of containers) {
    const usage = nestedUsage(c) ?? usageOf(c);
    if (!usage) continue;
    const recordCost = numberField(c, COST_KEYS);
    if (recordCost !== undefined) usage.costUsd = recordCost;
    return {
      usage,
      model,
      provider: providerOf(c) ?? providerOf(o),
      key: firstStr(c, [
        "id",
        "uuid",
        "message_id",
        "messageId",
        "request_id",
        "requestId",
        "response_id",
        "responseId",
      ]),
      direct: c === o,
    };
  }
  return null;
}

function harvest(value: unknown, base: Base, out: RawEvent[], depth = 0): void {
  if (depth > MAX_DEPTH || out.length >= MAX_PER_FILE) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (out.length >= MAX_PER_FILE) return;
      harvest(item, base, out, depth + 1);
    }
    return;
  }
  if (!isObj(value)) return;

  const o = value;
  const ctx: Base = {
    fileKey: base.fileKey,
    sessionId: firstStr(o, SESSION_KEYS) ?? base.sessionId,
    ts: firstMs(o, TS_KEYS) ?? base.ts,
    projectPath: firstStr(o, PROJECT_KEYS) ?? base.projectPath,
  };

  const hit = extract(o);
  const hasChildArray = CHILD_ARRAY_KEYS.some((k) => Array.isArray(o[k]));
  if (hit && !(hit.direct && hasChildArray)) {
    out.push({
      sessionId: ctx.sessionId,
      ts: ctx.ts,
      model: hit.model,
      provider: hit.provider,
      projectPath: ctx.projectPath,
      usage: hit.usage,
      key: hit.key ?? `${base.fileKey}#${out.length}`,
      recordKey: hit.key,
    });
    return;
  }

  for (const [key, child] of Object.entries(o)) {
    if (USAGE_KEY_SET.has(key)) continue;
    if (child && typeof child === "object") harvest(child, ctx, out, depth + 1);
  }
}

function toEvent(raw: RawEvent): UsageEvent {
  const stored = raw.usage.costUsd;
  const computed = costOf({
    model: raw.model,
    input: raw.usage.input,
    cached: raw.usage.cached,
    cacheWrite: raw.usage.cacheWrite,
    output: raw.usage.output,
  });
  const cost = stored ?? computed;
  const event: UsageEvent = {
    id: hashId(TOOL, raw.sessionId, raw.ts, raw.model, raw.key),
    tool: TOOL,
    ts: raw.ts,
    sessionId: raw.sessionId,
    model: raw.model,
    inputTokens: raw.usage.input,
    cachedInputTokens: raw.usage.cached,
    cacheWriteTokens: raw.usage.cacheWrite,
    outputTokens: raw.usage.output,
    costSource:
      stored !== undefined ? "stored" : computed === null ? "unavailable" : "computed",
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

async function scanFile(file: string): Promise<RawEvent[]> {
  const out: RawEvent[] = [];
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) return out;

    const base: Base = {
      sessionId: path.basename(file).replace(/\.(jsonl|json)(\.zst)?$/i, ""),
      ts: info.mtimeMs > 0 ? info.mtimeMs : Date.now(),
      fileKey: file,
    };

    if (/\.json$/i.test(file)) {
      const parsed = await readJson<unknown>(file);
      if (parsed !== null) {
        harvest(parsed, base, out);
        return out;
      }
    }

    let lines = 0;
    for await (const line of readLines(file)) {
      if (out.length >= MAX_PER_FILE || lines++ > 500_000) break;
      const text = line.trim();
      if (!text || (text[0] !== "{" && text[0] !== "[")) continue;
      try {
        harvest(JSON.parse(text), base, out);
      } catch {
        // malformed line: keep scanning
      }
    }
  } catch {
    // unreadable / truncated file: skip it
  }
  return out;
}

export const adapter: Adapter = {
  id: TOOL,
  label: LABEL,
  meta: {
    fidelity: "exact",
    costSource: "computed",
    units: "tokens",
    paths: ["~/.kimi/**/*.jsonl", "~/.kimi-code/**/*.jsonl"],
  },
  detect: async () => roots().some((root) => existsSync(root)),
  scan: async () => {
    try {
      const files: string[] = [];
      for (const root of roots()) {
        if (!existsSync(root)) continue;
        files.push(
          ...(await walkFiles(root, {
            match: (name) => /\.(jsonl|json)(\.zst)?$/i.test(name),
            maxFiles: 20_000,
          })),
        );
      }
      const unique = [...new Set(files)];
      if (unique.length === 0) return [];

      const chunks = await mapLimit(unique, 8, scanFile);
      const raws = chunks.flat().sort((a, b) => a.ts - b.ts);

      const seen = new Set<string>();
      const events: UsageEvent[] = [];
      for (const raw of raws) {
        if (events.length >= MAX_EVENTS) break;
        const event = toEvent(raw);
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
