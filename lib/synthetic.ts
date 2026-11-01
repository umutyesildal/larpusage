/**
 * Deterministic synthetic usage generator.
 *
 * The output is a pure function of the options: the same seed, intensity,
 * window and tool filter always produce byte-identical events. `endTs`
 * defaults to `Date.now()` only because the caller wants a window ending
 * "today"; pass it explicitly when reproducibility across midnights matters.
 *
 * Token convention (matches `aggregate.tokensOf`): `inputTokens`,
 * `cachedInputTokens`, `cacheWriteTokens` and `outputTokens` are exclusive
 * buckets and sum to the event's total token count. `reasoningTokens` is a
 * subset of `outputTokens`, never an extra bucket.
 */

import { hashId, splitCache } from "@/lib/adapters/kit";
import { costOf, normalizeModel } from "@/lib/pricing";
import type { ToolId, UsageEvent } from "@/lib/types";

export type Intensity = "indie" | "startup" | "seriesb" | "lab";

/** Tokens per day before weekday/growth/noise modulation. */
const BASELINE: Record<Intensity, number> = {
  indie: 1_200_000,
  startup: 22_000_000,
  seriesb: 95_000_000,
  lab: 480_000_000,
};

/** Sunday-first, matching `Date#getDay()`. */
export const WEEKDAY_FACTOR: readonly number[] = [
  0.55, 1.05, 1.1, 1.08, 1.02, 0.92, 0.58,
];

/** Share of the day's tokens produced by each tool. */
const TOOL_WEIGHT: Partial<Record<ToolId, number>> = {
  codex: 0.46,
  opencode: 0.18,
  claude: 0.16,
  gemini: 0.1,
  qoder: 0.06,
  zcode: 0.04,
};

const TOOL_DEFAULT_MODEL: Record<ToolId, string> = {
  devin: "swe-2-high",
  deepseek: "deepseek-v4-pro",
  mistral: "mistral-large-3",
  zai: "glm-5.3",
  codex: "gpt-5.6-sol",
  opencode: "glm-5.3",
  claude: "claude-sonnet-5.5",
  qoder: "qwen3.8-max",
  gemini: "gemini-3.5-flash",
  zcode: "glm-5.3",
  cline: "claude-sonnet-5.5",
  roo: "claude-sonnet-5.5",
  kilo: "claude-sonnet-5.5",
  kiro: "claude-sonnet-5.5",
  amp: "claude-sonnet-5.5",
  droid: "claude-sonnet-5.5",
  goose: "claude-sonnet-5.5",
  openclaw: "claude-sonnet-5.5",
  crush: "claude-sonnet-5.5",
  kimi: "kimi-k3",
  qwen: "qwen3.8-max",
  antigravity: "gemini-3.5-pro",
  grok: "grok-4.5",
  copilot: "gpt-5.6-terra",
  cursor: "gpt-5.6-sol",
  windsurf: "claude-sonnet-5.5",
  manual: "gpt-5.6-sol",
};

const REASONING_MODEL_RE =
  /^(?:gpt-5|gpt-6|claude-(?:opus|sonnet|fable|mythos)|gemini-3|glm-5|qwen3\.8-(?:max|plus)|kimi-k3|deepseek-v4|grok-4|minimax-m3)/;

export type TokenMix = {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
};

/** Small, fast, fully deterministic PRNG. Returns values in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Default model used by the manual layer when a source omits one. */
export function defaultModelFor(tool: ToolId): string {
  return TOOL_DEFAULT_MODEL[tool];
}

/** Whether a model emits reasoning tokens (always a subset of output). */
export function isReasoningModel(model: string): boolean {
  return REASONING_MODEL_RE.test(normalizeModel(model));
}

/**
 * Split a chunk's total tokens into exclusive buckets.
 *
 * `output` is 4–18% of the prompt input, `cached` is 55–92% of the prompt and
 * `cacheWrite` is 0–6% of it. The prompt itself is then made exclusive by
 * `splitCache`, so the four public buckets sum back to `totalTokens`.
 */
