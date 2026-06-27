import { createClient } from "@libsql/client";
import type {
  AgentDecision,
  AgentProfile,
  ArenaState,
  AssetClass,
  IndicatorSnapshot,
  LlmProvider,
  MarketCandle,
  Position,
  TradingSymbol
} from "@/lib/types";
import type { ProductResult, SeatInput } from "@/lib/store";

const STARTING_CAPITAL = 10000;
const MIN_SLIPPAGE_BPS = 5;
const MAX_SLIPPAGE_BPS = 20;
const MIN_TRADE_NOTIONAL = 10;
const HISTORY_DAYS = 730;
const MAX_CANDLES = 760;
const DATA_SOURCE = "Alpha Vantage + Yahoo Finance";
const REQUEST_DELAY_SECONDS = Number(process.env.ALPHAVANTAGE_REQUEST_DELAY_SECONDS || "1.1");
const LLM_TIMEOUT_SECONDS = Number(process.env.LLM_TIMEOUT_SECONDS || "60");

type PersistedArenaState = ArenaState & { candles?: Record<string, MarketCandle[]> };
type MarketSnapshot = {
  symbol: string;
  last_close: number;
  one_day_return: number;
  six_day_return: number;
  volatility_12d: number;
  indicators: IndicatorSnapshot;
  latest_bars: Array<{ date: string; close: number; volume: number }>;
};

const providerKeyEnv: Record<LlmProvider, string> = {
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  gemini: "GEMINI_API_KEY",
  siliconflow: "SILICONFLOW_API_KEY",
  local: ""
};

const defaultSymbols: TradingSymbol[] = [
  { symbol: "AAPL", name: "Apple", assetClass: "stock", active: true },
  { symbol: "NVDA", name: "NVIDIA", assetClass: "stock", active: true },
  { symbol: "EURUSD", name: "EUR/USD", assetClass: "forex", active: true },
  { symbol: "BTC-USD", name: "Bitcoin", assetClass: "crypto", active: true },
  { symbol: "XAUUSD", name: "Gold USD proxy", assetClass: "commodity", active: true }
];

const defaultSeats: AgentProfile[] = [
  makeSeat("openai", "OpenAI Seat", "openai", env("OPENAI_MODEL") || "gpt-4o-mini", "LLM macro + price action", "medium", "#111111"),
  makeSeat("openrouter", "OpenRouter Seat", "openrouter", env("OPENROUTER_MODEL") || "openai/gpt-4o-mini", "Router model cross-check", "medium", "#2563eb"),
  makeSeat("gemini", "Gemini Seat", "gemini", env("GEMINI_MODEL") || "gemini-1.5-flash", "LLM pattern synthesis", "low", "#0f766e"),
  makeSeat("siliconflow", "SiliconFlow Seat", "siliconflow", env("SILICONFLOW_MODEL") || "Qwen/Qwen2.5-72B-Instruct", "LLM momentum scout", "high", "#7c3aed")
];

const client = createClient({
  url: process.env.TURSO_DATABASE_URL || "file:data/arena.db",
  authToken: process.env.TURSO_AUTH_TOKEN
});

function env(name: string) {
  return process.env[name]?.trim() ?? "";
}

function makeSeat(
  id: string,
  name: string,
  provider: LlmProvider,
  model: string,
  style: string,
  risk: AgentProfile["risk"],
  color: string
): AgentProfile {
  return { id, name, provider, model, style, risk, color, prompt: "", kind: "llm", enabled: false };
}

function withRuntimeFlags(agent: AgentProfile): AgentProfile {
  const keyEnv = providerKeyEnv[agent.provider];
  return { ...agent, prompt: effectivePrompt(agent), enabled: Boolean(keyEnv && env(keyEnv)) };
}

function defaultPrompt(agent: Pick<AgentProfile, "risk" | "style">) {
  return `Act as a disciplined ${agent.risk || "medium"}-risk trading analyst running the ${agent.style || "balanced multi-asset strategy"}. For every daily round, combine technical analysis and fundamental/macro context. Technical checks: trend, momentum, volatility, recent volume, support/resistance, and risk/reward. Fundamental checks: business quality for stocks, macro/rates context for FX, liquidity/adoption/regime for crypto, and real rates/USD/liquidity for commodities. Prefer capital preservation, avoid overtrading, size conviction cautiously, and explain the key risk in the thesis.`;
}

function effectivePrompt(agent: AgentProfile) {
  return agent.prompt?.trim() || defaultPrompt(agent);
}

async function ensureTable() {
  await client.execute(`
    create table if not exists arena_state (
      id text primary key,
      payload text not null,
      updated_at integer not null
    )
  `);
}

