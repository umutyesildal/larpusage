/**
 * Manual sources + headline overrides.
 *
 * Manuals live in one of three places, first match wins:
 *   1. `$MANUAL_CONFIG` (absolute, `~`-relative, or cwd-relative)
 *   2. `.data/manual.json` under the project root
 *   3. `~/.larpusage/manual.json`
 *
 * The file is a `ManualSource[]`. This is the only module in the fabrication
 * layer allowed to touch the filesystem.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { dayKey, expandHome, hashId, num } from "@/lib/adapters/kit";
import { dataPath } from "@/lib/paths";
import { costOf } from "@/lib/pricing";
import {
  WEEKDAY_FACTOR,
  defaultModelFor,
  isReasoningModel,
  mulberry32,
  splitTokenMix,
} from "@/lib/synthetic";
import type { ToolId, UsageEvent } from "@/lib/types";

export type ManualSource = {
  id: string;
  label: string;
  tool: ToolId;
  tokens: number;
  /** Inclusive local dates, YYYY-MM-DD. */
  from: string;
  to: string;
  shape: "even" | "ramp" | "frontload";
  model?: string;
  creditsPerMTok?: number;
  color?: string;
};

type Reconcile = "pin-only" | "scale-synthetic" | "scale-all";

type OverrideTotals = {
  lifetimeTokens?: number;
  peakTokens?: number;
  longestTaskMs?: number;
  streak?: number;
  reconcile?: Reconcile;
};

const TOOL_IDS: readonly ToolId[] = [
  "codex",
  "opencode",
  "claude",
  "qoder",
  "gemini",
  "zcode",
  "cline",
  "roo",
  "kilo",
  "kiro",
  "amp",
  "droid",
  "goose",
  "openclaw",
  "crush",
  "kimi",
  "qwen",
  "antigravity",
  "grok",
  "copilot",
  "cursor",
  "windsurf",
  "manual",
];

/** ~20 years; protects against a typo like `to: "2099-01-01"`. */
const MAX_MANUAL_DAYS = 366 * 20;

export function loadManual(): ManualSource[] {
  for (const candidate of manualPaths()) {
    if (!existsSync(candidate)) continue;
    return readManual(candidate);
  }
  return [];
}

/**
 * Turn manual sources into one synthetic event per source-day at local noon.
 * Totals are distributed with the weekday rhythm and the requested shape, then
 * renormalised so each source contributes exactly `tokens` in integer tokens.
 */
export function manualToEvents(sources: ManualSource[], seed = 1): UsageEvent[] {
  const baseSeed = Number.isFinite(seed) ? seed : 1;
  const events: UsageEvent[] = [];

  for (const source of sources) {
    const from = parseDay(source.from);
    const to = parseDay(source.to);
    if (!from || !to) continue;
    const days = enumerateDays(from, to);
    if (days.length === 0) continue;

    const shapeRnd = mulberry32(
      hashSeed(hashId("manual-shape", baseSeed, source.id)),
    );
    const weights = days.map((date, index) => {
      const weekday = WEEKDAY_FACTOR[date.getDay()] ?? 1;
      const position =
        days.length === 1 ? 0.5 : index / (days.length - 1);
      const shaped =
        source.shape === "ramp"
          ? 0.6 + 0.8 * position
          : source.shape === "frontload"
            ? 1.4 - 0.8 * position
            : 1;
      const jitter = 0.9 + shapeRnd() * 0.2;
      return Math.max(weekday * shaped * jitter, 1e-9);
    });
    const daily = spread(source.tokens, weights);

    const model = source.model?.trim() || defaultModelFor(source.tool);
    const reasoningCapable = isReasoningModel(model);

    days.forEach((date, index) => {
      const tokens = daily[index];
      if (tokens <= 0) return;

      const ts = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        12,
        0,
        0,
        0,
      ).getTime();
      const key = dayKey(ts);
      const mixRnd = mulberry32(
        hashSeed(hashId("manual-mix", baseSeed, source.id, key)),
      );
      const mix = splitTokenMix(tokens, mixRnd, reasoningCapable);

      const event: UsageEvent = {
        id: hashId("manual", baseSeed, source.id, key),
        tool: source.tool,
        ts,
        sessionId: hashId("manual-session", baseSeed, source.id, key),
        model,
        inputTokens: mix.input,
        cachedInputTokens: mix.cached,
        cacheWriteTokens: mix.cacheWrite,
        outputTokens: mix.output,
        ...(mix.reasoning > 0 ? { reasoningTokens: mix.reasoning } : {}),
        costSource: "computed",
        fidelity: "exact",
        isSynthetic: true,
      };

      if (source.creditsPerMTok !== undefined) {
        const credits = (tokens / 1_000_000) * source.creditsPerMTok;
        event.credits = credits;
        event.creditUnit = `${source.tool}-credit`;
        event.costUsd = credits * 0.01;
        event.costSource = "credits";
      } else {
        const cost = costOf({
          model,
          input: mix.input,
          cached: mix.cached,
          cacheWrite: mix.cacheWrite,
          output: mix.output,
        });
        if (cost === null) event.costSource = "unavailable";
        else event.costUsd = cost;
      }

      events.push(event);
    });
  }

  return events.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
}

