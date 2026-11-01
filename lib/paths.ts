import { join } from "node:path";

export const DATA_DIR =
  process.env.LARPUSAGE_DATA_DIR ||
  (process.env.VERCEL ? "/tmp/larpusage" : join(process.cwd(), ".data"));

export function dataPath(...parts: string[]): string {
  return join(DATA_DIR, ...parts);
}
