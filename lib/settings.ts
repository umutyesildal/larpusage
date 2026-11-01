import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DATA_DIR, dataPath } from "@/lib/paths";

export type ManualEntry = {
  id: string;
  label: string;
  tool: string;
  tokens: number;
  from: string;
  to: string;
  shape: "even" | "ramp" | "frontload";
  model?: string;
};

export type Mode = "real" | "larp";

export type Settings = {
  handle: string;
  mode: Mode;
  fill: boolean;
  intensity: "indie" | "startup" | "seriesb" | "lab";
  seed: number;
  meters: { session: number; week: number };
  manual: ManualEntry[];
};

export const defaultSettings: Settings = {
  handle: "larpking",
  mode: "larp",
  fill: true,
  intensity: "startup",
  seed: 20261014,
  meters: { session: 800_000_000, week: 3_000_000_000 },
  manual: [],
};

// The hosted build cannot scan a laptop, so it starts from a composed profile
// instead of an empty one. Local installs still start with no added sources.
const hostedDemo: ManualEntry[] = [
  {
    id: "demo-zcode",
    label: "ZCode",
    tool: "zcode",
    tokens: 5_800_000_000,
    from: "2026-04-01",
    to: "2026-10-31",
    shape: "ramp",
    model: "glm-5.3",
  },
  {
    id: "demo-devin",
    label: "Devin",
    tool: "devin",
    tokens: 2_900_000_000,
    from: "2026-06-01",
    to: "2026-10-31",
    shape: "ramp",
    model: "swe-2-high",
  },
];

const DIR = DATA_DIR;
const FILE = dataPath("settings.json");

export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await readFile(FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...defaultSettings,
      ...parsed,
      meters: { ...defaultSettings.meters, ...(parsed.meters ?? {}) },
      manual: Array.isArray(parsed.manual) ? parsed.manual : [],
    };
  } catch {
    return process.env.VERCEL
      ? { ...defaultSettings, manual: hostedDemo }
      : defaultSettings;
  }
}

export async function saveSettings(next: Settings): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(next, null, 2), "utf8");
}