export function splitTokenMix(
  totalTokens: number,
  rnd: () => number,
  reasoningCapable: boolean,
): TokenMix {
  const total = Math.max(0, Math.round(totalTokens));
  if (total === 0) {
    return { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  }

  const outputRatio = 0.04 + rnd() * 0.14;
  const prompt = Math.min(Math.max(Math.round(total / (1 + outputRatio)), 0), total);
  const output = total - prompt;

  const cachedRate = 0.55 + rnd() * 0.37;
  const cacheWriteRate = rnd() * 0.06;
  const parts = splitCache(
    prompt,
    Math.round(prompt * cachedRate),
    Math.round(prompt * cacheWriteRate),
  );

  const reasoning = reasoningCapable
    ? Math.min(output, Math.round(output * (0.08 + rnd() * 0.32)))
    : 0;

  return {
    input: parts.input,
    cached: parts.cached,
    cacheWrite: parts.cacheWrite,
    output,
    reasoning,
  };
}

export function generateSynthetic(opts: {
  seed: number;
  intensity: Intensity;
  /** Number of local days in the window, including today. */
  days: number;
  endTs?: number;
  tools?: ToolId[];
}): UsageEvent[] {
  const days = Number.isFinite(opts.days) ? Math.max(0, Math.floor(opts.days)) : 0;
  if (days === 0) return [];

  const base = BASELINE[opts.intensity] ?? BASELINE.indie;
  // Keep the caller's seed verbatim in ids; mulberry32 does the uint32 coercion.
  const seed = Number.isFinite(opts.seed) ? opts.seed : 0;
  const rnd = mulberry32(seed);

  const endTs =
    opts.endTs !== undefined && Number.isFinite(opts.endTs)
      ? opts.endTs
      : Date.now();
  const end = new Date(endTs);
  const endMidnight = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  const dates: Date[] = [];
  for (let i = 0; i < days; i += 1) {
    const date = new Date(endMidnight);
    date.setDate(endMidnight.getDate() - (days - 1 - i));
    dates.push(date);
  }

  const activeTools = resolveTools(opts.tools);
  const weights = activeTools.map((tool) => TOOL_WEIGHT[tool] ?? 0);

  const spikeDays = pickSpikeDays(dates, rnd);

  const events: UsageEvent[] = [];
  let sessionIndex = 0;

  for (let i = 0; i < days; i += 1) {
    const date = dates[i];
    const noise = 0.86 + rnd() * 0.28;
    const growth = 1 + 0.35 * (i / days);
    const weekday = WEEKDAY_FACTOR[date.getDay()] ?? 1;
    const spike = spikeDays.get(i) ?? 1;
    const dayTokens = Math.max(
      0,
      Math.round(base * weekday * growth * noise * spike),
    );
    if (dayTokens <= 0) continue;

    const toolTotals = allocate(dayTokens, weights);

    // The day is split into 4–14 sessions in total. Every active tool gets at
    // least one slot so the weighted tool split is always represented; the
    // remaining slots follow the token weights.
    const minSessions = Math.min(14, Math.max(4, activeTools.length));
    const sessionCount = minSessions + Math.floor(rnd() * (15 - minSessions));
    const extraSlots = allocate(sessionCount - activeTools.length, weights);

    for (let t = 0; t < activeTools.length; t += 1) {
      const tool = activeTools[t];
      const toolTokens = toolTotals[t];
      if (toolTokens <= 0) continue;

      const slotCount = 1 + (extraSlots[t] ?? 0);
      const plans: Array<{ startMin: number; durationMin: number }> = [];
      for (let s = 0; s < slotCount; s += 1) {
        plans.push({
          // 18 minutes … 4h50m.
          durationMin: 18 + rnd() * (290 - 18),
          // 08:00 … 23:00 local, inclusive.
          startMin: 8 * 60 + Math.floor(rnd() * (15 * 60 + 1)),
        });
      }
      plans.sort(
        (a, b) => a.startMin - b.startMin || a.durationMin - b.durationMin,
      );

      // Longer sessions carry proportionally more tokens.
      const durationWeights = plans.map(
        (plan) => plan.durationMin * (0.85 + rnd() * 0.3),
      );
      const chunks = allocate(toolTokens, durationWeights);

      for (let s = 0; s < plans.length; s += 1) {
        const tokens = chunks[s];
        if (tokens <= 0) continue;

        const ts = new Date(
          date.getFullYear(),
          date.getMonth(),
          date.getDate(),
          0,
          plans[s].startMin,
          0,
          0,
        ).getTime();
        const model = pickModel(tool, rnd);
        const mix = splitTokenMix(tokens, rnd, isReasoningModel(model));
        const total = mix.input + mix.cached + mix.cacheWrite + mix.output;

        const event: UsageEvent = {
          id: hashId("synthetic", seed, tool, sessionIndex, ts),
          tool,
          ts,
          sessionId: hashId("synthetic-session", seed, tool, sessionIndex),
          model,
          inputTokens: mix.input,
          cachedInputTokens: mix.cached,
          cacheWriteTokens: mix.cacheWrite,
          outputTokens: mix.output,
          ...(mix.reasoning > 0 ? { reasoningTokens: mix.reasoning } : {}),
          costSource: tool === "qoder" ? "credits" : "computed",
          fidelity: "exact",
          isSynthetic: true,
        };

        if (tool === "qoder") {
          const credits = total / 900;
          event.credits = credits;
          event.creditUnit = "qoder-credit";
          event.costUsd = credits * 0.01;
        } else {
          const cost = costOf({
            model,
            input: mix.input,
            cached: mix.cached,
            cacheWrite: mix.cacheWrite,
            output: mix.output,
          });
          if (cost !== null) event.costUsd = cost;
        }

        events.push(event);
        sessionIndex += 1;
      }
    }
  }

  return events.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
}

/** Pick 1–2 weekday spike days, never adjacent, as index → multiplier. */
function pickSpikeDays(dates: Date[], rnd: () => number): Map<number, number> {
  const spikes = new Map<number, number>();
  const weekdays: number[] = [];
  for (let i = 0; i < dates.length; i += 1) {
    const day = dates[i].getDay();
    if (day >= 1 && day <= 5) weekdays.push(i);
  }
  if (weekdays.length === 0) return spikes;

  const wanted = weekdays.length >= 2 && rnd() < 0.55 ? 2 : 1;
  const first = weekdays[Math.floor(rnd() * weekdays.length)];
  spikes.set(first, 1.8 + rnd() * 0.8);

  if (wanted === 2) {
    const pool = weekdays.filter((index) => Math.abs(index - first) >= 2);
    if (pool.length > 0) {
      const second = pool[Math.floor(rnd() * pool.length)];
      spikes.set(second, 1.8 + rnd() * 0.8);
    }
  }

  return spikes;
}

/**
 * Only the six weighted tools are synthetic-capable. A filter that matches
 * none of them falls back to codex so callers still get a usable stream.
 */
function resolveTools(requested?: ToolId[]): ToolId[] {
  const known = Object.keys(TOOL_WEIGHT) as ToolId[];
  const filtered =
    requested && requested.length > 0
      ? known.filter((tool) => requested.includes(tool))
      : known;
  const chosen = filtered.length > 0 ? filtered : (["codex"] as ToolId[]);
  return chosen.sort(
    (a, b) => (TOOL_WEIGHT[b] ?? 0) - (TOOL_WEIGHT[a] ?? 0) || a.localeCompare(b),
  );
}

function pickModel(tool: ToolId, rnd: () => number): string {
  switch (tool) {
    case "codex":
      return rnd() < 0.72 ? "gpt-5.6-sol" : "gpt-6-astra";
    case "claude":
      return rnd() < 0.6 ? "claude-opus-5.5" : "claude-sonnet-5.5";
    case "opencode":
      return rnd() < 0.78 ? "glm-5.3" : "qwen3.8-max";
    default:
      return defaultModelFor(tool);
  }
}

/** Largest-remainder integer split; always sums back to `total`. */
function allocate(total: number, weights: readonly number[]): number[] {
  const count = weights.length;
  if (count === 0) return [];

  const safeTotal = Math.max(0, Math.round(total));
  const sum = weights.reduce((acc, weight) => acc + Math.max(0, weight), 0);
  if (safeTotal === 0 || sum <= 0) return weights.map(() => 0);

  const raw = weights.map((weight) => (safeTotal * Math.max(0, weight)) / sum);
  const out = raw.map((value) => Math.floor(value));
  let remainder = safeTotal - out.reduce((acc, value) => acc + value, 0);
  const order = raw
    .map((value, index) => ({ fraction: value - Math.floor(value), index }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  let cursor = 0;
  while (remainder > 0) {
    out[order[cursor % count].index] += 1;
    remainder -= 1;
    cursor += 1;
  }

  return out;
}
