import { NextResponse } from "next/server";
import { listModels } from "@/lib/store";
import type { LlmProvider } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const providers = new Set(["openai", "openrouter", "gemini", "siliconflow"]);

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const provider = searchParams.get("provider") ?? "";
    if (!providers.has(provider)) {
      return NextResponse.json({ error: "provider is required" }, { status: 400 });
    }
    return NextResponse.json(await listModels(provider as LlmProvider));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to list models" }, { status: 500 });
  }
}
