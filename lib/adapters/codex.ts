import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter, UsageEvent } from "@/lib/types";
import { costOf } from "@/lib/pricing";
import {
  exists,
  hashId,
  mapLimit,
  num,
  projectName,
  readLines,
  splitCache,
  walkFiles,
} from "./kit";

type CodexRecord = {
  type?: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
};

export function codexRoots(): string[] {
  const home = homedir();
  const roots = [
    process.env.CODEX_HOME,
    join(home, ".codex"),
  ].filter(Boolean) as string[];
  return roots;
}

async function parseFile(path: string): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  let sessionId = path.split("/").pop()?.replace(/\.jsonl(\.zst)?$/, "") ?? path;
  let projectPath: string | undefined;
  let model = "";
  let isSubagent = false;
  const seen = new Set<string>();
  const fallback: Array<{
    ts: number;
    input: number;
    cached: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
  }> = [];
  let prevCumulative: Record<string, number> | null = null;
  let lastSignature = "";
  let n = 0;

  try {
    for await (const line of readLines(path)) {
      if (n++ > 400_000) break;
      let rec: CodexRecord;
      try {
        rec = JSON.parse(line) as CodexRecord;
      } catch {
        continue;
      }
      const payload = (rec.payload ?? {}) as Record<string, unknown>;

      if (rec.type === "session_meta") {
        sessionId = String(payload.id ?? payload.session_id ?? sessionId);
        projectPath = typeof payload.cwd === "string" ? payload.cwd : projectPath;
        const source = payload.source as Record<string, unknown> | undefined;
        isSubagent = Boolean(
          payload.parent_thread_id ||
            (source && typeof source === "object" && "subagent" in source) ||
            payload.thread_source === "guardian_review",
        );
        continue;
      }

      if (rec.type === "turn_context") {
        if (typeof payload.model === "string" && payload.model) model = payload.model;
        continue;
      }

      if (rec.type === "event_msg" && payload.type === "token_count") {
        const info = (payload.info ?? {}) as Record<string, unknown>;
        const last = (info.last_token_usage ?? info.lastTokenUsage) as
          | Record<string, unknown>
          | undefined;
        const total = (info.total_token_usage ?? info.totalTokenUsage) as
          | Record<string, unknown>
          | undefined;
        const read = (u: Record<string, unknown>) => ({
          input: num(u.input_tokens),
          cached: num(u.cached_input_tokens),
          cacheWrite: num(u.cache_write_input_tokens),
          output: num(u.output_tokens),
          reasoning: num(u.reasoning_output_tokens),
        });
        let usage = last ? read(last) : null;
        if (!usage && total) {
          const cur: Record<string, number> = {
            input: num(total.input_tokens),
            cached: num(total.cached_input_tokens),
            cacheWrite: num(total.cache_write_input_tokens),
            output: num(total.output_tokens),
            reasoning: num(total.reasoning_output_tokens),
          };
          if (prevCumulative) {
            const delta = {
              input: cur.input - prevCumulative.input,
              cached: cur.cached - prevCumulative.cached,
              cacheWrite: cur.cacheWrite - prevCumulative.cacheWrite,
              output: cur.output - prevCumulative.output,
              reasoning: Math.max(0, cur.reasoning - prevCumulative.reasoning),
            };
            if (delta.input >= 0 && delta.output >= 0) usage = delta;
          }
          prevCumulative = cur;
        }
        if (usage && usage.input + usage.output > 0) {
          const sig = `${usage.input}|${usage.cached}|${usage.output}|${usage.reasoning}`;
          if (sig !== lastSignature) {
            lastSignature = sig;
            fallback.push({
              ts: rec.timestamp ? Date.parse(rec.timestamp) : Date.now(),
              ...usage,
            });
          }
        }
        continue;
      }

      if (rec.type === "token_usage_record") {
        const usage = payload.usage as Record<string, unknown> | undefined;
        if (!usage) continue;
        const responseId = String(payload.response_id ?? "");
        const turnId = String(payload.turn_id ?? "");
        const key = responseId || `${sessionId}|${turnId}|${n}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const rawInput = num(usage.input_tokens);
        const cached = num(usage.cached_input_tokens);
        const cacheWrite = num(usage.cache_write_input_tokens);
        const output = num(usage.output_tokens);
        const reasoning = num(usage.reasoning_output_tokens);
        if (rawInput + output === 0) continue;

        const split = splitCache(rawInput, cached, cacheWrite);
        const ts = rec.timestamp ? Date.parse(rec.timestamp) : Date.now();
        const m = model || "gpt-5.6-sol";
        const cost = costOf({
          model: m,
          input: split.input,
          cached: split.cached,
          cacheWrite: split.cacheWrite,
          output,
        });

        events.push({
          id: hashId("codex", sessionId, key),
          tool: "codex",
          ts,
          sessionId,
          projectPath,
          projectName: projectName(projectPath),
          provider: "openai",
          model: m,
          inputTokens: split.input,
          cachedInputTokens: split.cached,
          cacheWriteTokens: split.cacheWrite,
          outputTokens: output,
          reasoningTokens: reasoning,
          costUsd: cost ?? undefined,
          costSource: cost === null ? "unavailable" : "computed",
          fidelity: "exact",
          isSubagent,
        });
      }
    }
  } catch {
    /* fall through to the fallback rows */
  }

  if (events.length === 0 && fallback.length) {
    const m = model || "gpt-5.6-sol";
    fallback.forEach((u, i) => {
      const split = splitCache(u.input, u.cached, u.cacheWrite);
      const cost = costOf({
        model: m,
        input: split.input,
        cached: split.cached,
        cacheWrite: split.cacheWrite,
        output: u.output,
      });
      events.push({
        id: hashId("codex", sessionId, u.ts, i),
        tool: "codex",
        ts: u.ts,
        sessionId,
        projectPath,
        projectName: projectName(projectPath),
        provider: "openai",
        model: m,
        inputTokens: split.input,
        cachedInputTokens: split.cached,
        cacheWriteTokens: split.cacheWrite,
        outputTokens: u.output,
        reasoningTokens: u.reasoning,
        costUsd: cost ?? undefined,
        costSource: cost === null ? "unavailable" : "computed",
        fidelity: "exact",
        isSubagent,
      });
    });
  }

  return events;
}

export const adapter: Adapter = {
  id: "codex",
  label: "Codex",
  meta: {
    fidelity: "exact",
    costSource: "computed",
    units: "tokens",
    paths: ["~/.codex/sessions/**/rollout-*.jsonl[.zst]", "~/.codex/archived_sessions/**"],
  },
  detect: async () => {
    for (const root of codexRoots()) if (await exists(root)) return true;
    return false;
  },
  scan: async () => {
    const files: string[] = [];
    for (const root of codexRoots()) {
      if (!(await exists(root))) continue;
      const found = await walkFiles(root, {
        match: (name) => name.endsWith(".jsonl") || name.endsWith(".jsonl.zst"),
        maxFiles: 4000,
      });
      files.push(...found);
    }
    const unique = Array.from(new Set(files));
    const chunks = await mapLimit(unique, 6, parseFile);
    return chunks.flat().sort((a, b) => a.ts - b.ts);
  },
};