/**
 * Apply headline overrides. Never mutates the input events.
 *
 * `lifetimeTokens` is the only override that can reshape events; `peakTokens`,
 * `longestTaskMs` and `streak` are headline-only and produce warnings instead
 * of silently clamping the grid. Returned warnings are ordered by override.
 */
export function applyOverrides(
  events: UsageEvent[],
  totals: OverrideTotals,
): { events: UsageEvent[]; warnings: string[] } {
  const warnings: string[] = [];
  let next = events.slice();

  const reconcile: Reconcile = totals.reconcile ?? "pin-only";

  const lifetime = validTarget(totals.lifetimeTokens);
  if (totals.lifetimeTokens !== undefined && lifetime === null) {
    warnings.push(
      `lifetime target ${fmtNumber(totals.lifetimeTokens)} is not a positive number; ignored`,
    );
  }
  if (lifetime !== null) {
    if (reconcile === "pin-only") {
      const current = sumTokens(next);
      const delta = lifetime - current;
      warnings.push(
        Math.abs(delta) < 1
          ? `lifetime ${fmtTokens(lifetime)} pinned as a headline; events already total ${fmtTokens(current)}`
          : `lifetime ${fmtTokens(lifetime)} pinned as a headline; events still total ${fmtTokens(current)} (${fmtTokens(Math.abs(delta))} ${delta > 0 ? "short" : "over"})`,
      );
    } else {
      const scaled = scaleToLifetime(next, lifetime, reconcile);
      next = scaled.events;
      if (scaled.warning) warnings.push(scaled.warning);
    }
  } else if (reconcile !== "pin-only" && totals.lifetimeTokens === undefined) {
    warnings.push(
      `reconcile "${reconcile}" needs lifetimeTokens; events left untouched`,
    );
  }

  const peak = validTarget(totals.peakTokens);
  if (totals.peakTokens !== undefined && peak === null) {
    warnings.push(
      `peak target ${fmtNumber(totals.peakTokens)} is not a positive number; ignored`,
    );
  }
  if (peak !== null) {
    const max = maxDayTokens(next);
    if (max > peak + 0.5) {
      warnings.push(
        `peak ${fmtTokens(peak)} is ${fmtTokens(max - peak)} below the grid's max day (${fmtTokens(max)})`,
      );
    }
  }

  const task = validTarget(totals.longestTaskMs);
  if (totals.longestTaskMs !== undefined && task === null) {
    warnings.push(
      `longest task target ${fmtNumber(totals.longestTaskMs)}ms is not a positive number; ignored`,
    );
  }
  if (task !== null) {
    const current = longestTaskSpan(next);
    if (task > current + 1000) {
      warnings.push(
        `longest task ${formatDuration(task)} is longer than any session span in the grid (${formatDuration(current)}); headline only`,
      );
    }
  }

  const streak = validTarget(totals.streak);
  if (totals.streak !== undefined && streak === null) {
    warnings.push(
      `streak target ${fmtNumber(totals.streak)}d is not a positive number; ignored`,
    );
  }
  if (streak !== null) {
    const days = activeDays(next);
    const longest = longestRun(days);
    if (streak > longest) {
      warnings.push(
        `streak of ${Math.round(streak)}d is unachievable: the grid's longest consecutive run is ${longest}d`,
      );
    }
  }

  return { events: next, warnings };
}

