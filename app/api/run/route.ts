import { NextResponse } from "next/server";
import { runArenaCycle } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isAuthorized(request: Request) {
  const secret = process.env.RUN_SECRET?.trim();
  if (!secret) return true;
  const url = new URL(request.url);
  const provided = url.searchParams.get("secret") || request.headers.get("x-run-secret") || "";
  return provided === secret;
}

async function runRound(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized run request" }, { status: 401 });
  }
  try {
    const result = await runArenaCycle();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to run arena cycle" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return runRound(request);
}

export async function POST(request: Request) {
  return runRound(request);
}