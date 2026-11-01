"use client";

import { useEffect, useMemo, useState } from "react";
import type { Snapshot } from "@/lib/types";
import type { Mode, Settings } from "@/lib/settings";
import { clock, compact, dayLabel, duration, full, money } from "@/lib/format";
import { Heatmap } from "./Heatmap";
import { WeekBars } from "./WeekBars";
import { AnimatedNumber } from "./AnimatedNumber";
import { Studio } from "./Studio";
import { ShareButton } from "./ShareButton";
import { ProviderLogo } from "./ProviderLogo";
import { providerById } from "@/lib/providers";
import { GITHUB_URL } from "@/lib/links";

function streakOf(days: Snapshot["days"]) {
  const active = new Set(days.filter((d) => d.tokens > 0).map((d) => d.day));
  const sorted = Array.from(active).sort();
  let longest = 0;
  let run = 0;
  let prev: string | null = null;
  for (const day of sorted) {
    if (prev) {
      const diff = (Date.parse(day) - Date.parse(prev)) / 86_400_000;
      run = diff === 1 ? run + 1 : 1;
    } else run = 1;
    longest = Math.max(longest, run);
    prev = day;
  }
  let current = 0;
  const cursor = new Date();
  const key = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
  if (!active.has(key(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (active.has(key(cursor))) {
    current += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return { current, longest };
}

function streakStart(days: Snapshot["days"]): string | null {
  const active = new Set(days.filter((d) => d.tokens > 0).map((d) => d.day));
  const cursor = new Date();
  const key = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
  if (!active.has(key(cursor))) cursor.setDate(cursor.getDate() - 1);
  let first: string | null = null;
  while (active.has(key(cursor))) {
    first = key(cursor);
    cursor.setDate(cursor.getDate() - 1);
  }
  return first;
}

export function Profile({
  snapshot: initialSnapshot,
  settings: initialSettings,
  initialView = "grid",
}: {
  snapshot: Snapshot;
  settings: Settings;
  initialView?: "grid" | "bars";
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [settings, setSettings] = useState(initialSettings);
  const [mode, setMode] = useState<Mode>(initialSettings.mode);
  const [view, setView] = useState<"grid" | "bars">(initialView);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [modelTool, setModelTool] = useState<string | null>(
    initialSnapshot.tools[0]?.tool ?? null,
  );

  useEffect(() => {
    if (!snapshot.tools.length) return;
    if (!modelTool || !snapshot.tools.some((t) => t.tool === modelTool)) {
      setModelTool(snapshot.tools[0].tool);
    }
  }, [snapshot.tools, modelTool]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape") setOpen(false);
    };
    if (new URLSearchParams(window.location.search).get("studio") === "1") setOpen(true);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const days = snapshot.days;
  const total = days.reduce((s, d) => s + d.tokens, 0);
  const last30 = days.slice(-30).reduce((s, d) => s + d.tokens, 0);
  const last90 = days.slice(-90).reduce((s, d) => s + d.tokens, 0);
  const activeDays = days.filter((d) => d.tokens > 0).length;

  const peak = useMemo(
    () => days.reduce((best, d) => (d.tokens > best.tokens ? d : best), days[0]),
    [days],
  );
  const streaks = useMemo(() => streakOf(days), [days]);
  const runStart = useMemo(() => streakStart(days), [days]);
  const rangeCost = useMemo(() => days.reduce((s, d) => s + d.costUsd, 0), [days]);

  const today = days[days.length - 1];
  const last7 = days.slice(-7);
  const prev7 = days.slice(-8, -1);
  const avg7 = prev7.length ? prev7.reduce((s, d) => s + d.tokens, 0) / prev7.length : 0;
  const dayDelta = avg7 > 0 && today ? ((today.tokens - avg7) / avg7) * 100 : 0;
  const activeLast7 = last7.filter((d) => d.tokens > 0).length;

  const agentCount = new Set(snapshot.tools.map((t) => t.tool)).size;

  async function refresh(nextMode: Mode = mode, nextSettings = settings) {
    const res = await fetch(`/api/usage?mode=${nextMode}`, { cache: "no-store" });
    if (res.ok) setSnapshot((await res.json()) as Snapshot);
    setSettings(nextSettings);
  }

  async function switchMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    setSwitching(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...settings, mode: next }),
      });
      const data = (await res.json()) as { settings: Settings };
      await refresh(next, data.settings ?? { ...settings, mode: next });
    } finally {
      setSwitching(false);
    }
  }

  async function saveSettings(next: Settings) {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const data = (await res.json()) as { settings: Settings };
      const saved = data.settings ?? next;
      setMode(saved.mode);
      await refresh(saved.mode, saved);
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }

  function pickView(next: "grid" | "bars") {
    setView(next);
    window.history.replaceState(null, "", `?view=${next}`);
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="brand-mark" />
            <span>token</span>
          </div>

          <div className="top-actions">
            <div className="mode-toggle" role="group" aria-label="Data mode">
              <button
                className={mode === "real" ? "active" : ""}
                onClick={() => void switchMode("real")}
                aria-pressed={mode === "real"}
              >
                Real
              </button>
              <button
                className={mode === "larp" ? "active" : ""}
                onClick={() => void switchMode("larp")}
                aria-pressed={mode === "larp"}
              >
                Larp
              </button>
            </div>
            <ShareButton snapshot={snapshot} settings={settings} />
            <a
              className="pill gh"
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              aria-label="Open the GitHub repository"
            >
              GitHub
            </a>
            <button className="pill action" onClick={() => setOpen(true)} aria-label="Open studio">
              <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
                <path
                  d="M8 3.5v9M3.5 8h9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
              Studio
            </button>
          </div>
        </div>
      </header>

      <main className={`canvas ${switching ? "is-switching" : ""}`} aria-busy={switching}>
        <div className="rise">
          <h1 className="h1">{settings.handle}</h1>
          <p className="sub">
            <AnimatedNumber
              value={snapshot.totals.lifetimeTokens}
              format={(n) => compact(n)}
              className="tnum"
            />{" "}
            tokens across {agentCount} agents since{" "}
            {snapshot.firstEventAt
              ? new Date(snapshot.firstEventAt).toLocaleDateString("en-US", {
                  month: "long",
                  year: "numeric",
                })
              : "today"}
            .
          </p>
        </div>

        <section className="kpis panel rise" style={{ animationDelay: "40ms" }}>
          <div className="kpi">
            <div className="kpi-label">Lifetime tokens</div>
            <AnimatedNumber
              value={snapshot.totals.lifetimeTokens}
              format={(n) => compact(n)}
              className="kpi-value lead tnum"
            />
            <div className="kpi-foot tnum">{snapshot.totals.activeDays} active days</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Peak day</div>
            <AnimatedNumber
              value={peak?.tokens ?? 0}
              format={(n) => compact(n)}
              className="kpi-value tnum"
            />
            <div className="kpi-foot">{peak?.day ? dayLabel(peak.day) : "—"}</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Longest task</div>
            <div className="kpi-value tnum">{duration(snapshot.totals.longestTaskMs)}</div>
            <div className="kpi-foot">single session</div>
          </div>
          <div className="kpi">
            <div className="kpi-label">Streak</div>
            <div className="kpi-value tnum">{streaks.current} days</div>
            <div className="kpi-foot tnum">
              {runStart ? `since ${dayLabel(runStart)}` : `best ${streaks.longest}`}
            </div>
          </div>
        </section>

        <section className="activity panel rise" style={{ animationDelay: "90ms" }}>
          <div className="activity-head">
            <div>
              <h2 className="section-title">Token activity</h2>
              <div className="section-meta">
                last 12 months · {compact(total)} tokens · {activeDays} active days
              </div>
            </div>
            <div className="view-toggle" role="group" aria-label="Chart type">
              {(["grid", "bars"] as const).map((v) => (
                <button
                  key={v}
                  className={view === v ? "active" : ""}
                  onClick={() => pickView(v)}
                  aria-pressed={view === v}
                >
                  {v === "grid" ? "Grid" : "Bars"}
                </button>
              ))}
            </div>
          </div>

          <div className="period-strip">
            <div>
              <span>Last 30 days</span>
              <b className="tnum">{compact(last30)}</b>
            </div>
            <div>
              <span>Last 90 days</span>
              <b className="tnum">{compact(last90)}</b>
            </div>
            <div>
              <span>Last 12 months</span>
              <b className="tnum">{compact(total)}</b>
            </div>
          </div>

          {view === "bars" ? (
            <WeekBars days={days} />
          ) : (
            <Heatmap days={days} selected={selectedDay} onSelect={setSelectedDay} />
          )}

          {view === "grid" &&
            selectedDay &&
            (() => {
              const d = days.find((x) => x.day === selectedDay);
              if (!d) return null;
              return (
                <div className="day-detail tnum">
                  <span style={{ color: "var(--text)" }}>{dayLabel(d.day)}</span>
                  <span>{compact(d.tokens)} tokens</span>
                  <span>{full(d.requests)} requests</span>
                  <span>{d.costUsd > 0 ? money(d.costUsd) : "—"}</span>
                </div>
              );
            })()}
        </section>

        <section className="bottom rise" style={{ animationDelay: "140ms" }}>
          <div className="panel value-card">
            <div>
              <div className="kpi-label">API value</div>
              <div className="api-value">
                <AnimatedNumber
                  value={rangeCost}
                  format={(n) => money(n)}
                  className="big tnum"
                  duration={800}
                />
                <span className="note">at list prices</span>
              </div>
            </div>

            <div className="value-split">
              <div className="value-col">
                <div className="mini-label">By tool</div>
                {snapshot.tools
                  .filter((t) => t.tokens > 0)
                  .slice(0, 4)
                  .map((t) => (
                    <button
                      type="button"
                      className={`tool-row ${modelTool === t.tool ? "is-active" : ""}`}
                      key={t.tool}
                      onClick={() => setModelTool(t.tool)}
                      aria-pressed={modelTool === t.tool}
                    >
                      <span className="tool-logo">
                        {t.tool === "manual" ? (
                          <span className="tool-fallback">?</span>
                        ) : (
                          <ProviderLogo provider={providerById(t.tool)} size={15} />
                        )}
                      </span>
                      <span className="name">{t.label}</span>
                      <span className="track">
                        <span className="bar" style={{ width: `${Math.max(2, t.share * 100)}%` }} />
                      </span>
                      <span className="val">{compact(t.tokens)}</span>
                    </button>
                  ))}
              </div>

              <div className="value-col">
                <div className="mini-label">
                  By model ·{" "}
                  {snapshot.tools.find((t) => t.tool === modelTool)?.label ?? "all"}
                </div>
                {(snapshot.toolModels[modelTool ?? ""] ?? snapshot.models).slice(0, 4).map((m, _i, arr) => (
                  <div className="model-row" key={m.model}>
                    <span className="model-name" title={m.model}>
                      {m.model}
                    </span>
                    <span className="track">
                      <span className="bar" style={{ width: `${Math.max(2, m.share * 100)}%` }} />
                    </span>
                    <span className="model-pct tnum">{Math.round(m.share * 100)}%</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="section-meta tnum">
              {snapshot.totals.requests.toLocaleString("en-US")} requests ·{" "}
              {Math.round(snapshot.totals.credits).toLocaleString("en-US")} credits
            </div>
          </div>

          <div className="panel today-card">
            <div className="kpi-label">Today</div>
            <AnimatedNumber
              value={today?.tokens ?? 0}
              format={(n) => compact(n)}
              className="today-big tnum"
            />
            <div className="today-meta">
              <span className="today-delta tnum">
                {dayDelta >= 0 ? "+" : ""}
                {Math.abs(dayDelta).toFixed(0)}%
              </span>
              <span>vs 7-day average</span>
            </div>

            <div className="today-stats">
              <div>
                <span>Requests</span>
                <b className="tnum">{full(today?.requests ?? 0)}</b>
              </div>
              <div>
                <span>Cost</span>
                <b className="tnum">{money(today?.costUsd ?? 0)}</b>
              </div>
              <div>
                <span>Active</span>
                <b className="tnum">{activeLast7} / 7</b>
              </div>
            </div>

            <div className="week-bars" aria-hidden>
              {last7.map((d, i) => {
                const max = Math.max(...last7.map((x) => x.tokens), 1);
                const h = Math.max(3, Math.round((d.tokens / max) * 30));
                return (
                  <span
                    key={d.day}
                    className={i === last7.length - 1 ? "is-today" : ""}
                    style={{ height: h }}
                  />
                );
              })}
            </div>
          </div>
        </section>

        <footer className="footer">
          <div className="sources-inline">
            <span>
              <span className="dot live" />
              {snapshot.tools.length} sources
            </span>
            <span>{snapshot.totals.activeDays} days recorded</span>
          </div>
          <div className="tnum">collected {clock(snapshot.generatedAt)}</div>
        </footer>
      </main>

      <Studio
        open={open}
        onClose={() => setOpen(false)}
        settings={settings}
        snapshot={snapshot}
        saving={saving}
        onSave={saveSettings}
      />
    </div>
  );
}
