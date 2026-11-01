"use client";

import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

type AnimatedNumberProps = {
  value: number;
  format: (n: number) => string;
  duration?: number;
  className?: string;
};

export function AnimatedNumber({
  value,
  format,
  duration = 600,
  className,
}: AnimatedNumberProps): JSX.Element {
  const [display, setDisplay] = useState(value);
  const shown = useRef(value);
  const target = useRef(value);
  const raf = useRef<number | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    target.current = value;
  }, [value]);

  useEffect(() => {
    // First mount renders the final value; not a count-up.
    if (!mounted.current) {
      mounted.current = true;
      return;
    }

    if (raf.current !== null) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }

    const from = shown.current;
    const to = value;
    const ms = Number.isFinite(duration) ? Math.max(0, duration) : 0;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    if (reduce || ms === 0 || !Number.isFinite(from) || !Number.isFinite(to) || from === to) {
      shown.current = to;
      setDisplay(to);
      return;
    }

    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, Math.max(0, (now - start) / ms));
      const eased = 1 - Math.pow(1 - p, 3); // cubic ease-out
      const next = from + (to - from) * eased;
      shown.current = next;
      setDisplay(next);
      if (p < 1) {
        raf.current = requestAnimationFrame(tick);
      } else {
        shown.current = to;
        setDisplay(to);
        raf.current = null;
      }
    };
    raf.current = requestAnimationFrame(tick);

    return () => {
      if (raf.current !== null) {
        cancelAnimationFrame(raf.current);
        raf.current = null;
      }
    };
  }, [value, duration]);

  // If the user turns reduced motion on mid-count, stop and show the final value.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => {
      if (!mq.matches) return;
      if (raf.current !== null) {
        cancelAnimationFrame(raf.current);
        raf.current = null;
      }
      shown.current = target.current;
      setDisplay(target.current);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return <span className={className}>{format(display)}</span>;
}
