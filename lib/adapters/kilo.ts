import { readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  exists,
  expandHome,
  hashId,
  mapLimit,
  projectName,
  readJson,
  readLines,
  splitCache,
} from "@/lib/adapters/kit";
import { costOf } from "@/lib/pricing";
import type { Adapter, CostSource, UsageEvent } from "@/lib/types";

const TOOL = "kilo" as const;
const FALLBACK_MODEL = "claude-sonnet-4.6";
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "Cache",
  "cache",
  "CachedData",
  "GPUCache",
  "Code Cache",
  "Service Worker",
]);

type Obj = Record<string, unknown>;
type Tokens = {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
};

const MODEL_KEYS = ["model", "modelId", "model_id", "modelName", "model_name", "modelKey"];
const IN_TOKEN_KEYS = ["inputTokens", "input_tokens", "prompt_tokens", "promptTokens", "promptTokenCount", "inputTokenCount"];
const OUT_TOKEN_KEYS = [
  "tokensOut",
  "tokens_out",
  "outputTokens",
  "output_tokens",
  "completion_tokens",
  "completionTokens",
  "completionTokenCount",
  "outputTokenCount",
];
const CACHE_READ_KEYS = [
  "cacheReads",
  "cache_reads",
  "cacheReadTokens",
  "cache_read_tokens",
  "cache_read_input_tokens",
  "cacheReadInputTokens",
  "cached_tokens",
  "cachedTokens",
  "cachedInputTokens",
  "cacheReadTokenCount",
];
const CACHE_WRITE_KEYS = [
  "cacheWrites",
  "cache_writes",
  "cacheWriteTokens",
  "cache_write_tokens",
  "cache_creation_input_tokens",
  "cacheCreationInputTokens",
  "cacheWriteTokenCount",
];
const REASONING_KEYS = [
  "reasoningTokens",
  "reasoning_tokens",
  "thoughtsTokens",
  "thoughts_tokens",
  "thoughtTokens",
  "reasoningTokenCount",
];
const TIME_KEYS = [
  "ts",
  "timestamp",
  "createdAt",
  "created_at",
  "created",
  "updatedAt",
  "updated_at",
  "startTime",
  "start_time",
  "startedAt",
  "started_at",
  "timeUnixNano",
  "observedTimeUnixNano",
  "startTimeUnixNano",
  "endTimeUnixNano",
  "time",
  "date",
];

function obj(v: unknown): Obj | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined;
}

function maybeNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
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
    if (n >= 1e17) return Math.round(n / 1e6); // nanoseconds
    if (n >= 1e14) return Math.round(n / 1e3); // microseconds
    if (n < 1e11) return Math.round(n * 1000); // seconds
    return Math.round(n);
  }
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

function tsFrom(o: Obj | undefined, fallback: number): number {
  if (!o) return fallback;
  const queue: Obj[] = [o];
  for (const k of ["data", "payload", "response", "message", "metadata", "attributes", "span"]) {
    const n = obj(o[k]);
    if (n) queue.push(n);
  }
  for (const c of queue) {
    for (const k of TIME_KEYS) {
      const t = toMs(c[k]);
      if (t !== undefined) return t;
    }
  }
  return fallback;
}

