import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter, UsageEvent } from "@/lib/types";
import { exists, hashId, num, projectName } from "./kit";

function dbPath(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base =
    process.env.OPENCODE_DATA_DIR ||
    (xdg ? join(xdg, "opencode") : join(homedir(), ".local", "share", "opencode"));
  return join(base, "opencode.db");
}

type Json = Record<string, unknown>;

function tokensOf(data: Json) {
  const t = (data.tokens ?? {}) as Json;
  const cache = (t.cache ?? {}) as Json;
  return {
    input: num(t.input),
    output: num(t.output),
    reasoning: num(t.reasoning),
    cached: num(cache.read),
    cacheWrite: num(cache.write),
  };
}

function modelOf(data: Json): { model: string; provider?: string } {
  const m = data.model;
  if (m && typeof m === "object") {
    const obj = m as Json;
    return {
      model: String(obj.id ?? obj.modelID ?? "unknown"),
      provider: obj.providerID ? String(obj.providerID) : undefined,
    };
  }
  return {
    model: String(data.modelID ?? "unknown"),
    provider: data.providerID ? String(data.providerID) : undefined,
  };
}

export const adapter: Adapter = {
  id: "opencode",
  label: "OpenCode",
  meta: {
    fidelity: "exact",
    costSource: "stored",
    units: "tokens",
    paths: ["~/.local/share/opencode/opencode.db"],
  },
  detect: async () => exists(dbPath()),
  scan: async () => {
    const path = dbPath();
    if (!(await exists(path))) return [];
    const events: UsageEvent[] = [];
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const sessions = new Map<string, string | undefined>();
      try {
        const rows = db.prepare("SELECT id, directory FROM session").all() as Json[];
        for (const r of rows) sessions.set(String(r.id), r.directory ? String(r.directory) : undefined);
      } catch {
        /* older schema */
      }
      try {
        const rows = db.prepare("SELECT id, directory FROM session_v2").all() as Json[];
        for (const r of rows) sessions.set(String(r.id), r.directory ? String(r.directory) : undefined);
      } catch {
        /* no v2 */
      }

      const seen = new Set<string>();

      // v1 message table
      try {
        const rows = db
          .prepare("SELECT id, session_id, time_created, data FROM message")
          .all() as Json[];
        for (const r of rows) {
          let data: Json;
          try {
            data = JSON.parse(String(r.data)) as Json;
          } catch {
            continue;
          }
          if (data.role !== "assistant") continue;
          const { model, provider } = modelOf(data);
          if (!model || model === "unknown") continue;
          const t = tokensOf(data);
          if (t.input + t.output + t.cached === 0) continue;
          const sessionId = String(r.session_id);
          const id = hashId("opencode", sessionId, String(r.id));
          if (seen.has(id)) continue;
          seen.add(id);
          const cost = num(data.cost);
          const dir = sessions.get(sessionId);
          events.push({
            id,
            tool: "opencode",
            ts: num(r.time_created),
            sessionId,
            projectPath: dir,
            projectName: projectName(dir),
            provider,
            model,
            inputTokens: t.input,
            cachedInputTokens: t.cached,
            cacheWriteTokens: t.cacheWrite,
            outputTokens: t.output,
            reasoningTokens: t.reasoning,
            costUsd: cost > 0 ? cost : undefined,
            costSource: cost > 0 ? "stored" : "computed",
            fidelity: "exact",
          });
        }
      } catch {
        /* no v1 table */
      }

      // v2 session_message table
      try {
        const rows = db
          .prepare("SELECT id, session_id, time_created, type, data FROM session_message")
          .all() as Json[];
        for (const r of rows) {
          if (String(r.type) !== "assistant") continue;
          let data: Json;
          try {
            data = JSON.parse(String(r.data)) as Json;
          } catch {
            continue;
          }
          const { model, provider } = modelOf(data);
          if (!model || model === "unknown") continue;
          const t = tokensOf(data);
          if (t.input + t.output + t.cached === 0) continue;
          const sessionId = String(r.session_id);
          const id = hashId("opencode", sessionId, String(r.id));
          if (seen.has(id)) continue;
          seen.add(id);
          const cost = num(data.cost);
          const dir = sessions.get(sessionId);
          events.push({
            id,
            tool: "opencode",
            ts: num(r.time_created),
            sessionId,
            projectPath: dir,
            projectName: projectName(dir),
            provider,
            model,
            inputTokens: t.input,
            cachedInputTokens: t.cached,
            cacheWriteTokens: t.cacheWrite,
            outputTokens: t.output,
            reasoningTokens: t.reasoning,
            costUsd: cost > 0 ? cost : undefined,
            costSource: cost > 0 ? "stored" : "computed",
            fidelity: "exact",
          });
        }
      } catch {
        /* no v2 table */
      }

      return events.sort((a, b) => a.ts - b.ts);
    } catch {
      return [];
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
    }
  },
};
