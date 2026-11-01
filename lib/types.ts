export type ToolId =
  | "codex"
  | "opencode"
  | "claude"
  | "qoder"
  | "gemini"
  | "zcode"
  | "cline"
  | "roo"
  | "kilo"
  | "kiro"
  | "amp"
  | "droid"
  | "goose"
  | "openclaw"
  | "crush"
  | "kimi"
  | "qwen"
  | "antigravity"
  | "grok"
  | "copilot"
  | "cursor"
  | "windsurf"
  | "devin"
  | "deepseek"
  | "mistral"
  | "zai"
  | "manual";

export type Fidelity = "exact" | "estimated" | "credits" | "unavailable";
export type CostSource =
  | "stored"
  | "computed"
  | "credits"
  | "estimated"
  | "unavailable";

export type UsageEvent = {
  id: string;
  tool: ToolId;
  ts: number;
  sessionId: string;
  projectPath?: string;
  projectName?: string;
  provider?: string;
  model: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  credits?: number;
  creditUnit?: string;
  costUsd?: number;
  costSource: CostSource;
  fidelity: Fidelity;
  isSynthetic?: boolean;
  isBackfill?: boolean;
  isSubagent?: boolean;
};

export type SourceStatus = {
  tool: ToolId;
  label: string;
  found: boolean;
  path?: string;
  files: number;
  events: number;
  lastEventAt?: number;
  fidelity: Fidelity;
  costSource: CostSource;
  units: "tokens" | "credits";
  warnings: string[];
  ms: number;
};

export type Adapter = {
  id: ToolId;
  label: string;
  detect: () => Promise<boolean>;
  scan: () => Promise<UsageEvent[]>;
  meta: {
    fidelity: Fidelity;
    costSource: CostSource;
    units: "tokens" | "credits";
    paths: string[];
  };
};

export type DayBucket = {
  day: string; // YYYY-MM-DD local
  tokens: number;
  costUsd: number;
  requests: number;
  credits: number;
};

export type ToolSummary = {
  tool: ToolId;
  label: string;
  tokens: number;
  costUsd: number;
  credits: number;
  requests: number;
  share: number;
  fidelity: Fidelity;
};

export type ModelSummary = {
  model: string;
  tokens: number;
  costUsd: number;
  requests: number;
  share: number;
};

export type Snapshot = {
  generatedAt: number;
  rangeDays: number;
  totals: {
    lifetimeTokens: number;
    peakTokens: number;
    peakDay: string;
    longestTaskMs: number;
    currentStreak: number;
    longestStreak: number;
    activeDays: number;
    requests: number;
    costUsd: number;
    realCostUsd: number;
    manualCostUsd: number;
    backfillCostUsd: number;
    credits: number;
    larpValue: number;
    realLifetimeTokens: number;
    manualLifetimeTokens: number;
    backfillLifetimeTokens: number;
  };
  days: DayBucket[];
  tools: ToolSummary[];
  models: ModelSummary[];
  toolModels: Record<string, ModelSummary[]>;
  sources: SourceStatus[];
  firstEventAt?: number;
  lastEventAt?: number;
};

export type RangeKey = "30d" | "90d" | "365d" | "all";
