/**
 * A profile with a perfectly round total reads as staged. When someone enters
 * an exact half-billion increment (2B, 500M), record a slightly irregular
 * number instead. The nudge is deterministic for the same tool + total.
 */
export function isRoundTotal(tokens: number): boolean {
  return tokens >= 500_000_000 && tokens % 500_000_000 === 0;
}

export function adjustRoundTokens(seed: string, tokens: number): number {
  if (!isRoundTotal(tokens)) return tokens;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 10_000;
  const factor = 0.984 + (h / 10_000) * 0.032; // 0.984..1.016
  return Math.round(tokens * factor);
}