function initialState(): PersistedArenaState {
  const timestamp = Date.now();
  const cash = Object.fromEntries(defaultSeats.map((agent) => [agent.id, STARTING_CAPITAL]));
  return {
    symbols: defaultSymbols,
    agents: defaultSeats.map(withRuntimeFlags),
    decisions: [],
    equity: defaultSeats.map((agent) => ({ agentId: agent.id, timestamp, equity: STARTING_CAPITAL })),
    positions: [],
    orders: [],
    cash,
    startingCapital: STARTING_CAPITAL,
    indicators: {},
    latestPrices: {},
    candles: {},
    dataStatus: { source: DATA_SOURCE, entitlement: "daily", interval: "1day", errors: [], lastSyncAt: null },
    updatedAt: timestamp
  };
}

async function loadState(): Promise<PersistedArenaState> {
  await ensureTable();
  const result = await client.execute({ sql: "select payload from arena_state where id = ?", args: ["default"] });
  const payload = result.rows[0]?.payload;
  const state = typeof payload === "string" ? (JSON.parse(payload) as PersistedArenaState) : initialState();
  state.symbols ||= defaultSymbols;
  state.agents = (state.agents?.length ? state.agents : defaultSeats).map(withRuntimeFlags);
  state.decisions ||= [];
  state.equity ||= [];
  state.positions ||= [];
  state.orders ||= [];
  state.cash ||= Object.fromEntries(state.agents.map((agent) => [agent.id, STARTING_CAPITAL]));
  state.indicators ||= {};
  state.latestPrices ||= {};
  state.candles ||= {};
  state.startingCapital = STARTING_CAPITAL;
  state.dataStatus ||= { source: DATA_SOURCE, entitlement: "daily", interval: "1day", errors: [], lastSyncAt: null };
  state.dataStatus.source = DATA_SOURCE;
  state.dataStatus.interval = "1day";
  state.dataStatus.entitlement = "daily";
  state.updatedAt = Date.now();
  return state;
}

async function saveState(state: PersistedArenaState) {
  state.updatedAt = Date.now();
  state.agents = state.agents.map((agent) => ({ ...agent, enabled: Boolean(providerKeyEnv[agent.provider] && env(providerKeyEnv[agent.provider])) }));
  await ensureTable();
  await client.execute({
    sql: "insert into arena_state (id, payload, updated_at) values (?, ?, ?) on conflict(id) do update set payload = excluded.payload, updated_at = excluded.updated_at",
    args: ["default", JSON.stringify(state), state.updatedAt]
  });
}

function publicState(state: PersistedArenaState): ArenaState {
  const { candles: _candles, ...rest } = state;
  return { ...rest, agents: rest.agents.map(withRuntimeFlags) };
}

export async function getTursoArenaState() {
  return publicState(await loadState());
}

export async function addTursoSymbol(symbol: string, name: string, assetClass: AssetClass) {
  const state = await loadState();
  const normalized = normalizeSymbol(symbol, assetClass);
  state.symbols = state.symbols.filter((item) => item.symbol !== normalized);
  state.symbols.push({ symbol: normalized, name: name || normalized, assetClass, active: true });
  state.dataStatus.errors = state.dataStatus.errors.filter((message) => !message.toUpperCase().startsWith(`${normalized}:`));
  await saveState(state);
  return { symbol: normalized };
}

export async function deleteTursoSymbol(symbol: string) {
  const state = await loadState();
  const normalized = symbol.trim().toUpperCase();
  state.symbols = state.symbols.filter((item) => item.symbol !== normalized);
  delete state.latestPrices[normalized];
  delete state.indicators?.[normalized];
  delete state.candles?.[normalized];
  state.positions = (state.positions ?? []).filter((item) => item.symbol !== normalized);
  state.dataStatus.errors = state.dataStatus.errors.filter((message) => !message.toUpperCase().startsWith(`${normalized}:`));
  await saveState(state);
  return { symbol: normalized };
}

export async function addTursoSeat(input: SeatInput) {
  const state = await loadState();
  const provider = input.provider;
  const id = normalizeId(input.id || input.name || `${provider}-seat`);
  const risk = input.risk && ["low", "medium", "high"].includes(input.risk) ? input.risk : "medium";
  const agent = withRuntimeFlags({
    id,
    name: input.name || `${provider} Seat`,
    provider,
    model: input.model || defaultModel(provider),
    kind: input.kind || "llm",
    style: input.style || "Custom LLM strategy",
    risk,
    color: input.color || "#111111",
    prompt: input.prompt || "",
    enabled: false
  });
  state.agents = state.agents.filter((item) => item.id !== id).concat(agent);
  state.cash ||= {};
  state.cash[id] ??= STARTING_CAPITAL;
  if (!state.equity.some((point) => point.agentId === id)) {
    state.equity.push({ agentId: id, timestamp: Date.now(), equity: STARTING_CAPITAL });
  }
  await saveState(state);
  return { id };
}

export async function deleteTursoSeat(id: string) {
  const state = await loadState();
  const clean = normalizeId(id);
  state.agents = state.agents.filter((item) => item.id !== clean);
  state.decisions = state.decisions.filter((item) => item.agentId !== clean);
  state.equity = state.equity.filter((item) => item.agentId !== clean);
  state.positions = (state.positions ?? []).filter((item) => item.agentId !== clean);
  state.orders = (state.orders ?? []).filter((item) => item.agentId !== clean);
  if (state.cash) delete state.cash[clean];
  await saveState(state);
  return { id: clean };
}


