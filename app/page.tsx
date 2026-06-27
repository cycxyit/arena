"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { AgentDecision, AgentProfile, ArenaState, AssetClass, EquityPoint, IndicatorSnapshot, Position } from "@/lib/types";

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const AUTO_SYNC_INTERVAL_MS = 30 * 60 * 1000;
const FALLBACK_STARTING_CAPITAL = 10000;

const defaultState: ArenaState = {
  symbols: [],
  agents: [],
  decisions: [],
  equity: [],
  positions: [],
  cash: {},
  startingCapital: FALLBACK_STARTING_CAPITAL,
  latestPrices: {},
  dataStatus: { source: "Alpha Vantage", entitlement: "daily", interval: "1day", errors: [], lastSyncAt: null },
  updatedAt: 0
};

type Standing = {
  agent: AgentProfile;
  equity: number;
  pnl: number;
  pnlPct: number;
  decision?: AgentDecision;
  cash: number;
  positions: Position[];
  indicators?: IndicatorSnapshot;
};

export default function Home() {
  const [state, setState] = useState<ArenaState>(defaultState);
  const [symbol, setSymbol] = useState("");
  const [name, setName] = useState("");
  const [assetClass, setAssetClass] = useState<AssetClass>("stock");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("Waiting for market sync");
  const [hydrated, setHydrated] = useState(false);
  const [nextSyncAt, setNextSyncAt] = useState<number | null>(null);
  const syncingRef = useRef(false);

  async function loadState() {
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !isArenaState(payload)) throw new Error("Invalid arena state");
      setState(payload);
      if (payload.dataStatus.errors.length) setMessage(payload.dataStatus.errors[0]);
    } catch {
      setMessage("Failed to load arena state");
    } finally {
      setLoading(false);
    }
  }

  async function runCycle() {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setRunning(true);
    setMessage("Syncing daily data, backfilling 2-year history when needed...");
    try {
      const response = await fetch("/api/run", { method: "POST" });
      const payload = await response.json();
      if (!response.ok || !isArenaState(payload.state)) throw new Error(payload.error ?? "Invalid arena cycle result");
      setState(payload.state);
      if (payload.errors?.length) setMessage(payload.errors[0]);
      else {
        const updated = Array.isArray(payload.updated) ? payload.updated : [];
        const backfilled = Array.isArray(payload.backfilled) ? payload.backfilled : [];
        if (backfilled.length) setMessage(`Backfilled 2y history: ${backfilled.join(", ")}; AI analyzed updated data`);
        else if (updated.length) setMessage(`Updated: ${updated.join(", ")}; AI analyzed new daily bars`);
        else setMessage("No new daily bars; AI analysis skipped");
      }
    } catch {
      setMessage("Alpha Vantage sync failed. Check API key pool, entitlement, or rate limits.");
    } finally {
      syncingRef.current = false;
      setRunning(false);
      setNextSyncAt(Date.now() + AUTO_SYNC_INTERVAL_MS);
    }
  }

  async function addCustomSymbol(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!symbol.trim()) return;
    const response = await fetch("/api/symbols", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, name, assetClass })
    });
    if (response.ok) {
      setSymbol("");
      setName("");
      await loadState();
      setMessage("Market added to the arena");
    }
  }

  useEffect(() => {
    setHydrated(true);
    loadState();
    setNextSyncAt(Date.now() + AUTO_SYNC_INTERVAL_MS);
    const interval = window.setInterval(() => {
      void runCycle();
    }, AUTO_SYNC_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, []);

  const decisions = Array.isArray(state.decisions) ? state.decisions : [];
  const validDecisions = decisions.filter((decision) => decision.symbol !== "--" && decision.confidence > 0 && decision.source !== "disabled" && decision.source !== "error");
  const symbols = Array.isArray(state.symbols) ? state.symbols : [];
  const agents = Array.isArray(state.agents) ? state.agents : [];
  const equity = Array.isArray(state.equity) ? state.equity : [];
  const positions = Array.isArray(state.positions) ? state.positions : [];
  const cash = state.cash && typeof state.cash === "object" ? state.cash : {};
  const startingCapital = typeof state.startingCapital === "number" ? state.startingCapital : FALLBACK_STARTING_CAPITAL;
  const indicators = state.indicators && typeof state.indicators === "object" ? state.indicators : {};

  const latestDecisionByAgent = useMemo(() => {
    const result = new Map<string, AgentDecision>();
    for (const decision of decisions) if (!result.has(decision.agentId)) result.set(decision.agentId, decision);
    return result;
  }, [decisions]);

  const standings = useMemo<Standing[]>(() => {
    return agents
      .map((agent) => {
        const series = equity.filter((point) => point.agentId === agent.id);
        const value = series.at(-1)?.equity ?? startingCapital;
        const pnl = value - startingCapital;
        const agentPositions = positions.filter((position) => position.agentId === agent.id);
        const primarySymbol = latestDecisionByAgent.get(agent.id)?.symbol !== "--" ? latestDecisionByAgent.get(agent.id)?.symbol : agentPositions[0]?.symbol;
        return { agent, equity: value, pnl, pnlPct: pnl / startingCapital, decision: latestDecisionByAgent.get(agent.id), cash: cash[agent.id] ?? startingCapital, positions: agentPositions, indicators: primarySymbol ? indicators[primarySymbol] : undefined };
      })
      .sort((a, b) => b.equity - a.equity);
  }, [agents, equity, latestDecisionByAgent, startingCapital, cash, positions, indicators]);

  const updatedTime = hydrated && state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString("zh-CN") : "--:--:--";
  const sourceLine = `${state.dataStatus.interval} / ${state.dataStatus.source} / ${state.dataStatus.entitlement}`;
  const nextSyncLine = hydrated && nextSyncAt ? `auto sync ${new Date(nextSyncAt).toLocaleTimeString("zh-CN")}` : "auto sync every 30m";

  return (
    <main>
      <header className="arena-header">
        <div>
          <p className="eyebrow">{sourceLine}</p>
          <h1>Alpha Arena Console</h1>
        </div>
        <div className="status">
          <span>{message}<small>{nextSyncLine}</small></span>
          <Link className="button-link" href="/admin">Admin</Link><button onClick={runCycle} disabled={running}>{running ? "Running" : "Run round"}</button>
        </div>
      </header>

      <section className="market-strip">
        <form onSubmit={addCustomSymbol} className="symbol-form">
          <input value={symbol} onChange={(event) => setSymbol(event.target.value)} placeholder="AAPL / EURUSD / BTC / XAUUSD" />
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name, optional" />
          <select value={assetClass} onChange={(event) => setAssetClass(event.target.value as AssetClass)}>
            <option value="stock">Stock</option>
            <option value="forex">Forex</option>
            <option value="crypto">Crypto</option>
            <option value="commodity">Commodity</option>
          </select>
          <button type="submit">Add market</button>
        </form>
        <div className="ticker-row">
          {symbols.map((item) => <span key={item.symbol}>{item.symbol}<b>{state.latestPrices[item.symbol]?.toFixed(2) ?? "No data"}</b></span>)}
        </div>
      </section>

      {state.dataStatus.errors.length > 0 ? <section className="notice"><b>Data source</b><span>{state.dataStatus.errors[0]}</span></section> : null}

      <section className="leaderboard">
        <div className="section-head">
          <div><p className="eyebrow">Leaderboard</p><h2>Model accounts</h2></div>
          <span>{currency.format(startingCapital)} starting capital / updated {updatedTime}</span>
        </div>
        <div className="ranking-table">
          <div className="ranking-row ranking-head"><span>#</span><span>Model</span><span>Equity</span><span>Return</span><span>Provider</span><span>Action</span><span>Market</span></div>
          {standings.map((row, index) => (
            <div className="ranking-row" key={row.agent.id}>
              <span>{index + 1}</span>
              <strong>{row.agent.name}</strong>
              <span>{currency.format(row.equity)}</span>
              <span className={row.pnl >= 0 ? "positive" : "negative"}>{formatPercent(row.pnlPct)}</span>
              <span>{row.agent.provider}</span>
              <span>{row.decision?.action ?? "WAIT"}</span>
              <span>{row.decision?.symbol ?? "--"}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="arena-layout">
        <section className="chart-panel">
          <div className="section-head"><div><p className="eyebrow">Equity</p><h2>Account curves</h2></div><span>{loading ? "Loading" : `${equity.length} points`}</span></div>
          <EquityChart agents={agents} points={equity} />
          <div className="legend">{agents.map((agent) => <span key={agent.id}><i style={{ background: agent.color }} />{agent.name}</span>)}</div>
        </section>

        <section className="agent-panel">
          <div className="section-head"><div><p className="eyebrow">Model Seats</p><h2>Live agents</h2></div><span>{agents.length} agents</span></div>
          <div className="agent-list">{standings.map((row) => <AgentSeat key={row.agent.id} row={row} />)}</div>
        </section>
      </section>

      <section className="trade-log">
        <div className="section-head"><div><p className="eyebrow">Decision Log</p><h2>Round history</h2></div><span>{validDecisions.length} valid rows</span></div>
        <div className="log-table">
          <div className="log-row log-head"><span>Time</span><span>Model</span><span>Order</span><span>Action</span><span>Market</span><span>Fill</span><span>Reason</span></div>
          {validDecisions.length === 0 ? <div className="empty-log">No valid trading decisions yet. Disabled seats, failed LLM calls, and placeholder HOLD rows are hidden.</div> : validDecisions.map((decision, index) => (
            <div className="log-row" key={`${decision.agentId}-${decision.createdAt}-${index}`}>
              <span>{hydrated ? new Date(decision.createdAt).toLocaleTimeString("zh-CN") : "--:--:--"}</span>
              <span>{agents.find((agent) => agent.id === decision.agentId)?.name ?? decision.agentId}</span>
              <span>{decision.orderStatus ?? decision.provider ?? "--"}</span>
              <span>{decision.action}</span>
              <span>{decision.symbol}</span>
              <span>{decision.orderStatus === "FILLED" ? currency.format(decision.notional ?? 0) : `${decision.confidence}%`}</span>
              <span>{decision.orderReason ? `${decision.orderReason} / ${decision.thesis}` : decision.thesis}</span>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function EquityChart({ agents, points }: { agents: AgentProfile[]; points: EquityPoint[] }) {
  const width = 820;
  const height = 380;
  const padding = 34;
  const values = points.map((point) => point.equity);
  const min = Math.min(...values, FALLBACK_STARTING_CAPITAL * 0.98);
  const max = Math.max(...values, FALLBACK_STARTING_CAPITAL * 1.02);
  const times = points.map((point) => point.timestamp);
  const minTime = times.length ? Math.min(...times) : 0;
  const maxTime = times.length ? Math.max(...times) : 1;
  const x = (timestamp: number) => padding + ((timestamp - minTime) / Math.max(1, maxTime - minTime)) * (width - padding * 2);
  const y = (value: number) => height - padding - ((value - min) / Math.max(1, max - min)) * (height - padding * 2);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="equity-chart" role="img">
      <rect x="0" y="0" width={width} height={height} rx="0" />
      {[0, 1, 2, 3].map((line) => <line key={line} x1={padding} x2={width - padding} y1={padding + line * 94} y2={padding + line * 94} />)}
      {points.length === 0 ? <text x="50%" y="50%" textAnchor="middle">Waiting for real Alpha Vantage daily bars</text> : null}
      {agents.map((agent) => {
        const series = points.filter((point) => point.agentId === agent.id);
        const d = series.map((point, index) => `${index === 0 ? "M" : "L"} ${x(point.timestamp)} ${y(point.equity)}`).join(" ");
        return <path key={agent.id} d={d} stroke={agent.color} />;
      })}
    </svg>
  );
}

function AgentSeat({ row }: { row: Standing }) {
  return (
    <article className="agent-seat">
      <div className="seat-top"><div><h3>{row.agent.name}</h3><p>{row.agent.style}</p></div><span>{row.agent.enabled ? row.decision?.action ?? "WAIT" : "OFF"}</span></div>
      <div className="seat-metrics"><span>Equity<b>{currency.format(row.equity)}</b></span><span>Cash<b>{currency.format(row.cash)}</b></span><span>Return<b className={row.pnl >= 0 ? "positive" : "negative"}>{formatPercent(row.pnlPct)}</b></span><span>Provider<b>{row.agent.provider}</b></span><span>Source<b>{row.decision?.source ?? (row.agent.enabled ? "ready" : "disabled")}</b></span></div>
      <div className="holding-list">{row.positions.length ? row.positions.map((position) => <span key={position.symbol}>{position.symbol}<b>{currency.format(position.marketValue)}</b><small>{position.quantity.toFixed(4)} @ {currency.format(position.avgPrice)} / P&L {currency.format(position.unrealizedPnl)}</small></span>) : <span>No position<b>Cash only</b><small>Waiting for the next valid BUY decision.</small></span>}</div>
      <ToolContext indicators={row.indicators} />
      <p><b>{row.agent.model}</b>{row.decision?.orderStatus ? ` / ${row.decision.orderStatus}` : ""}{row.decision?.slippageBps ? ` / slip ${row.decision.slippageBps}bps` : ""} / {row.decision?.orderReason ? `${row.decision.orderReason}. ` : ""}{row.decision?.thesis ?? (row.agent.enabled ? "Waiting for real daily bars." : "Add the provider API key in .env.local to enable this LLM seat.")}</p>
    </article>
  );
}

function ToolContext({ indicators }: { indicators?: IndicatorSnapshot }) {
  if (!indicators) return <div className="tool-context"><span>Tools</span><b>Waiting for indicators/news cache</b></div>;
  const rsi = typeof indicators.rsi14 === "number" ? indicators.rsi14.toFixed(1) : "--";
  const macd = typeof indicators.macd === "number" ? indicators.macd.toFixed(3) : "--";
  const atr = typeof indicators.atr_pct === "number" ? `${(indicators.atr_pct * 100).toFixed(2)}%` : "--";
  return <div className="tool-context"><span>Tools</span><b>RSI {rsi} / MACD {macd} / ATR {atr}</b></div>;
}

function formatPercent(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(2)}%`;
}

function isArenaState(value: unknown): value is ArenaState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ArenaState>;
  return Array.isArray(candidate.symbols) && Array.isArray(candidate.agents) && Array.isArray(candidate.decisions) && Array.isArray(candidate.equity) && Boolean(candidate.latestPrices) && typeof candidate.latestPrices === "object" && Boolean(candidate.dataStatus) && typeof candidate.dataStatus === "object";
}