import type { AssetClass, MarketCandle } from "@/lib/types";

type YahooResponse = {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }>;
  };
};

export function normalizeSymbol(symbol: string, assetClass: AssetClass) {
  const clean = symbol.trim().toUpperCase();
  if (!clean) return clean;
  if (assetClass === "crypto" && !clean.includes("-")) return `${clean}-USD`;
  if (assetClass === "forex" && !clean.endsWith("=X")) return `${clean}=X`;
  return clean;
}

export async function fetchYahooCandles(symbol: string): Promise<MarketCandle[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?interval=30m&range=5d&includePrePost=false`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": "ai-trading-arena/0.1"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Yahoo Finance returned ${response.status} for ${symbol}`);
  }

  const payload = (await response.json()) as YahooResponse;
  const result = payload.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  const timestamps = result?.timestamp ?? [];
  const closes = quote?.close ?? [];

  return timestamps
    .map((timestamp, index) => {
      const close = closes[index];
      const open = quote?.open?.[index] ?? close;
      const high = quote?.high?.[index] ?? close;
      const low = quote?.low?.[index] ?? close;
      if (close == null || open == null || high == null || low == null) return null;
      return {
        symbol,
        timestamp: timestamp * 1000,
        open,
        high,
        low,
        close,
        volume: quote?.volume?.[index] ?? 0
      };
    })
    .filter((candle): candle is MarketCandle => Boolean(candle));
}