export async function searchTursoProducts(query: string): Promise<{ results: ProductResult[] }> {
  const keyword = query.trim();
  if (!keyword) return { results: [] };
  const normalized = keyword.toUpperCase().replace(/[\s/]/g, "");
  const results: ProductResult[] = [];

  for (const [symbol, name] of FX_PRODUCTS) {
    if (symbol.includes(normalized) || name.toLowerCase().includes(keyword.toLowerCase())) {
      results.push({ symbol, name, assetClass: "forex", type: "FX", region: "Global", currency: "" });
    }
  }
  for (const [symbol, name] of CRYPTO_PRODUCTS) {
    if (symbol.replace("-", "").includes(normalized.replace("-", "")) || name.toLowerCase().includes(keyword.toLowerCase())) {
      results.push({ symbol, name, assetClass: "crypto", type: "Crypto", region: "Global", currency: "USD" });
    }
  }
  for (const [symbol, name, yahooSymbol] of COMMODITY_PRODUCTS) {
    const aliases = [symbol, yahooSymbol, name].map((item) => item.toUpperCase().replace(/[\s=/-]/g, ""));
    if (aliases.some((alias) => alias.includes(normalized.replace(/[=/-]/g, ""))) || name.toLowerCase().includes(keyword.toLowerCase())) {
      results.push({ symbol, name, assetClass: "commodity", type: "Commodity", region: "Global", currency: "USD" });
    }
  }

  try {
    const payload = await alphaQuery({ function: "SYMBOL_SEARCH", keywords: keyword });
    for (const item of (payload.bestMatches ?? []).slice(0, 12)) {
      const symbol = String(item["1. symbol"] ?? "").trim();
      const name = String(item["2. name"] ?? "").trim();
      if (!symbol || !name) continue;
      results.push({ symbol, name, assetClass: "stock", type: item["3. type"] || "Equity", region: item["4. region"] || "", currency: item["8. currency"] || "" });
    }
  } catch (error) {
    if (!results.length) {
      results.push({ symbol: "", name: `Alpha Vantage search failed: ${error instanceof Error ? error.message : String(error)}`, assetClass: "stock", type: "error", region: "", currency: "" });
    }
  }

  const seen = new Set<string>();
  return { results: results.filter((item) => { const key = `${item.assetClass}:${item.symbol}`; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 20) };
}

export async function listTursoModels(provider: LlmProvider) {
  const key = env(providerKeyEnv[provider]);
  const headers: Record<string, string> = { "User-Agent": "ai-arena/0.5" };
  if (provider === "openai") {
    if (!key) return { models: [], error: "Missing OPENAI_API_KEY in environment variables" };
    const payload = await jsonFetch("https://api.openai.com/v1/models", { headers: { ...headers, Authorization: `Bearer ${key}` } });
    return { models: (payload.data ?? []).map((item: { id?: string }) => item.id).filter(Boolean).sort() };
  }
  if (provider === "openrouter") {
    const requestHeaders: Record<string, string> = { ...headers, "HTTP-Referer": env("NEXT_PUBLIC_SITE_URL") || "https://vercel.app", "X-Title": "AI Trading Arena" };
    if (key) requestHeaders.Authorization = `Bearer ${key}`;
    const payload = await jsonFetch("https://openrouter.ai/api/v1/models", { headers: requestHeaders });
    return { models: (payload.data ?? []).map((item: { id?: string }) => item.id).filter(Boolean).sort() };
  }
  if (provider === "siliconflow") {
    if (!key) return { models: [], error: "Missing SILICONFLOW_API_KEY in environment variables" };
    const payload = await jsonFetch("https://api.siliconflow.com/v1/models", { headers: { ...headers, Authorization: `Bearer ${key}` } });
    return { models: (payload.data ?? []).map((item: { id?: string }) => item.id).filter(Boolean).sort() };
  }
  if (provider === "gemini") {
    if (!key) return { models: [], error: "Missing GEMINI_API_KEY in environment variables" };
    const payload = await jsonFetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`, { headers });
    return { models: (payload.models ?? []).map((item: { name?: string; supportedGenerationMethods?: string[] }) => item.supportedGenerationMethods?.includes("generateContent") ? item.name?.replace("models/", "") : "").filter(Boolean).sort() };
  }
  return { models: [] };
}

export async function runTursoArenaCycle() {
  const state = await loadState();
  const synced: string[] = [];
  const updated: string[] = [];
  const backfilled: string[] = [];
  const failed: string[] = [];
  const errors: string[] = [];
  state.candles ||= {};

  const activeSymbols = state.symbols.filter((symbol) => symbol.active);
  for (let symbolIndex = 0; symbolIndex < activeSymbols.length; symbolIndex += 1) {
    const item = activeSymbols[symbolIndex];
    try {
      const candles = await fetchCandles(item.symbol, item.assetClass);
      const previous = state.candles[item.symbol]?.length ?? 0;
      state.candles[item.symbol] = mergeCandles(state.candles[item.symbol] ?? [], candles);
      const latest = state.candles[item.symbol].at(-1);
      if (latest) state.latestPrices[item.symbol] = latest.close;
      state.indicators ||= {};
      state.indicators[item.symbol] = computeIndicators(state.candles[item.symbol].slice(-80));
      synced.push(item.symbol);
      if ((state.candles[item.symbol]?.length ?? 0) > previous || previous < 500) {
        updated.push(item.symbol);
        if (previous < 500) backfilled.push(item.symbol);
      }
    } catch (error) {
      failed.push(item.symbol);
      errors.push(`${item.symbol}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (REQUEST_DELAY_SECONDS > 0 && symbolIndex < activeSymbols.length - 1) {
      await sleep(REQUEST_DELAY_SECONDS * 1000);
    }
  }

  state.dataStatus = { source: DATA_SOURCE, entitlement: "daily", interval: "1day", errors: errors.slice(0, 4), lastSyncAt: latestSyncTimestamp(state) };
  const snapshot = buildMarketSnapshot(state, updated.length ? updated : synced);
  const timestamp = Date.now();

  if (snapshot.length) {
    for (const agent of state.agents.map(withRuntimeFlags)) {
      let decision: AgentDecision;
      try {
        decision = await decide(state, agent, snapshot);
      } catch (error) {
        const reason = `${agent.provider} call failed: ${error instanceof Error ? error.message : String(error)}`;
        decision = ruleDecision(agent, snapshot, reason);
        decision.source = "error";
      }
      executeDecision(state, agent, decision, timestamp);
      state.decisions.unshift(decision);
    }
    state.decisions = state.decisions.slice(0, 64);
    state.orders = (state.orders ?? []).slice(0, 80);
    state.equity = state.equity.slice(-500);
  }

  await saveState(state);
  return { synced, updated, backfilled, analyzed: snapshot.length > 0, failed, errors, state: publicState(state) };
}

function normalizeSymbol(symbol: string, assetClass: AssetClass) {
  const clean = symbol.trim().toUpperCase().replace(/\s/g, "");
  if (assetClass === "forex") return clean.replace(/[/-]/g, "").replace(/=X$/, "");
  if (assetClass === "crypto") return clean.includes("-") ? clean.replace("/", "-") : `${clean.replace("/", "-")}-USD`;
  if (assetClass === "commodity") return ["GOLD", "XAU", "XAUUSD", "XAU/USD", "XAUUSD=X"].includes(clean) ? "XAUUSD" : clean.replace("/", "-");
  return clean;
}

function normalizeId(value: string) {
  return (value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || `seat-${Date.now()}`).slice(0, 64);
}

function defaultModel(provider: LlmProvider) {
  return { openai: "gpt-4o-mini", openrouter: "openai/gpt-4o-mini", gemini: "gemini-1.5-flash", siliconflow: "Qwen/Qwen2.5-72B-Instruct", local: "local-rule" }[provider];
}

async function alphaQuery(params: Record<string, string>) {
  const key = chooseAlphaKey();
  const url = new URL("https://www.alphavantage.co/query");
  Object.entries({ ...params, apikey: key }).forEach(([name, value]) => url.searchParams.set(name, value));
  const payload = await jsonFetch(url.toString(), { headers: { "User-Agent": "ai-arena/0.5" } });
  for (const keyName of ["Error Message", "Information", "Note"]) {
    if (payload[keyName]) throw new Error(String(payload[keyName]));
  }
  return payload;
}

function chooseAlphaKey() {
  const raw = env("ALPHAVANTAGE_API_KEYS") || env("ALPHAVANTAGE_API_KEY");
  const keys = raw.split(/[\s,]+/).map((key) => key.trim()).filter(Boolean);
  if (!keys.length) throw new Error("Missing ALPHAVANTAGE_API_KEYS or ALPHAVANTAGE_API_KEY");
  return keys[Math.floor(Math.random() * keys.length)];
}

async function fetchCandles(symbol: string, assetClass: AssetClass): Promise<MarketCandle[]> {
  if (assetClass === "commodity") return fetchYahooCandles(symbol);
  const params: Record<string, string> = assetClass === "stock"
    ? { function: "TIME_SERIES_DAILY", symbol, outputsize: "compact" }
    : assetClass === "forex"
      ? { function: "FX_DAILY", from_symbol: symbol.slice(0, 3), to_symbol: symbol.slice(3), outputsize: "compact" }
      : { function: "DIGITAL_CURRENCY_DAILY", symbol: splitCrypto(symbol)[0], market: splitCrypto(symbol)[1] };
  const payload = await alphaQuery(params);
  const key = Object.keys(payload).find((name) => name.startsWith("Time Series"));
  if (!key) throw new Error(`Alpha Vantage did not return daily bars for ${symbol}`);
  return trimCandles(Object.entries(payload[key]).map(([date, values]) => {
    const v = values as Record<string, string>;
    return { symbol, timestamp: Date.parse(`${date.split(" ")[0]}T00:00:00Z`), open: read(v, "1. open"), high: read(v, "2. high"), low: read(v, "3. low"), close: read(v, "4. close"), volume: read(v, "5. volume", 0) };
  }).sort((a, b) => a.timestamp - b.timestamp));
}

async function fetchYahooCandles(symbol: string): Promise<MarketCandle[]> {
  const yahooSymbol = yahooChartSymbol(symbol);
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = period2 - (HISTORY_DAYS + 10) * 86400;
  const encodedSymbol = encodeURIComponent(yahooSymbol).replace(/%3D/g, "=");
  const query = new URLSearchParams({ period1: String(period1), period2: String(period2), interval: "1d", events: "history", includeAdjustedClose: "true" });
  const payload = await jsonFetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodedSymbol}?${query}`, { headers: { "User-Agent": "Mozilla/5.0 ai-arena/0.5" } });
  const result = payload.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo Finance did not return daily bars for ${symbol}`);
  const quote = result.indicators?.quote?.[0] ?? {};
  const candles: MarketCandle[] = [];
  for (let index = 0; index < (result.timestamp ?? []).length; index += 1) {
    if ([quote.open?.[index], quote.high?.[index], quote.low?.[index], quote.close?.[index]].some((value) => value == null)) continue;
    candles.push({ symbol, timestamp: Number(result.timestamp[index]) * 1000, open: Number(quote.open[index]), high: Number(quote.high[index]), low: Number(quote.low[index]), close: Number(quote.close[index]), volume: Number(quote.volume?.[index] ?? 0) });
  }
  if (!candles.length) throw new Error(`Yahoo Finance did not return usable bars for ${symbol}`);
  return trimCandles(candles);
}

