import { NextResponse } from "next/server";
import { loadSettings, saveSettings, type Settings } from "@/lib/settings";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await loadSettings());
}

export async function POST(request: Request) {
  const body = (await request.json()) as Partial<Settings>;
  const current = await loadSettings();
  const next: Settings = {
    ...current,
    ...body,
    meters: { ...current.meters, ...(body.meters ?? {}) },
    manual: Array.isArray(body.manual) ? body.manual : current.manual,
  };
  await saveSettings(next);
  return NextResponse.json({ ok: true, settings: next });
}
