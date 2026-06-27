import { NextResponse } from "next/server";
import { getArenaState } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const state = await getArenaState();
    return NextResponse.json(state);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load arena state" }, { status: 500 });
  }
}