function yahooChartSymbol(symbol: string) {
  const clean = symbol.toUpperCase().replace(/\s/g, "");
  return { XAUUSD: "GC=F", "XAU/USD": "GC=F", "XAUUSD=X": "GC=F", GOLD: "GC=F", GC: "GC=F", "GOLD-FUTURES": "GC=F" }[clean] ?? clean;
}

function splitCrypto(symbol: string) {
  const clean = symbol.toUpperCase().replace("/", "-");
  if (clean.includes("-")) return clean.split("-", 2);
  return [clean.slice(0, -3), clean.slice(-3) || "USD"];
}

function read(values: Record<string, string>, prefix: string, fallback?: number) {
  const key = Object.keys(values).find((item) => item.startsWith(prefix));
  if (key) return Number(values[key]);
  if (fallback !== undefined) return fallback;
  throw new Error(`Market response missing ${prefix}`);
}

function trimCandles(candles: MarketCandle[]) {
  const cutoff = Date.now() - HISTORY_DAYS * 86400 * 1000;
  const recent = candles.filter((item) => item.timestamp >= cutoff);
  return (recent.length ? recent : candles.slice(-500)).slice(-MAX_CANDLES);
}

function mergeCandles(oldCandles: MarketCandle[], newCandles: MarketCandle[]) {
  const map = new Map<number, MarketCandle>();
  for (const candle of oldCandles) map.set(candle.timestamp, candle);
  for (const candle of newCandles) map.set(candle.timestamp, candle);
  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp).slice(-MAX_CANDLES);
}

