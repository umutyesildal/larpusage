"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { DayBucket } from "@/lib/types";
import { compact, dayLabel } from "@/lib/format";

type Props = {
  days: DayBucket[];
  selected?: string | null;
  onSelect?: (day: string | null) => void;
};

type HeatCell = {
  day: string;
  tokens: number;
  level: number;
  col: number;
  row: number;
};

type TipSource = "pointer" | "key";

type Tip = {
  index: number;
  source: TipSource;
  col: number;
  day: string;
  tokens: number;
  x: number;
  y: number;
  above: boolean;
  hostW: number;
};

const DAY = 86_400_000;
const ROWS = 7;
const WEEKS = 53;
const EDGE_PAD = 12;
const TOOLTIP_FLIP_AT = 56;
const CELL_TRANSITION =
  "background-color 260ms ease, transform 100ms ease, box-shadow 160ms ease";

const SR_ONLY: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  return reduced;
}

function levels(days: DayBucket[]): Map<string, number> {
  const vals = days
    .map((d) => d.tokens)
    .filter((t) => t > 0)
    .sort((a, b) => a - b);
  const out = new Map<string, number>();
  if (!vals.length) return out;
  const q = (p: number) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
  const t1 = q(0.25);
  const t2 = q(0.5);
  const t3 = q(0.78);
  const t4 = q(0.94);
  for (const d of days) {
    let level = 0;
    if (d.tokens > 0) level = 1;
    if (d.tokens >= t1) level = 2;
    if (d.tokens >= t2) level = 3;
    if (d.tokens >= t3) level = 4;
    if (d.tokens >= t4) level = 4;
    out.set(d.day, level);
  }
  return out;
}

