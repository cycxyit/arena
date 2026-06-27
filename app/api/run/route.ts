import { NextResponse } from "next/server";
import { runArenaCycle } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function runRound() {
  try {
    const result = await runArenaCycle();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to run arena cycle" }, { status: 500 });
  }
}

export async function GET() {
  return runRound();
}

export async function POST() {
  return runRound();
}