function average(values: number[]) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
function stdev(values: number[]) { const mean = average(values); return values.length > 1 ? Math.sqrt(average(values.map((value) => (value - mean) ** 2))) : 0; }
function ema(values: number[], period: number) { if (!values.length) return null; const alpha = 2 / (period + 1); return values.slice(1).reduce((prev, value) => value * alpha + prev * (1 - alpha), values[0]); }
function rsi(values: number[], period = 14) { if (values.length <= period) return null; const changes = values.slice(1).map((value, index) => value - values[index]); const gains = average(changes.slice(-period).map((value) => Math.max(value, 0))); const losses = average(changes.slice(-period).map((value) => Math.abs(Math.min(value, 0)))); return losses === 0 ? 100 : 100 - 100 / (1 + gains / losses); }
function atr(rows: MarketCandle[], period = 14) { if (rows.length <= 1) return null; const ranges = rows.slice(1).map((row, index) => Math.max(row.high - row.low, Math.abs(row.high - rows[index].close), Math.abs(row.low - rows[index].close))); return average(ranges.slice(-period)); }
function round(value: number | null, digits = 6) { return value == null || Number.isNaN(value) ? null : Number(value.toFixed(digits)); }

function computeIndicators(rows: MarketCandle[]): IndicatorSnapshot {
  const closes = rows.map((row) => row.close);
  const last = closes.at(-1) ?? null;
  const sma20 = closes.length >= 20 ? average(closes.slice(-20)) : null;
  const sma50 = closes.length >= 50 ? average(closes.slice(-50)) : null;
  const ema12 = ema(closes.slice(-26), 12);
  const ema26 = ema(closes.slice(-35), 26);
  const atr14 = atr(rows.slice(-20), 14);
  return { sma20: round(sma20), sma50: round(sma50), ema12: round(ema12), ema26: round(ema26), macd: round(ema12 != null && ema26 != null ? ema12 - ema26 : null), rsi14: round(rsi(closes), 2), atr14: round(atr14), atr_pct: round(atr14 != null && last ? atr14 / last : null), price_vs_sma20: round(sma20 && last ? (last - sma20) / sma20 : null), price_vs_sma50: round(sma50 && last ? (last - sma50) / sma50 : null) };
}