function manualPaths(): string[] {
  const paths: string[] = [];
  const configured = process.env.MANUAL_CONFIG?.trim();
  if (configured) paths.push(resolveUserPath(configured));
  paths.push(dataPath("manual.json"));
  paths.push(resolve(homedir(), ".larpusage", "manual.json"));
  return paths;
}

function resolveUserPath(path: string): string {
  const expanded = path.startsWith("~") ? expandHome(path) : path;
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

function readManual(path: string): ManualSource[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return normalizeManual(parsed);
  } catch {
    return [];
  }
}

function normalizeManual(raw: unknown): ManualSource[] {
  if (!Array.isArray(raw)) return [];

  const out: ManualSource[] = [];
  const ids = new Set<string>();

  raw.forEach((entry: unknown, index: number) => {
    if (entry === null || typeof entry !== "object") return;
    const row = entry as Record<string, unknown>;

    const tool =
      typeof row.tool === "string" && isToolId(row.tool) ? row.tool : null;
    if (tool === null) return;

    const tokens = num(row.tokens);
    if (tokens <= 0) return;

    const from = typeof row.from === "string" ? row.from.trim() : "";
    const to = typeof row.to === "string" ? row.to.trim() : "";
    if (!parseDay(from) || !parseDay(to) || from > to) return;

    const shape: ManualSource["shape"] =
      row.shape === "ramp" ||
      row.shape === "frontload" ||
      row.shape === "even"
        ? row.shape
        : "even";

    const baseId =
      typeof row.id === "string" && row.id.trim()
        ? row.id.trim()
        : `manual-${index + 1}`;
    const id = uniqueId(baseId, ids);
    ids.add(id);

    const model =
      typeof row.model === "string" && row.model.trim()
        ? row.model.trim()
        : undefined;
    const label =
      typeof row.label === "string" && row.label.trim()
        ? row.label.trim()
        : id;
    const color =
      typeof row.color === "string" && row.color.trim()
        ? row.color.trim()
        : undefined;
    const creditsPerMTok = optionalRate(row.creditsPerMTok);

    out.push({
      id,
      label,
      tool,
      tokens,
      from,
      to,
      shape,
      ...(model !== undefined ? { model } : {}),
      ...(creditsPerMTok !== undefined ? { creditsPerMTok } : {}),
      ...(color !== undefined ? { color } : {}),
    });
  });

  return out;
}

