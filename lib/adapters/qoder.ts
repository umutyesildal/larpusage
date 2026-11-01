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

const ROOTS = ["~/.qoder/projects", "~/.qoder-cn/projects"];
const CONCURRENCY = 8;
const MAX_DEPTH = 12;
const CREDIT_USD = 0.01;
const CREDIT_UNIT = "qoder-credit";

const META_PATHS = ["~/.qoder/projects/**/*.jsonl", "~/.qoder-cn/projects/**/*.jsonl"];

type QoderUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  credits?: number;
  original_credits?: number;
  request_id?: string;
  billable?: boolean;
  context_usage_ratio?: number;
};

type QoderRecord = {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
  message?: {
    id?: string;
    model?: string;
    usage?: QoderUsage | null;
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
  record: QoderRecord,
  file: string,
): { key: string; event: UsageEvent } | null {
  if (record.type !== "assistant") return null;
  if (record.isApiErrorMessage === true) return null;

  const usage = record.message?.usage;
  if (!usage || typeof usage !== "object") return null;

  const model = typeof record.message?.model === "string" ? record.message.model.trim() : "";
  if (!model || model === "<synthetic>") return null;

  const ts = Date.parse(record.timestamp ?? "");
  if (!Number.isFinite(ts)) return null;

  const messageId = typeof record.message?.id === "string" ? record.message.id : "";
  const requestId = typeof usage.request_id === "string" ? usage.request_id : "";
  const uuid = typeof record.uuid === "string" ? record.uuid : "";
  if (!requestId && !messageId && !uuid) return null;

  const input = num(usage.input_tokens);
  const cached = num(usage.cache_read_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  const output = num(usage.output_tokens);
  const tokenTotal = input + cached + cacheWrite + output;

  // max(), not sum: the two fields describe the same charge (list vs billed).
  const credits = Math.max(num(usage.credits), num(usage.original_credits));

  if (tokenTotal === 0 && credits === 0) return null;

  const sessionId =
    typeof record.sessionId === "string" && record.sessionId
      ? record.sessionId
      : sessionFallback(file);

  const projectPath =
    typeof record.cwd === "string" && record.cwd.trim() ? record.cwd : undefined;

  let costSource: CostSource;
  let fidelity: Fidelity;
  let costUsd: number | undefined;

  if (credits > 0) {
    costUsd = credits * CREDIT_USD;
    costSource = "credits";
    fidelity = "credits";
  } else {
    const computed = costOf({ model, input, cached, cacheWrite, output });
    costUsd = computed ?? undefined;
    costSource = computed !== null ? "computed" : "unavailable";
    fidelity = computed !== null ? "exact" : "unavailable";
  }

  const dedupeKey = requestId
    ? requestId
    : messageId
      ? `${sessionId}|${messageId}`
      : uuid;

  const event: UsageEvent = {
    id: hashId("qoder", sessionId, requestId || messageId || uuid),
    tool: "qoder",
    ts,
    sessionId,
    projectPath,
    projectName: projectName(projectPath),
    provider: "qoder",
    model,
    // Token fields stay unset when the local logs only carry credits.
    costUsd,
    costSource,
    fidelity,
  };

  if (tokenTotal > 0) {
    event.inputTokens = input;
    event.outputTokens = output;
    if (cached > 0) event.cachedInputTokens = cached;
    if (cacheWrite > 0) event.cacheWriteTokens = cacheWrite;
  }

  if (credits > 0) {
    event.credits = credits;
    event.creditUnit = CREDIT_UNIT;
  }

  if (file.includes("/subagents/") || record.isSidechain === true) event.isSubagent = true;

  return { key: dedupeKey, event };
}

export const adapter: Adapter = {
  id: "qoder",
  label: "Qoder",
  meta: {
    fidelity: "credits",
    costSource: "credits",
    units: "credits",
    paths: META_PATHS,
  },

  detect: async () => {
    try {
      for (const root of ROOTS) {
        if (await exists(expandHome(root))) return true;
      }
      return false;
    } catch {
      return false;
    }
  },

  scan: async () => {
    try {
      const seen = new Map<string, UsageEvent>();
      const files: string[] = [];

      for (const root of ROOTS) {
        const dir = expandHome(root);
        if (!(await exists(dir))) continue;
        files.push(...(await walk(dir)));
      }
      if (files.length === 0) return [];

      files.sort();

      await mapLimit(files, CONCURRENCY, async (file) => {
        try {
          for await (const line of readLines(file)) {
            let record: QoderRecord;
            try {
              record = JSON.parse(line) as QoderRecord;
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