function buildMarketSnapshot(state: PersistedArenaState, symbols: string[]): MarketSnapshot[] {
  return symbols.map((symbol) => {
    const candles = state.candles?.[symbol]?.slice(-30) ?? [];
    if (candles.length < 4) return null;
    const closes = candles.map((item) => item.close);
    const last = closes.at(-1) ?? 0;
    const prev = closes.at(-2) ?? last;
    const sixAgo = closes.length >= 7 ? closes[closes.length - 7] : 0;
    return {
      symbol,
      last_close: last,
      one_day_return: prev ? (last - prev) / prev : 0,
      six_day_return: sixAgo ? (last - sixAgo) / sixAgo : 0,
      volatility_12d: last ? stdev(closes.slice(-12)) / last : 0,
      indicators: state.indicators?.[symbol] ?? {},
      latest_bars: candles.slice(-8).map((row) => ({ date: new Date(row.timestamp).toISOString().slice(0, 10), close: row.close, volume: row.volume }))
    };
  }).filter(Boolean) as MarketSnapshot[];
}

async function decide(state: PersistedArenaState, agent: AgentProfile, snapshot: MarketSnapshot[]): Promise<AgentDecision> {
  const keyEnv = providerKeyEnv[agent.provider];
  const apiKey = keyEnv ? env(keyEnv) : "";
  if (!apiKey || agent.provider === "local") {
    const decision = ruleDecision(agent, snapshot);
    if (agent.provider !== "local") {
      decision.source = "disabled";
      decision.action = "HOLD";
      decision.symbol = "--";
      decision.confidence = 0;
      decision.horizon = "disabled";
      decision.thesis = `${agent.provider} key is not configured. Add ${keyEnv} to Vercel environment variables to enable this LLM seat.`;
    }
    return decision;
  }
  const prompt = buildPrompt(state, agent, snapshot);
  const text = agent.provider === "gemini" ? await callGemini(agent, prompt, apiKey) : await callChat(agent, prompt, apiKey);
  return { ...parseDecision(text, snapshot), agentId: agent.id, provider: agent.provider, model: agent.model, source: "llm", createdAt: Date.now() };
}

function ruleDecision(agent: AgentProfile, snapshot: MarketSnapshot[], reason?: string): AgentDecision {
  const item = snapshot.slice().sort((a, b) => Math.abs(b.six_day_return + b.one_day_return) - Math.abs(a.six_day_return + a.one_day_return))[0];
  if (!item) return { agentId: agent.id, symbol: "--", action: "HOLD", confidence: 0, thesis: "No synced market bars are available.", horizon: "1 day", createdAt: Date.now(), provider: agent.provider, model: agent.model, source: "error" };
  const score = item.six_day_return * 1.8 + item.one_day_return * 2.8 - item.volatility_12d * 0.2;
  const fallbackReason = reason || `${agent.provider} is unavailable`;
  return { agentId: agent.id, symbol: item.symbol, action: score > 0.0025 ? "BUY" : score < -0.003 ? "SELL" : "HOLD", confidence: Math.min(94, Math.max(42, Math.round(Math.abs(score) * 5200 + 48))), thesis: `Fallback rule used because ${fallbackReason}. Signal=${score.toFixed(4)} on daily bars.`, horizon: "1-5 days", createdAt: Date.now(), provider: agent.provider, model: agent.model, source: "rule" };
}

function buildPrompt(state: PersistedArenaState, agent: AgentProfile, snapshot: MarketSnapshot[]) {
  const payload = {
    agent: { name: agent.name, risk: agent.risk, style: agent.style, custom_prompt: effectivePrompt(agent) },
    tools: { portfolio_state: "cash, positions, equity from Turso SQLite", market_snapshot: "daily candles and returns", technical_indicators: "SMA/EMA/MACD/RSI/ATR snapshots", fundamentals_news: "Alpha Vantage overview where available; commodities use Yahoo Finance bars", risk_check: "server-side sizing, whitelist, 5-20 bps slippage" },
    account: { starting_capital: STARTING_CAPITAL, slippage_bps_range: [MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS], portfolio: portfolioState(state, agent.id) },
    timeframe: "1 day",
    tradable_symbols: snapshot.map((item) => item.symbol),
    market_snapshot: snapshot
  };
  return `You are one seat in an Alpha Arena style paper-trading competition. Choose exactly one action for the next daily round. Use only the provided market data and custom_prompt. Analyze technical setup and fundamental/macro context. Return one-line minified JSON only, no markdown, no code fence, no newline. Required keys: action, symbol, confidence, thesis, horizon. action must be BUY, SELL, or HOLD. symbol must be one of tradable_symbols. confidence is 0-100. Keep thesis under 220 characters. Input: ${JSON.stringify(payload)}`;
}

