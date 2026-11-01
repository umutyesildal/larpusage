import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Adapter, UsageEvent } from "@/lib/types";
import { costOf } from "@/lib/pricing";
import { exists, hashId, num, projectName } from "./kit";

function dbPath(): string {
  const home = homedir();
  return process.env.DEVIN_HOME
    ? join(process.env.DEVIN_HOME, "cli", "sessions.db")
    : join(home, ".local", "share", "devin", "cli", "sessions.db");
}

/** Fusion models name both a primary and a sidekick. Price the primary. */
function primaryModel(raw: string): string {
  const value = raw.toLowerCase();
  if (value.includes("claude-opus")) return "claude-opus-5.5";
  if (value.includes("swe-2")) return "swe-2-high";
  if (value.includes("gpt-6-luna")) return "gpt-6-luna";
  if (value.includes("gpt-6")) return "gpt-6-sol";
  if (value.includes("gpt-5")) return "gpt-5.6-sol";
  return raw;
}

export const adapter: Adapter = {
  id: "devin",
  label: "Devin",
  meta: {
    fidelity: "exact",
    costSource: "computed",
    units: "tokens",
    paths: ["~/.local/share/devin/cli/sessions.db"],
  },
  detect: async () => exists(dbPath()),
  scan: async () => {
    const path = dbPath();
    if (!(await exists(path))) return [];
    const events: UsageEvent[] = [];
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      const rows = db
        .prepare(
          `WITH t AS (
             SELECT
               m.session_id AS session_id,
               COALESCE(
                 json_extract(m.chat_message, '$.metadata.request_id'),
                 json_extract(m.chat_message, '$.message_id')
               ) AS rid,
               MAX(json_extract(m.chat_message, '$.metadata.metrics.input_tokens')) AS inp,
               MAX(json_extract(m.chat_message, '$.metadata.metrics.output_tokens')) AS outp,
               MAX(COALESCE(json_extract(m.chat_message, '$.metadata.metrics.cache_read_tokens'), 0)) AS cr,
               MAX(COALESCE(json_extract(m.chat_message, '$.metadata.metrics.cache_creation_tokens'), 0)) AS cc,
               MIN(m.created_at) AS ts
             FROM message_nodes m
             WHERE json_extract(m.chat_message, '$.metadata.metrics') IS NOT NULL
             GROUP BY m.session_id, rid
           )
           SELECT t.*, s.model AS model, s.working_directory AS cwd
           FROM t LEFT JOIN sessions s ON s.id = t.session_id`,
        )
        .all() as Array<Record<string, unknown>>;

      for (const row of rows) {
        const rawInput = num(row.inp);
        const cached = num(row.cr);
        const cacheWrite = num(row.cc);
        const output = num(row.outp);
        if (rawInput + cached + cacheWrite + output === 0) continue;

        const model = primaryModel(String(row.model ?? "swe-2-high"));
        const ts = num(row.ts) * 1000;
        const sessionId = String(row.session_id ?? "");
        const rid = String(row.rid ?? ts);
        const projectPath = row.cwd ? String(row.cwd) : undefined;
        const cost = costOf({
          model,
          input: rawInput,
          cached,
          cacheWrite,
          output,
        });

        events.push({
          id: hashId("devin", sessionId, rid),
          tool: "devin",
          ts,
          sessionId,
          projectPath,
          projectName: projectName(projectPath),
          provider: "devin",
          model,
          inputTokens: rawInput,
          cachedInputTokens: cached,
          cacheWriteTokens: cacheWrite,
          outputTokens: output,
          costUsd: cost ?? undefined,
          costSource: cost === null ? "unavailable" : "computed",
          fidelity: "exact",
        });
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
