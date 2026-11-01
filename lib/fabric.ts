import type { ToolId, UsageEvent } from "@/lib/types";
import { splitTokens } from "@/lib/tokens";
import { costOf } from "@/lib/pricing";
import { hashId } from "@/lib/adapters/kit";
import type { ManualEntry } from "@/lib/settings";

const DAY = 86_400_000;

export function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DOW = [0.55, 1.05, 1.1, 1.08, 1.02, 0.92, 0.58];

export function toDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

export function fromDay(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, 12, 0, 0).getTime();
}

function event(args: {
  tool: ToolId;
  model: string;
  ts: number;
  sessionId: string;
  tokens: number;
  credits?: number;
  synthetic: boolean;
  backfill?: boolean;
}): UsageEvent {
  const { input, cached, output } = splitTokens(args.tokens);
  const cost = costOf({ model: args.model, input, cached, output });
  return {
    id: hashId("fabric", args.tool, args.sessionId, args.ts),
    tool: args.tool,
    ts: args.ts,
    sessionId: args.sessionId,
    model: args.model,
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    credits: args.credits,
    creditUnit: args.credits ? "credit" : undefined,
    costUsd: cost ?? (args.credits ? args.credits * 0.01 : undefined),
    costSource: args.credits ? "credits" : cost === null ? "unavailable" : "computed",
    fidelity: "exact",
    isSynthetic: args.synthetic,
    isBackfill: args.backfill,
  };
}

