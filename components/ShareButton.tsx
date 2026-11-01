"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { JSX } from "react";
import { createPortal } from "react-dom";
import { toPng } from "html-to-image";
import type { Snapshot } from "@/lib/types";
import type { Settings } from "@/lib/settings";
import { ShareCard } from "./ShareCard";
import styles from "./share-button.module.css";

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;

function fileName(handle: string): string {
  const clean = handle
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `token-${clean || "profile"}.png`;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

async function imagesReady(root: HTMLElement): Promise<void> {
  const images = Array.from(root.querySelectorAll("img"));
  await Promise.all(
    images.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete) {
            resolve();
            return;
          }
          let timer = 0;
          const done = () => {
            window.clearTimeout(timer);
            img.removeEventListener("load", done);
            img.removeEventListener("error", done);
            resolve();
          };
          timer = window.setTimeout(done, 3000);
          img.addEventListener("load", done);
          img.addEventListener("error", done);
        }),
    ),
  );
}

export function ShareButton({
  snapshot,
  settings,
}: {
  snapshot: Snapshot;
  settings: Settings;
}): JSX.Element {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(0.5);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const captureRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("share") === "1") {
      setOpen(true);
    }
  }, []);

  // Seed the preview scale from the viewport so opening the dialog does not
  // visibly resize; the ref measurement below corrects it once mounted.
  function openModal() {
    const availableWidth = Math.min(1200, window.innerWidth * 0.92) - 42;
    const availableHeight = Math.min(CARD_HEIGHT, window.innerHeight * 0.62);
    setScale(
      Math.max(0.2, Math.min(1, availableWidth / CARD_WIDTH, availableHeight / CARD_HEIGHT)),
    );
    setOpen(true);
  }

  // Modal behavior: scroll lock, focus in, focus trap, Esc, focus restore.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    setError(null);
    panelRef.current?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const root = panelRef.current;
      if (!root) return;
      const items = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);
      if (!items.length) {
        e.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === root)) {
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
      const target =
        previous && previous !== document.body && document.contains(previous)
          ? previous
          : triggerRef.current;
      target?.focus();
    };
  }, [open, close]);

  // Fit the 1200×630 card into the panel and the viewport.
  useEffect(() => {
    if (!open) return;
    const stage = stageRef.current;
    if (!stage) return;
    let frame = 0;

    function measure() {
      frame = 0;
      const el = stageRef.current;
      if (!el) return;
      const width = el.clientWidth;
      if (!width) return;
      const height = Math.min(CARD_HEIGHT, window.innerHeight * 0.62);
      setScale(Math.min(1, width / CARD_WIDTH, height / CARD_HEIGHT));
    }

    function schedule() {
      if (!frame) frame = window.requestAnimationFrame(measure);
    }

    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(stage);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [open]);

  async function download() {
    const node = captureRef.current;
    if (!node || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (document.fonts) await document.fonts.ready;
      await imagesReady(node);
      await nextFrame();

      const options = {
        pixelRatio: 2,
        backgroundColor: "#0a0a0b",
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
      };

      // A first warm-up pass primes html-to-image's asset cache: the real
      // capture then lands with the fonts and provider logos already inlined.
      await toPng(node, { ...options, pixelRatio: 1 });
      const dataUrl = await toPng(node, options);

      const link = document.createElement("a");
      link.href = dataUrl;
      link.download = fileName(settings.handle);
      link.rel = "noopener";
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch {
      setError("Could not export the image. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const modal = open ? (
    <>
      <div className={styles.backdrop} onClick={close} role="presentation" />
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-title`}
        tabIndex={-1}
        ref={panelRef}
      >
        <div className={styles.head}>
          <div>
            <h2 className={styles.title} id={`${uid}-title`}>
              Share
            </h2>
          </div>
        </div>

        <div className={styles.stageWrap} ref={stageRef}>
          <div
            className={styles.stage}
            style={{ width: CARD_WIDTH * scale, height: CARD_HEIGHT * scale }}
          >
            <div className={styles.stageInner} style={{ transform: `scale(${scale})` }}>
              <ShareCard snapshot={snapshot} settings={settings} />
            </div>
          </div>
        </div>

        <div className={styles.actions}>
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          <div className={styles.buttons}>
            <button type="button" className={styles.ghost} onClick={close}>
              Close
            </button>
            <button
              type="button"
              className={styles.primary}
              onClick={() => void download()}
              disabled={busy}
              aria-busy={busy}
            >
              {busy ? "Preparing…" : "Download PNG"}
            </button>
          </div>
        </div>
      </div>

      <div className={styles.capture} aria-hidden>
        <ShareCard snapshot={snapshot} settings={settings} innerRef={captureRef} />
      </div>
    </>
  ) : null;

  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        onClick={openModal}
        aria-haspopup="dialog"
        aria-expanded={open}
        ref={triggerRef}
      >
        Share
      </button>
      {modal && typeof document !== "undefined" ? createPortal(modal, document.body) : null}
    </>
  );
}
