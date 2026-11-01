/**
 * Merge real and synthetic usage streams. Real data always wins.
 *
 * - Synthetic events on a day that has real events are dropped.
 * - Synthetic events after the earliest real event's day are dropped.
 * - Ids are deduplicated, preferring the real event.
 * - Output is sorted ascending by timestamp.
 *
 * When there are no real events at all, the synthetic stream is returned
 * (deduplicated and sorted). `backfillBefore` defaults to true: synthetic may
 * fill the period *before* the first real event. Set it to false to get a
 * real-only stream as soon as any real data exists.
 */

import { dayKey } from "@/lib/adapters/kit";
import type { UsageEvent } from "@/lib/types";

export function mergeSources(
  real: UsageEvent[],
  synthetic: UsageEvent[],
  opts?: { backfillBefore?: boolean },
): UsageEvent[] {
  if (real.length === 0) return finalize([], synthetic);
  if (opts?.backfillBefore === false) return finalize(real, []);

  const realDays = new Set(real.map((event) => dayKey(event.ts)));
  let earliest = real[0].ts;
  for (const event of real) {
    if (event.ts < earliest) earliest = event.ts;
  }
  const firstDay = dayKey(earliest);

  const kept = synthetic.filter((event) => {
    const day = dayKey(event.ts);
    if (realDays.has(day)) return false;
    return day < firstDay;
  });

  return finalize(real, kept);
}

function finalize(real: UsageEvent[], synthetic: UsageEvent[]): UsageEvent[] {
  const byId = new Map<string, UsageEvent>();

  // Real goes in first so an id collision is resolved in its favour.
  for (const event of real) {
    if (!byId.has(event.id)) byId.set(event.id, event);
  }
  for (const event of synthetic) {
    if (!byId.has(event.id)) byId.set(event.id, event);
  }

  return Array.from(byId.values()).sort(
    (a, b) => a.ts - b.ts || a.id.localeCompare(b.id),
  );
}
