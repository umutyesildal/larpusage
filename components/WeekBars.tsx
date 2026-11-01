"use client";

import { useMemo, useState } from "react";
import type { DayBucket } from "@/lib/types";
import { compact, dayLabel } from "@/lib/format";

const DAY = 86_400_000;

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function WeekBars({ days }: { days: DayBucket[] }) {
  const [hover, setHover] = useState<number | null>(null);

  const weeks = useMemo(() => {
    if (!days.length) return [];
    const end = new Date(days[days.length - 1].day);
    const endDay = startOfDay(end);
    const dow = new Date(endDay).getDay(); // 0 Sun
    const mondayOffset = (dow + 6) % 7;
    const endMonday = endDay - mondayOffset * DAY;
    const count = 52;
    const startMonday = endMonday - (count - 1) * 7 * DAY;

    const buckets = Array.from({ length: count }, (_, i) => ({
      start: startMonday + i * 7 * DAY,
      end: startMonday + i * 7 * DAY + 6 * DAY,
      tokens: 0,
    }));

    for (const d of days) {
      const [y, m, dd] = d.day.split("-").map(Number);
      const ts = new Date(y, (m ?? 1) - 1, dd ?? 1).getTime();
      const idx = Math.floor((ts - startMonday) / (7 * DAY));
      if (idx >= 0 && idx < count) buckets[idx].tokens += d.tokens;
    }
    return buckets;
  }, [days]);

  const max = useMemo(() => weeks.reduce((m, w) => Math.max(m, w.tokens), 0), [weeks]);
  const total = useMemo(() => weeks.reduce((s, w) => s + w.tokens, 0), [weeks]);
  const active = weeks.filter((w) => w.tokens > 0).length;

  const labels = useMemo(() => {
    const out: Array<{ i: number; label: string }> = [];
    let last = "";
    weeks.forEach((w, i) => {
      const d = new Date(w.start);
      const month = d.toLocaleDateString("en-US", { month: "short" });
      if (month !== last) {
        out.push({ i, label: month });
        last = month;
      }
    });
    return out;
  }, [weeks]);

  return (
    <div className="weekbars-wrap">
      <div className="weekbars-scale">
        <span className="tnum">{compact(max)}</span>
        <span className="tnum">0</span>
      </div>

      <div className="weekbars-main">
        <div
          className="weekbars"
          role="img"
          aria-label={`Weekly tokens, ${compact(total)} total`}
        >
          {weeks.map((w, i) => {
            const h = max > 0 ? Math.max(w.tokens > 0 ? 2 : 0, (w.tokens / max) * 100) : 0;
            return (
              <div
                key={w.start}
                className={`weekbar ${hover === i ? "is-hover" : ""} ${i === weeks.length - 1 ? "is-now" : ""}`}
                style={{ height: `${h}%` }}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              >
                <span className="weekbar-tip tnum">
                  <b>{compact(w.tokens)}</b>
                  <em>
                    {dayLabel(new Date(w.start).toISOString().slice(0, 10))} –{" "}
                    {dayLabel(new Date(w.end).toISOString().slice(0, 10))}
                  </em>
                </span>
              </div>
            );
          })}
        </div>

        <div className="weekbars-labels">
          {labels.map((l) => (
            <span key={`${l.label}-${l.i}`} style={{ left: `${(l.i / Math.max(1, weeks.length - 1)) * 100}%` }}>
              {l.label}
            </span>
          ))}
        </div>

        <div className="weekbars-meta tnum">
          <span>{compact(total)} tokens</span>
          <span>{active} active weeks</span>
          <span>peak {compact(max)}</span>
        </div>
      </div>
    </div>
  );
}
