export type Rate = {
  input: number;
  cached: number;
  output: number;
};

const RATES: Record<string, Rate> = {
  // OpenAI
  "gpt-6-astra": { input: 10, cached: 1, output: 50 },
  "gpt-6-sol": { input: 2, cached: 0.2, output: 10 },
  "gpt-6-luna": { input: 0.2, cached: 0.02, output: 1.2 },
  "gpt-5.6-sol": { input: 4, cached: 0.4, output: 20 },
  "gpt-5.6-terra": { input: 2, cached: 0.2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cached: 0.02, output: 1.2 },
  "gpt-5.5": { input: 2.5, cached: 0.25, output: 15 },
  "gpt-5.4": { input: 2.5, cached: 0.25, output: 15 },
  "gpt-5": { input: 1.25, cached: 0.125, output: 10 },
  "gpt-4.1": { input: 2, cached: 0.5, output: 8 },
  "gpt-4o": { input: 2.5, cached: 1.25, output: 10 },
  "o3": { input: 2, cached: 0.5, output: 8 },
  "o4-mini": { input: 1.1, cached: 0.275, output: 4.4 },
  "codex-mini": { input: 1.5, cached: 0.375, output: 6 },

  // Anthropic
  "claude-opus-5.5": { input: 4, cached: 0.2, output: 20 },
  "claude-opus-5": { input: 5, cached: 0.5, output: 25 },
  "claude-opus-4.8": { input: 5, cached: 0.5, output: 25 },
  "claude-opus-4.7": { input: 5, cached: 0.5, output: 25 },
  "claude-sonnet-5.5": { input: 2, cached: 0.2, output: 10 },
  "claude-sonnet-5": { input: 2, cached: 0.2, output: 10 },
  "claude-sonnet-4.6": { input: 3, cached: 0.3, output: 15 },
  "claude-haiku-4.5": { input: 1, cached: 0.1, output: 5 },
  "claude-fable-5.1": { input: 10, cached: 0.25, output: 50 },
  "claude-fable-5": { input: 10, cached: 1, output: 50 },
  "claude-mythos-5.1": { input: 10, cached: 0.25, output: 50 },

  // Google
  "gemini-3.5-pro": { input: 1.25, cached: 0.31, output: 10 },
  "gemini-3.5-flash": { input: 0.3, cached: 0.075, output: 2.5 },
  "gemini-3.5-flash-lite": { input: 0.1, cached: 0.025, output: 0.4 },
  "gemini-3.1-pro": { input: 1.25, cached: 0.31, output: 10 },
  "gemini-2.5-pro": { input: 1.25, cached: 0.31, output: 10 },
  "gemini-2.5-flash": { input: 0.3, cached: 0.075, output: 2.5 },

  // Z.ai / GLM
  "glm-5.3": { input: 1.4, cached: 0.26, output: 4.4 },
  "glm-5.3-flash": { input: 0.15, cached: 0.03, output: 0.5 },
  "glm-5.3-flashx": { input: 0.37, cached: 0.075, output: 1.25 },
  "glm-5.2": { input: 1.4, cached: 0.26, output: 4.4 },
  "glm-5.1": { input: 1.4, cached: 0.26, output: 4.4 },
  "glm-5": { input: 1, cached: 0.2, output: 3.2 },
  "glm-5v-turbo": { input: 1.4, cached: 0.26, output: 4.4 },
  "glm-5.1-highspeed": { input: 1.4, cached: 0.26, output: 4.4 },
  "glm-5-turbo": { input: 1, cached: 0.2, output: 3.2 },
  "glm-4.7": { input: 0.6, cached: 0.11, output: 2.2 },
  "glm-4.7-flashx": { input: 0.15, cached: 0.03, output: 0.5 },
  "glm-4.7-flash": { input: 0.05, cached: 0.01, output: 0.2 },
  "glm-4.6": { input: 0.6, cached: 0.11, output: 2.2 },
  "glm-4.5-air": { input: 0.2, cached: 0.04, output: 1.1 },
  "glm-4.5": { input: 0.6, cached: 0.11, output: 2.2 },
  "glm-4.6v": { input: 0.6, cached: 0.11, output: 2.2 },
  "glm-4.6v-flash": { input: 0.05, cached: 0.01, output: 0.2 },
  "glm-4.6v-flashx": { input: 0.15, cached: 0.03, output: 0.5 },
  "glm-4.1v-thinking-flashx": { input: 0.15, cached: 0.03, output: 0.5 },
  "glm-4.1v-thinking-flash": { input: 0.05, cached: 0.01, output: 0.2 },
  "glm-4-flashx-250414": { input: 0.05, cached: 0.01, output: 0.2 },
  "glm-4-flash-250414": { input: 0.05, cached: 0.01, output: 0.2 },
  "glm-4v-flash": { input: 0.05, cached: 0.01, output: 0.2 },


  // Qwen / Alibaba
  "qwen3.8-max": { input: 1.6, cached: 0.4, output: 6.4 },
  "qwen3.8-plus": { input: 0.4, cached: 0.1, output: 1.2 },
  "qwen3.8-flash": { input: 0.05, cached: 0.0125, output: 0.2 },
  "qwen3-coder-plus": { input: 0.65, cached: 0.16, output: 3.25 },

  // Moonshot
  "kimi-k3": { input: 3, cached: 0.6, output: 15 },
  "kimi-k2.8": { input: 0.6, cached: 0.15, output: 2.5 },
  "kimi-k2": { input: 0.6, cached: 0.15, output: 2.5 },

  // DeepSeek
  "deepseek-v4-pro": { input: 1.2, cached: 0.24, output: 4.8 },
  "deepseek-v4-flash": { input: 0.14, cached: 0.028, output: 0.56 },
  "deepseek-v3.2": { input: 0.28, cached: 0.028, output: 0.42 },

  // xAI
  "grok-4.5": { input: 3, cached: 0.75, output: 15 },
  "grok-4": { input: 3, cached: 0.75, output: 15 },

  // MiniMax
  "minimax-m3": { input: 0.3, cached: 0.06, output: 1.2 },
  "swe-2-high": { input: 3, cached: 0.3, output: 15 },
};

