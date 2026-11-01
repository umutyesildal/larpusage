/**
 * AI generation layer for Studio.
 *
 * Turns a free-text description of AI usage into a spec the Studio can apply:
 * a handle, an intensity, two meter budgets and up to eight manual sources.
 *
 * The module is split into three layers:
 *   1. provider resolution + one Nebius (or OpenAI) chat completion
 *   2. a shared sanitizer that no input can bypass
 *   3. a network-free local parser used when no key exists or the model fails
 *
 * Nothing here runs at module load. Keys are read lazily and never logged, and
 * provider errors never leave this module as text.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ManualEntry, Settings } from "@/lib/settings";
import { defaultModelFor } from "@/lib/synthetic";
import type { ToolId } from "@/lib/types";

/* -------------------------------------------------------------------------- */
/* contracts                                                                  */
/* -------------------------------------------------------------------------- */

export type Intensity = Settings["intensity"];
export type SourceShape = ManualEntry["shape"];

export type GenerateSpec = {
  handle?: string;
  intensity?: Intensity;
  meters?: { session: number; week: number };
  sources: ManualEntry[];
};

export type GenerateResult = {
  ok: boolean;
  engine: "ai" | "local";
  /** Safe, human-readable message. Never a provider error. */
  note?: string;
  spec: GenerateSpec;
};

export type ProviderId = "nebius" | "openai";

export type Provider = {
  id: ProviderId;
  endpoint: string;
  model: string;
  key: string;
};

/* -------------------------------------------------------------------------- */
/* constants                                                                  */
/* -------------------------------------------------------------------------- */

const NEBIUS_ENDPOINT = "https://api.studio.nebius.ai/v1/chat/completions";
const NEBIUS_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = "gpt-4.1-mini";

const AI_TIMEOUT_MS = 18_000;
const AI_MAX_TOKENS = 900;
const AI_TEMPERATURE = 0.4;
const MAX_PROMPT_CHARS = 2_000;
const MAX_SOURCES = 8;
const MAX_RANGE_MONTHS = 36;

const MIN_SOURCE_TOKENS = 500_000;
const MAX_SOURCE_TOKENS = 5_000_000_000_000;

const MIN_SESSION_TOKENS = 50_000_000;
const MAX_SESSION_TOKENS = 5_000_000_000;
const DEFAULT_SESSION_TOKENS = 800_000_000;

const MIN_WEEK_TOKENS = 200_000_000;
const MAX_WEEK_TOKENS = 20_000_000_000;
const DEFAULT_WEEK_TOKENS = 3_000_000_000;

const FALLBACK_SOURCE_TOKENS = 2_000_000_000;
const FALLBACK_DAYS = 90;
const DEFAULT_MONTHS = 6;

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
  "deepseek",
  "mistral",
  "zai",
  "manual",
];

const TOOL_LABEL: Record<ToolId, string> = {
  devin: "Devin",
  deepseek: "DeepSeek",
  mistral: "Mistral",
  zai: "Z.ai",
  codex: "Codex",
  opencode: "OpenCode",
  claude: "Claude Code",
  qoder: "Qoder",
  gemini: "Gemini CLI",
  zcode: "ZCode",
  cline: "Cline",
  roo: "Roo Code",
  kilo: "Kilo Code",
  kiro: "Kiro",
  amp: "Amp",
  droid: "Droid",
  goose: "Goose",
  openclaw: "OpenClaw",
  crush: "Crush",
  kimi: "Kimi",
  qwen: "Qwen Code",
  antigravity: "Antigravity",
  grok: "Grok",
  copilot: "GitHub Copilot",
  cursor: "Cursor",
  windsurf: "Windsurf",
  manual: "Manual",
};

const MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  thousand: 1_000,
  m: 1_000_000,
  million: 1_000_000,
  b: 1_000_000_000,
  billion: 1_000_000_000,
  t: 1_000_000_000_000,
  trillion: 1_000_000_000_000,
};

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  eighteen: 18,
  twenty: 20,
  thirty: 30,
};

