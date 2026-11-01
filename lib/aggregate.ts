import type {
  DayBucket,
  Fidelity,
  ModelSummary,
  Snapshot,
  SourceStatus,
  ToolSummary,
  UsageEvent,
} from "@/lib/types";

const DAY = 86_400_000;

const LABELS: Record<string, string> = {
  codex: "Codex",
  opencode: "OpenCode",
  claude: "Claude",
  qoder: "Qoder",
  gemini: "Gemini",
  zcode: "ZCode",
  cline: "Cline",
  roo: "Roo",
  kilo: "Kilo",
  kiro: "Kiro",
  amp: "Amp",
  droid: "Droid",
  goose: "Goose",
  openclaw: "OpenClaw",
  crush: "Crush",
  kimi: "Kimi",
  qwen: "Qwen",
  antigravity: "Antigravity",
  grok: "Grok",
  windsurf: "Windsurf",
  devin: "Devin",
  copilot: "Copilot",
  cursor: "Cursor",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  zai: "Z.ai",
  manual: "Custom",
};

export function tokensOf(e: UsageEvent): number {
  return (
    (e.inputTokens ?? 0) +
    (e.cachedInputTokens ?? 0) +
    (e.cacheWriteTokens ?? 0) +
    (e.outputTokens ?? 0)
  );
}

