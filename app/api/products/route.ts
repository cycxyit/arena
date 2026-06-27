import { NextResponse } from "next/server";
import { searchProducts } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("q") ?? "";
    if (!query.trim()) return NextResponse.json({ results: [] });
    return NextResponse.json(await searchProducts(query));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to search products" }, { status: 500 });
  }
}