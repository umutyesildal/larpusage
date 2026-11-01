import type { ToolId } from "@/lib/types";

export type Provider = {
  id: string;
  label: string;
  tool: ToolId;
  model: string;
  models: string[];
  logo: string;
  mono: boolean;
};

export const GLM_MODELS = ["glm-5.3", "glm-5.3-flash", "glm-5v-turbo", "glm-5.2", "glm-5.1", "glm-5.1-highspeed", "glm-5", "glm-5-turbo", "glm-4.7", "glm-4.7-flashx", "glm-4.7-flash", "glm-4.6", "glm-4.5-air", "glm-4.5", "glm-4.6v", "glm-4.6v-flash", "glm-4.6v-flashx", "glm-4.1v-thinking-flashx", "glm-4.1v-thinking-flash", "glm-4-flashx-250414", "glm-4-flash-250414", "glm-4v-flash"];

export const PROVIDERS: Provider[] = [
  { id: "claude", label: "Claude", tool: "claude", models: ["claude-opus-5.5", "claude-sonnet-5.5", "claude-haiku-4.5"], model: "claude-opus-5.5", logo: "claude-color.svg", mono: false },
  { id: "codex", label: "ChatGPT", tool: "codex", models: ["gpt-5.6-sol", "gpt-6-astra", "gpt-5.6-terra"], model: "gpt-5.6-sol", logo: "openai.svg", mono: true },
  { id: "opencode", label: "OpenCode", tool: "opencode", models: ["glm-5.3", "qwen3.8-max", "claude-sonnet-5.5"], model: "glm-5.3", logo: "opencode.svg", mono: true },
  { id: "gemini", label: "Gemini", tool: "gemini", models: ["gemini-3.5-pro", "gemini-3.5-flash"], model: "gemini-3.5-flash", logo: "gemini-color.svg", mono: false },
  { id: "cursor", label: "Cursor", tool: "cursor", models: ["claude-sonnet-5.5", "gpt-5.6-sol"], model: "claude-sonnet-5.5", logo: "cursor.svg", mono: true },
  { id: "windsurf", label: "Windsurf", tool: "windsurf", models: ["swe-2-high", "claude-opus-5.5"], model: "swe-2-high", logo: "windsurf.svg", mono: true },
  { id: "devin", label: "Devin", tool: "devin", models: ["swe-2-high", "claude-opus-5.5", "gpt-6-sol"], model: "swe-2-high", logo: "devin.svg", mono: false },
  { id: "copilot", label: "Copilot", tool: "copilot", models: ["gpt-5.4", "claude-sonnet-5.5"], model: "gpt-5.4", logo: "copilot.svg", mono: true },
  { id: "qwen", label: "Qwen", tool: "qwen", models: ["qwen3.8-max", "qwen3.8-plus", "qwen3.8-flash"], model: "qwen3.8-max", logo: "qwen-color.svg", mono: false },
  { id: "kimi", label: "Kimi", tool: "kimi", models: ["kimi-k3", "kimi-k2.8"], model: "kimi-k3", logo: "kimi-color.svg", mono: false },
  { id: "deepseek", label: "DeepSeek", tool: "deepseek", models: ["deepseek-v4-pro", "deepseek-v4-flash"], model: "deepseek-v4-pro", logo: "deepseek-color.svg", mono: false },
  { id: "mistral", label: "Mistral", tool: "mistral", models: ["mistral-large-3", "mistral-medium-3"], model: "mistral-large-3", logo: "mistral-color.svg", mono: false },
  { id: "grok", label: "Grok", tool: "grok", models: ["grok-4.5", "grok-4"], model: "grok-4.5", logo: "grok.svg", mono: true },
  { id: "zai", label: "Z.ai", tool: "zai", models: GLM_MODELS, model: "glm-5.3", logo: "zai.svg", mono: true },
  { id: "zcode", label: "ZCode", tool: "zcode", models: GLM_MODELS, model: "glm-5.3", logo: "zcode.svg", mono: false },
  { id: "qoder", label: "Qoder", tool: "qoder", models: ["qwen3.8-max", "claude-sonnet-5.5"], model: "qwen3.8-max", logo: "qoder-color.svg", mono: false },
  { id: "amp", label: "Amp", tool: "amp", models: ["gpt-5.6-sol", "claude-sonnet-5.5"], model: "gpt-5.6-sol", logo: "amp-color.svg", mono: false },
  { id: "antigravity", label: "Antigravity", tool: "antigravity", models: ["gemini-3.5-pro", "gemini-3.5-flash"], model: "gemini-3.5-pro", logo: "antigravity-color.svg", mono: false },
  { id: "cline", label: "Cline", tool: "cline", models: ["claude-sonnet-5.5", "claude-opus-5.5"], model: "claude-sonnet-5.5", logo: "cline.svg", mono: true },
  { id: "roo", label: "Roo", tool: "roo", models: ["claude-sonnet-5.5", "claude-opus-5.5"], model: "claude-sonnet-5.5", logo: "roocode.svg", mono: true },
  { id: "kilo", label: "Kilo", tool: "kilo", models: ["claude-sonnet-5.5", "claude-opus-5.5"], model: "claude-sonnet-5.5", logo: "kilocode.svg", mono: true },
  { id: "goose", label: "Goose", tool: "goose", models: ["claude-sonnet-5.5", "claude-opus-5.5"], model: "claude-sonnet-5.5", logo: "goose.svg", mono: true },
];

export const PRIMARY = ["claude", "codex", "opencode"] as const;

const ALIASES: Record<string, string> = {
  manual: "claude",
};

export function providerById(id: string): Provider {
  const key = ALIASES[id] ?? id;
  return PROVIDERS.find((p) => p.id === key) ?? PROVIDERS[0];
}
