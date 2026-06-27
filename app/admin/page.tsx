"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import type { ArenaState, AssetClass, LlmProvider } from "@/lib/types";

const emptyState: ArenaState = {
  symbols: [],
  agents: [],
  decisions: [],
  equity: [],
  latestPrices: {},
  dataStatus: { source: "Alpha Vantage", entitlement: "daily", interval: "1day", errors: [], lastSyncAt: null },
  updatedAt: 0
};

const providerOptions: Array<{ value: LlmProvider; label: string }> = [
  { value: "openai", label: "OpenAI" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "gemini", label: "Gemini" },
  { value: "siliconflow", label: "SiliconFlow" }
];

type SeatForm = {
  name: string;
  provider: LlmProvider;
  model: string;
  style: string;
  prompt: string;
  risk: "low" | "medium" | "high";
  color: string;
};

export default function AdminPage() {
  const [state, setState] = useState<ArenaState>(emptyState);
  const [message, setMessage] = useState("Ready");
  const [seat, setSeat] = useState<SeatForm>({ name: "", provider: "openai", model: "gpt-4o-mini", style: "Custom LLM strategy", prompt: "", risk: "medium", color: "#111111" });
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsMessage, setModelsMessage] = useState("Load models from the selected provider.");
  const [market, setMarket] = useState({ symbol: "", name: "", assetClass: "stock" as AssetClass });
  const [productQuery, setProductQuery] = useState("");
  const [productResults, setProductResults] = useState<Array<{ symbol: string; name: string; assetClass: AssetClass; type: string; region: string; currency: string }>>([]);

  async function loadState() {
    const response = await fetch("/api/state", { cache: "no-store" });
    setState(await response.json());
  }

  useEffect(() => {
    loadState();
  }, []);

  async function loadModels(provider = seat.provider) {
    setModelsLoading(true);
    setModelsMessage("Loading provider models...");
    try {
      const response = await fetch(`/api/models?provider=${encodeURIComponent(provider)}`, { cache: "no-store" });
      const payload = await response.json();
      const nextModels = Array.isArray(payload.models) ? payload.models : [];
      setModels(nextModels);
      if (nextModels.length > 0) {
        setSeat((current) => ({ ...current, model: nextModels.includes(current.model) ? current.model : nextModels[0] }));
        setModelsMessage(`${nextModels.length} models loaded.`);
      } else {
        setModelsMessage(payload.error ?? "No models returned. You can still type a model id manually.");
      }
    } catch {
      setModels([]);
      setModelsMessage("Model list request failed. You can still type a model id manually.");
    } finally {
      setModelsLoading(false);
    }
  }

  function changeProvider(provider: LlmProvider) {
    setSeat({ ...seat, provider, model: defaultModel(provider) });
    setModels([]);
    setModelsMessage("Load models from the selected provider.");
  }

  async function addSeat(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch("/api/seats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(seat)
    });
    const payload = await response.json();
    setMessage(response.ok ? `Seat saved: ${payload.id}` : payload.error ?? "Failed to save seat");
    if (response.ok) {
      setSeat({ ...seat, name: "", prompt: "" });
      await loadState();
    }
  }

  async function removeSeat(id: string) {
    const response = await fetch("/api/seats", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id })
    });
    const payload = await response.json();
    setMessage(response.ok ? `Seat deleted: ${payload.id}` : payload.error ?? "Failed to delete seat");
    if (response.ok) await loadState();
  }

  async function searchProducts(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch(`/api/products?q=${encodeURIComponent(productQuery)}`, { cache: "no-store" });
    const payload = await response.json();
    setProductResults(payload.results ?? []);
    setMessage(response.ok ? `Found ${(payload.results ?? []).length} products` : payload.error ?? "Search failed");
  }

  async function addProductResult(item: { symbol: string; name: string; assetClass: AssetClass }) {
    const response = await fetch("/api/symbols", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(item)
    });
    const payload = await response.json();
    setMessage(response.ok ? `Market saved: ${payload.symbol}` : payload.error ?? "Failed to save market");
    if (response.ok) await loadState();
  }

  async function addMarket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const response = await fetch("/api/symbols", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(market)
    });
    const payload = await response.json();
    setMessage(response.ok ? `Market saved: ${payload.symbol}` : payload.error ?? "Failed to save market");
    if (response.ok) {
      setMarket({ ...market, symbol: "", name: "" });
      await loadState();
    }
  }

  async function removeMarket(symbol: string) {
    const response = await fetch("/api/symbols", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol })
    });
    const payload = await response.json();
    setMessage(response.ok ? `Market deleted: ${payload.symbol}` : payload.error ?? "Failed to delete market");
    if (response.ok) await loadState();
  }

  return (
    <main>
      <header className="arena-header">
        <div>
          <p className="eyebrow">Admin</p>
          <h1>Arena Management</h1>
        </div>
        <div className="status">
          <span>{message}<small>seats {state.agents.length} / markets {state.symbols.length}</small></span>
          <Link className="button-link" href="/">Arena</Link>
        </div>
      </header>

      <section className="admin-grid">
        <section className="admin-panel">
          <div className="section-head"><div><p className="eyebrow">AI Seats</p><h2>Add seat</h2></div></div>
          <form className="admin-form" onSubmit={addSeat}>
            <input value={seat.name} onChange={(event) => setSeat({ ...seat, name: event.target.value })} placeholder="Seat name" />
            <select value={seat.provider} onChange={(event) => changeProvider(event.target.value as LlmProvider)}>
              {providerOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
            <div className="model-picker">
              {models.length > 0 ? (
                <select value={seat.model} onChange={(event) => setSeat({ ...seat, model: event.target.value })}>
                  {models.map((model) => <option key={model} value={model}>{model}</option>)}
                </select>
              ) : (
                <input value={seat.model} onChange={(event) => setSeat({ ...seat, model: event.target.value })} placeholder="Model id" />
              )}
              <button type="button" onClick={() => loadModels()} disabled={modelsLoading}>{modelsLoading ? "Loading" : "Load models"}</button>
            </div>
            <input value={seat.style} onChange={(event) => setSeat({ ...seat, style: event.target.value })} placeholder="Strategy style" />
            <select value={seat.risk} onChange={(event) => setSeat({ ...seat, risk: event.target.value as SeatForm["risk"] })}>
              <option value="low">Low risk</option>
              <option value="medium">Medium risk</option>
              <option value="high">High risk</option>
            </select>
            <input value={seat.color} onChange={(event) => setSeat({ ...seat, color: event.target.value })} placeholder="#111111" />
            <textarea value={seat.prompt} onChange={(event) => setSeat({ ...seat, prompt: event.target.value })} placeholder="Custom prompt for this seat. Example: favor low drawdown, explain risk first, only trade liquid symbols." />
            <p className="form-note">{modelsMessage}</p>
            <button type="submit">Save seat</button>
          </form>

          <div className="admin-list">
            {state.agents.map((agent) => (
              <article className="admin-row" key={agent.id}>
                <div><strong>{agent.name}</strong><span>{agent.provider} / {agent.model} / {agent.enabled ? "enabled" : "disabled"}</span>{agent.prompt ? <small>{agent.prompt}</small> : null}</div>
                <button type="button" onClick={() => removeSeat(agent.id)}>Delete</button>
              </article>
            ))}
          </div>
        </section>

        <section className="admin-panel">
          <div className="section-head"><div><p className="eyebrow">Watchlist</p><h2>Trading products</h2></div></div>
          <form className="admin-search" onSubmit={searchProducts}>
            <input value={productQuery} onChange={(event) => setProductQuery(event.target.value)} placeholder="Search products: apple / tesla / eurusd / btc / gold" />
            <button type="submit">Search products</button>
          </form>
          {productResults.length > 0 ? (
            <div className="admin-list product-results">
              {productResults.map((item) => (
                <article className="admin-row" key={`${item.assetClass}-${item.symbol}-${item.name}`}>
                  <div><strong>{item.symbol || "Unavailable"}</strong><span>{item.name} / {item.assetClass} / {item.region || item.type}</span></div>
                  {item.symbol ? <button type="button" onClick={() => addProductResult(item)}>Add</button> : null}
                </article>
              ))}
            </div>
          ) : null}
          <form className="admin-form" onSubmit={addMarket}>
            <input value={market.symbol} onChange={(event) => setMarket({ ...market, symbol: event.target.value })} placeholder="AAPL / EURUSD / BTC / XAUUSD" />
            <input value={market.name} onChange={(event) => setMarket({ ...market, name: event.target.value })} placeholder="Name, optional" />
            <select value={market.assetClass} onChange={(event) => setMarket({ ...market, assetClass: event.target.value as AssetClass })}>
              <option value="stock">Stock</option>
              <option value="forex">Forex</option>
              <option value="crypto">Crypto</option>
              <option value="commodity">Commodity</option>
            </select>
            <button type="submit">Save market</button>
          </form>

          <div className="admin-list">
            {state.symbols.map((item) => (
              <article className="admin-row" key={item.symbol}>
                <div><strong>{item.symbol}</strong><span>{item.name} / {item.assetClass}</span></div>
                <button type="button" onClick={() => removeMarket(item.symbol)}>Delete</button>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}

function defaultModel(provider: LlmProvider) {
  return {
    openai: "gpt-4o-mini",
    openrouter: "openai/gpt-4o-mini",
    gemini: "gemini-1.5-flash",
    siliconflow: "Qwen/Qwen2.5-72B-Instruct",
    local: "local-rule"
  }[provider];
}