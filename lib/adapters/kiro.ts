import { readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  exists,
  expandHome,
  hashId,
  mapLimit,
  projectName,
  readLines,
  splitCache,
} from "@/lib/adapters/kit";
import { costOf } from "@/lib/pricing";
import type { Adapter, CostSource, UsageEvent } from "@/lib/types";

const TOOL = "kiro" as const;
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
  "extensions",
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
  "outputTokens",
  "output_tokens",
  "completion_tokens",
  "completionTokens",
  "completionTokenCount",
  "outputTokenCount",
  "tokensOut",
  "tokens_out",
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
  "eventTime",
  "time",
  "date",
];

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
  for (const k of ["data", "payload", "response", "message", "metadata", "attributes", "span", "event"]) {
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
    for (const k of [
      "data",
      "payload",
      "response",
      "message",
      "metadata",
      "attributes",
      "modelInfo",
      "model",
      "event",
      "span",
      "result",
    ]) {
      const n = obj(o[k]);
      if (!n) continue;
      const nested = modelIn(n);
      if (nested) return nested;
    }
  }
  return undefined;
}

function strFrom(o: Obj, keys: string[]): string | undefined {
  const queue: Obj[] = [o];
  for (const k of ["data", "payload", "message", "metadata", "event"]) {
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

    const inclusive = pickNum(c, ["tokensIn", "tokens_in"]);
    if (inclusive !== undefined) {
      if (inclusive + out <= 0) continue;
      const s = splitCache(inclusive, cached, cacheWrite);
      return { input: s.input, cached: s.cached, cacheWrite: s.cacheWrite, output: out, reasoning };
    }

    const input = pickNum(c, IN_TOKEN_KEYS);
    if (input === undefined && out <= 0) continue;
    if ((input ?? 0) + out <= 0) continue;

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

function isCumulative(o: Obj): boolean {
  const type = (typeof o.type === "string" ? o.type : typeof o.kind === "string" ? o.kind : "").toLowerCase();
  if (/summary|shutdown|session[_-]?end|total|cumulative|snapshot/.test(type)) return true;
  return o.cumulative === true || o.isCumulative === true || o.is_cumulative === true;
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

async function findJsonl(root: string, maxDepth = 6): Promise<string[]> {
  const found = new Set<string>();
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  let visited = 0;

  while (stack.length > 0 && found.size < 10_000 && visited < 30_000) {
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
        strFrom(o, ["sessionId", "session_id", "conversationId", "conversation_id", "threadId", "thread_id", "chatId"]) ??
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

    // Cumulative snapshots are cumulative: keep only the newest one per file.
    cumulative.sort((a, b) => a.ts - b.ts);
    return [cumulative[cumulative.length - 1]];
  } catch {
    return [];
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function normalized(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isInputColumn(name: string): boolean {
  return ["inputtokens", "inputtokencount", "prompttokens", "prompttokencount", "tokensin"].includes(normalized(name));
}

function isOutputColumn(name: string): boolean {
  return ["outputtokens", "outputtokencount", "completiontokens", "completiontokencount", "tokensout"].includes(
    normalized(name),
  );
}

function isTokenColumn(name: string): boolean {
  const n = normalized(name);
  return (
    isInputColumn(name) ||
    isOutputColumn(name) ||
    [
      "cachereadinputtokens",
      "cachereadtokens",
      "cachereads",
      "cachecreationinputtokens",
      "cachewritetokens",
      "cachewrites",
      "reasoningtokens",
      "reasoningtokencount",
      "totaltokens",
    ].includes(n)
  );
}

function isModelColumn(name: string): boolean {
  return ["model", "modelid", "modelname", "modelkey"].includes(normalized(name));
}

function isTimeColumn(name: string): boolean {
  return [
    "timestamp",
    "ts",
    "createdat",
    "created",
    "updatedat",
    "starttime",
    "startedat",
    "eventtime",
    "time",
    "date",
  ].includes(normalized(name));
}

function isSessionColumn(name: string): boolean {
  return ["sessionid", "conversationid", "threadid", "session", "conversation", "chatid"].includes(normalized(name));
}

function isIdColumn(name: string): boolean {
  return ["id", "requestid", "messageid", "eventid", "turnid", "uuid", "callid"].includes(normalized(name));
}

function isCostColumn(name: string): boolean {
  return ["cost", "costusd", "totalcost", "totalcostusd", "totalnanoaiu", "costnanoaiu", "nanoaiu"].includes(
    normalized(name),
  );
}

function isCwdColumn(name: string): boolean {
  return ["cwd", "projectpath", "workspacepath", "rootpath", "workspace"].includes(normalized(name));
}

async function scanDatabase(path: string): Promise<UsageEvent[]> {
  try {
    const st = await stat(path).catch(() => null);
    const fallbackTs = st?.mtimeMs ?? Date.now();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 2000");
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as unknown as Array<{
        name?: unknown;
      }>;

      let best:
        | {
            table: string;
            columns: string[];
            score: number;
            perRequest: boolean;
          }
        | undefined;

      for (const tableRow of tables) {
        const table = typeof tableRow.name === "string" ? tableRow.name : "";
        if (!table || !/usage|message|conversation|event|request|turn|session|metric|call|chat|transcript/i.test(table)) {
          continue;
        }

        let info: Array<{ name?: unknown }>;
        try {
          info = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as unknown as Array<{ name?: unknown }>;
        } catch {
          continue;
        }
        const names = info.map((c) => (typeof c.name === "string" ? c.name : "")).filter(Boolean);
        if (!names.some(isInputColumn) || !names.some(isOutputColumn)) continue;

        const selected = names.filter(
          (name) =>
            isTokenColumn(name) ||
            isModelColumn(name) ||
            isTimeColumn(name) ||
            isSessionColumn(name) ||
            isIdColumn(name) ||
            isCostColumn(name) ||
            isCwdColumn(name) ||
            /^(type|role|kind|status)$/i.test(name),
        );
        if (selected.length === 0) continue;

        const perRequest = names.some(isTimeColumn) || names.some(isIdColumn) || names.some((n) => /^(type|role|kind)$/i.test(n));
        let score = 0;
        if (names.some(isModelColumn)) score += 4;
        if (names.some(isTimeColumn)) score += 3;
        if (names.some(isSessionColumn)) score += 2;
        if (names.some(isIdColumn)) score += 2;
        if (names.some(isCostColumn)) score += 1;

        if (!best || score > best.score || (score === best.score && perRequest && !best.perRequest)) {
          best = { table, columns: selected, score, perRequest };
        }
      }

      // Unknown schema: return nothing rather than inventing rows.
      if (!best || !best.perRequest) return [];

      let rows: Obj[];
      try {
        rows = db
          .prepare(`SELECT ${best.columns.map(quoteIdent).join(", ")} FROM ${quoteIdent(best.table)} LIMIT 200000`)
          .all() as unknown as Obj[];
      } catch {
        return [];
      }

      const dbSession = basename(path).replace(/\.(sqlite3?|db)$/i, "") || "kiro-cli";
      const out: UsageEvent[] = [];
      rows.forEach((row, i) => {
        const tokens = tokensFrom(row);
        if (!tokens || totalTokens(tokens) <= 0) return;
        const model = modelFrom(row) ?? FALLBACK_MODEL;
        const ts = tsFrom(row, fallbackTs);
        const sessionId =
          strFrom(row, ["sessionId", "session_id", "conversationId", "conversation_id", "threadId", "thread_id", "chatId"]) ??
          (dbSession === "data" ? "kiro-cli" : dbSession);
        const requestId =
          strFrom(row, ["requestId", "request_id", "messageId", "message_id", "eventId", "event_id", "turnId", "id", "uuid"]) ??
          String(i);
        out.push(
          finish({
            id: hashId(TOOL, "db", path, best?.table ?? "", requestId),
            ts,
            sessionId,
            cwd: cwdFrom(row),
            model,
            tokens,
            cost: costFrom(row),
          }),
        );
      });
      return out;
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  } catch {
    // Missing driver, locked database, WAL-only mode, or unknown schema.
    return [];
  }
}

function roots(): string[] {
  const home = process.env.HOME ?? "";
  return [
    join(home, ".kiro", "sessions", "cli"),
    join(home, ".local", "share", "kiro-cli"),
    join(home, "Library", "Application Support", "Kiro"),
  ].map((p) => resolve(expandHome(p)));
}

function dbPaths(): string[] {
  const home = process.env.HOME ?? "";
  return [
    join(home, ".local", "share", "kiro-cli", "data.sqlite3"),
    join(home, "Library", "Application Support", "Kiro", "data.sqlite3"),
    join(home, "Library", "Application Support", "Kiro", "kiro-cli", "data.sqlite3"),
  ].map((p) => resolve(expandHome(p)));
}

export const adapter: Adapter = {
  id: TOOL,
  label: "Kiro",
  meta: {
    fidelity: "exact",
    costSource: "computed",
    units: "tokens",
    paths: [
      "~/.kiro/sessions/cli/**/*.jsonl",
      "~/.local/share/kiro-cli/data.sqlite3",
      "~/Library/Application Support/Kiro/**",
    ],
  },
  detect: async (): Promise<boolean> => {
    try {
      for (const root of roots()) if (await exists(root)) return true;
      for (const db of dbPaths()) if (await exists(db)) return true;
    } catch {
      // ignore
    }
    return false;
  },
  scan: async (): Promise<UsageEvent[]> => {
    try {
      const files = new Set<string>();
      for (const root of roots()) {
        if (!(await exists(root))) continue;
        for (const file of await findJsonl(root)) files.add(file);
      }

      const databases = new Set<string>();
      for (const db of dbPaths()) if (await exists(db)) databases.add(db);

      const sources: Array<{ kind: "jsonl" | "db"; path: string }> = [
        ...[...files].map((path) => ({ kind: "jsonl" as const, path })),
        ...[...databases].map((path) => ({ kind: "db" as const, path })),
      ];
      const lists = await mapLimit(sources, 6, (source) =>
        source.kind === "jsonl" ? scanJsonl(source.path) : scanDatabase(source.path),
      );
      const events = lists.flat();

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