async function callChat(agent: AgentProfile, prompt: string, apiKey: string) {
  const endpoints: Partial<Record<LlmProvider, string>> = { openai: "https://api.openai.com/v1/chat/completions", openrouter: "https://openrouter.ai/api/v1/chat/completions", siliconflow: "https://api.siliconflow.com/v1/chat/completions" };
  const endpoint = endpoints[agent.provider];
  if (!endpoint) throw new Error(`Unsupported chat provider: ${agent.provider}`);
  const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
  if (agent.provider === "openrouter") Object.assign(headers, { "HTTP-Referer": env("NEXT_PUBLIC_SITE_URL") || "https://vercel.app", "X-Title": "AI Trading Arena" });
  const payload = await jsonFetch(endpoint, { method: "POST", headers, body: JSON.stringify({ model: agent.model, messages: [{ role: "system", content: "You are a disciplined paper-trading model. Output JSON only." }, { role: "user", content: prompt }], temperature: 0.2, max_tokens: 700 }) }, LLM_TIMEOUT_SECONDS * 1000);
  return payload.choices?.[0]?.message?.content ?? "{}";
}

async function callGemini(agent: AgentProfile, prompt: string, apiKey: string) {
  const payload = await jsonFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(agent.model)}:generateContent?key=${encodeURIComponent(apiKey)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, responseMimeType: "application/json", maxOutputTokens: 700 } }) }, LLM_TIMEOUT_SECONDS * 1000);
  return payload.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
}

function parseDecision(text: string, snapshot: MarketSnapshot[]): Pick<AgentDecision, "symbol" | "action" | "confidence" | "thesis" | "horizon"> {
  const raw = text.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const match = raw.match(/\{[\s\S]*\}/);
  const candidate = match?.[0] ?? raw;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(candidate);
  } catch {
    data = salvageDecision(candidate);
  }
  const symbols = new Set(snapshot.map((item) => item.symbol));
  const symbol = symbols.has(String(data.symbol).toUpperCase()) ? String(data.symbol).toUpperCase() : snapshot[0]?.symbol ?? "--";
  const actionText = String(data.action ?? "HOLD").toUpperCase();
  const action = (["BUY", "SELL", "HOLD"].includes(actionText) ? actionText : "HOLD") as "BUY" | "SELL" | "HOLD";
  return { symbol, action, confidence: Math.max(0, Math.min(100, Number(data.confidence ?? 0))), thesis: String(data.thesis ?? "LLM returned malformed JSON; recovered executable fields.").slice(0, 600), horizon: String(data.horizon ?? "1-5 days").slice(0, 80) };
}

function salvageDecision(text: string): Record<string, unknown> {
  const pick = (key: string) => text.match(new RegExp(`"?${key}"?\\s*:\\s*"?([^",}\\n]+)`, "i"))?.[1]?.trim();
  const quoted = (key: string) => text.match(new RegExp(`"?${key}"?\\s*:\\s*"([^"\\n]{1,600})`, "i"))?.[1]?.trim();
  return {
    action: pick("action") ?? "HOLD",
    symbol: pick("symbol") ?? "",
    confidence: Number(pick("confidence") ?? 0),
    thesis: quoted("thesis") ?? "LLM returned malformed JSON; recovered partial decision.",
    horizon: quoted("horizon") ?? "1-5 days"
  };
}

function portfolioState(state: PersistedArenaState, agentId: string) {
  const cash = state.cash?.[agentId] ?? STARTING_CAPITAL;
  const positions = (state.positions ?? []).filter((item) => item.agentId === agentId).map((item) => {
    const marketPrice = state.latestPrices[item.symbol] ?? item.avgPrice;
    return { symbol: item.symbol, quantity: item.quantity, avg_price: item.avgPrice, market_price: marketPrice, market_value: item.quantity * marketPrice, unrealized_pnl: item.quantity * (marketPrice - item.avgPrice) };
  });
  return { cash: Number(cash.toFixed(2)), equity: Number((cash + positions.reduce((sum, item) => sum + item.market_value, 0)).toFixed(2)), positions };
}

