import { NextResponse } from "next/server";
import { addSymbol, deleteSymbol } from "@/lib/store";
import type { AssetClass } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const assetClasses = new Set(["stock", "forex", "crypto", "commodity"]);

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { symbol?: string; name?: string; assetClass?: AssetClass };
    if (!body.symbol || !body.assetClass || !assetClasses.has(body.assetClass)) {
      return NextResponse.json({ error: "symbol and assetClass are required" }, { status: 400 });
    }
    return NextResponse.json(await addSymbol(body.symbol, body.name ?? body.symbol, body.assetClass));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to add symbol" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = (await request.json()) as { symbol?: string };
    if (!body.symbol) return NextResponse.json({ error: "symbol is required" }, { status: 400 });
    return NextResponse.json(await deleteSymbol(body.symbol));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to delete symbol" }, { status: 500 });
  }
}