function modelIn(o: Obj): string | undefined {
  for (const k of MODEL_KEYS) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  for (const k of ["gen_ai.request.model", "gen_ai.response.model"]) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  const mi = obj(o.modelInfo);
  if (mi) {
    for (const k of MODEL_KEYS) {
      const v = mi[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return undefined;
}

function modelFrom(...sources: unknown[]): string | undefined {
  for (const src of sources) {
    const o = obj(src);
    if (!o) continue;
    const direct = modelIn(o);
    if (direct) return direct;
    for (const k of ["data", "payload", "response", "message", "metadata", "attributes", "modelInfo", "model"]) {
      const n = obj(o[k]);
      if (!n) continue;
      const nested = modelIn(n);
      if (nested) return nested;
    }
  }
  return undefined;
}

/** Narrow metadata read: returns only a <model> tag value, never surrounding text. */
function modelFromText(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const m = /<model(?:_name)?>\s*([^<]{1,160}?)\s*<\/model(?:_name)?>/i.exec(text);
  return m ? m[1].trim() : undefined;
}

function arrOf(v: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(v)) return v;
  const o = obj(v);
  if (!o) return [];
  for (const k of keys) {
    const a = o[k];
    if (Array.isArray(a)) return a;
    const inner = obj(a);
    if (inner) {
      for (const k2 of keys) {
        const a2 = inner[k2];
        if (Array.isArray(a2)) return a2;
      }
    }
  }
  return [];
}

function jsonObj(text: string | undefined): Obj | undefined {
  if (!text) return undefined;
  const t = text.trim();
  if (!t.startsWith("{")) return undefined;
  try {
    return obj(JSON.parse(t));
  } catch {
    return undefined;
  }
}

function usageCandidates(o: Obj): Obj[] {
  const out: Obj[] = [o];
  for (const k of ["usage", "tokenUsage", "token_usage", "tokens", "usageMetadata", "metrics", "stats", "tokenCount", "attributes", "metadata", "providerMetadata"]) {
    const c = obj(o[k]);
    if (c) out.push(c);
  }
  for (const k of ["data", "payload", "response", "message", "result", "event", "span"]) {
    const n = obj(o[k]);
    if (!n) continue;
    out.push(n);
    for (const k2 of ["usage", "tokenUsage", "token_usage", "tokens", "usageMetadata", "metrics", "stats", "tokenCount", "metadata", "providerMetadata"]) {
      const c = obj(n[k2]);
      if (c) out.push(c);
    }
  }
  return out;
}

function tokensFrom(o: Obj): Tokens | null {
  for (const c of usageCandidates(o)) {
    const out = pickNum(c, OUT_TOKEN_KEYS) ?? 0;
    const reasoning = pickNum(c, REASONING_KEYS) ?? 0;
    const cached = pickNum(c, CACHE_READ_KEYS) ?? 0;
    const cacheWrite = pickNum(c, CACHE_WRITE_KEYS) ?? 0;

    // Cline / Roo / Kilo task_metadata and api_req_started shape.
    const inclusive = pickNum(c, ["tokensIn", "tokens_in"]);
    if (inclusive !== undefined) {
      if (inclusive + out <= 0) continue;
      const s = splitCache(inclusive, cached, cacheWrite);
      return { input: s.input, cached: s.cached, cacheWrite: s.cacheWrite, output: out, reasoning };
    }

    const input = pickNum(c, IN_TOKEN_KEYS);
    if (input === undefined && out <= 0) continue;
    if ((input ?? 0) + out <= 0) continue;

    // Anthropic usage already reports input_tokens exclusive of cache buckets.
    const anthropic = c["cache_read_input_tokens"] !== undefined || c["cache_creation_input_tokens"] !== undefined;
    if (anthropic) {
      return { input: input ?? 0, cached, cacheWrite, output: out, reasoning };
    }

    const s = splitCache(input ?? 0, cached, cacheWrite);
    return { input: s.input, cached: s.cached, cacheWrite: s.cacheWrite, output: out, reasoning };
  }
  return null;
}

function totalTokens(t: Tokens): number {
  return t.input + t.cached + t.cacheWrite + t.output;
}

function costFrom(o: Obj): number | undefined {
  for (const c of usageCandidates(o)) {
    const usd = pickNum(c, ["costUsd", "cost_usd", "costUSD", "totalCostUsd", "total_cost_usd"]);
    if (usd !== undefined) return usd;
    const nano = pickNum(c, ["totalNanoAiu", "total_nano_aiu", "nanoAiu", "nano_aiu", "costNanoAiu", "cost_nano_aiu"]);
    if (nano !== undefined) return nano / 1e11;
    const plain = pickNum(c, ["cost"]);
    if (plain !== undefined) return plain;
    const co = obj(c.cost);
    if (co) {
      const cu = pickNum(co, ["usd", "amount", "value"]);
      if (cu !== undefined) return cu;
      const cn = pickNum(co, ["nanoAiu", "nano_aiu"]);
      if (cn !== undefined) return cn / 1e11;
    }
  }
  return undefined;
}

function cwdFrom(o: Obj | undefined): string | undefined {
  if (!o) return undefined;
  const queue: Obj[] = [o];
  for (const k of ["metadata", "data", "payload"]) {
    const n = obj(o[k]);
    if (n) queue.push(n);
  }
  for (const c of queue) {
    for (const k of ["cwd", "projectPath", "project_path", "workspacePath", "workspace_path", "rootPath", "root_path"]) {
      const v = c[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    const ws = obj(c.workspace);
    if (ws) {
      for (const k of ["path", "rootPath", "fsPath"]) {
        const v = ws[k];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
    }
  }
  return undefined;
}

function finish(args: {
  id: string;
  ts: number;
  sessionId: string;
  cwd?: string;
  model: string;
  tokens: Tokens;
  cost?: number;
}): UsageEvent {
  let costUsd = args.cost;
  let costSource: CostSource;
  if (costUsd !== undefined && Number.isFinite(costUsd)) {
    costSource = "stored";
  } else {
    const computed = costOf({
      model: args.model,
      input: args.tokens.input,
      cached: args.tokens.cached,
      cacheWrite: args.tokens.cacheWrite,
      output: args.tokens.output,
    });
    if (computed !== null) {
      costUsd = computed;
      costSource = "computed";
    } else {
      costUsd = undefined;
      costSource = "unavailable";
    }
  }

  return {
    id: args.id,
    tool: TOOL,
    ts: args.ts,
    sessionId: args.sessionId,
    projectPath: args.cwd,
    projectName: projectName(args.cwd),
    model: args.model,
    inputTokens: args.tokens.input,
    cachedInputTokens: args.tokens.cached,
    cacheWriteTokens: args.tokens.cacheWrite,
    outputTokens: args.tokens.output,
    reasoningTokens: args.tokens.reasoning > 0 ? args.tokens.reasoning : undefined,
    costUsd,
    costSource,
    fidelity: "exact",
  };
}

type Mark = { ts: number; model: string };

function marksFrom(meta: Obj | undefined): Mark[] {
  const out: Mark[] = [];
  const usage = meta?.model_usage ?? meta?.modelUsage;
  if (Array.isArray(usage)) {
    for (const entry of usage) {
      const o = obj(entry);
      if (!o) continue;
      const model = modelFrom(o);
      if (model) out.push({ ts: tsFrom(o, 0), model });
    }
  }
  const top = modelFrom(meta);
  if (top) out.push({ ts: 0, model: top });
  return out;
}

function modelAt(marks: Mark[], ts: number): string | undefined {
  let best: Mark | undefined;
  for (const m of marks) {
    if (m.ts <= ts && (!best || m.ts >= best.ts)) best = m;
  }
  return best?.model ?? marks[0]?.model;
}

function historyEvents(
  raw: unknown,
  sessionId: string,
  cwd: string | undefined,
  fallbackTs: number,
  marks: Mark[],
): UsageEvent[] {
  const entries = arrOf(raw, "messages", "history", "apiConversationHistory", "conversation", "items");
  const out: UsageEvent[] = [];
  entries.forEach((v, i) => {
    const o = obj(v);
    if (!o) return;
    const role = (typeof o.role === "string" ? o.role : typeof o.type === "string" ? o.type : "").toLowerCase();
    if (role === "user" || role === "human" || role === "system") return;
    const tokens = tokensFrom(o);
    if (!tokens || totalTokens(tokens) <= 0) return;
    const ts = tsFrom(o, fallbackTs);
    const model =
      modelFrom(o) ??
      modelFromText(o.content) ??
      modelFromText(o.text) ??
      modelAt(marks, ts) ??
      FALLBACK_MODEL;
    out.push(
      finish({
        id: hashId(TOOL, sessionId, "history", i),
        ts,
        sessionId,
        cwd,
        model,
        tokens,
        cost: costFrom(o),
      }),
    );
  });
  return out;
}

function uiEvents(
  raw: unknown,
  sessionId: string,
  cwd: string | undefined,
  fallbackTs: number,
  marks: Mark[],
): UsageEvent[] {
  const entries = arrOf(raw, "messages", "uiMessages", "items");
  const started: UsageEvent[] = [];
  const finished: UsageEvent[] = [];

  entries.forEach((v, i) => {
    const o = obj(v);
    if (!o) return;
    const say = typeof o.say === "string" ? o.say : typeof o.type === "string" ? o.type : "";
    if (say !== "api_req_started" && say !== "api_req_finished") return;

    const text = typeof o.text === "string" ? o.text : undefined;
    const parsed = jsonObj(text);
    const tokens = (parsed ? tokensFrom(parsed) : null) ?? tokensFrom(o);
    if (!tokens || totalTokens(tokens) <= 0) return;

    const ts = tsFrom(o, fallbackTs);
    const model =
      modelFrom(parsed, o) ??
      modelFromText(text) ??
      modelAt(marks, ts) ??
      FALLBACK_MODEL;
    const cost = (parsed ? costFrom(parsed) : undefined) ?? costFrom(o);
    const event = finish({
      id: hashId(TOOL, sessionId, "ui", say, i),
      ts,
      sessionId,
      cwd,
      model,
      tokens,
      cost,
    });
    if (say === "api_req_started") started.push(event);
    else finished.push(event);
  });

  return started.length > 0 ? started : finished;
}

function metaEvents(
  meta: Obj | undefined,
  sessionId: string,
  cwd: string | undefined,
  fallbackTs: number,
  marks: Mark[],
): UsageEvent[] {
  const usage = meta?.model_usage ?? meta?.modelUsage;
  if (!Array.isArray(usage)) return [];
  const out: UsageEvent[] = [];
  usage.forEach((v, i) => {
    const o = obj(v);
    if (!o) return;
    const tokens = tokensFrom(o);
    if (!tokens || totalTokens(tokens) <= 0) return;
    const ts = tsFrom(o, fallbackTs);
    const model = modelFrom(o) ?? modelAt(marks, ts) ?? FALLBACK_MODEL;
    out.push(
      finish({
        id: hashId(TOOL, sessionId, "meta", i),
        ts,
        sessionId,
        cwd,
        model,
        tokens,
        cost: costFrom(o),
      }),
    );
  });
  return out;
}

function strFrom(o: Obj, keys: string[]): string | undefined {
  const queue: Obj[] = [o];
  for (const k of ["data", "payload", "message", "metadata"]) {
    const n = obj(o[k]);
    if (n) queue.push(n);
  }
  for (const c of queue) {
    for (const k of keys) {
      const v = c[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return undefined;
}

function isCumulative(o: Obj): boolean {
  const type = (typeof o.type === "string" ? o.type : typeof o.kind === "string" ? o.kind : "").toLowerCase();
  if (/summary|shutdown|session[_-]?end|total|cumulative|snapshot/.test(type)) return true;
  return o.cumulative === true || o.isCumulative === true || o.is_cumulative === true;
}

async function findJsonl(root: string, maxDepth = 5): Promise<string[]> {
  const found = new Set<string>();
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let visited = 0;

  while (stack.length > 0 && found.size < 5_000 && visited < 20_000) {
    const current = stack.pop();
    if (!current) break;
    visited++;

    let entries;
    try {
      entries = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (current.depth < maxDepth && !SKIP_DIRS.has(entry.name)) {
          stack.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 });
        }
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        found.add(join(current.dir, entry.name));
      }
    }
  }

  return [...found];
}

async function scanJsonl(file: string): Promise<UsageEvent[]> {
  try {
    const st = await stat(file).catch(() => null);
    const fallbackTs = st?.mtimeMs ?? Date.now();
    const fileSession = basename(file).replace(/\.jsonl$/i, "") || hashId(TOOL, file);
    const perRequest: UsageEvent[] = [];
    const cumulative: UsageEvent[] = [];
    let index = 0;

    for await (const line of readLines(file)) {
      index++;
      if (!line.trim().startsWith("{")) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const o = obj(parsed);
      if (!o) continue;

      const tokens = tokensFrom(o);
      if (!tokens || totalTokens(tokens) <= 0) continue;

      const ts = tsFrom(o, fallbackTs);
      const model = modelFrom(o) ?? FALLBACK_MODEL;
      const sessionId =
        strFrom(o, ["sessionId", "session_id", "conversationId", "conversation_id", "threadId", "thread_id"]) ??
        fileSession;
      const event = finish({
        id: hashId(TOOL, file, index),
        ts,
        sessionId,
        cwd: cwdFrom(o),
        model,
        tokens,
        cost: costFrom(o),
      });

      if (isCumulative(o)) cumulative.push(event);
      else perRequest.push(event);
    }

    if (perRequest.length > 0) return perRequest;
    if (cumulative.length === 0) return [];

    // A cumulative snapshot must never be added on top of other snapshots.
    cumulative.sort((a, b) => a.ts - b.ts);
    return [cumulative[cumulative.length - 1]];
  } catch {
    return [];
  }
}

async function findSessionDirs(root: string): Promise<string[]> {
  const found = new Set<string>();
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let visited = 0;

  while (stack.length > 0 && found.size < 20_000 && visited < 50_000) {
    const current = stack.pop();
    if (!current) break;
    visited++;

    let entries;
    try {
      entries = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    const subdirs: string[] = [];
    let isTask = false;
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (current.depth < 4 && !SKIP_DIRS.has(entry.name)) {
          subdirs.push(join(current.dir, entry.name));
        }
      } else if (
        entry.isFile() &&
        (entry.name === "ui_messages.json" ||
          entry.name === "api_conversation_history.json" ||
          entry.name === "task_metadata.json")
      ) {
        isTask = true;
      }
    }

    if (isTask) {
      found.add(current.dir);
      continue;
    }
    for (const dir of subdirs.reverse()) stack.push({ dir, depth: current.depth + 1 });
  }

  return [...found];
}

async function scanTask(dir: string): Promise<UsageEvent[]> {
  try {
    const [meta, history, ui, st] = await Promise.all([
      readJson<unknown>(join(dir, "task_metadata.json")),
      readJson<unknown>(join(dir, "api_conversation_history.json")),
      readJson<unknown>(join(dir, "ui_messages.json")),
      stat(dir).catch(() => null),
    ]);

    const metaObj = obj(meta);
    const sessionId = basename(dir) || hashId(TOOL, dir);
    const cwd = cwdFrom(metaObj) ?? cwdFrom(obj(history));
    const fallbackTs = st?.mtimeMs ?? Date.now();
    const marks = marksFrom(metaObj);

    // Pick exactly one source per task so the same request is never counted twice.
    const fromHistory = historyEvents(history, sessionId, cwd, fallbackTs, marks);
    const fromUi = uiEvents(ui, sessionId, cwd, fallbackTs, marks);
    const fromMeta = metaEvents(metaObj, sessionId, cwd, fallbackTs, marks);

    let best = fromHistory;
    if (fromUi.length > best.length) best = fromUi;
    if (fromMeta.length > best.length) best = fromMeta;
    return best;
  } catch {
    return [];
  }
}

function roots(): string[] {
  const home = process.env.HOME ?? "";
  const candidates = [
    process.env.KILO_DATA_DIR,
    join(home, ".config", "kilo"),
    join(home, "Library", "Application Support", "Code", "User", "globalStorage", "kilocode.kilo-code"),
    join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "kilocode.kilo-code"),
    join(home, "Library", "Application Support", "Windsurf", "User", "globalStorage", "kilocode.kilo-code"),
  ];
  const out = new Set<string>();
  for (const candidate of candidates) {
    if (candidate) out.add(resolve(expandHome(candidate)));
  }
  return [...out];
}

export const adapter: Adapter = {
  id: TOOL,
  label: "Kilo Code",
  meta: {
    fidelity: "exact",
    costSource: "computed",
    units: "tokens",
    paths: [
      "~/.config/kilo/tasks/**",
      "~/.config/kilo/**/*.jsonl",
      "~/Library/Application Support/Code/User/globalStorage/kilocode.kilo-code/tasks/**",
      "~/Library/Application Support/Cursor/User/globalStorage/kilocode.kilo-code/tasks/**",
      "~/Library/Application Support/Windsurf/User/globalStorage/kilocode.kilo-code/tasks/**",
      "$KILO_DATA_DIR/tasks/**",
    ],
  },
  detect: async (): Promise<boolean> => {
    try {
      for (const root of roots()) if (await exists(root)) return true;
    } catch {
      // ignore
    }
    return false;
  },
  scan: async (): Promise<UsageEvent[]> => {
    try {
      const dirs = new Set<string>();
      const jsonlFiles = new Set<string>();
      for (const root of roots()) {
        if (!(await exists(root))) continue;
        for (const dir of await findSessionDirs(root)) dirs.add(dir);
        for (const file of await findJsonl(root)) jsonlFiles.add(file);
      }

      const [taskLists, jsonlLists] = await Promise.all([
        mapLimit([...dirs], 6, scanTask),
        mapLimit([...jsonlFiles], 6, scanJsonl),
      ]);
      const events = [...taskLists.flat(), ...jsonlLists.flat()];

      const seenIds = new Set<string>();
      const seenSignatures = new Set<string>();
      return events
        .filter((event) => {
          if (seenIds.has(event.id)) return false;
          seenIds.add(event.id);
          const signature = hashId(
            TOOL,
            event.sessionId,
            event.ts,
            event.model,
            event.inputTokens,
            event.cachedInputTokens,
            event.cacheWriteTokens,
            event.outputTokens,
          );
          if (seenSignatures.has(signature)) return false;
          seenSignatures.add(signature);
          return true;
        })
        .sort((a, b) => a.ts - b.ts);
    } catch {
      return [];
    }
  },
};