export function manualEvents(entries: ManualEntry[], seed = 1): UsageEvent[] {
  const out: UsageEvent[] = [];
  for (const entry of entries) {
    const start = fromDay(entry.from);
    const end = fromDay(entry.to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    const days = Math.min(730, Math.floor((end - start) / DAY) + 1);
    if (days <= 0) continue;

    const rnd = mulberry32(seed + entry.id.length * 7919);
    const weights: number[] = [];
    for (let i = 0; i < days; i++) {
      const ts = start + i * DAY;
      const dow = new Date(ts).getDay();
      const p = i / Math.max(1, days - 1);
      const shape =
        entry.shape === "ramp" ? 0.6 + 0.8 * p : entry.shape === "frontload" ? 1.4 - 0.8 * p : 1;
      const off = i > 0 && i < days - 1 && rnd() < 0.3;
      weights.push(off ? 0 : DOW[dow] * shape * (0.9 + rnd() * 0.2));
    }
    const sum = weights.reduce((a, b) => a + b, 0) || 1;

    weights.forEach((w, i) => {
      const ts = start + i * DAY;
      const tokens = Math.round((entry.tokens * w) / sum);
      if (tokens <= 0) return;

      // A day of usage is a handful of requests in one sitting, not a single
      // instant. Splitting it gives the profile a real longest-task figure.
      const sessionId = `${entry.id}-${toDay(ts)}`;
      const dayStart = ts - 12 * 3_600_000;
      const chunks = 2 + Math.floor(rnd() * 3);
      const startMinute = 9 * 60 + Math.floor(rnd() * 9 * 60);
      const span = 24 + Math.floor(rnd() * 96);
      const chunkWeights: number[] = [];
      for (let c = 0; c < chunks; c++) chunkWeights.push(0.6 + rnd() * 0.8);
      const chunkSum = chunkWeights.reduce((a, b) => a + b, 0) || 1;

      let emitted = 0;
      chunkWeights.forEach((cw, c) => {
        const chunkTokens =
          c === chunks - 1
            ? tokens - emitted
            : Math.floor((tokens * cw) / chunkSum);
        if (chunkTokens <= 0) return;
        emitted += chunkTokens;
        const minute = startMinute + (span * c) / Math.max(1, chunks - 1);
        out.push(
          event({
            tool: entry.tool as ToolId,
            model: entry.model ?? "glm-5.3",
            ts: dayStart + minute * 60_000,
            sessionId,
            tokens: chunkTokens,
            synthetic: true,
          }),
        );
      });
    });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

const PRESETS = {
  indie: 1_200_000,
  startup: 22_000_000,
  seriesb: 95_000_000,
  lab: 480_000_000,
} as const;

export function syntheticEvents(opts: {
  seed: number;
  intensity: keyof typeof PRESETS;
  days: number;
  baseline?: number;
}): UsageEvent[] {
  const { seed, intensity, days } = opts;
  const rnd = mulberry32(seed);
  const base = opts.baseline ?? PRESETS[intensity];
  const tools: Array<{ id: ToolId; model: string; w: number }> = [
    { id: "codex", model: "gpt-5.6-sol", w: 0.46 },
    { id: "opencode", model: "glm-5.3", w: 0.18 },
    { id: "claude", model: "claude-opus-5.5", w: 0.16 },
    { id: "gemini", model: "gemini-3.5-flash", w: 0.1 },
    { id: "qoder", model: "qwen3.8-max", w: 0.06 },
    { id: "zcode", model: "glm-5.3", w: 0.04 },
  ];

  const out: UsageEvent[] = [];
  const today = new Date();
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();

  const spikeDays = new Set<number>();
  for (let s = 0; s < 6; s++) {
    const idx = 5 + Math.floor(rnd() * Math.max(1, days - 30));
    spikeDays.add(idx);
  }

  for (let i = 0; i < days; i++) {
    const ts = end - (days - 1 - i) * DAY;
    if (i < days - 1 && rnd() < 0.22) continue; // days off
    const dow = new Date(ts).getDay();
    const trend = 1 + 1.6 * Math.pow(i / Math.max(1, days), 2);
    const spike = spikeDays.has(i) ? 4 + rnd() * 6 : 1;
    const dayTokens = base * DOW[dow] * trend * spike * (0.86 + rnd() * 0.28);
    for (const t of tools) {
      const tokens = Math.round(dayTokens * t.w);
      if (tokens <= 0) continue;

      const sessionId = `gen-${t.id}-${toDay(ts)}`;
      const dayStart = ts - 12 * 3_600_000;
      const chunks = 2 + Math.floor(rnd() * 2);
      const startMinute = 8 * 60 + Math.floor(rnd() * 10 * 60);
      const span = 20 + Math.floor(rnd() * 80);
      const chunkWeights: number[] = [];
      for (let c = 0; c < chunks; c++) chunkWeights.push(0.7 + rnd() * 0.6);
      const chunkSum = chunkWeights.reduce((a, b) => a + b, 0) || 1;

      let emitted = 0;
      chunkWeights.forEach((cw, c) => {
        const chunkTokens =
          c === chunks - 1 ? tokens - emitted : Math.floor((tokens * cw) / chunkSum);
        if (chunkTokens <= 0) return;
        emitted += chunkTokens;
        const minute = startMinute + (span * c) / Math.max(1, chunks - 1);
        out.push(
          event({
            tool: t.id,
            model: t.model,
            ts: dayStart + minute * 60_000,
            sessionId,
            tokens: chunkTokens,
            credits: t.id === "qoder" ? Math.round(chunkTokens / 900) : undefined,
            synthetic: true,
            backfill: true,
          }),
        );
      });
    }
  }
  return out;
}

export function mergeRealAndSynthetic(
  real: UsageEvent[],
  synthetic: UsageEvent[],
  opts: { clipToBeforeFirstReal?: boolean } = {},
): UsageEvent[] {
  const realKeys = new Set(real.map((e) => `${e.tool}:${toDay(e.ts)}`));
  const firstReal = real.length ? Math.min(...real.map((e) => e.ts)) : Infinity;
  const seen = new Set<string>();
  const out: UsageEvent[] = [];
  for (const e of real) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  const clip = opts.clipToBeforeFirstReal ?? true;
  for (const e of synthetic) {
    if (clip && e.ts >= firstReal) continue;
    const key = `${e.tool}:${toDay(e.ts)}`;
    if (realKeys.has(key)) continue;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out.sort((a, b) => a.ts - b.ts);
}
