/** Split a total into the same buckets the generator uses. */
export function splitTokens(total: number) {
  const output = Math.round(total * 0.1);
  const rest = Math.max(0, total - output);
  const input = Math.round(rest * 0.24);
  const cached = Math.max(0, rest - input);
  return { input, cached, output };
}
