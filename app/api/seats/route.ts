import { NextResponse } from "next/server";
import { addSeat, deleteSeat } from "@/lib/store";
import type { LlmProvider } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const providers = new Set(["openai", "openrouter", "gemini", "siliconflow", "local"]);

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body.name || !body.provider || !body.model || !providers.has(body.provider)) {
      return NextResponse.json({ error: "name, provider and model are required" }, { status: 400 });
    }
    return NextResponse.json(await addSeat({ ...body, provider: body.provider as LlmProvider }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to add seat" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = (await request.json()) as { id?: string };
    if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    return NextResponse.json(await deleteSeat(body.id));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to delete seat" }, { status: 500 });
  }
}