function executeDecision(state: PersistedArenaState, agent: AgentProfile, decision: AgentDecision, timestamp: number) {
  state.cash ||= {};
  state.positions ||= [];
  state.orders ||= [];
  state.equity ||= [];
  const agentId = agent.id;
  const action = decision.action;
  const symbol = decision.symbol;
  let cash = state.cash[agentId] ?? STARTING_CAPITAL;
  const price = state.latestPrices[symbol];
  const record = (status: string, reason: string, slippage = 0, executionPrice: number | null = null, quantity = 0, notional = 0) => {
    decision.createdAt = timestamp;
    decision.orderStatus = status;
    decision.orderReason = reason;
    decision.slippageBps = slippage;
    decision.executionPrice = executionPrice;
    decision.executedQuantity = Number(quantity.toFixed(8));
    decision.notional = Number(notional.toFixed(4));
    state.orders!.unshift({ agentId, symbol, action, status, quantity: decision.executedQuantity, notional: decision.notional, signalPrice: price ?? null, executionPrice, slippageBps: slippage, reason, createdAt: timestamp });
  };

  if (decision.source === "disabled" || decision.source === "error" || symbol === "--" || action === "HOLD") {
    record("SKIPPED", action === "HOLD" ? "Model chose HOLD." : "No executable signal.");
  } else if (!price) {
    record("REJECTED", "No market price available.");
  } else {
    const slippage = MIN_SLIPPAGE_BPS + Math.floor(Math.random() * (MAX_SLIPPAGE_BPS - MIN_SLIPPAGE_BPS + 1));
    const riskScale = agent.risk === "high" ? 1.35 : agent.risk === "low" ? 0.55 : 0.9;
    const confidenceScale = Math.max(0.15, Math.min(1, decision.confidence / 100));
    const index = state.positions.findIndex((item) => item.agentId === agentId && item.symbol === symbol);
    const current = index >= 0 ? state.positions[index] : null;
    if (action === "BUY") {
      const executionPrice = price * (1 + slippage / 10000);
      const notional = Math.min(cash, cash * 0.55 * riskScale * confidenceScale);
      if (notional < MIN_TRADE_NOTIONAL) record("REJECTED", "Insufficient cash for minimum notional.", slippage, executionPrice);
      else {
        const quantity = notional / executionPrice;
        const oldQty = current?.quantity ?? 0;
        const oldCost = oldQty * (current?.avgPrice ?? 0);
        const nextQty = oldQty + quantity;
        const avgPrice = (oldCost + notional) / nextQty;
        const next: Position = { agentId, symbol, quantity: nextQty, avgPrice, marketPrice: price, marketValue: nextQty * price, unrealizedPnl: nextQty * (price - avgPrice) };
        if (index >= 0) state.positions[index] = next; else state.positions.push(next);
        cash -= notional;
        state.cash[agentId] = cash;
        record("FILLED", "BUY filled after risk sizing and slippage.", slippage, executionPrice, quantity, notional);
      }
    } else if (action === "SELL") {
      const quantityHeld = current?.quantity ?? 0;
      const executionPrice = price * (1 - slippage / 10000);
      const quantity = quantityHeld * Math.min(1, 0.55 * riskScale * confidenceScale);
      const notional = quantity * executionPrice;
      if (!current || quantity <= 0 || notional < MIN_TRADE_NOTIONAL) record("REJECTED", "No position or notional too small to sell.", slippage, executionPrice);
      else {
        current.quantity -= quantity;
        cash += notional;
        state.cash[agentId] = cash;
        if (current.quantity <= 0.000001) state.positions.splice(index, 1);
        record("FILLED", "SELL filled against existing position.", slippage, executionPrice, quantity, notional);
      }
    }
  }
  state.equity.push({ agentId, timestamp, equity: portfolioState(state, agentId).equity });
}

function latestSyncTimestamp(state: PersistedArenaState) {
  return Math.max(0, ...Object.values(state.candles ?? {}).map((items) => items.at(-1)?.timestamp ?? 0)) || null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jsonFetch(url: string, init?: RequestInit, timeoutMs = 25000) {
  const response = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  if (!response.ok) throw new Error(text.slice(0, 500) || `${response.status} ${response.statusText}`);
  return JSON.parse(text);
}

const FX_PRODUCTS = [["EURUSD", "EUR/USD"], ["GBPUSD", "GBP/USD"], ["USDJPY", "USD/JPY"], ["USDCHF", "USD/CHF"], ["AUDUSD", "AUD/USD"], ["USDCAD", "USD/CAD"], ["NZDUSD", "NZD/USD"], ["EURJPY", "EUR/JPY"]] as const;
const CRYPTO_PRODUCTS = [["BTC-USD", "Bitcoin"], ["ETH-USD", "Ethereum"], ["SOL-USD", "Solana"], ["BNB-USD", "BNB"], ["XRP-USD", "XRP"], ["ADA-USD", "Cardano"], ["DOGE-USD", "Dogecoin"], ["AVAX-USD", "Avalanche"]] as const;
const COMMODITY_PRODUCTS = [["XAUUSD", "Gold USD proxy", "GC=F"], ["GC=F", "Gold Futures", "GC=F"], ["XAGUSD", "Silver Spot USD", "SI=F"], ["SI=F", "Silver Futures", "SI=F"]] as const;

