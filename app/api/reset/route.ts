import { NextResponse } from "next/server";
import { resetArenaCompetition } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    return NextResponse.json(await resetArenaCompetition());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to reset arena" }, { status: 500 });
  }
}