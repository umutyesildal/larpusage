"use client";

import { useMemo } from "react";
import type { JSX, Ref } from "react";
import type { Snapshot } from "@/lib/types";
import type { Settings } from "@/lib/settings";
import { compact, duration, money } from "@/lib/format";
import { providerById } from "@/lib/providers";
import { GITHUB_LABEL } from "@/lib/links";
import { ProviderLogo } from "./ProviderLogo";
import styles from "./share-card.module.css";

const GRID_DAYS = 140;

function levelFor(tokens: number, max: number): number {
  if (!tokens || tokens <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((tokens / max) * 4)));
}

export function ShareCard({
  snapshot,
  settings,
  innerRef,
}: {
  snapshot: Snapshot;
  settings: Settings;
  innerRef?: Ref<HTMLDivElement>;
}): JSX.Element {
  const grid = useMemo(() => {
    const days = snapshot.days.slice(-GRID_DAYS);
    const vals = days
      .map((d) => d.tokens)
      .filter((t) => t > 0)
      .sort((a, b) => a - b);
    const q = (p: number) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] ?? 1;
    const t1 = q(0.25);
    const t2 = q(0.5);
    const t3 = q(0.78);
    const t4 = q(0.94);
    return days.map((d) => ({
      day: d.day,
      level:
        d.tokens <= 0
          ? 0
          : d.tokens >= t4
            ? 4
            : d.tokens >= t3
              ? 3
              : d.tokens >= t2
                ? 2
                : 1,
    }));
  }, [snapshot.days]);

  const agents = useMemo(() => {
    const active = snapshot.tools.filter((t) => t.tokens > 0 || t.credits > 0);
    return (active.length ? active : snapshot.tools).length;
  }, [snapshot.tools]);

  const topTools = useMemo(
    () => snapshot.tools.filter((t) => t.tokens > 0 || t.credits > 0).slice(0, 4),
    [snapshot.tools],
  );

  const handle = settings.handle?.trim() || "profile";
  const streak = snapshot.totals.currentStreak;

  const rangeLabel = useMemo(() => {
    const from = snapshot.firstEventAt
      ? new Date(snapshot.firstEventAt).toLocaleDateString("en-US", {
          month: "short",
          year: "numeric",
        })
      : "";
    const to = new Date(snapshot.generatedAt).toLocaleDateString("en-US", {
      month: "short",
      year: "numeric",
    });
    return from ? `${from} – ${to}` : to;
  }, [snapshot.firstEventAt, snapshot.generatedAt]);

  const gridLabels = useMemo(() => {
    const days = snapshot.days.slice(-GRID_DAYS);
    const out: Array<{ col: number; label: string }> = [];
    let last = "";
    days.forEach((d, i) => {
      if (i % 7 !== 0) return;
      const label = new Date(d.day).toLocaleDateString("en-US", { month: "short" });
      if (label !== last) {
        out.push({ col: i / 7, label });
        last = label;
      }
    });
    return out;
  }, [snapshot.days]);

  return (
    <div className={styles.card} ref={innerRef} data-share-card>
      <div className={styles.top}>
        <div className={styles.brand}>
          <span className={styles.mark} aria-hidden />
          <span>token usage</span>
        </div>
        <div className={styles.range}>{rangeLabel}</div>
      </div>

      <div className={styles.main}>
        <div className={styles.left}>
          <div className={styles.identity}>
            <div className={styles.handle}>{handle}</div>
            <div className={styles.big}>{compact(snapshot.totals.lifetimeTokens)}</div>
            <div className={styles.sub}>
              tokens across {agents} agents
              {snapshot.firstEventAt
                ? ` since ${new Date(snapshot.firstEventAt).toLocaleDateString("en-US", {
                    month: "long",
                    year: "numeric",
                  })}`
                : ""}
            </div>
          </div>

          <div className={styles.stats}>
            <div className={styles.stat}>
              <div className={styles.statLabel}>Peak day</div>
              <div className={styles.statValue}>{compact(snapshot.totals.peakTokens)}</div>
            </div>
            <div className={styles.stat}>
              <div className={styles.statLabel}>Longest task</div>
              <div className={styles.statValue}>{duration(snapshot.totals.longestTaskMs)}</div>
            </div>
            <div className={styles.stat}>
              <div className={styles.statLabel}>Streak</div>
              <div className={styles.statValue}>
                {streak} {streak === 1 ? "day" : "days"}
              </div>
            </div>
            <div className={styles.stat}>
              <div className={styles.statLabel}>Active days</div>
              <div className={styles.statValue}>{snapshot.totals.activeDays}</div>
            </div>
          </div>

          <div className={styles.models}>
            <div className={styles.modelsLabel}>Top models</div>
            {snapshot.models.slice(0, 3).map((m) => (
              <div className={styles.modelRow} key={m.model}>
                <span className={styles.modelName}>{m.model}</span>
                <span className={styles.modelPct}>{Math.round(m.share * 100)}%</span>
              </div>
            ))}
          </div>

          <div className={styles.value}>
            <span className={styles.valueLabel}>API value</span>
            <span className={styles.valueNumber}>{money(snapshot.totals.costUsd)}</span>
            <span className={styles.valueNote}>at list prices</span>
          </div>
        </div>

        <div className={styles.right}>
          <div className={styles.gridWrap}>
            <div className={styles.gridHead}>
              <span>Daily tokens</span>
              <span>last 20 weeks</span>
            </div>
            <div className={styles.grid} aria-hidden>
              {grid.map((d) => (
                <span className={styles.cell} data-level={d.level} key={d.day} />
              ))}
            </div>
            <div className={styles.gridLabels} aria-hidden>
              {gridLabels.map((l) => (
                <span
                  key={`${l.label}-${l.col}`}
                  style={{
                    left: `${(l.col / (GRID_DAYS / 7)) * 100}%`,
                    transform: l.col === 0 ? "none" : undefined,
                  }}
                >
                  {l.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className={styles.foot}>
        <div className={styles.tools}>
          {topTools.map((t) => (
            <span className={styles.tool} key={t.tool}>
              <ProviderLogo provider={providerById(t.tool)} size={16} />
              <span>{t.label}</span>
              <em>{t.tokens > 0 ? compact(t.tokens) : `${Math.round(t.credits)} cr`}</em>
            </span>
          ))}
        </div>
        <div className={styles.repo}>{GITHUB_LABEL}</div>
      </div>
    </div>
  );
}
