import { readdir } from "node:fs/promises";
import path from "node:path";

import {
  exists,
  expandHome,
  hashId,
  mapLimit,
  num,
  projectName,
  readLines,
} from "@/lib/adapters/kit";
import { costOf } from "@/lib/pricing";
import type { Adapter, CostSource, Fidelity, UsageEvent } from "@/lib/types";

const ROOT = "~/.claude/projects";
const CONCURRENCY = 8;
const MAX_EVENTS = 300_000;
const MAX_DEPTH = 12;

const META_PATHS = ["~/.claude/projects/**/*.jsonl"];

type ClaudeUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens_details?: { thinking_tokens?: number } | null;
  cache_creation?: {
    ephemeral_1h_input_tokens?: number;
    ephemeral_5m_input_tokens?: number;
  } | null;
};

type ClaudeRecord = {
  type?: string;
  uuid?: string;
  requestId?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  isSidechain?: boolean;
  agentId?: string;
  costUSD?: number;
  message?: {
    id?: string;
    model?: string;
    usage?: ClaudeUsage | null;
    cost?: number;
  } | null;
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
    } else if (
      entry.isFile() &&
      (entry.name.endsWith(".jsonl") || entry.name.endsWith(".jsonl.zst"))
    ) {
      files.push(full);
    }
  }
  return files;
}

function sessionFallback(file: string): string {
  const base = path.basename(file);
  return base.replace(/\.jsonl(\.zst)?$/, "");
}

function toEvent(
  record: ClaudeRecord,
  file: string,
): { key: string; event: UsageEvent } | null {
  if (record.type !== "assistant") return null;

  const usage = record.message?.usage;
  if (!usage || typeof usage !== "object") return null;

  const model = typeof record.message?.model === "string" ? record.message.model.trim() : "";
  if (!model) return null;

  const messageId = typeof record.message?.id === "string" ? record.message.id : "";
  const requestId = typeof record.requestId === "string" ? record.requestId : "";
  const uuid = typeof record.uuid === "string" ? record.uuid : "";
  if (!messageId && !requestId && !uuid) return null;

  const ts = Date.parse(record.timestamp ?? "");
  if (!Number.isFinite(ts)) return null;

  // One API response is written as many JSONL rows (one per content block),
  // all sharing message.id + requestId with identical usage. Keep exactly one.
  const key = messageId || requestId ? `${messageId}|${requestId}` : `uuid:${uuid}`;

  let input = num(usage.input_tokens);
  const cached = num(usage.cache_read_input_tokens);
  const ephemeral1h = num(usage.cache_creation?.ephemeral_1h_input_tokens);
  const ephemeral5m = num(usage.cache_creation?.ephemeral_5m_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens) || ephemeral1h + ephemeral5m;
  const output = num(usage.output_tokens);
  const thinking = num(usage.output_tokens_details?.thinking_tokens);

  // Streaming placeholder: input_tokens of 0/1 with real cache traffic means the
  // prompt portion was not recorded. Do not invent a value.
  if (input < 2 && cached + cacheWrite > 0) input = 0;

  if (input + cached + cacheWrite + output === 0) return null;

  const sessionId =
    typeof record.sessionId === "string" && record.sessionId
      ? record.sessionId
      : sessionFallback(file);

  const projectPath =
    typeof record.cwd === "string" && record.cwd.trim() ? record.cwd : undefined;

  const stored = Math.max(num(record.costUSD), num(record.message?.cost));
  const hasStored = stored > 0;
  const computed = hasStored
    ? null
    : costOf({ model, input, cached, cacheWrite, output });

  const costSource: CostSource = hasStored
    ? "stored"
    : computed !== null
      ? "computed"
      : "unavailable";
  const fidelity: Fidelity = costSource === "unavailable" ? "unavailable" : "exact";

  const event: UsageEvent = {
    id: hashId("claude", sessionId, requestId || messageId || uuid),
    tool: "claude",
    ts,
    sessionId,
    projectPath,
    projectName: projectName(projectPath),
    provider: "anthropic",
    model,
    inputTokens: input,
    outputTokens: output,
    costSource,
    fidelity,
  };

  if (cached > 0) event.cachedInputTokens = cached;
  if (cacheWrite > 0) event.cacheWriteTokens = cacheWrite;
  if (thinking > 0) event.reasoningTokens = Math.min(thinking, output);
  if (costSource !== "unavailable") event.costUsd = hasStored ? stored : (computed as number);
  if (model === "<synthetic>") event.isSynthetic = true;
  if (file.includes("/subagents/") || record.isSidechain === true) event.isSubagent = true;

  return { key, event };
}

export const adapter: Adapter = {
  id: "claude",
  label: "Claude Code",
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

      await mapLimit(files, CONCURRENCY, async (file) => {
        if (seen.size >= MAX_EVENTS) return;
        try {
          for await (const line of readLines(file)) {
            if (seen.size >= MAX_EVENTS) break;
            let record: ClaudeRecord;
            try {
              record = JSON.parse(line) as ClaudeRecord;
            } catch {
              continue;
            }
            if (!record || typeof record !== "object") continue;

            const hit = toEvent(record, file);
            if (!hit) continue;
            if (!seen.has(hit.key)) seen.set(hit.key, hit.event);
          }
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
