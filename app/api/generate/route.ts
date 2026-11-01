import { NextResponse } from "next/server";

import { generateSpec, type GenerateResult } from "@/lib/ai";
import type { Settings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPartialSettings(value: unknown): Partial<Settings> {
  return isRecord(value) ? (value as Partial<Settings>) : {};
}

function failure(note: string): GenerateResult {
  return { ok: false, engine: "local", note, spec: { sources: [] } };
}

function reply(result: GenerateResult): NextResponse {
  return NextResponse.json(result, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return reply(failure("That request was not valid JSON."));
  }

  if (!isRecord(body)) {
    return reply(failure("Send a JSON object with a prompt."));
  }

  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  const current = asPartialSettings(body.current);

  try {
    return reply(await generateSpec(prompt, current));
  } catch {
    return reply(failure("Generation failed. Try again."));
  }
}
