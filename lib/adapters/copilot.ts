import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

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

const TOOL = "copilot" as const;
const NANO_AIU = 1e11;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "Cache",
  "cache",
  "CachedData",
  "GPUCache",
  "Code Cache",
  "skills",
]);

type Obj = Record<string, unknown>;
type Tokens = {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
};
type Fidelity = "exact" | "estimated";

const MODEL_KEYS = ["model", "modelId", "model_id", "modelName", "model_name", "modelKey"];
const IN_TOKEN_KEYS = [
  "inputTokens",
  "input_tokens",
  "prompt_tokens",
  "promptTokens",
  "promptTokenCount",
  "inputTokenCount",
  "gen_ai.usage.input_tokens",
];
const OUT_TOKEN_KEYS = [
  "outputTokens",
  "output_tokens",
  "completion_tokens",
  "completionTokens",
  "completionTokenCount",
  "outputTokenCount",
  "gen_ai.usage.output_tokens",
];
const CACHE_READ_KEYS = [
  "cacheReadTokens",
  "cache_read_tokens",
  "cache_read_input_tokens",
  "cacheReadInputTokens",
  "cached_tokens",
  "cachedTokens",
  "cachedInputTokens",
  "cacheReads",
  "cache_reads",
  "gen_ai.usage.cache_read.input_tokens",
];
const CACHE_WRITE_KEYS = [
  "cacheWriteTokens",
  "cache_write_tokens",
  "cache_creation_input_tokens",
  "cacheCreationInputTokens",
  "cacheWrites",
  "cache_writes",
  "gen_ai.usage.cache_creation.input_tokens",
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

/** OTLP encodes attributes as [{key, value:{stringValue|intValue}}]; flatten that shape. */
function attrsOf(v: unknown): Obj | undefined {
  const direct = obj(v);
  if (direct) return direct;
  if (!Array.isArray(v)) return undefined;

  const out: Obj = {};
  for (const item of v) {
    const a = obj(item);
    if (!a || typeof a.key !== "string") continue;
    const value = obj(a.value);
    if (value) {
      for (const k of ["stringValue", "intValue", "doubleValue", "boolValue"]) {
        const raw = value[k];
        if (raw !== undefined) {
          out[a.key] = raw;
          break;
        }
      }
    } else if (a.value !== undefined) {
      out[a.key] = a.value;
    }
  }
  return out;
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
  for (const k of ["data", "payload", "response", "message", "metadata", "attributes", "span", "event", "record"]) {
    const n = attrsOf(o[k]);
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
      "record",
    ]) {
      const n = attrsOf(o[k]);
      if (!n) continue;
      const nested = modelIn(n);
      if (nested) return nested;
    }
  }
  return undefined;
}