/* -------------------------------------------------------------------------- */
/* small guards                                                               */
/* -------------------------------------------------------------------------- */

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.slice(0, maxLength).trim() || null;
}

function cleanModel(value: unknown): string | null {
  const text = cleanText(value, 64);
  return text ? text.replace(/\s+/g, "-") : null;
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "source";
}

/* -------------------------------------------------------------------------- */
/* dates                                                                      */
/* -------------------------------------------------------------------------- */

function atNoon(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
}

function usableDate(date: Date): Date {
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function fmtDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function addDays(date: Date, days: number): Date {
  const next = atNoon(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth() + months, 1, 12, 0, 0, 0);
  const daysInMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0, 12, 0, 0, 0).getDate();
  next.setDate(Math.min(date.getDate(), daysInMonth));
  return next;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!DAY_RE.test(raw)) return null;
  const stamp = Date.parse(`${raw}T12:00:00`);
  if (!Number.isFinite(stamp)) return null;

  const [year, month, day] = raw.split("-").map(Number);
  const date = new Date(year, (month ?? 1) - 1, day ?? 1, 12, 0, 0, 0);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== (month ?? 1) - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

/* -------------------------------------------------------------------------- */
/* numbers                                                                    */
/* -------------------------------------------------------------------------- */

function parseTokenAmount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") return null;

  const cleaned = value.trim().toLowerCase().replace(/,/g, "").replace(/\s+/g, " ");
  if (!cleaned) return null;

  const match =
    /^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)\s*(k|m|b|t|thousand|million|billion|trillion)?(?:\s+tokens?)?$/.exec(
      cleaned,
    );
  if (!match) return null;

  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const suffix = match[2];
  return suffix ? base * (MULTIPLIERS[suffix] ?? 1) : base;
}

/** Largest scaled token amount mentioned anywhere in a free-text description. */
function extractTokenTotal(text: string): number | null {
  let largest = 0;

  const scaled = /(\d[\d,]*(?:\.\d+)?)\s*(k|m|b|t|thousand|million|billion|trillion)\b/gi;
  for (const match of text.matchAll(scaled)) {
    const base = Number((match[1] ?? "").replace(/,/g, ""));
    const multiplier = MULTIPLIERS[(match[2] ?? "").toLowerCase()] ?? 0;
    const value = base * multiplier;
    if (Number.isFinite(value) && value > largest) largest = value;
  }

  const plain = /\b(\d{1,3}(?:,\d{3})+|\d{7,})\b/g;
  for (const match of text.matchAll(plain)) {
    const value = Number((match[1] ?? "").replace(/,/g, ""));
    if (Number.isFinite(value) && value > largest) largest = value;
  }

  return largest > 0 ? largest : null;
}