export function Heatmap({ days, selected, onSelect }: Props) {
  const [tip, setTip] = useState<Tip | null>(null);
  const [activeDay, setActiveDay] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [tipW, setTipW] = useState(0);
  const reduced = useReducedMotion();
  const hintId = useId();

  const wrap = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const tooltipEl = useRef<HTMLDivElement>(null);

  const { cells, months, total } = useMemo(() => {
    const map = new Map(days.map((d) => [d.day, d]));
    const levelMap = levels(days);
    const end = days.length ? new Date(days[days.length - 1].day) : new Date();
    const endMidnight = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    const endDow = endMidnight.getDay(); // 0 Sun
    const lastSunday = new Date(endMidnight.getTime() - endDow * DAY);
    const start = new Date(lastSunday.getTime() - (WEEKS - 1) * 7 * DAY);

    const cells: HeatCell[] = [];
    const months: Array<{ label: string; col: number }> = [];
    let lastMonth = -1;

    for (let w = 0; w < WEEKS; w++) {
      for (let r = 0; r < ROWS; r++) {
        const ts = start.getTime() + (w * 7 + r) * DAY;
        const d = new Date(ts);
        if (d > endMidnight) continue;
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
          d.getDate(),
        ).padStart(2, "0")}`;
        const bucket = map.get(key);
        cells.push({
          day: key,
          tokens: bucket?.tokens ?? 0,
          level: levelMap.get(key) ?? 0,
          col: w,
          row: r,
        });
        if (r === 0 && d.getMonth() !== lastMonth) {
          lastMonth = d.getMonth();
          months.push({ label: d.toLocaleDateString("en-US", { month: "short" }), col: w });
        }
      }
    }
    return {
      cells,
      months,
      total: days.reduce((s, d) => s + d.tokens, 0),
    };
  }, [days]);

  // A range switch rebuilds the cell map; never leave a stale tooltip behind.
  useEffect(() => {
    setTip(null);
  }, [days]);

  useIsomorphicLayoutEffect(() => {
    const el = tooltipEl.current;
    if (!el) return;
    const width = el.offsetWidth;
    if (Math.abs(width - tipW) > 0.5) setTipW(width);
  }, [tip, tipW]);

  // Track the active cell by day, not index, so an updated dataset cannot
  // silently move the focus ring to a different date.
  const active = activeDay === null ? -1 : cells.findIndex((c) => c.day === activeDay);
  const activeCell = active >= 0 ? cells[active] : null;
  const announcement = activeCell
    ? `${dayLabel(activeCell.day)}: ${compact(activeCell.tokens)} tokens`
    : "";
  const hoverIdx = tip && tip.source === "pointer" ? tip.index : null;
  const hotCol = tip ? tip.col : null;

  const hostW = tip?.hostW ?? 0;
  const maxAnchor = Math.max(EDGE_PAD, hostW - EDGE_PAD);
  const anchorX = tip ? Math.min(Math.max(tip.x, EDGE_PAD), maxAnchor) : 0;
  const halfW = Math.min(tipW / 2, Math.max(0, hostW / 2 - EDGE_PAD));
  const tooltipLeft = Math.min(
    Math.max(anchorX, EDGE_PAD + halfW),
    Math.max(EDGE_PAD + halfW, maxAnchor - halfW),
  );

  function elementAt(index: number): HTMLElement | null {
    const el = grid.current?.children.item(index);
    return el instanceof HTMLElement ? el : null;
  }

  function placeTip(index: number, source: TipSource, cellEl?: HTMLElement | null) {
    const hostEl = wrap.current;
    if (!hostEl) return;
    const el = cellEl ?? elementAt(index);
    const cell = cells[index];
    if (!el || !cell) return;
    const host = hostEl.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const above = rect.top - host.top >= TOOLTIP_FLIP_AT;
    setTip({
      index,
      source,
      col: cell.col,
      day: cell.day,
      tokens: cell.tokens,
      x: rect.left - host.left + rect.width / 2,
      y: above ? rect.top - host.top - 8 : rect.bottom - host.top + 8,
      above,
      hostW: host.width,
    });
  }

  function nearestIndex(col: number, row: number): number {
    if (!cells.length) return -1;
    let minCol = cells[0].col;
    let maxCol = cells[0].col;
    for (const c of cells) {
      if (c.col < minCol) minCol = c.col;
      if (c.col > maxCol) maxCol = c.col;
    }
    const targetCol = Math.min(Math.max(col, minCol), maxCol);
    let minRow = ROWS;
    let maxRow = -1;
    for (const c of cells) {
      if (c.col !== targetCol) continue;
      if (c.row < minRow) minRow = c.row;
      if (c.row > maxRow) maxRow = c.row;
    }
    const targetRow = Math.min(Math.max(row, minRow), maxRow);
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (c.col === targetCol && c.row === targetRow) return i;
    }
    return -1;
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (!cells.length) return;
    // Leave browser/OS shortcuts (Cmd+Arrow, etc.) alone.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    const isArrow =
      k === "ArrowLeft" || k === "ArrowRight" || k === "ArrowUp" || k === "ArrowDown";
    const activate = k === "Enter" || k === " " || k === "Spacebar";
    if (!isArrow && !activate && k !== "Escape" && k !== "Home" && k !== "End") return;
    e.preventDefault();

    if (k === "Escape") {
      setTip(null);
      return;
    }

    const current = active >= 0 ? active : cells.length - 1;

    if (activate) {
      if (active < 0) setActiveDay(cells[current].day);
      if (tip && tip.source === "key" && tip.index === current) setTip(null);
      else placeTip(current, "key");
      return;
    }

    let next = current;
    if (k === "Home") next = 0;
    else if (k === "End") next = cells.length - 1;
    else {
      const c = cells[current];
      let col = c.col;
      let row = c.row;
      if (k === "ArrowLeft") col -= 1;
      else if (k === "ArrowRight") col += 1;
      else if (k === "ArrowUp") row -= 1;
      else if (k === "ArrowDown") row += 1;
      const found = nearestIndex(col, row);
      if (found !== -1) next = found;
    }

    setActiveDay(cells[next].day);
    if (next !== current && tip && tip.source === "key") placeTip(next, "key");
  }

  return (
    <div className="heat-wrap">
      <div className="heat-weekdays" aria-hidden>
        <span />
        <span>Mon</span>
        <span />
        <span>Wed</span>
        <span />
        <span>Fri</span>
        <span />
      </div>
      <div className="heat-main" ref={wrap}>
        <div className="heat-months" aria-hidden>
          {months.map((m) => (
            <span key={`${m.label}-${m.col}`} style={{ left: `${(m.col / WEEKS) * 100}%` }}>
              {m.label}
            </span>
          ))}
        </div>
        <div
          ref={grid}
          className="heat-grid"
          role="img"
          aria-label={`Token activity, ${compact(total)} tokens`}
          aria-describedby={hintId}
          tabIndex={0}
          style={{ outline: "none" }}
          onMouseLeave={() => setTip((t) => (t && t.source === "pointer" ? null : t))}
          onKeyDown={onKeyDown}
          onFocus={() => {
            setFocused(true);
            if (active < 0) {
              if (!cells.length) return;
              const fallback =
                tip && tip.source === "pointer" && tip.index < cells.length
                  ? tip.index
                  : cells.length - 1;
              const cell = cells[fallback];
              if (cell) setActiveDay(cell.day);
            }
          }}
          onBlur={() => {
            setFocused(false);
            setTip((t) => (t && t.source === "key" ? null : t));
          }}
        >
          {cells.map((c, index) => {
            const isHover = hoverIdx === index;
            const isHot = hotCol === c.col;
            const focusRing = focused && active === index && !isHover;
            const shadows: string[] = [];
            if (selected === c.day) shadows.push("inset 0 0 0 2px rgba(90, 163, 240, 0.9)");
            if (focusRing) shadows.push("inset 0 0 0 2px rgba(255, 255, 255, 0.92)");
            shadows.push(
              `inset 0 0 0 999px rgba(255, 255, 255, ${isHot ? 0.055 : 0})`,
            );
            return (
              <div
                key={c.day}
                className="cell"
                data-level={c.level}
                data-col={c.col}
                style={{
                  transform: isHover && !reduced ? "scale(1.15)" : "none",
                  transition: reduced ? "none" : CELL_TRANSITION,
                  boxShadow: shadows.join(", "),
                  position: isHover ? "relative" : undefined,
                  zIndex: isHover ? 2 : undefined,
                }}
                onMouseEnter={(e: ReactMouseEvent<HTMLDivElement>) => {
                  placeTip(index, "pointer", e.currentTarget);
                }}
                onClick={(e: ReactMouseEvent<HTMLDivElement>) => {
                  setActiveDay(c.day);
                  // Touch devices do not hover; a tap should still reveal the day.
                  placeTip(index, "pointer", e.currentTarget);
                  onSelect?.(selected === c.day ? null : c.day);
                }}
              />
            );
          })}
        </div>
        {tip && (
          <div
            ref={tooltipEl}
            className="tooltip tnum"
            aria-hidden
            style={{
              left: tooltipLeft,
              top: tip.y,
              transform: tip.above ? "translate(-50%, -100%)" : "translate(-50%, 0)",
              maxWidth: Math.max(0, tip.hostW - EDGE_PAD * 2),
            }}
          >
            <b>{compact(tip.tokens)} tokens</b>
            <div style={{ opacity: 0.72, marginTop: 2 }}>{dayLabel(tip.day)}</div>
          </div>
        )}
        <div className="heat-legend">
          <span>Less</span>
          {[0, 1, 2, 3, 4].map((l) => (
            <span
              key={l}
              className="cell"
              data-level={l}
              style={reduced ? { transform: "none", transition: "none" } : undefined}
            />
          ))}
          <span>More</span>
        </div>
      </div>
      <div id={hintId} style={SR_ONLY}>
        Token activity heatmap. Use arrow keys to move between days. Press Enter or Space for
        details.
      </div>
      <div aria-live="polite" aria-atomic="true" style={SR_ONLY}>
        {focused ? announcement : ""}
      </div>
    </div>
  );
}
