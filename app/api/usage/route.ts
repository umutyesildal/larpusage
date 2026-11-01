import { NextResponse } from "next/server";
import { assemble } from "@/lib/assemble";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const range = url.searchParams.get("range") ?? "365d";
  const fresh = url.searchParams.get("fresh") === "1";
  const modeParam = url.searchParams.get("mode");
  const mode = modeParam === "real" || modeParam === "larp" ? modeParam : undefined;
  const { snapshot } = await assemble(range, { fresh, mode });
  return NextResponse.json(snapshot, {
    headers: { "cache-control": "no-store" },
  });
}
