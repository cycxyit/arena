export type AssetClass = "stock" | "forex" | "crypto" | "commodity";
export type AgentKind = "llm" | "agent" | "rule";
export type LlmProvider = "openai" | "openrouter" | "siliconflow" | "gemini" | "local";

export type TradingSymbol = {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  active: boolean;
};

export type MarketCandle = {
  symbol: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type AgentProfile = {
  id: string;
  name: string;
  style: string;
  risk: "low" | "medium" | "high";
  color: string;
  provider: LlmProvider;
  model: string;
  prompt: string;
  kind: AgentKind;
  watchlist?: string[];
  enabled: boolean;
};

export type AgentDecision = {
  agentId: string;
  symbol: string;
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
  thesis: string;
  horizon: string;
  createdAt: number;
  provider?: LlmProvider;
  model?: string;
  source?: "llm" | "rule" | "disabled" | "error";
  slippageBps?: number;
  executionPrice?: number | null;
  orderStatus?: "FILLED" | "REJECTED" | "SKIPPED" | string | null;
  orderReason?: string | null;
  executedQuantity?: number;
  notional?: number;
};

export type EquityPoint = {
  agentId: string;
  timestamp: number;
  equity: number;
};

export type Position = {
  agentId: string;
  symbol: string;
  quantity: number;
  avgPrice: number;
  marketPrice: number;
  marketValue: number;
  unrealizedPnl: number;
};

export type OrderRecord = {
  agentId: string;
  symbol: string;
  action: "BUY" | "SELL" | "HOLD" | string;
  status: string;
  quantity: number;
  notional: number;
  signalPrice?: number | null;
  executionPrice?: number | null;
  slippageBps: number;
  reason: string;
  createdAt: number;
};

export type IndicatorSnapshot = {
  sma20?: number | null;
  sma50?: number | null;
  ema12?: number | null;
  ema26?: number | null;
  macd?: number | null;
  rsi14?: number | null;
  atr14?: number | null;
  atr_pct?: number | null;
  price_vs_sma20?: number | null;
  price_vs_sma50?: number | null;
};

export type DataStatus = {
  source: string;
  entitlement: string;
  interval: string;
  errors: string[];
  lastSyncAt: number | null;
};

export type ArenaState = {
  symbols: TradingSymbol[];
  agents: AgentProfile[];
  decisions: AgentDecision[];
  equity: EquityPoint[];
  positions?: Position[];
  orders?: OrderRecord[];
  cash?: Record<string, number>;
  startingCapital?: number;
  indicators?: Record<string, IndicatorSnapshot>;
  latestPrices: Record<string, number>;
  dataStatus: DataStatus;
  updatedAt: number;
};