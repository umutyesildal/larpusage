import type { Adapter } from "@/lib/types";
import { adapter as codex } from "./codex";
import { adapter as opencode } from "./opencode";
import { adapter as claude } from "./claude";
import { adapter as qoder } from "./qoder";
import { adapter as gemini } from "./gemini";
import { adapter as zcode } from "./zcode";
import { adapter as amp } from "./amp";
import { adapter as droid } from "./droid";
import { adapter as goose } from "./goose";
import { adapter as openclaw } from "./openclaw";
import { adapter as crush } from "./crush";
import { adapter as kimi } from "./kimi";
import { adapter as qwen } from "./qwen";
import { adapter as antigravity } from "./antigravity";
import { adapter as grok } from "./grok";
import { adapter as cline } from "./cline";
import { adapter as roo } from "./roo";
import { adapter as kilo } from "./kilo";
import { adapter as kiro } from "./kiro";
import { adapter as cursor } from "./cursor";
import { adapter as copilot } from "./copilot";
import { adapter as devin } from "./devin";

export const adapters: Adapter[] = [
  codex,
  opencode,
  claude,
  qoder,
  gemini,
  zcode,
  cline,
  roo,
  kilo,
  kiro,
  cursor,
  copilot,
  devin,
  amp,
  droid,
  goose,
  openclaw,
  crush,
  kimi,
  qwen,
  antigravity,
  grok,
];