function optionalRate(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const parsed = typeof value === "number" ? value : Number(value.trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function isToolId(value: string): value is ToolId {
  return (TOOL_IDS as readonly string[]).includes(value);
}

function uniqueId(base: string, seen: Set<string>): string {
  if (!seen.has(base)) return base;
  let suffix = 2;
  while (seen.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

type DayParts = { year: number; month: number; day: number };

function parseDay(value: string): DayParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function enumerateDays(from: DayParts, to: DayParts): Date[] {
  const days: Date[] = [];
  const cursor = new Date(from.year, from.month - 1, from.day);
  const last = new Date(to.year, to.month - 1, to.day).getTime();
  while (cursor.getTime() <= last && days.length < MAX_MANUAL_DAYS) {
    days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

function hashSeed(hex: string): number {
  return Number.parseInt(hex.slice(0, 8), 16) >>> 0;
}

/** Largest-remainder integer split; always sums back to `total`. */
function spread(total: number, weights: readonly number[]): number[] {
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

function validTarget(value: number | undefined): number | null {
  if (value === undefined) return null;
  return Number.isFinite(value) && value > 0 ? value : null;
}

function scaleToLifetime(
  events: UsageEvent[],
  target: number,
  mode: Exclude<Reconcile, "pin-only">,
): { events: UsageEvent[]; warning?: string } {
  const selected: number[] = [];
  let eligibleTotal = 0;
  let fixedTotal = 0;

  events.forEach((event, index) => {
    if (mode === "scale-all" || event.isSynthetic === true) {
      selected.push(index);
      eligibleTotal += totalTokens(event);
    } else {
      fixedTotal += totalTokens(event);
    }
  });

  if (selected.length === 0 || eligibleTotal <= 0) {
    return {
      events,
      warning: `cannot scale to lifetime ${fmtTokens(target)}: the grid has no ${mode === "scale-all" ? "tokens" : "synthetic tokens"} to scale (${fmtTokens(eligibleTotal + fixedTotal)} total)`,
    };
  }

  const desired = target - fixedTotal;
  if (desired <= 0) {
    return {
      events,
      warning: `lifetime ${fmtTokens(target)} is below the ${fmtTokens(fixedTotal)} held by real events; synthetic events left unscaled`,
    };
  }

  const factor = desired / eligibleTotal;
  const next = events.slice();
  let largest = selected[0];

  for (const index of selected) {
    next[index] = scaleEvent(events[index], factor);
    if (totalTokens(next[index]) > totalTokens(next[largest])) largest = index;
  }

  // Rounding each bucket independently can drift a few tokens; absorb the
  // residual on the largest eligible event so the target is hit exactly.
  const residual = Math.round(target - sumTokens(next));
  if (residual !== 0) {
    next[largest] = addTokenDelta(next[largest], residual);
  }

  const achieved = sumTokens(next);
  return {
    events: next,
    warning:
      Math.abs(achieved - target) > 0.5
        ? `scaled ${selected.length} event${selected.length === 1 ? "" : "s"} by ×${factor.toFixed(3)} but reached ${fmtTokens(achieved)} instead of ${fmtTokens(target)}`
        : undefined,
  };
}

function scaleEvent(event: UsageEvent, factor: number): UsageEvent {
  const next: UsageEvent = { ...event };

  if (event.inputTokens !== undefined) {
    next.inputTokens = Math.round(event.inputTokens * factor);
  }
  if (event.cachedInputTokens !== undefined) {
    next.cachedInputTokens = Math.round(event.cachedInputTokens * factor);
  }
  if (event.cacheWriteTokens !== undefined) {
    next.cacheWriteTokens = Math.round(event.cacheWriteTokens * factor);
  }
  if (event.outputTokens !== undefined) {
    next.outputTokens = Math.round(event.outputTokens * factor);
  }
  if (event.reasoningTokens !== undefined) {
    next.reasoningTokens = Math.min(
      next.outputTokens ?? 0,
      Math.round(event.reasoningTokens * factor),
    );
  }
  if (event.credits !== undefined) {
    next.credits = event.credits * factor;
  }

  if (event.costSource === "credits" && next.credits !== undefined) {
    next.costUsd = next.credits * 0.01;
  } else {
    const cost = costOf({
      model: next.model,
      input: next.inputTokens,
      cached: next.cachedInputTokens,
      cacheWrite: next.cacheWriteTokens,
      output: next.outputTokens,
    });
    if (cost !== null) next.costUsd = cost;
    else if (event.costUsd !== undefined) next.costUsd = event.costUsd * factor;
  }

  return next;
}

function addTokenDelta(event: UsageEvent, delta: number): UsageEvent {
  if (delta === 0) return event;

  const before = totalTokens(event);
  if (before <= 0) return event;

  const next: UsageEvent = { ...event };
  const input = next.inputTokens ?? 0;
  if (input + delta >= 0) {
    next.inputTokens = input + delta;
  } else {
    const overflow = input + delta;
    next.inputTokens = 0;
    next.outputTokens = Math.max(0, (next.outputTokens ?? 0) + overflow);
  }

  const after = totalTokens(next);
  if (event.credits !== undefined && before > 0) {
    next.credits = event.credits * (after / before);
  }

  if (next.costSource === "credits" && next.credits !== undefined) {
    next.costUsd = next.credits * 0.01;
  } else {
    const cost = costOf({
      model: next.model,
      input: next.inputTokens,
      cached: next.cachedInputTokens,
      cacheWrite: next.cacheWriteTokens,
      output: next.outputTokens,
    });
    if (cost !== null) next.costUsd = cost;
  }

  return next;
}

function totalTokens(event: UsageEvent): number {
  return (
    (event.inputTokens ?? 0) +
    (event.cachedInputTokens ?? 0) +
    (event.cacheWriteTokens ?? 0) +
    (event.outputTokens ?? 0)
  );
}

function sumTokens(events: UsageEvent[]): number {
  return events.reduce((sum, event) => sum + totalTokens(event), 0);
}

function maxDayTokens(events: UsageEvent[]): number {
  const byDay = new Map<string, number>();
  for (const event of events) {
    const key = dayKey(event.ts);
    byDay.set(key, (byDay.get(key) ?? 0) + totalTokens(event));
  }
  let max = 0;
  for (const value of byDay.values()) {
    if (value > max) max = value;
  }
  return max;
}

function longestTaskSpan(events: UsageEvent[]): number {
  const bySession = new Map<string, { min: number; max: number }>();
  for (const event of events) {
    const key = `${event.tool}:${event.sessionId}`;
    const current = bySession.get(key);
    if (!current) bySession.set(key, { min: event.ts, max: event.ts });
    else {
      current.min = Math.min(current.min, event.ts);
      current.max = Math.max(current.max, event.ts);
    }
  }
  let longest = 0;
  for (const span of bySession.values()) {
    longest = Math.max(longest, span.max - span.min);
  }
  return longest;
}

function activeDays(events: UsageEvent[]): string[] {
  const days = new Set<string>();
  for (const event of events) {
    if (totalTokens(event) > 0) days.add(dayKey(event.ts));
  }
  return Array.from(days).sort();
}

function longestRun(days: readonly string[]): number {
  let best = 0;
  let run = 0;
  let previous: string | null = null;
  for (const day of days) {
    if (
      previous !== null &&
      (Date.parse(day) - Date.parse(previous)) / 86_400_000 === 1
    ) {
      run += 1;
    } else {
      run = 1;
    }
    best = Math.max(best, run);
    previous = day;
  }
  return best;
}

function fmtTokens(value: number): string {
  const abs = Math.abs(value);
  const units: ReadonlyArray<[number, string]> = [
    [1_000_000_000_000, "T"],
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "K"],
  ];
  for (const [divisor, suffix] of units) {
    if (abs >= divisor) {
      const scaled = value / divisor;
      const digits = Math.abs(scaled) >= 10 ? 1 : 2;
      return `${trimZeros(scaled.toFixed(digits))}${suffix}`;
    }
  }
  return `${Math.round(value)}`;
}

function fmtNumber(value: number): string {
  return Number.isFinite(value) ? fmtTokens(value) : String(value);
}

function trimZeros(value: string): string {
  return value.includes(".") ? value.replace(/\.?0+$/, "") : value;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds <= 0) return "0s";
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}
