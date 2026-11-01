export function formatAmount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${trim(n / 1e12)}T`;
  if (abs >= 1e9) return `${trim(n / 1e9)}B`;
  if (abs >= 1e6) return `${trim(n / 1e6)}M`;
  if (abs >= 1e3) return `${trim(n / 1e3)}K`;
  return String(Math.round(n));
}

function trim(n: number): string {
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return n
    .toFixed(digits)
    .replace(/\.0+$/, "")
    .replace(/(\.\d)0$/, "$1");
}

export function parseAmount(input: string): number | null {
  const m = input.trim().match(/^([\d]*\.?[\d]+)\s*([kKmMbBtT])?$/);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = (m[2] ?? "").toLowerCase();
  const mult =
    unit === "k" ? 1e3 : unit === "m" ? 1e6 : unit === "b" ? 1e9 : unit === "t" ? 1e12 : 1;
  return Math.round(value * mult);
}

export function unitOf(input: string): "M" | "B" {
  return /b\s*$/i.test(input.trim()) ? "B" : "M";
}
