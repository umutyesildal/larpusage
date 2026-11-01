"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import type { Snapshot } from "@/lib/types";
import type { ManualEntry, Mode, Settings } from "@/lib/settings";
import { compact, money } from "@/lib/format";
import { formatAmount } from "@/lib/amount";
import { costOf, rateFor } from "@/lib/pricing";
import { splitTokens } from "@/lib/tokens";
import { adjustRoundTokens, isRoundTotal } from "@/lib/realism";
import { providerById } from "@/lib/providers";
import { ProviderChooser } from "./ProviderChooser";
import { ProviderLogo } from "./ProviderLogo";
import styles from "./studio.module.css";

const SHAPES = [
  { value: "even", label: "Even" },
  { value: "ramp", label: "Ramp up" },
  { value: "frontload", label: "Front loaded" },
] as const;

type Generation = {
  sources: ManualEntry[];
  handle?: string;
  intensity?: Settings["intensity"];
  meters?: { session?: number; week?: number };
  engine: "ai" | "local";
};

function iso(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

function defaultRange() {
  const to = new Date();
  const from = new Date();
  from.setMonth(from.getMonth() - 6);
  return { from: iso(from), to: iso(to) };
}

function clone(settings: Settings): Settings {
  return {
    ...settings,
    meters: { ...settings.meters },
    manual: (settings.manual ?? []).map((m) => ({ ...m })),
  };
}

export function Studio({
  open,
  onClose,
  settings,
  snapshot,
  saving,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  snapshot: Snapshot;
  saving: boolean;
  onSave: (next: Settings) => Promise<void>;
}) {
  const uid = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Settings>(() => clone(settings));
  const [tab, setTab] = useState<"manual" | "ai">("manual");
  const [form, setForm] = useState(() => ({
    tool: "claude",
    label: "Claude",
    model: "claude-opus-5.5",
    amount: "5.8",
    unit: "B" as "M" | "B",
    ...defaultRange(),
    shape: "even" as ManualEntry["shape"],
  }));
  const [customModel, setCustomModel] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generation, setGeneration] = useState<Generation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(clone(settings));
    setError(null);
    setSaveError(null);
    setGeneration(null);
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const items = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const provider = providerById(form.tool);
  const tokens = useMemo(() => {
    const value = Number(form.amount);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.round(value * (form.unit === "B" ? 1_000_000_000 : 1_000_000));
  }, [form.amount, form.unit]);

  const canAdd = tokens >= 1_000_000 && form.from <= form.to && form.model.length > 0;

  const draftManualTokens = draft.manual.reduce((s, m) => s + (Number(m.tokens) || 0), 0);
  const realTokens = snapshot.totals.realLifetimeTokens;
  const previewTokens =
    draft.mode === "real"
      ? realTokens
      : realTokens +
        draftManualTokens +
        (draft.fill ? snapshot.totals.backfillLifetimeTokens : 0);
  const pendingSplit = splitTokens(tokens);
  const pendingCost =
    tokens > 0
      ? costOf({
          model: form.model,
          input: pendingSplit.input,
          cached: pendingSplit.cached,
          output: pendingSplit.output,
        })
      : null;

  const draftManualCost = draft.manual.reduce((sum, m) => {
    const value = Number(m.tokens) || 0;
    if (value <= 0) return sum;
    const split = splitTokens(value);
    return (
      sum +
      (costOf({
        model: m.model ?? "",
        input: split.input,
        cached: split.cached,
        output: split.output,
      }) ?? 0)
    );
  }, 0);

  const previewCost =
    draft.mode === "real"
      ? snapshot.totals.realCostUsd
      : snapshot.totals.realCostUsd +
        draftManualCost +
        (draft.fill ? snapshot.totals.backfillCostUsd : 0);

  const detected = snapshot.sources.filter((s) => s.found && s.tool !== "manual" && s.events > 0);

  const mini = useMemo(() => {
    const last = snapshot.days.slice(-84);
    const vals = last
      .map((d) => d.tokens)
      .filter((t) => t > 0)
      .sort((a, b) => a - b);
    const q = (p: number) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] ?? 1;
    const t1 = q(0.25);
    const t2 = q(0.5);
    const t3 = q(0.78);
    const t4 = q(0.94);
    return last.map((d) => ({
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
      day: d.day,
    }));
  }, [snapshot.days]);

  function setField(patch: Partial<typeof form>) {
    setForm((f) => ({ ...f, ...patch }));
  }

  function selectProvider(p: { tool: string; label: string; model: string; models: string[] }) {
    setCustomModel(false);
    setField({ tool: p.tool, label: p.label, model: p.model });
  }

  function addSource(e: FormEvent) {
    e.preventDefault();
    if (!canAdd) return;
    const recorded = adjustRoundTokens(`${form.tool}|${tokens}`, tokens);
    const entry: ManualEntry = {
      id: `src-${form.tool}-${Date.now().toString(36)}`,
      label: form.label,
      tool: form.tool,
      tokens: recorded,
      from: form.from,
      to: form.to,
      shape: form.shape,
      model: form.model,
    };
    setDraft((d) => ({ ...d, manual: [...d.manual, entry] }));
    setForm((f) => ({ ...f, amount: "" }));
    setError(null);
  }

  function removeSource(id: string) {
    setDraft((d) => ({ ...d, manual: d.manual.filter((m) => m.id !== id) }));
  }

  async function generate() {
    if (!prompt.trim() || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, current: draft }),
      });
      const data = await res.json();
      if (!data.ok && !data.spec?.sources?.length) {
        setError(data.note || "Could not build a spec.");
        return;
      }
      setGeneration({
        sources: data.spec.sources ?? [],
        handle: data.spec.handle,
        intensity: data.spec.intensity,
        meters: data.spec.meters,
        engine: data.engine === "ai" ? "ai" : "local",
      });
      if (data.note) setError(data.note);
    } catch {
      setError("The generator did not answer.");
    } finally {
      setGenerating(false);
    }
  }

  function applyGeneration() {
    if (!generation) return;
    setDraft((d) => ({
      ...d,
      handle: generation.handle ?? d.handle,
      intensity: generation.intensity ?? d.intensity,
      meters: {
        session: generation.meters?.session ?? d.meters.session,
        week: generation.meters?.week ?? d.meters.week,
      },
      manual: [
        ...d.manual,
        ...generation.sources.map((src) => ({
          ...src,
          tokens: adjustRoundTokens(`${src.tool}|${src.tokens}`, Number(src.tokens)),
        })),
      ],
    }));
    setGeneration(null);
    setPrompt("");
    setTab("manual");
  }

  async function save() {
    setSaveError(null);
    try {
      await onSave({
        ...draft,
        handle: draft.handle.trim() || "you",
        meters: {
          session: Math.max(1, draft.meters.session),
          week: Math.max(1, draft.meters.week),
        },
      });
      onClose();
    } catch {
      setSaveError("Could not save.");
    }
  }

  if (!open) return null;

  const generatedTokens = generation?.sources.reduce((s, x) => s + Number(x.tokens), 0) ?? 0;
  const modelOptions = Array.from(
    new Set([
      ...provider.models,
      ...(snapshot.toolModels[form.tool] ?? []).map((m) => m.model),
    ]),
  );
  const isCustomModel = customModel || !modelOptions.includes(form.model);

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <div
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        tabIndex={-1}
        ref={dialogRef}
      >
        <header className={styles.head}>
          <div>
            <h2 className={styles.title} id={`${uid}-title`}>
              Studio
            </h2>
            <p className={styles.subline}>Add usage, then save.</p>
          </div>

          <div className={styles.mode} role="radiogroup" aria-label="Data mode">
            {(["real", "larp"] as Mode[]).map((m) => (
              <label
                key={m}
                className={styles.modeOption}
                data-active={draft.mode === m ? "true" : undefined}
              >
                <input
                  type="radio"
                  name={`${uid}-mode`}
                  checked={draft.mode === m}
                  onChange={() => setDraft((d) => ({ ...d, mode: m }))}
                />
                <span>{m === "real" ? "Real" : "Larp"}</span>
              </label>
            ))}
          </div>

          <button type="button" className={styles.close} onClick={onClose}>
            Close
          </button>
        </header>

        <div className={styles.body}>
          <section className={styles.left}>
            {draft.mode === "real" ? (
              <div className={styles.realPane}>
                <h3 className={styles.paneTitle}>Real mode</h3>
                <p className={styles.realCopy}>
                  Real reads only what is on this machine. Nothing can be added here.
                  Switch to Larp to compose a profile.
                </p>
                <ul className={styles.realList}>
                  {detected.map((s) => {
                    const tool = snapshot.tools.find((t) => t.tool === s.tool);
                    const value =
                      s.units === "credits"
                        ? `${Math.round(tool?.credits ?? 0).toLocaleString("en-US")} credits`
                        : compact(tool?.tokens ?? 0);
                    return (
                      <li className={styles.realRow} key={s.tool}>
                        <ProviderLogo provider={providerById(s.tool)} size={20} />
                        <div>
                          <div className={styles.realLabel}>{s.label}</div>
                          <div className={styles.realMeta}>{s.events} requests</div>
                        </div>
                        <b className={styles.realValue}>{value}</b>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : (
              <div className={styles.addPane}>
                <div className={styles.tabs} role="tablist" aria-label="Add method">
                  <button
                    role="tab"
                    aria-selected={tab === "manual"}
                    className={styles.tab}
                    onClick={() => setTab("manual")}
                  >
                    Add tokens
                  </button>
                  <button
                    role="tab"
                    aria-selected={tab === "ai"}
                    className={styles.tab}
                    onClick={() => setTab("ai")}
                  >
                    Describe it
                  </button>
                </div>

                {tab === "manual" ? (
                  <form className={styles.form} onSubmit={addSource}>
                    <div className={styles.chooserWrap}>
                      <ProviderChooser
                        value={form.tool}
                        onChange={selectProvider}
                      />
                    </div>

                    <div className={styles.amountRow}>
                      <label className={styles.field}>
                        <span>Tokens</span>
                        <div className={styles.amount}>
                          <input
                            value={form.amount}
                            onChange={(e) =>
                              setField({
                                amount: e.target.value.replace(/[^\d.]/g, "").slice(0, 8),
                              })
                            }
                            inputMode="decimal"
                            placeholder="5.8"
                          />
                          <div className={styles.unit}>
                            {(["M", "B"] as const).map((u) => (
                              <button
                                key={u}
                                type="button"
                                className={form.unit === u ? styles.unitActive : ""}
                                onClick={() => setField({ unit: u })}
                              >
                                {u}
                              </button>
                            ))}
                          </div>
                        </div>
                        <em>
                          {tokens <= 0
                            ? "Amount in millions or billions"
                            : isRoundTotal(tokens)
                              ? `Will record ${formatAmount(
                                  adjustRoundTokens(`${form.tool}|${tokens}`, tokens),
                                )}`
                              : formatAmount(tokens)}
                        </em>
                      </label>

                      <label className={styles.field}>
                        <span>Model</span>
                        <select
                          value={isCustomModel ? "__custom" : form.model}
                          onChange={(e) => {
                            if (e.target.value === "__custom") {
                              setCustomModel(true);
                              setField({ model: "" });
                            } else {
                              setCustomModel(false);
                              setField({ model: e.target.value });
                            }
                          }}
                        >
                          {modelOptions.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                          <option value="__custom">Custom model…</option>
                        </select>
                        {isCustomModel && (
                          <input
                            value={form.model}
                            onChange={(e) => setField({ model: e.target.value })}
                            placeholder="model-id"
                            autoComplete="off"
                            maxLength={80}
                          />
                        )}
                        <em>
                          {rateFor(form.model)
                            ? "Priced from the rate card"
                            : form.model
                              ? "No rate for this model"
                              : "Enter a model id"}
                        </em>
                      </label>
                    </div>

                    <div className={styles.amountRow}>
                      <label className={styles.field}>
                        <span>From</span>
                        <input
                          type="date"
                          value={form.from}
                          onChange={(e) => setField({ from: e.target.value })}
                        />
                      </label>
                      <label className={styles.field}>
                        <span>To</span>
                        <input
                          type="date"
                          value={form.to}
                          onChange={(e) => setField({ to: e.target.value })}
                        />
                      </label>
                    </div>

                    <label className={styles.field}>
                      <span>Shape</span>
                      <select
                        value={form.shape}
                        onChange={(e) =>
                          setField({ shape: e.target.value as ManualEntry["shape"] })
                        }
                      >
                        {SHAPES.map((s) => (
                          <option key={s.value} value={s.value}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                      <em>How the total spreads across the range</em>
                    </label>

                    <button type="submit" className={styles.addButton} disabled={!canAdd}>
                      Add {tokens > 0 ? formatAmount(tokens) : "tokens"}
                    </button>
                    <p className={styles.formNote}>
                      {tokens > 0
                        ? `${formatAmount(tokens)} across ${form.from} → ${form.to}` +
                          (pendingCost !== null
                            ? ` · ≈ ${money(pendingCost)} at list prices`
                            : " · no rate for this model")
                        : "The total is split across the range with a weekday rhythm."}
                    </p>
                  </form>
                ) : (
                  <div className={styles.aiPane}>
                    <p className={styles.aiCopy}>
                      Describe the usage in a sentence. It becomes sources you can still edit.
                    </p>
                    <textarea
                      className={styles.prompt}
                      rows={5}
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder="Heavy Claude user since March, about 4B tokens, plus some Codex."
                      maxLength={2000}
                    />
                    <div className={styles.aiFoot}>
                      <span className={styles.hint}>
                        {generation
                          ? `${generation.sources.length} sources · ${compact(generatedTokens)} · ${generation.engine === "ai" ? "AI" : "local"}`
                          : "Nothing is added until you apply."}
                      </span>
                      <button
                        type="button"
                        className={styles.ghost}
                        onClick={() => void generate()}
                        disabled={generating || !prompt.trim()}
                      >
                        {generating ? "Generating…" : "Generate"}
                      </button>
                    </div>
                    {generation && (
                      <button type="button" className={styles.addButton} onClick={applyGeneration}>
                        Add {generation.sources.length} sources
                      </button>
                    )}
                    {error && <p className={styles.error}>{error}</p>}
                  </div>
                )}
              </div>
            )}
          </section>

          <aside className={styles.right}>
            <div className={styles.preview}>
              <div className={styles.previewHead}>
                <span>Preview</span>
                <span>{draft.mode === "real" ? "Real" : "Larp"}</span>
              </div>
              <input
                className={styles.nameInput}
                value={draft.handle}
                maxLength={24}
                onChange={(e) => setDraft((d) => ({ ...d, handle: e.target.value }))}
                aria-label="Handle"
              />
              <div className={styles.previewBig}>{compact(previewTokens)}</div>
              <div className={styles.previewMeta}>
                tokens · {detected.length + (draft.mode === "larp" ? draft.manual.length : 0)} sources
              </div>
              <div className={styles.mini} aria-hidden>
                {mini.map((d) => (
                  <span key={d.day} data-level={d.level} />
                ))}
              </div>
              <div className={styles.previewFoot}>
                <span>{money(previewCost)}</span>
                <span>at list prices</span>
              </div>
            </div>

            {draft.mode === "larp" && (
              <div className={styles.added}>
              <div className={styles.addedHead}>
                <span>Added</span>
                <span>{draft.manual.length}</span>
                </div>
              <ul className={styles.addedList}>
                {draft.manual.map((m) => (
                  <li className={styles.addedRow} key={m.id}>
                    {m.tool === "manual" ? (
                      <span className={styles.unknown} aria-hidden>
                        ?
                      </span>
                    ) : (
                      <ProviderLogo provider={providerById(m.tool)} size={18} />
                    )}
                    <span className={styles.addedLabel}>{m.label}</span>
                    <span className={styles.addedValue}>{compact(m.tokens)}</span>
                    <button
                      type="button"
                      className={styles.remove}
                      onClick={() => removeSource(m.id)}
                      aria-label={`Remove ${m.label}`}
                    >
                      ×
                    </button>
                  </li>
                ))}
                {!draft.manual.length && (
                  <li className={styles.addedEmpty}>Nothing added yet.</li>
                )}
              </ul>
              </div>

            )}
          </aside>
        </div>

        <footer className={styles.foot}>
          <div className={styles.footInfo}>
            <span>{compact(previewTokens)} tokens</span>
            <span>
              {detected.length + (draft.mode === "larp" ? draft.manual.length : 0)} sources
            </span>
            <span>Saved on this device</span>
          </div>
          <div className={styles.footActions}>
            <button type="button" className={styles.ghost} onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className={styles.primary}
              onClick={() => void save()}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </footer>

        {saveError && <p className={styles.error}>{saveError}</p>}
      </div>
    </>
  );
}