function splitTotal(total: number, weights: readonly number[]): number[] {
  const count = weights.length;
  if (count === 0) return [];

  const safeTotal = Math.max(0, Math.round(total));
  const sum = weights.reduce((acc, weight) => acc + Math.max(0, weight), 0);
  if (safeTotal === 0 || sum <= 0) return weights.map(() => 0);

  const raw = weights.map((weight) => (safeTotal * Math.max(0, weight)) / sum);
  const out = raw.map((value) => Math.floor(value));
  let remainder = safeTotal - out.reduce((acc, value) => acc + value, 0);

  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  let cursor = 0;
  while (remainder > 0) {
    const slot = order[cursor % count];
    if (slot) out[slot.index] += 1;
    remainder -= 1;
    cursor += 1;
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* tools                                                                      */
/* -------------------------------------------------------------------------- */

const TOOL_PATTERNS: ReadonlyArray<readonly [ToolId, RegExp]> = [
  ["claude", /\b(?:claude(?:[\s-]+code)?|anthropic|opus|sonnet|haiku|fable|mythos)\b/i],
  ["codex", /\b(?:codex|chatgpt|openai|gpt(?:-\d[\w.]*)?)\b/i],
  ["opencode", /\bopen[\s-]?code\b/i],
  ["qoder", /\bqoder\b/i],
  ["gemini", /\b(?:gemini|google(?:\s+ai)?)\b/i],
  ["zcode", /\bz[\s-]?code\b|\bz\.ai\b|\bglm\b/i],
  ["cline", /\bcline\b/i],
  ["roo", /\broo(?:[\s-]+code)?\b/i],
  ["kilo", /\bkilo(?:[\s-]+code)?\b/i],
  ["kiro", /\bkiro\b/i],
  ["amp", /\bamp\b/i],
  ["droid", /\bdroid\b/i],
  ["goose", /\bgoose\b/i],
  ["openclaw", /\bopen[\s-]?claw\b/i],
  ["crush", /\bcrush\b/i],
  ["kimi", /\b(?:kimi|moonshot)\b/i],
  ["qwen", /\b(?:qwen|alibaba)\b/i],
  ["antigravity", /\bantigravity\b/i],
  ["grok", /\b(?:grok|xai|x\.ai)\b/i],
  ["copilot", /\b(?:github\s+)?copilot\b/i],
  ["cursor", /\bcursor\b/i],
  ["windsurf", /\b(?:windsurf|codeium)\b/i],
];

function detectTools(text: string): ToolId[] {
  const firstSeen = new Map<ToolId, number>();

  for (const [tool, pattern] of TOOL_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const previous = firstSeen.get(tool);
    if (previous === undefined || match.index < previous) firstSeen.set(tool, match.index);
  }

  return Array.from(firstSeen.entries())
    .sort((a, b) => a[1] - b[1])
    .map(([tool]) => tool);
}

function normalizeTool(value: unknown): ToolId | null {
  if (typeof value !== "string") return null;

  const key = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!key) return null;

  const direct = TOOL_IDS.find((tool) => tool === key);
  if (direct) return direct;

  const aliases: ReadonlyArray<readonly [string, ToolId]> = [
    ["claude-code", "claude"],
    ["claude-ai", "claude"],
    ["anthropic", "claude"],
    ["openai", "codex"],
    ["chatgpt", "codex"],
    ["gpt", "codex"],
    ["open-code", "opencode"],
    ["google", "gemini"],
    ["gemini-cli", "gemini"],
    ["z-ai", "zcode"],
    ["glm", "zcode"],
    ["roo-code", "roo"],
    ["kilo-code", "kilo"],
    ["qwen-code", "qwen"],
    ["moonshot", "kimi"],
    ["alibaba", "qwen"],
    ["xai", "grok"],
    ["codeium", "windsurf"],
    ["github-copilot", "copilot"],
  ];

  for (const [alias, tool] of aliases) {
    if (key === alias) return tool;
  }

  // Compound labels such as "openai-codex" or "anthropic-claude" still name
  // exactly one source; accept the first known tool token in the key.
  const tokens = key.split("-");
  for (const tool of TOOL_IDS) {
    if (tokens.includes(tool)) return tool;
  }
  return null;
}

function normalizeShape(value: unknown): SourceShape {
  const key =
    typeof value === "string" ? value.trim().toLowerCase().replace(/[^a-z]/g, "") : "";
  if (key === "ramp" || key === "rampup" || key === "ramping") return "ramp";
  if (key.includes("front") || key.includes("taper")) return "frontload";
  return "even";
}

function normalizeIntensity(value: unknown): Intensity | null {
  const key =
    typeof value === "string" ? value.trim().toLowerCase().replace(/[^a-z]/g, "") : "";
  if (key === "indie" || key === "startup" || key === "seriesb" || key === "lab") {
    return key;
  }
  return null;
}

function weightsFor(tools: readonly ToolId[]): number[] {
  if (tools.length <= 1) return [1];

  const hasClaude = tools.includes("claude");
  const hasCodex = tools.includes("codex");
  const fixed = (hasClaude ? 0.5 : 0) + (hasCodex ? 0.3 : 0);
  if (fixed === 0) return tools.map(() => 1);

  const others = tools.filter((tool) => tool !== "claude" && tool !== "codex").length;
  const rest = Math.max(0, 1 - fixed);

  return tools.map((tool) => {
    if (tool === "claude") return 0.5;
    if (tool === "codex") return 0.3;
    return others > 0 ? rest / others : 0;
  });
}

function modelFor(tool: ToolId, text: string): string {
  const lower = text.toLowerCase();

  switch (tool) {
    case "claude":
      if (/\bmythos\b/.test(lower)) return "claude-mythos-5.1";
      if (/\bfable\b/.test(lower)) return "claude-fable-5.1";
      if (/\bopus\b/.test(lower)) return "claude-opus-5.5";
      if (/\bhaiku\b/.test(lower)) return "claude-haiku-4.5";
      if (/\bsonnet\b/.test(lower)) return "claude-sonnet-5.5";
      return defaultModelFor(tool);
    case "codex":
      if (/\bastra\b/.test(lower)) return "gpt-6-astra";
      if (/\bluna\b/.test(lower)) return "gpt-6-luna";
      if (/\bgpt-6\b/.test(lower)) return "gpt-6-sol";
      if (/\bgpt-5\.6\b/.test(lower)) return "gpt-5.6-sol";
      return defaultModelFor(tool);
    case "gemini":
      if (/\bflash[\s-]?lite\b/.test(lower)) return "gemini-3.5-flash-lite";
      if (/\bflash\b/.test(lower)) return "gemini-3.5-flash";
      if (/\bpro\b/.test(lower)) return "gemini-3.5-pro";
      return defaultModelFor(tool);
    case "kimi":
      return /\bk3\b/.test(lower) ? "kimi-k3" : defaultModelFor(tool);
    case "qwen":
      if (/\bmax\b/.test(lower)) return "qwen3.8-max";
      if (/\bplus\b/.test(lower)) return "qwen3.8-plus";
      if (/\bflash\b/.test(lower)) return "qwen3.8-flash";
      return defaultModelFor(tool);
    default:
      return defaultModelFor(tool);
  }
}

/* -------------------------------------------------------------------------- */
/* free-text hints                                                            */
/* -------------------------------------------------------------------------- */

function detectHandle(text: string): string | null {
  const at = /\b@([a-zA-Z0-9][a-zA-Z0-9_.-]{0,23})\b/.exec(text);
  if (at?.[1]) return at[1];

  const labeled = /\b(?:handle|username)\s*(?:is|:|=)\s*@?([a-zA-Z0-9][a-zA-Z0-9_.-]{0,23})\b/i.exec(
    text,
  );
  if (labeled?.[1]) return labeled[1];

  const called = /\bcall me\s+@?([a-zA-Z0-9][a-zA-Z0-9_.-]{0,23})\b/i.exec(text);
  return called?.[1] ?? null;
}

function detectIntensity(text: string): Intensity | null {
  if (/\b(?:research\s+)?lab\b|\bfrontier\b/i.test(text)) return "lab";
  if (/\bseries\s*[- ]?b\b/i.test(text)) return "seriesb";
  if (/\bstart[\s-]?up\b|\bseed[\s-]?stage\b/i.test(text)) return "startup";
  if (/\bindie\b|\bsolo\b|\bhobby\b|\bpersonal\s+use\b/i.test(text)) return "indie";
  return null;
}

function detectShape(text: string): SourceShape {
  if (/\bfront[\s-]?load(?:ed)?\b|\bstarted\s+(?:heavy|hard)\b|\btapered\b|\bslowed\b/i.test(text)) {
    return "frontload";
  }
  if (
    /\bramp(?:ed|ing)?\b|\bgrew\b|\bgrowing\b|\baccelerat(?:ed|ing)\b|\bincreas(?:ed|ing)\b|\bpicked\s+up\b/i.test(
      text,
    )
  ) {
    return "ramp";
  }
  return "even";
}

function countOf(value: string): number | null {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  return NUMBER_WORDS[value.toLowerCase()] ?? null;
}

type DateRange = { from: Date; to: Date };

function shiftBack(today: Date, count: number, unit: string): Date {
  switch (unit) {
    case "day":
      return addDays(today, -count);
    case "week":
      return addDays(today, -count * 7);
    case "month":
      return addMonths(today, -count);
    default:
      return addMonths(today, -count * 12);
  }
}

function detectRange(text: string, now: Date): DateRange | null {
  const lower = text.toLowerCase();
  const today = atNoon(now);

  const sinceAgo = /\bsince\s+(\d+)\s+(day|week|month|year)s?\s+ago\b/.exec(lower);
  if (sinceAgo?.[1] && sinceAgo[2]) {
    const count = countOf(sinceAgo[1]);
    if (count) return { from: shiftBack(today, count, sinceAgo[2]), to: today };
  }

  const lastN = /\b(?:last|past|previous)\s+(\d+|[a-z]+)\s+(day|week|month|year)s?\b/.exec(lower);
  if (lastN?.[1] && lastN[2]) {
    const count = countOf(lastN[1]);
    if (count) return { from: shiftBack(today, count, lastN[2]), to: today };
  }

  if (/\bthis\s+year\b|\byear[\s-]?to[\s-]?date\b|\bytd\b/.test(lower)) {
    return { from: new Date(today.getFullYear(), 0, 1, 12, 0, 0, 0), to: today };
  }

  if (/\bthis\s+month\b/.test(lower)) {
    return { from: new Date(today.getFullYear(), today.getMonth(), 1, 12, 0, 0, 0), to: today };
  }

  if (/\bsince\s+(?:the\s+)?(?:start\s+of\s+)?(?:this\s+)?year\b/.test(lower)) {
    return { from: new Date(today.getFullYear(), 0, 1, 12, 0, 0, 0), to: today };
  }

  const sinceMonth =
    /\bsince\s+(?:the\s+start\s+of\s+)?(?:last\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b(?:\s+(?:of\s+)?(\d{4}))?/.exec(
      lower,
    );
  if (sinceMonth?.[1]) {
    const month = MONTHS[sinceMonth[1]];
    if (month !== undefined) {
      const explicitYear = sinceMonth[2] ? Number(sinceMonth[2]) : null;
      let from = new Date(
        explicitYear ?? today.getFullYear(),
        month,
        1,
        12,
        0,
        0,
        0,
      );
      if (explicitYear === null && from.getTime() > today.getTime()) {
        from = new Date(from.getFullYear() - 1, month, 1, 12, 0, 0, 0);
      }
      return { from, to: today };
    }
  }

  const sinceYear = /\bsince\s+(?:the\s+start\s+of\s+)?(\d{4})\b/.exec(lower);
  if (sinceYear?.[1]) {
    const year = Number(sinceYear[1]);
    if (Number.isFinite(year) && year >= 1970) {
      return { from: new Date(year, 0, 1, 12, 0, 0, 0), to: today };
    }
  }

  if (/\b(?:last|past|previous)\s+year\b/.test(lower)) {
    return { from: addMonths(today, -12), to: today };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* sanitizer                                                                  */
/* -------------------------------------------------------------------------- */

function sanitizeHandle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const handle = value
    .trim()
    .replace(/^@+/, "")
    .replace(/[^a-zA-Z0-9_.-]/g, "")
    .slice(0, 24)
    .replace(/^[._-]+|[._-]+$/g, "");
  return handle.length > 0 ? handle : null;
}

function sanitizeMeters(value: unknown): { session: number; week: number } {
  const row = isRecord(value) ? value : {};

  const sessionRaw = parseTokenAmount(row.session);
  const weekRaw = parseTokenAmount(row.week);

  return {
    session: Math.round(
      sessionRaw === null
        ? DEFAULT_SESSION_TOKENS
        : clamp(sessionRaw, MIN_SESSION_TOKENS, MAX_SESSION_TOKENS),
    ),
    week: Math.round(
      weekRaw === null
        ? DEFAULT_WEEK_TOKENS
        : clamp(weekRaw, MIN_WEEK_TOKENS, MAX_WEEK_TOKENS),
    ),
  };
}

function sanitizeSource(
  value: unknown,
  index: number,
  defaults: { from: Date; to: Date },
): ManualEntry | null {
  if (!isRecord(value)) return null;

  const tool = normalizeTool(value.tool);
  if (!tool) return null;

  const rawTokens = parseTokenAmount(value.tokens);
  if (rawTokens === null || !Number.isFinite(rawTokens) || rawTokens <= 0) return null;

  const label = cleanText(value.label, 48) ?? TOOL_LABEL[tool];
  const tokens = Math.round(clamp(rawTokens, MIN_SOURCE_TOKENS, MAX_SOURCE_TOKENS));

  let from = parseDay(value.from) ?? defaults.from;
  let to = parseDay(value.to) ?? defaults.to;

  if (from.getTime() > to.getTime()) {
    const swap = from;
    from = to;
    to = swap;
  }

  const earliest = addMonths(to, -MAX_RANGE_MONTHS);
  if (from.getTime() < earliest.getTime()) from = earliest;

  const model = cleanModel(value.model) ?? defaultModelFor(tool);

  return {
    id: `ai-${slugify(label)}-${index}`,
    label,
    tool,
    tokens,
    from: fmtDay(from),
    to: fmtDay(to),
    shape: normalizeShape(value.shape),
    model,
  };
}

/**
 * The one gate every spec passes through, AI or local. Invalid sources are
 * dropped, dates are made coherent, tokens and meters are clamped, and ids are
 * deterministic so applying the same spec twice replaces rather than duplicates.
 */
export function sanitizeSpec(raw: unknown, now: Date = new Date()): GenerateSpec {
  const today = atNoon(usableDate(now));
  const defaults = { from: addMonths(today, -DEFAULT_MONTHS), to: today };

  const container = isRecord(raw) ? raw : {};
  const candidates = Array.isArray(container.sources)
    ? container.sources
    : Array.isArray(raw)
      ? raw
      : [];

  const sources: ManualEntry[] = [];
  for (const candidate of candidates) {
    if (sources.length >= MAX_SOURCES) break;
    const source = sanitizeSource(candidate, sources.length, defaults);
    if (source) sources.push(source);
  }

  const handle = sanitizeHandle(container.handle);
  const intensity = normalizeIntensity(container.intensity);

  return {
    ...(handle ? { handle } : {}),
    ...(intensity ? { intensity } : {}),
    meters: sanitizeMeters(container.meters),
    sources,
  };
}

/* -------------------------------------------------------------------------- */
/* local parser                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Network-free fallback. The same sanitizer applies, so its output can never
 * be out of bounds even when the text is unusual.
 */
export function localSpec(prompt: string, now: Date = new Date()): GenerateSpec {
  const text = typeof prompt === "string" ? prompt : "";
  const today = atNoon(usableDate(now));

  const tools = detectTools(text);
  const total = extractTokenTotal(text);
  const range = detectRange(text, today);
  const shape = detectShape(text);
  const handle = detectHandle(text);
  const intensity = detectIntensity(text);

  const raw: Record<string, unknown> = {};

  if (handle) raw.handle = handle;

  if (total === null) {
    const tool = tools[0] ?? "claude";
    const source: Record<string, unknown> = {
      label: TOOL_LABEL[tool],
      tool,
      tokens: FALLBACK_SOURCE_TOKENS,
      from: fmtDay(addDays(today, -FALLBACK_DAYS)),
      to: fmtDay(today),
      shape,
      model: modelFor(tool, text),
    };
    raw.intensity = "startup";
    raw.sources = [source];
    return sanitizeSpec(raw, today);
  }

  const selected: ToolId[] = tools.length > 0 ? tools.slice(0, MAX_SOURCES) : ["claude"];
  const window = range ?? { from: addMonths(today, -DEFAULT_MONTHS), to: today };
  const shares = splitTotal(total, weightsFor(selected));

  if (intensity) raw.intensity = intensity;
  raw.sources = selected.map((tool, index) => ({
    label: TOOL_LABEL[tool],
    tool,
    tokens: shares[index] ?? 0,
    from: fmtDay(window.from),
    to: fmtDay(window.to),
    shape,
    model: modelFor(tool, text),
  }));

  return sanitizeSpec(raw, today);
}

/* -------------------------------------------------------------------------- */
/* providers                                                                  */
/* -------------------------------------------------------------------------- */

function envKey(name: string): string | null {
  const value = process.env[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

async function readOpenCodeNebiusKey(): Promise<string | null> {
  try {
    const path = join(homedir(), ".local", "share", "opencode", "auth.json");
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return null;

    const nebius = parsed.nebius;
    if (!isRecord(nebius) || nebius.type !== "api") return null;

    const key = nebius.key;
    return typeof key === "string" && key.trim() ? key.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Resolution order:
 *   1. NEBIUS_API_KEY
 *   2. ~/.local/share/opencode/auth.json → nebius.key (type "api")
 *   3. OPENAI_API_KEY
 */
export async function resolveProvider(): Promise<Provider | null> {
  const envNebius = envKey("NEBIUS_API_KEY");
  if (envNebius) {
    return {
      id: "nebius",
      endpoint: NEBIUS_ENDPOINT,
      model: NEBIUS_MODEL,
      key: envNebius,
    };
  }

  const storedNebius = await readOpenCodeNebiusKey();
  if (storedNebius) {
    return {
      id: "nebius",
      endpoint: NEBIUS_ENDPOINT,
      model: NEBIUS_MODEL,
      key: storedNebius,
    };
  }

  const envOpenai = envKey("OPENAI_API_KEY");
  if (envOpenai) {
    return {
      id: "openai",
      endpoint: OPENAI_ENDPOINT,
      model: OPENAI_MODEL,
      key: envOpenai,
    };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* AI request                                                                 */
/* -------------------------------------------------------------------------- */

const SYSTEM_PROMPT = `You convert a description of AI coding tool usage into one compact JSON object for a usage profile. Return ONLY the JSON object: no markdown, no code fence, no commentary.

The object has exactly these keys:
- "handle": string, 1-24 characters, optional. Only set it when the user states their own handle.
- "intensity": one of "indie", "startup", "seriesb", "lab".
- "meters": {"session": number, "week": number}. These are token budgets, not percentages.
- "sources": array of at most 8 source objects.

Each source object has exactly these keys:
- "label": short human label, e.g. "Claude Code".
- "tool": exactly one of: codex, opencode, claude, qoder, gemini, zcode, cline, roo, kilo, kiro, amp, droid, goose, openclaw, crush, kimi, qwen, antigravity, grok, copilot, cursor, windsurf, manual.
- "tokens": a number, never a string. This is the total tokens for that source.
- "from": YYYY-MM-DD.
- "to": YYYY-MM-DD.
- "shape": "even", "ramp" or "frontload".
- "model": a model name that fits the tool.

Rules:
- Never invent more than 8 sources. Prefer 1-4.
- If the user does not name a tool, use "claude".
- If one total token count is given and several tools are named, split the total across them. Give the most-used tool the largest share.
- If no token count is given, estimate a plausible total from the description.
- If only one date boundary is given, use today as the other boundary.
- Dates must be real calendar dates. "from" must not be after "to".
- Prefer current catalogue models when they fit: claude-opus-5.5, claude-sonnet-5.5, claude-haiku-4.5, gpt-5.6-sol, gpt-5.6-terra, gemini-3.5-pro, gemini-3.5-flash, glm-5.3, qwen3.8-max, kimi-k3, grok-4.5.
- Do not output ids, explanations, extra keys, or null values.
- Today's date appears in the user message; use it for relative ranges such as "last 6 months" or "since March".`;

type AiMessage = { role: "system" | "user"; content: string };

function currentSummary(current: Partial<Settings>): string {
  const parts: string[] = [];

  if (typeof current.handle === "string") {
    const handle = sanitizeHandle(current.handle);
    if (handle) parts.push(`handle "${handle}"`);
  }

  const intensity = normalizeIntensity(current.intensity);
  if (intensity) parts.push(`intensity ${intensity}`);

  if (isRecord(current.meters)) {
    const session = parseTokenAmount(current.meters.session);
    const week = parseTokenAmount(current.meters.week);
    if (session !== null && week !== null) {
      parts.push(`meters session ${Math.round(session)} / week ${Math.round(week)}`);
    }
  }

  if (Array.isArray(current.manual) && current.manual.length > 0) {
    parts.push(`${current.manual.length} manual source${current.manual.length === 1 ? "" : "s"}`);
  }

  return parts.length > 0 ? parts.join(", ") : "empty";
}

function buildMessages(prompt: string, current: Partial<Settings>, today: string): AiMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Today: ${today}\nCurrent profile: ${currentSummary(current)}\n\nUsage description:\n"""\n${prompt}\n"""`,
    },
  ];
}

function extractContent(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;

  const first = choices[0];
  if (!isRecord(first)) return null;

  const message = first.message;
  if (!isRecord(message)) return null;

  const content = message.content;
  if (typeof content === "string") {
    return content.trim() ? content : null;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();
    return text ? text : null;
  }

  return null;
}

function stripFence(content: string): string {
  let text = content.trim();
  if (!text.startsWith("```")) return text;

  text = text.replace(/^```(?:json)?\s*/i, "");
  if (text.endsWith("```")) text = text.slice(0, -3);
  return text.trim();
}

function parseJsonObject(content: string): unknown {
  const text = stripFence(content);

  try {
    return JSON.parse(text) as unknown;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as unknown;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * One bounded provider call. Returns parsed JSON only when the transport, the
 * status, the shape and the JSON syntax are all valid; every failure is null.
 * The key, headers, status and body never escape this function.
 */
async function requestSpec(
  provider: Provider,
  prompt: string,
  current: Partial<Settings>,
  today: string,
): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const response = await fetch(provider.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${provider.key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: provider.model,
        messages: buildMessages(prompt, current, today),
        temperature: AI_TEMPERATURE,
        max_tokens: AI_MAX_TOKENS,
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) return null;

    const payload: unknown = await response.json();
    const content = extractContent(payload);
    return content ? parseJsonObject(content) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* entry point                                                                */
/* -------------------------------------------------------------------------- */

function emptySpec(): GenerateSpec {
  return { sources: [] };
}

/**
 * Generate a spec from free text. This function never throws and never returns
 * a provider error. Validation and upstream failures are `ok: false` with a
 * safe `note`; a usable local spec is still returned so the Studio can apply it
 * if it wants to.
 */
export async function generateSpec(
  prompt: unknown,
  current: Partial<Settings> = {},
): Promise<GenerateResult> {
  const text = typeof prompt === "string" ? prompt.trim() : "";

  if (!text) {
    return {
      ok: false,
      engine: "local",
      note: "Describe your AI usage first.",
      spec: emptySpec(),
    };
  }

  if (text.length > MAX_PROMPT_CHARS) {
    return {
      ok: false,
      engine: "local",
      note: `Keep the description under ${MAX_PROMPT_CHARS.toLocaleString("en-US")} characters.`,
      spec: emptySpec(),
    };
  }

  const safeCurrent: Partial<Settings> = isRecord(current) ? current : {};
  const today = fmtDay(atNoon(new Date()));

  let provider: Provider | null = null;
  try {
    provider = await resolveProvider();
  } catch {
    provider = null;
  }

  if (!provider) {
    return {
      ok: true,
      engine: "local",
      note: "Generated locally",
      spec: localSpec(text),
    };
  }

  const raw = await requestSpec(provider, text, safeCurrent, today);
  const spec = raw === null ? null : sanitizeSpec(raw);

  if (!spec || spec.sources.length === 0) {
    return {
      ok: false,
      engine: "local",
      note: "Generated locally — the model did not return a usable spec.",
      spec: localSpec(text),
    };
  }

  return { ok: true, engine: "ai", spec };
}