export function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function localMidnight(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function rangeToDays(range: string): number {
  switch (range) {
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "365d":
      return 365;
    default:
      return 0; // all
  }
}

export function buildDays(events: UsageEvent[], days: number): DayBucket[] {
  const byDay = new Map<string, DayBucket>();
  const end = localMidnight(new Date());
  const start = days > 0 ? end - (days - 1) * DAY : 0;

  for (const e of events) {
    if (days > 0 && e.ts < start) continue;
    const key = dayKey(e.ts);
    const cur =
      byDay.get(key) ??
      ({ day: key, tokens: 0, costUsd: 0, requests: 0, credits: 0 } satisfies DayBucket);
    cur.tokens += tokensOf(e);
    cur.costUsd += e.costUsd ?? 0;
    cur.credits += e.credits ?? 0;
    cur.requests += 1;
    byDay.set(key, cur);
  }

  if (days <= 0) {
    return Array.from(byDay.values()).sort((a, b) => a.day.localeCompare(b.day));
  }

  const out: DayBucket[] = [];
  for (let i = 0; i < days; i++) {
    const ts = start + i * DAY;
    const key = dayKey(ts);
    out.push(
      byDay.get(key) ?? { day: key, tokens: 0, costUsd: 0, requests: 0, credits: 0 },
    );
  }
  return out;
}

export function computeStreaks(days: DayBucket[]) {
  const active = new Set(days.filter((d) => d.tokens > 0).map((d) => d.day));
  const sorted = Array.from(active).sort();
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const day of sorted) {
    if (prev) {
      const diff = (Date.parse(day) - Date.parse(prev)) / DAY;
      run = diff === 1 ? run + 1 : 1;
    } else {
      run = 1;
    }
    longest = Math.max(longest, run);
    prev = day;
  }

  // current streak: walk back from today (or yesterday if today has no usage yet)
  let current = 0;
  const cursor = new Date();
  if (!active.has(dayKey(cursor.getTime()))) cursor.setDate(cursor.getDate() - 1);
  while (active.has(dayKey(cursor.getTime()))) {
    current += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return { current, longest, activeDays: active.size };
}

export function computeLongestTask(events: UsageEvent[]): number {
  const bySession = new Map<string, number[]>();
  for (const e of events) {
    const key = `${e.tool}:${e.sessionId}`;
    const arr = bySession.get(key);
    if (arr) arr.push(e.ts);
    else bySession.set(key, [e.ts]);
  }
  let longest = 0;
  const MAX_GAP = 2 * 3_600_000; // a task ends after 2h of silence
  for (const times of bySession.values()) {
    times.sort((a, b) => a - b);
    let start = times[0];
    let prev = times[0];
    for (let i = 1; i < times.length; i++) {
      const t = times[i];
      if (t - prev > MAX_GAP) {
        longest = Math.max(longest, prev - start);
        start = t;
      }
      prev = t;
    }
    longest = Math.max(longest, prev - start);
  }
  return Math.min(longest, 24 * 3_600_000);
}

export function summarizeTools(events: UsageEvent[], sources: SourceStatus[]): ToolSummary[] {
  const map = new Map<
    string,
    { tokens: number; costUsd: number; credits: number; requests: number }
  >();
  for (const e of events) {
    const cur = map.get(e.tool) ?? { tokens: 0, costUsd: 0, credits: 0, requests: 0 };
    cur.tokens += tokensOf(e);
    cur.costUsd += e.costUsd ?? 0;
    cur.credits += e.credits ?? 0;
    cur.requests += 1;
    map.set(e.tool, cur);
  }
  const total = Array.from(map.values()).reduce((s, v) => s + v.tokens, 0) || 1;
  return Array.from(map.entries())
    .map(([tool, v]) => {
      const src = sources.find((s) => s.tool === tool);
      return {
        tool: tool as ToolSummary["tool"],
        label: src?.label ?? LABELS[tool] ?? tool,
        tokens: v.tokens,
        costUsd: v.costUsd,
        credits: v.credits,
        requests: v.requests,
        share: v.tokens / total,
        fidelity: (src?.fidelity ?? "exact") as Fidelity,
      };
    })
    .sort((a, b) => b.tokens - a.tokens);
}

export function summarizeModels(events: UsageEvent[], limit = 8): ModelSummary[] {
  const map = new Map<string, { tokens: number; costUsd: number; requests: number }>();
  for (const e of events) {
    const cur = map.get(e.model) ?? { tokens: 0, costUsd: 0, requests: 0 };
    cur.tokens += tokensOf(e);
    cur.costUsd += e.costUsd ?? 0;
    cur.requests += 1;
    map.set(e.model, cur);
  }
  const total = Array.from(map.values()).reduce((s, v) => s + v.tokens, 0) || 1;
  return Array.from(map.entries())
    .map(([model, v]) => ({ model, ...v, share: v.tokens / total }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, limit);
}

export function buildSnapshot(args: {
  events: UsageEvent[];
  sources: SourceStatus[];
  range: string;
  now?: number;
}): Snapshot {
  const { events, sources, range } = args;
  const days = rangeToDays(range);
  const buckets = buildDays(events, days > 0 ? days : 365);

  const inRange =
    days > 0
      ? events.filter((e) => e.ts >= Date.now() - days * DAY)
      : events;

  const lifetimeTokens = events.reduce((s, e) => s + tokensOf(e), 0);
  const realLifetimeTokens = events.reduce(
    (s, e) => s + (e.isSynthetic ? 0 : tokensOf(e)),
    0,
  );
  const manualLifetimeTokens = events.reduce(
    (s, e) => s + (e.isSynthetic && !e.isBackfill ? tokensOf(e) : 0),
    0,
  );
  const backfillLifetimeTokens = events.reduce(
    (s, e) => s + (e.isBackfill ? tokensOf(e) : 0),
    0,
  );
  const realCostUsd = events.reduce(
    (s, e) => s + (!e.isSynthetic ? e.costUsd ?? 0 : 0),
    0,
  );
  const manualCostUsd = events.reduce(
    (s, e) => s + (e.isSynthetic && !e.isBackfill ? e.costUsd ?? 0 : 0),
    0,
  );
  const backfillCostUsd = events.reduce(
    (s, e) => s + (e.isBackfill ? e.costUsd ?? 0 : 0),
    0,
  );
  const peak = buckets.reduce(
    (best, d) => (d.tokens > best.tokens ? d : best),
    buckets[0] ?? { day: "", tokens: 0, costUsd: 0, requests: 0, credits: 0 },
  );
  const streaks = computeStreaks(buckets);
  const longestTaskMs = computeLongestTask(events);
  const costUsd = events.reduce((s, e) => s + (e.costUsd ?? 0), 0);
  const credits = events.reduce((s, e) => s + (e.credits ?? 0), 0);
  const requests = events.length;
  const larpValue = events.reduce(
    (s, e) => s + (e.costUsd ?? (e.credits ? e.credits * 0.01 : 0)),
    0,
  );

  const firstEventAt = events.length ? Math.min(...events.map((e) => e.ts)) : undefined;
  const lastEventAt = events.length ? Math.max(...events.map((e) => e.ts)) : undefined;

  const toolModelMap = new Map<
    string,
    Map<string, { tokens: number; costUsd: number; requests: number }>
  >();
  for (const e of inRange) {
    let models = toolModelMap.get(e.tool);
    if (!models) {
      models = new Map();
      toolModelMap.set(e.tool, models);
    }
    const cur = models.get(e.model) ?? { tokens: 0, costUsd: 0, requests: 0 };
    cur.tokens += tokensOf(e);
    cur.costUsd += e.costUsd ?? 0;
    cur.requests += 1;
    models.set(e.model, cur);
  }
  const toolModels: Record<string, ModelSummary[]> = {};
  for (const [tool, models] of toolModelMap) {
    const sum = Array.from(models.values()).reduce((s, v) => s + v.tokens, 0) || 1;
    toolModels[tool] = Array.from(models.entries())
      .map(([model, v]) => ({
        model,
        tokens: v.tokens,
        costUsd: v.costUsd,
        requests: v.requests,
        share: v.tokens / sum,
      }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, 8);
  }

  return {
    generatedAt: args.now ?? Date.now(),
    rangeDays: days || 365,
    totals: {
      lifetimeTokens,
      peakTokens: peak.tokens,
      peakDay: peak.day,
      longestTaskMs,
      currentStreak: streaks.current,
      longestStreak: streaks.longest,
      activeDays: streaks.activeDays,
      requests,
      costUsd,
      realCostUsd,
      manualCostUsd,
      backfillCostUsd,
      credits,
      larpValue,
      realLifetimeTokens,
      manualLifetimeTokens,
      backfillLifetimeTokens,
    },
    days: buckets,
    tools: summarizeTools(events, sources),
    models: summarizeModels(inRange),
    toolModels,
    sources,
    firstEventAt,
    lastEventAt,
  };
}
