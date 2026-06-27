import { NextResponse } from "next/server";
import { runArenaCycle } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await runArenaCycle();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to run arena cycle" }, { status: 500 });
  }
}