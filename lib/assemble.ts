import { buildSnapshot, tokensOf } from "@/lib/aggregate";
import { getScan } from "@/lib/scan";
import { loadSettings } from "@/lib/settings";
import type { Snapshot, SourceStatus, UsageEvent } from "@/lib/types";
import { manualEvents, mergeRealAndSynthetic, syntheticEvents } from "@/lib/fabric";

export async function assemble(
  range: string,
  opts?: { fresh?: boolean; mode?: "real" | "larp" },
): Promise<{
  snapshot: Snapshot;
  settings: Awaited<ReturnType<typeof loadSettings>>;
}> {
  const [scan, settings] = await Promise.all([getScan({ fresh: opts?.fresh }), loadSettings()]);

  const mode = opts?.mode ?? settings.mode;
  const manual: UsageEvent[] = mode === "larp" && settings.manual.length
    ? manualEvents(settings.manual, settings.seed)
    : [];

  let events: UsageEvent[] = mergeRealAndSynthetic(scan.events, manual, {
    clipToBeforeFirstReal: false,
  });

  const sources: SourceStatus[] = [...scan.sources];

  if (manual.length) {
    sources.push({
      tool: "manual",
      label: "Custom",
      found: true,
      files: 0,
      events: manual.length,
      lastEventAt: Math.max(...manual.map((e) => e.ts)),
      fidelity: "exact",
      costSource: "computed",
      units: "tokens",
      warnings: [],
      ms: 0,
    });
  }

  if (mode === "larp" && settings.fill) {
    const perDay = new Map<string, number>();
    for (const e of scan.events) {
      const d = new Date(e.ts);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      perDay.set(key, (perDay.get(key) ?? 0) + tokensOf(e));
    }
    const vals = Array.from(perDay.values()).sort((a, b) => a - b);
    const baseline =
      vals.length > 0
        ? Math.max(400_000, vals[Math.floor(vals.length / 2)] * 0.05)
        : undefined;
    events = mergeRealAndSynthetic(
      events,
      syntheticEvents({
        seed: settings.seed,
        intensity: settings.intensity,
        days: 365,
        baseline,
      }),
      { clipToBeforeFirstReal: false },
    );
  }

  const snapshot = buildSnapshot({
    events,
    sources: sources.filter((s) => s.found || s.events > 0),
    range,
  });

  return { snapshot, settings };
}
