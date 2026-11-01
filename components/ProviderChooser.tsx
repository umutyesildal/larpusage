"use client";

import { useEffect, useState } from "react";
import { PRIMARY, PROVIDERS, providerById, type Provider } from "@/lib/providers";
import { ProviderLogo } from "./ProviderLogo";
import styles from "./provider-chooser.module.css";

export function ProviderChooser({
  value,
  onChange,
}: {
  value: string;
  onChange: (provider: Provider) => void;
}) {
  const [all, setAll] = useState(false);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("providers") === "all") {
      setAll(true);
    }
  }, []);
  const current = providerById(value);
  const primary = PRIMARY.map((id) => providerById(id));

  if (all) {
    return (
      <div className={styles.wrap}>
        <div className={styles.allHead}>
          <button type="button" className={styles.back} onClick={() => setAll(false)}>
            ← Back
          </button>
          <span className={styles.allTitle}>All providers</span>
          <span className={styles.allCount}>{PROVIDERS.length}</span>
        </div>
        <div className={styles.allGrid} role="radiogroup" aria-label="All providers">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={p.id === value}
              className={`${styles.small} ${p.id === value ? styles.smallActive : ""}`}
              onClick={() => {
                onChange(p);
                setAll(false);
              }}
            >
              <ProviderLogo provider={p} size={20} />
              <span>{p.label}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.primaryGrid} role="radiogroup" aria-label="Provider">
        {primary.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={p.id === value}
            className={`${styles.card} ${p.id === value ? styles.cardActive : ""}`}
            onClick={() => onChange(p)}
          >
            <ProviderLogo provider={p} size={28} />
            <span className={styles.cardLabel}>{p.label}</span>
          </button>
        ))}
        <button
          type="button"
          className={styles.card}
          onClick={() => setAll(true)}
          aria-label="Choose another provider"
        >
          <span className={styles.more} aria-hidden>
            ···
          </span>
          <span className={styles.cardLabel}>Other</span>
        </button>
      </div>
      <div className={styles.selected}>
        <ProviderLogo provider={current} size={16} />
        <span>{current.label}</span>
        <span className={styles.selectedModel}>{current.model}</span>
      </div>
    </div>
  );
}