const FAMILY: Array<[RegExp, Rate]> = [
  [/gpt-6-astra/i, RATES["gpt-6-astra"]],
  [/gpt-6-sol/i, RATES["gpt-6-sol"]],
  [/gpt-6-luna/i, RATES["gpt-6-luna"]],
  [/gpt-5\.6-sol/i, RATES["gpt-5.6-sol"]],
  [/gpt-5\.6-terra/i, RATES["gpt-5.6-terra"]],
  [/gpt-5\.6-luna/i, RATES["gpt-5.6-luna"]],
  [/gpt-5/i, RATES["gpt-5"]],
  [/^o[34]/i, RATES["o3"]],
  [/claude.*opus.*5\.5/i, RATES["claude-opus-5.5"]],
  [/claude.*opus/i, RATES["claude-opus-5"]],
  [/claude.*sonnet.*5/i, RATES["claude-sonnet-5"]],
  [/claude.*sonnet/i, RATES["claude-sonnet-4.6"]],
  [/claude.*haiku/i, RATES["claude-haiku-4.5"]],
  [/claude.*fable/i, RATES["claude-fable-5.1"]],
  [/gemini.*flash.*lite/i, RATES["gemini-3.5-flash-lite"]],
  [/gemini.*flash/i, RATES["gemini-3.5-flash"]],
  [/gemini.*pro/i, RATES["gemini-3.5-pro"]],
  [/glm-5\.3.*flashx/i, RATES["glm-5.3-flashx"]],
  [/glm-5\.3.*flash/i, RATES["glm-5.3-flash"]],
  [/glm-5/i, RATES["glm-5.3"]],
  [/glm-4/i, RATES["glm-4.6"]],
  [/qwen3\.8.*max/i, RATES["qwen3.8-max"]],
  [/qwen3\.8.*plus/i, RATES["qwen3.8-plus"]],
  [/qwen3\.8.*flash/i, RATES["qwen3.8-flash"]],
  [/kimi.*k3/i, RATES["kimi-k3"]],
  [/kimi/i, RATES["kimi-k2.5"]],
  [/deepseek.*pro/i, RATES["deepseek-v4-pro"]],
  [/deepseek/i, RATES["deepseek-v4-flash"]],
  [/grok/i, RATES["grok-4.5"]],
  [/minimax/i, RATES["minimax-m3"]],
  [/mistral/i, { input: 2, cached: 0.2, output: 6 }],
  [/swe-2/i, { input: 3, cached: 0.3, output: 15 }],
];

export function normalizeModel(model: string): string {
  return model
    .toLowerCase()
    .replace(/^qoder-custom-[0-9a-f-]{36}\//, "")
    .replace(/^[a-z0-9_-]+\//, "") // strip provider prefixes like "openai/"
    .replace(/:free$/, "")
    .replace(/@.*$/, "")
    .replace(/-(\d+)-(\d+)$/, "-$1.$2") // claude-opus-5-5 → claude-opus-5.5
    .trim();
}

export function rateFor(model: string): Rate | null {
  const key = normalizeModel(model);
  if (RATES[key]) return RATES[key];
  for (const [re, rate] of FAMILY) if (re.test(key)) return rate;
  return null;
}

export function costOf(args: {
  model: string;
  input?: number;
  cached?: number;
  cacheWrite?: number;
  output?: number;
}): number | null {
  const rate = rateFor(args.model);
  if (!rate) return null;
  const m = 1_000_000;
  return (
    ((args.input ?? 0) / m) * rate.input +
    ((args.cached ?? 0) / m) * rate.cached +
    ((args.cacheWrite ?? 0) / m) * rate.input +
    ((args.output ?? 0) / m) * rate.output
  );
}