function strFrom(o: Obj, keys: string[]): string | undefined {
  const queue: Obj[] = [o];
  for (const k of ["data", "payload", "message", "metadata", "attributes", "event", "record"]) {
    const n = attrsOf(o[k]);
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

const SESSION_KEYS = [
  "sessionId",
  "session_id",
  "conversationId",
  "conversation_id",
  "threadId",
  "thread_id",
  "chatId",
  "session.id",
  "gen_ai.conversation.id",
  "conversation.id",
];
const REQUEST_KEYS = [
  "apiCallId",
  "api_call_id",
  "serviceRequestId",
  "service_request_id",
  "requestId",
  "request_id",
  "callId",
  "call_id",
  "traceId",
  "trace_id",
  "spanId",
  "span_id",
];

function usageCandidates(o: Obj): Obj[] {
  const out: Obj[] = [o];
  for (const k of [
    "usage",
    "tokenUsage",
    "token_usage",
    "tokens",
    "usageMetadata",
    "metrics",
    "stats",
    "tokenCount",
    "attributes",
    "metadata",
    "providerMetadata",
    "requests",
  ]) {
    const c = attrsOf(o[k]);
    if (c) out.push(c);
  }
  for (const k of ["data", "payload", "response", "message", "result", "event", "span", "record"]) {
    const n = attrsOf(o[k]);
    if (!n) continue;
    out.push(n);
    for (const k2 of [
      "usage",
      "tokenUsage",
      "token_usage",
      "tokens",
      "usageMetadata",
      "metrics",
      "stats",
      "tokenCount",
      "metadata",
      "providerMetadata",
      "requests",
    ]) {
      const c = attrsOf(n[k2]);
      if (c) out.push(c);
    }
  }
  return out;
}

/**
 * Copilot reports inputTokens INCLUSIVE of cache reads/writes. Normalize to
 * exclusive buckets so input + cached + cacheWrite + output is the total.
 */
function tokensFrom(o: Obj): Tokens | null {
  for (const c of usageCandidates(o)) {
    const out = pickNum(c, OUT_TOKEN_KEYS) ?? 0;
    const reasoning = pickNum(c, REASONING_KEYS) ?? 0;
    const cached = pickNum(c, CACHE_READ_KEYS) ?? 0;
    const cacheWrite = pickNum(c, CACHE_WRITE_KEYS) ?? 0;
    const inclusive = pickNum(c, ["tokensIn", "tokens_in"]);
    const input = inclusive ?? pickNum(c, IN_TOKEN_KEYS);

    if (input === undefined && out <= 0) continue;
    if ((input ?? 0) + out <= 0) continue;

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

    // A plain numeric `cost` from Copilot is USD and wins over derived AIU.
    const plain = pickNum(c, ["cost"]);
    if (plain !== undefined) return plain;

    const nano = pickNum(c, [
      "totalNanoAiu",
      "total_nano_aiu",
      "nanoAiu",
      "nano_aiu",
      "costNanoAiu",
      "cost_nano_aiu",
    ]);
    if (nano !== undefined) return nano / NANO_AIU;

    const co = obj(c.cost);
    if (co) {
      const cu = pickNum(co, ["usd", "USD", "amount", "value"]);
      if (cu !== undefined) return cu;
      const cn = pickNum(co, ["nanoAiu", "nano_aiu"]);
      if (cn !== undefined) return cn / NANO_AIU;
    }
  }
  return undefined;
}

function cwdFrom(o: Obj | undefined): string | undefined {
  if (!o) return undefined;
  const queue: Obj[] = [o];
  for (const k of ["metadata", "data", "payload", "attributes"]) {
    const n = attrsOf(o[k]);
    if (n) queue.push(n);
  }
  for (const c of queue) {
    for (const k of [
      "cwd",
      "projectPath",
      "project_path",
      "workspacePath",
      "workspace_path",
      "rootPath",
      "root_path",
      "process.cwd",
    ]) {
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

function eventType(o: Obj): string {
  const queue: Obj[] = [o];
  for (const k of ["data", "payload", "event", "record", "attributes"]) {
    const n = attrsOf(o[k]);
    if (n) queue.push(n);
  }
  for (const c of queue) {
    for (const k of ["type", "eventType", "event_type", "kind", "name", "event"]) {
      const v = c[k];
      if (typeof v === "string" && v.trim()) return v.trim().toLowerCase();
    }
  }
  return "";
}

function finish(args: {
  id: string;
  ts: number;
  sessionId: string;
  cwd?: string;
  model: string;
  tokens: Tokens;
  cost?: number;
  fidelity: Fidelity;
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
    fidelity: args.fidelity,
  };
}

type Shutdown = { session: string; ts: number; metrics: unknown };

type Source = { kind: "events" | "otel"; path: string; session: string };
type ScanResult = { events: UsageEvent[]; shutdowns: Shutdown[] };

function eventFromRecord(
  o: Obj,
  args: {
    session: string;
    ts: number;
    idSeed: string;
    fidelity: Fidelity;
  },
): UsageEvent | undefined {
  const tokens = tokensFrom(o);
  if (!tokens || totalTokens(tokens) <= 0) return undefined;
  const model = modelFrom(o);
  if (!model) return undefined;

  const ts = tsFrom(o, args.ts);
  const sessionId = strFrom(o, SESSION_KEYS) ?? args.session;
  const requestId = strFrom(o, REQUEST_KEYS);
  const id = requestId
    ? hashId(TOOL, "request", requestId)
    : hashId(
        TOOL,
        args.idSeed,
        sessionId,
        ts,
        model,
        tokens.input,
        tokens.cached,
        tokens.cacheWrite,
        tokens.output,
      );

  return finish({
    id,
    ts,
    sessionId,
    cwd: cwdFrom(o),
    model,
    tokens,
    cost: costFrom(o),
    fidelity: args.fidelity,
  });
}

async function scanSource(source: Source): Promise<ScanResult> {
  try {
    const st = await stat(source.path).catch(() => null);
    const fallbackTs = st?.mtimeMs ?? Date.now();
    const events: UsageEvent[] = [];
    const shutdowns: Shutdown[] = [];
    let index = 0;

    for await (const line of readLines(source.path)) {
      index++;
      if (!line.trim().startsWith("{")) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const record = obj(parsed);
      if (!record) continue;

      if (source.kind === "events") {
        const type = eventType(record);
        if (type === "assistant.usage" || type === "assistant_usage" || type === "assistant-usage") {
          const event = eventFromRecord(record, {
            session: source.session,
            ts: fallbackTs,
            idSeed: `${source.path}:${index}`,
            fidelity: "exact",
          });
          if (event) events.push(event);
          continue;
        }

        const metrics =
          record.modelMetrics ??
          record.model_metrics ??
          obj(record.data)?.modelMetrics ??
          obj(record.data)?.model_metrics ??
          obj(record.payload)?.modelMetrics ??
          obj(record.payload)?.model_metrics;

        if (type.includes("shutdown") || metrics !== undefined) {
          shutdowns.push({
            session: strFrom(record, SESSION_KEYS) ?? source.session,
            ts: tsFrom(record, fallbackTs),
            metrics,
          });
        }
        continue;
      }

      // OTEL: a line may be one span/log record or an OTLP resource envelope.
      for (const candidate of otelRecords(record)) {
        const event = eventFromRecord(candidate, {
          session: source.session,
          ts: fallbackTs,
          idSeed: `${source.path}:${index}`,
          fidelity: "exact",
        });
        if (event) events.push(event);
      }
    }

    return { events, shutdowns };
  } catch {
    return { events: [], shutdowns: [] };
  }
}

function otelRecords(o: Obj): Obj[] {
  const out: Obj[] = [];

  if (Array.isArray(o.spans)) {
    for (const span of o.spans) {
      const s = obj(span);
      if (s) out.push(s);
    }
  }

  if (Array.isArray(o.resourceSpans)) {
    for (const resource of o.resourceSpans) {
      const r = obj(resource);
      if (!r) continue;
      const scopes = r.scopeSpans ?? r.instrumentationLibrarySpans;
      if (!Array.isArray(scopes)) continue;
      for (const scope of scopes) {
        const s = obj(scope);
        if (!s || !Array.isArray(s.spans)) continue;
        for (const span of s.spans) {
          const sp = obj(span);
          if (sp) out.push(sp);
        }
      }
    }
  }

  if (Array.isArray(o.resourceLogs)) {
    for (const resource of o.resourceLogs) {
      const r = obj(resource);
      if (!r) continue;
      const scopes = r.scopeLogs ?? r.instrumentationLibraryLogs;
      if (!Array.isArray(scopes)) continue;
      for (const scope of scopes) {
        const s = obj(scope);
        if (!s || !Array.isArray(s.logRecords)) continue;
        for (const record of s.logRecords) {
          const rec = obj(record);
          if (rec) out.push(rec);
        }
      }
    }
  }

  if (out.length === 0) out.push(o);
  return out;
}

function metricEntries(metrics: unknown): Array<{ model?: string; object: Obj }> {
  const out: Array<{ model?: string; object: Obj }> = [];

  if (Array.isArray(metrics)) {
    for (const value of metrics) {
      const o = obj(value);
      if (!o) continue;
      out.push({ model: modelFrom(o), object: o });
    }
    return out;
  }

  const root = obj(metrics);
  if (!root) return out;

  if (tokensFrom(root)) {
    out.push({ model: modelFrom(root), object: root });
    return out;
  }

  for (const [key, value] of Object.entries(root)) {
    const o = obj(value);
    if (!o) continue;
    out.push({ model: modelFrom(o) ?? key, object: o });
  }
  return out;
}

function shutdownEvents(shutdown: Shutdown): UsageEvent[] {
  const out: UsageEvent[] = [];
  for (const entry of metricEntries(shutdown.metrics)) {
    const tokens = tokensFrom(entry.object);
    if (!tokens || totalTokens(tokens) <= 0) continue;
    const model = entry.model ?? modelFrom(entry.object);
    if (!model) continue;
    const ts = tsFrom(entry.object, shutdown.ts);
    out.push(
      finish({
        id: hashId(TOOL, "shutdown", shutdown.session, model),
        ts,
        sessionId: shutdown.session,
        cwd: cwdFrom(entry.object),
        model,
        tokens,
        cost: costFrom(entry.object),
        fidelity: "estimated",
      }),
    );
  }
  return out;
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
      "cachedtokens",
      "cachedinputtokens",
      "cachecreationinputtokens",
      "cachewritetokens",
      "cachewrites",
      "reasoningtokens",
      "reasoningtokencount",
      "totaltokens",
      "totalnanoaiu",
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
  return ["id", "requestid", "messageid", "eventid", "turnid", "uuid", "callid", "traceid", "spanid"].includes(
    normalized(name),
  );
}

function isCostColumn(name: string): boolean {
  return [
    "cost",
    "costusd",
    "totalcost",
    "totalcostusd",
    "totalnanoaiu",
    "costnanoaiu",
    "nanoaiu",
    "reasoningcost",
  ].includes(normalized(name));
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
        if (!table || !/usage|request|message|event|turn|call|metric|session|completion|chat|transcript/i.test(table)) {
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

      // Only trust a table that looks like per-request usage. Unknown schema => [].
      if (!best || !best.perRequest) return [];

      let rows: Obj[];
      try {
        rows = db
          .prepare(`SELECT ${best.columns.map(quoteIdent).join(", ")} FROM ${quoteIdent(best.table)} LIMIT 200000`)
          .all() as unknown as Obj[];
      } catch {
        return [];
      }

      const out: UsageEvent[] = [];
      rows.forEach((row, i) => {
        const tokens = tokensFrom(row);
        if (!tokens || totalTokens(tokens) <= 0) return;
        const model = modelFrom(row);
        if (!model) return;

        const ts = tsFrom(row, fallbackTs);
        const sessionId = strFrom(row, SESSION_KEYS) ?? "copilot-store";
        const requestId =
          strFrom(row, [...REQUEST_KEYS, "messageId", "message_id", "eventId", "event_id", "turnId", "id", "uuid"]) ??
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
            fidelity: "exact",
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
    // Missing driver, locked DB, WAL-only mode, or unknown schema.
    return [];
  }
}

async function findNamed(root: string, name: string, maxDepth = 4): Promise<string[]> {
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
      } else if (entry.isFile() && entry.name === name) {
        found.add(join(current.dir, entry.name));
      }
    }
  }

  return [...found];
}

async function findJsonl(root: string, maxDepth = 3): Promise<string[]> {
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

function roots(): string[] {
  const out = new Set<string>();
  const home = process.env.HOME ?? "";
  out.add(resolve(join(home, ".copilot")));

  const env = process.env.COPILOT_HOME;
  if (env) {
    const base = resolve(expandHome(env));
    out.add(base);
    out.add(resolve(base, ".copilot"));
  }

  return [...out];
}

export const adapter: Adapter = {
  id: TOOL,
  label: "GitHub Copilot CLI",
  meta: {
    fidelity: "exact",
    costSource: "computed",
    units: "tokens",
    paths: [
      "~/.copilot/session-state/*/events.jsonl",
      "~/.copilot/session-store.db",
      "~/.copilot/otel/*.jsonl",
      "$COPILOT_HOME/session-state/*/events.jsonl",
      "$COPILOT_HOME/session-store.db",
      "$COPILOT_HOME/otel/*.jsonl",
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
      const sources: Source[] = [];
      const databases = new Set<string>();

      for (const root of roots()) {
        const stateRoot = join(root, "session-state");
        for (const file of await findNamed(stateRoot, "events.jsonl")) {
          sources.push({ kind: "events", path: file, session: basename(dirname(file)) || "copilot" });
        }
        for (const file of await findJsonl(join(root, "otel"))) {
          sources.push({ kind: "otel", path: file, session: basename(file).replace(/\.jsonl$/i, "") || "otel" });
        }
        const db = join(root, "session-store.db");
        if (await exists(db)) databases.add(db);
      }

      const [results, dbLists] = await Promise.all([
        mapLimit(sources, 6, scanSource),
        Promise.all([...databases].map((db) => scanDatabase(db))),
      ]);

      const exactFromFiles = results.flatMap((result) => result.events);
      const dbEvents = dbLists.flat();
      const dbSessions = new Set(dbEvents.map((event) => event.sessionId));

      // The per-request session store is preferred over event-log rows for the
      // same session; unrelated sessions (e.g. OTEL-only ones) still survive.
      const fileEvents = exactFromFiles.filter((event) => !dbSessions.has(event.sessionId));
      const exactSessions = new Set([...dbSessions, ...fileEvents.map((event) => event.sessionId)]);

      // A shutdown record is a cumulative snapshot: keep only the newest one
      // per session, and only when no per-request rows exist for that session.
      const latestShutdown = new Map<string, Shutdown>();
      for (const shutdown of results.flatMap((result) => result.shutdowns)) {
        const previous = latestShutdown.get(shutdown.session);
        if (!previous || shutdown.ts >= previous.ts) latestShutdown.set(shutdown.session, shutdown);
      }
      const fallback = [...latestShutdown.values()]
        .filter((shutdown) => !exactSessions.has(shutdown.session))
        .flatMap(shutdownEvents);

      const events = [...dbEvents, ...fileEvents, ...fallback];

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
            event.costUsd,
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
