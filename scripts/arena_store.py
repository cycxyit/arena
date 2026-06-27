import json
import math
import os
import random
import re
import sqlite3
import sys
import time
import urllib.parse
import urllib.request

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = os.getcwd()
DATA_DIR = os.path.join(ROOT, "data")
DB_PATH = os.path.join(DATA_DIR, "arena.db")


def load_local_env():
    env_path = os.path.join(ROOT, ".env.local")
    if not os.path.exists(env_path):
        return
    with open(env_path, "r", encoding="utf-8") as file:
        for line in file:
            clean = line.strip()
            if not clean or clean.startswith("#") or "=" not in clean:
                continue
            key, value = clean.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


load_local_env()

INTERVAL = "1day"
DATA_SOURCE = "Alpha Vantage + Yahoo Finance"
ENTITLEMENT = "daily"
REQUEST_DELAY_SECONDS = float(os.getenv("ALPHAVANTAGE_REQUEST_DELAY_SECONDS", "1.1"))
ALPHA_KEY_POOL = []
LLM_TIMEOUT_SECONDS = int(os.getenv("LLM_TIMEOUT_SECONDS", "45"))
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "").strip()
RESEARCH_MAX_AGE_MS = 6 * 60 * 60 * 1000
STARTING_CAPITAL = 10000.0
MIN_SLIPPAGE_BPS = 5
MAX_SLIPPAGE_BPS = 20
MIN_TRADE_NOTIONAL = 10.0
HISTORY_DAYS = 730
MIN_HISTORY_BARS = 500


PROVIDER_KEY_ENV = {
    "openai": "OPENAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "gemini": "GEMINI_API_KEY",
    "siliconflow": "SILICONFLOW_API_KEY",
    "local": "",
}

DEFAULT_SEATS = [
    {"id": "openai", "name": "OpenAI Seat", "style": "LLM macro + price action", "risk": "medium", "color": "#111111", "provider": "openai", "model": "gpt-4o-mini", "kind": "llm"},
    {"id": "openrouter", "name": "OpenRouter Seat", "style": "Router model cross-check", "risk": "medium", "color": "#2563eb", "provider": "openrouter", "model": "openai/gpt-4o-mini", "kind": "llm"},
    {"id": "gemini", "name": "Gemini Seat", "style": "LLM pattern synthesis", "risk": "low", "color": "#0f766e", "provider": "gemini", "model": "gemini-1.5-flash", "kind": "llm"},
    {"id": "siliconflow", "name": "SiliconFlow Seat", "style": "LLM momentum scout", "risk": "high", "color": "#7c3aed", "provider": "siliconflow", "model": "Qwen/Qwen2.5-72B-Instruct", "kind": "llm"},
]


def env(name, default=""):
    return os.getenv(name, default).strip()


def alpha_key_pool():
    raw = env("ALPHAVANTAGE_API_KEYS") or env("ALPHAVANTAGE_API_KEY")
    parts = re.split(r"[,\s]+", raw)
    keys = []
    seen = set()
    for key in parts:
        clean = key.strip()
        if clean and clean not in seen:
            keys.append(clean)
            seen.add(clean)
    return keys


def choose_alpha_key():
    keys = alpha_key_pool()
    if not keys:
        raise RuntimeError("Missing Alpha Vantage API key. Add ALPHAVANTAGE_API_KEYS or ALPHAVANTAGE_API_KEY to .env.local and restart the dev server.")
    return random.choice(keys)


def connect():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    migrate(conn)
    seed_symbols(conn)
    seed_seats(conn)
    initialize_accounts(conn)
    return conn


def migrate(conn):
    conn.executescript(
        """
        create table if not exists symbols (
          symbol text primary key,
          name text not null,
          asset_class text not null,
          active integer not null default 1,
          created_at integer not null
        );
        create table if not exists seats (
          id text primary key,
          name text not null,
          provider text not null,
          model text not null,
          kind text not null default 'llm',
          style text not null default '',
          risk text not null default 'medium',
          color text not null default '#111111',
          prompt text not null default '',
          watchlist text not null default '[]',
          active integer not null default 1,
          created_at integer not null
        );
        create table if not exists candles (
          symbol text not null,
          timestamp integer not null,
          open real not null,
          high real not null,
          low real not null,
          close real not null,
          volume real not null default 0,
          primary key (symbol, timestamp)
        );
        create table if not exists decisions (
          id integer primary key autoincrement,
          agent_id text not null,
          symbol text not null,
          action text not null,
          confidence integer not null,
          thesis text not null,
          horizon text not null,
          created_at integer not null
        );
        create table if not exists equity_points (
          id integer primary key autoincrement,
          agent_id text not null,
          timestamp integer not null,
          equity real not null
        );
        create table if not exists account_cash (
          agent_id text primary key,
          cash real not null,
          updated_at integer not null
        );
        create table if not exists positions (
          agent_id text not null,
          symbol text not null,
          quantity real not null,
          avg_price real not null,
          updated_at integer not null,
          primary key (agent_id, symbol)
        );
        create table if not exists sync_errors (
          id integer primary key autoincrement,
          message text not null,
          created_at integer not null
        );
        create table if not exists indicator_snapshots (
          symbol text primary key,
          payload text not null,
          updated_at integer not null
        );
        create table if not exists research_items (
          id integer primary key autoincrement,
          symbol text not null,
          source text not null,
          title text not null,
          url text,
          summary text not null,
          published_at text,
          created_at integer not null
        );
        create table if not exists orders (
          id integer primary key autoincrement,
          agent_id text not null,
          symbol text not null,
          requested_action text not null,
          status text not null,
          quantity real not null default 0,
          notional real not null default 0,
          signal_price real,
          execution_price real,
          slippage_bps integer not null default 0,
          reason text not null,
          created_at integer not null
        );
        """
    )
    ensure_column(conn, "decisions", "provider", "text")
    ensure_column(conn, "decisions", "model", "text")
    ensure_column(conn, "decisions", "source", "text")
    ensure_column(conn, "decisions", "slippage_bps", "integer not null default 0")
    ensure_column(conn, "decisions", "execution_price", "real")
    ensure_column(conn, "decisions", "order_status", "text")
    ensure_column(conn, "decisions", "order_reason", "text")
    ensure_column(conn, "decisions", "executed_quantity", "real not null default 0")
    ensure_column(conn, "decisions", "notional", "real not null default 0")
    ensure_column(conn, "seats", "prompt", "text not null default ''")
    ensure_column(conn, "seats", "watchlist", "text not null default '[]'")
    migrate_starting_capital(conn)
    conn.execute("create index if not exists idx_research_symbol_created on research_items(symbol, created_at desc)")
    cleanup_stale_symbol_cache(conn)
    conn.commit()


def cleanup_stale_symbol_cache(conn):
    active_rows = conn.execute("select symbol from symbols where active = 1").fetchall()
    if not active_rows:
        return
    active = {row["symbol"].upper() for row in active_rows}
    for row in conn.execute("select id, message from sync_errors").fetchall():
        prefix = row["message"].split(":", 1)[0].strip().upper()
        if prefix and prefix not in active:
            conn.execute("delete from sync_errors where id = ?", (row["id"],))
    for row in conn.execute("select symbol from indicator_snapshots").fetchall():
        if row["symbol"].upper() not in active:
            conn.execute("delete from indicator_snapshots where symbol = ?", (row["symbol"],))
    for row in conn.execute("select distinct symbol from research_items").fetchall():
        if row["symbol"].upper() not in active:
            conn.execute("delete from research_items where symbol = ?", (row["symbol"],))


def active_symbol_set(conn):
    return {row["symbol"].upper() for row in conn.execute("select symbol from symbols where active = 1").fetchall()}


def recent_active_errors(conn, limit=4):
    active = active_symbol_set(conn)
    if not active:
        return []
    errors = []
    for row in conn.execute("select message from sync_errors order by created_at desc limit 24").fetchall():
        message = row["message"]
        prefix = message.split(":", 1)[0].strip().upper()
        if prefix in active:
            errors.append(message)
        if len(errors) >= limit:
            break
    return errors


def ensure_column(conn, table, column, ddl):
    columns = {row["name"] for row in conn.execute(f"pragma table_info({table})")}
    if column not in columns:
        conn.execute(f"alter table {table} add column {column} {ddl}")


def migrate_starting_capital(conn):
    row = conn.execute("select max(equity) as max_equity from equity_points").fetchone()
    if row and row["max_equity"] and row["max_equity"] > STARTING_CAPITAL * 5:
        conn.execute("delete from equity_points")
        conn.execute("delete from account_cash")
        conn.execute("delete from positions")


def initialize_accounts(conn):
    now = int(time.time() * 1000)
    rows = conn.execute("select id from seats where active = 1").fetchall()
    for row in rows:
        conn.execute("insert or ignore into account_cash (agent_id, cash, updated_at) values (?, ?, ?)", (row["id"], STARTING_CAPITAL, now))
    conn.commit()


def seed_symbols(conn):
    count = conn.execute("select count(*) as count from symbols").fetchone()["count"]
    if count > 0:
        return
    now = int(time.time() * 1000)
    symbols = [("AAPL", "Apple", "stock"), ("NVDA", "NVIDIA", "stock"), ("EURUSD", "EUR/USD", "forex"), ("BTC-USD", "Bitcoin", "crypto")]
    conn.executemany("insert into symbols (symbol, name, asset_class, active, created_at) values (?, ?, ?, 1, ?)", [(symbol, name, asset_class, now) for symbol, name, asset_class in symbols])
    conn.commit()


def seed_seats(conn):
    count = conn.execute("select count(*) as count from seats").fetchone()["count"]
    if count > 0:
        return
    now = int(time.time() * 1000)
    conn.executemany(
        "insert into seats (id, name, provider, model, kind, style, risk, color, prompt, watchlist, active, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
        [(seat["id"], seat["name"], seat["provider"], seat["model"], seat["kind"], seat["style"], seat["risk"], seat["color"], seat.get("prompt", ""), json.dumps(seat.get("watchlist", []), separators=(",", ":")), now) for seat in DEFAULT_SEATS],
    )
    conn.commit()


def provider_key_env(provider):
    return PROVIDER_KEY_ENV.get(provider, "")


def list_seats(conn, active_only=True):
    where = "where active = 1" if active_only else ""
    rows = conn.execute(f"select id, name, provider, model, kind, style, risk, color, prompt, watchlist, active from seats {where} order by created_at asc").fetchall()
    seats = []
    for row in rows:
        seat = dict(row)
        seat["key_env"] = provider_key_env(seat["provider"])
        seat["watchlist"] = parse_watchlist(seat.get("watchlist"), active_symbol_set(conn))
        seats.append(seat)
    return seats


def parse_watchlist(raw, allowed_symbols):
    if not raw:
        return []
    try:
        values = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        values = str(raw).split(",")
    if not isinstance(values, list):
        return []
    allowed = {symbol.upper() for symbol in allowed_symbols}
    result = []
    for value in values:
        symbol = str(value).strip().upper()
        if symbol in allowed and symbol not in result:
            result.append(symbol)
    return result
def default_prompt(agent):
    style = agent.get("style") or "balanced multi-asset strategy"
    risk = agent.get("risk") or "medium"
    return (
        f"Act like an elite discretionary trader with a market-maker/main-force perspective, running the {style} at {risk} risk. "
        "Read liquidity, stops, accumulation/distribution, trend, momentum, volatility, support/resistance, and risk/reward. "
        "Add fundamental/macro context: business quality for stocks, rates/USD flows for FX, liquidity/adoption/regime for crypto, and real rates/USD/liquidity for commodities. "
        "Avoid overtrading, protect capital, size conviction cautiously, and explain the key risk in the thesis."
    )


def effective_prompt(agent):
    custom = str(agent.get("prompt") or "").strip()
    return custom or default_prompt(agent)


def public_agent(agent):
    key_env = provider_key_env(agent["provider"])
    return {
        "id": agent["id"],
        "name": agent["name"],
        "style": agent["style"],
        "risk": agent["risk"],
        "color": agent["color"],
        "provider": agent["provider"],
        "model": agent["model"],
        "prompt": effective_prompt(agent),
        "kind": agent["kind"],
        "watchlist": agent.get("watchlist", []),
        "enabled": bool(key_env and env(key_env)),
    }


def normalize_symbol(symbol, asset_class):
    clean = symbol.strip().upper().replace(" ", "")
    if asset_class == "forex":
        return clean.replace("/", "").replace("-", "").replace("=X", "")
    if asset_class == "crypto":
        clean = clean.replace("/", "-")
        if "-" not in clean:
            return f"{clean}-USD"
    if asset_class == "commodity":
        if clean in {"GOLD", "XAU", "XAUUSD", "XAU/USD", "XAUUSD=X"}:
            return "XAUUSD"
        return clean.replace("/", "-")
    return clean


def normalize_id(value):
    clean = re.sub(r"[^a-z0-9_-]+", "-", value.strip().lower())
    clean = re.sub(r"-+", "-", clean).strip("-")
    if not clean:
        clean = f"seat-{int(time.time())}"
    return clean[:64]


def http_json(url, payload=None, headers=None, timeout=25):
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers=headers or {}, method="GET" if body is None else "POST")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def alpha_query(params):
    query_params = dict(params)
    query_params["apikey"] = choose_alpha_key()
    url = "https://www.alphavantage.co/query?" + urllib.parse.urlencode(query_params)
    payload = http_json(url, headers={"User-Agent": "ai-arena/0.4"})
    for key in ("Error Message", "Information", "Note"):
        if key in payload:
            raise RuntimeError(str(payload[key]))
    return payload


def fetch_alpha_candles(symbol, asset_class, outputsize="compact"):
    if asset_class == "stock":
        params = {"function": "TIME_SERIES_DAILY", "symbol": symbol, "outputsize": outputsize}
    elif asset_class == "forex":
        base, quote = split_pair(symbol)
        params = {"function": "FX_DAILY", "from_symbol": base, "to_symbol": quote, "outputsize": outputsize}
    else:
        base, quote = split_crypto(symbol)
        params = {"function": "DIGITAL_CURRENCY_DAILY", "symbol": base, "market": quote}
    payload = alpha_query(params)
    key = next((name for name in payload.keys() if name.startswith("Time Series")), None)
    if not key:
        raise RuntimeError(f"Alpha Vantage did not return daily bars for {symbol}.")
    candles = []
    for timestamp_text, values in payload[key].items():
        timestamp = parse_alpha_timestamp(timestamp_text)
        candles.append((symbol, timestamp, read_float(values, "1. open"), read_float(values, "2. high"), read_float(values, "3. low"), read_float(values, "4. close"), read_float(values, "5. volume", 0)))
    candles.sort(key=lambda row: row[1])
    return trim_history(candles)


def fetch_yahoo_candles(symbol):
    yahoo_symbol = yahoo_chart_symbol(symbol)
    period2 = int(time.time())
    period1 = period2 - HISTORY_DAYS * 86400 - 10 * 86400
    query = urllib.parse.urlencode({"period1": period1, "period2": period2, "interval": "1d", "events": "history", "includeAdjustedClose": "true"})
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(yahoo_symbol, safe='=^.-')}?{query}"
    data = http_json(url, headers={"User-Agent": "Mozilla/5.0 ai-arena/0.4"}, timeout=25)
    result = (data.get("chart", {}).get("result") or [None])[0]
    if not result:
        error = data.get("chart", {}).get("error") or {}
        raise RuntimeError(f"Yahoo Finance did not return daily bars for {symbol}: {error.get('description') or 'empty response'}")
    timestamps = result.get("timestamp") or []
    quote = ((result.get("indicators") or {}).get("quote") or [{}])[0]
    opens = quote.get("open") or []
    highs = quote.get("high") or []
    lows = quote.get("low") or []
    closes = quote.get("close") or []
    volumes = quote.get("volume") or []
    candles = []
    for index, seconds in enumerate(timestamps):
        values = [opens, highs, lows, closes]
        if any(index >= len(series) or series[index] is None for series in values):
            continue
        volume = volumes[index] if index < len(volumes) and volumes[index] is not None else 0
        candles.append((symbol, int(seconds) * 1000, float(opens[index]), float(highs[index]), float(lows[index]), float(closes[index]), float(volume)))
    if not candles:
        raise RuntimeError(f"Yahoo Finance did not return usable daily bars for {symbol}.")
    candles.sort(key=lambda row: row[1])
    return trim_history(candles)


def yahoo_chart_symbol(symbol):
    clean = symbol.strip().upper().replace(" ", "")
    mapping = {"XAUUSD": "GC=F", "XAU/USD": "GC=F", "XAUUSD=X": "GC=F", "GOLD": "GC=F", "GC": "GC=F", "GOLD-FUTURES": "GC=F"}
    return mapping.get(clean, clean)


def trim_history(candles):
    cutoff = int((time.time() - HISTORY_DAYS * 86400) * 1000)
    recent = [row for row in candles if row[1] >= cutoff]
    return recent or candles[-MIN_HISTORY_BARS:]


def local_bar_count(conn, symbol):
    row = conn.execute("select count(*) as count from candles where symbol = ?", (symbol,)).fetchone()
    return int(row["count"] if row else 0)


def latest_local_timestamp(conn, symbol):
    row = conn.execute("select max(timestamp) as timestamp from candles where symbol = ?", (symbol,)).fetchone()
    return row["timestamp"] if row else None


def candle_key(row):
    return (row[0], row[1])


def load_market_history(conn, symbol, asset_class):
    needs_backfill = local_bar_count(conn, symbol) < MIN_HISTORY_BARS
    if asset_class == "commodity":
        return fetch_yahoo_candles(symbol), needs_backfill
    try:
        return fetch_alpha_candles(symbol, asset_class, "full" if needs_backfill else "compact"), needs_backfill
    except Exception:
        if needs_backfill:
            return fetch_alpha_candles(symbol, asset_class, "compact"), False
        raise


def insert_new_candles(conn, candles):
    inserted = 0
    for candle in candles:
        exists = conn.execute("select 1 from candles where symbol = ? and timestamp = ?", (candle[0], candle[1])).fetchone()
        conn.execute("insert or replace into candles (symbol, timestamp, open, high, low, close, volume) values (?, ?, ?, ?, ?, ?, ?)", candle)
        if not exists:
            inserted += 1
    return inserted


def read_float(values, prefix, fallback=None):
    for key, value in values.items():
        if key.startswith(prefix):
            return float(value)
    if fallback is not None:
        return float(fallback)
    raise RuntimeError(f"Alpha Vantage response missing {prefix}")


def parse_alpha_timestamp(value):
    parsed = time.strptime(value.split(" ")[0], "%Y-%m-%d")
    return int(time.mktime(parsed) * 1000)


def split_pair(symbol):
    clean = symbol.replace("/", "").replace("-", "").replace("=X", "").upper()
    if len(clean) != 6:
        raise RuntimeError(f"Forex symbol must look like EURUSD or EUR/USD: {symbol}")
    return clean[:3], clean[3:]


def split_crypto(symbol):
    clean = symbol.upper().replace("/", "-")
    if "-" in clean:
        base, quote = clean.split("-", 1)
        return base, quote
    if len(clean) > 3:
        return clean[:-3], clean[-3:]
    return clean, "USD"


def average(values):
    return sum(values) / len(values) if values else 0


def stdev(values):
    if len(values) < 2:
        return 0
    mean = average(values)
    return math.sqrt(average([(value - mean) ** 2 for value in values]))


def ema(values, period):
    if not values:
        return None
    alpha = 2 / (period + 1)
    result = values[0]
    for value in values[1:]:
        result = value * alpha + result * (1 - alpha)
    return result


def rsi(values, period=14):
    if len(values) <= period:
        return None
    gains = []
    losses = []
    for index in range(1, len(values)):
        change = values[index] - values[index - 1]
        gains.append(max(change, 0))
        losses.append(abs(min(change, 0)))
    avg_gain = average(gains[-period:])
    avg_loss = average(losses[-period:])
    if avg_loss == 0:
        return 100
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def atr(rows, period=14):
    if len(rows) <= 1:
        return None
    ranges = []
    for index in range(1, len(rows)):
        high = rows[index]["high"]
        low = rows[index]["low"]
        prev_close = rows[index - 1]["close"]
        ranges.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    return average(ranges[-period:]) if ranges else None


def compute_indicators(rows):
    closes = [row["close"] for row in rows]
    last = closes[-1] if closes else None
    ema12 = ema(closes[-26:], 12)
    ema26 = ema(closes[-35:], 26)
    macd = (ema12 - ema26) if ema12 is not None and ema26 is not None else None
    sma20 = average(closes[-20:]) if len(closes) >= 20 else None
    sma50 = average(closes[-50:]) if len(closes) >= 50 else None
    atr14 = atr(rows[-20:], 14)
    return {
        "sma20": round(sma20, 6) if sma20 is not None else None,
        "sma50": round(sma50, 6) if sma50 is not None else None,
        "ema12": round(ema12, 6) if ema12 is not None else None,
        "ema26": round(ema26, 6) if ema26 is not None else None,
        "macd": round(macd, 6) if macd is not None else None,
        "rsi14": round(rsi(closes, 14), 2) if rsi(closes, 14) is not None else None,
        "atr14": round(atr14, 6) if atr14 is not None else None,
        "atr_pct": round(atr14 / last, 6) if atr14 is not None and last else None,
        "price_vs_sma20": round((last - sma20) / sma20, 6) if sma20 and last else None,
        "price_vs_sma50": round((last - sma50) / sma50, 6) if sma50 and last else None,
    }


def load_indicator(conn, symbol):
    row = conn.execute("select payload from indicator_snapshots where symbol = ?", (symbol,)).fetchone()
    if not row:
        return {}
    try:
        return json.loads(row["payload"])
    except Exception:
        return {}


def upsert_indicators(conn, symbol):
    rows = list(reversed(conn.execute("select timestamp, open, high, low, close, volume from candles where symbol = ? order by timestamp desc limit 80", (symbol,)).fetchall()))
    if len(rows) < 15:
        return {}
    payload = compute_indicators(rows)
    conn.execute("insert or replace into indicator_snapshots (symbol, payload, updated_at) values (?, ?, ?)", (symbol, json.dumps(payload, separators=(",", ":")), int(time.time() * 1000)))
    return payload


def build_market_snapshot(conn, symbols):
    snapshot = []
    for symbol in symbols:
        candles = list(reversed(conn.execute("select symbol, timestamp, open, high, low, close, volume from candles where symbol = ? order by timestamp desc limit 30", (symbol,)).fetchall()))
        if len(candles) < 4:
            continue
        closes = [row["close"] for row in candles]
        last = closes[-1]
        prev = closes[-2]
        asset_row = conn.execute("select asset_class from symbols where symbol = ?", (symbol,)).fetchone()
        snapshot.append({
            "symbol": symbol,
            "asset_class": asset_row["asset_class"] if asset_row else "stock",
            "last_close": last,
            "one_day_return": (last - prev) / prev if prev else 0,
            "six_day_return": (last - closes[-7]) / closes[-7] if len(closes) >= 7 and closes[-7] else 0,
            "volatility_12d": stdev(closes[-12:]) / (last or 1),
            "indicators": load_indicator(conn, symbol),
            "research": load_research_context(conn, symbol),
            "latest_bars": [{"date": time.strftime("%Y-%m-%d", time.localtime(row["timestamp"] / 1000)), "close": row["close"], "volume": row["volume"]} for row in candles[-8:]],
        })
    return snapshot


def filter_snapshot_for_agent(conn, agent, market_snapshot):
    watchlist = agent.get("watchlist") or []
    if not watchlist:
        return market_snapshot
    allowed = set(watchlist)
    filtered = [item for item in market_snapshot if item["symbol"] in allowed]
    if filtered:
        return filtered
    return build_market_snapshot(conn, watchlist)
def load_research_context(conn, symbol, limit=5):
    rows = conn.execute("select source, title, url, summary, published_at from research_items where symbol = ? order by created_at desc limit ?", (symbol, limit)).fetchall()
    return [{"source": row["source"], "title": row["title"], "url": row["url"], "summary": row["summary"], "published_at": row["published_at"]} for row in rows]


def tavily_search(query):
    if not TAVILY_API_KEY:
        return []
    payload = {"query": query, "topic": "news", "search_depth": "basic", "time_range": "week", "max_results": 3, "include_answer": False, "include_raw_content": False}
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {TAVILY_API_KEY}"}
    data = http_json("https://api.tavily.com/search", payload=payload, headers=headers, timeout=20)
    return data.get("results", [])[:3]


def yahoo_news(symbol):
    url = "https://query1.finance.yahoo.com/v1/finance/search?" + urllib.parse.urlencode({"q": symbol, "newsCount": 3, "quotesCount": 0})
    try:
        data = http_json(url, headers={"User-Agent": "Mozilla/5.0 ai-arena/0.4"}, timeout=15)
    except Exception:
        return []
    return data.get("news", [])[:3]


def fetch_fundamental_summary(symbol, asset_class):
    if asset_class != "stock":
        return None
    try:
        payload = alpha_query({"function": "OVERVIEW", "symbol": symbol})
    except Exception as exc:
        return {"source": "Alpha Vantage", "title": f"{symbol} fundamentals unavailable", "url": "https://www.alphavantage.co/documentation/", "summary": str(exc)[:260], "published_at": ""}
    if not payload or not payload.get("Symbol"):
        return None
    fields = ["Name", "Sector", "Industry", "MarketCapitalization", "PERatio", "ForwardPE", "ProfitMargin", "RevenueTTM", "QuarterlyEarningsGrowthYOY", "QuarterlyRevenueGrowthYOY", "AnalystTargetPrice"]
    parts = [f"{field}: {payload.get(field)}" for field in fields if payload.get(field) not in (None, "", "None")]
    return {"source": "Alpha Vantage", "title": f"{symbol} company overview", "url": "https://www.alphavantage.co/documentation/", "summary": "; ".join(parts)[:700], "published_at": ""}


def store_research_item(conn, symbol, item):
    title = str(item.get("title") or "Untitled")[:240]
    url = str(item.get("url") or "")[:500]
    source = str(item.get("source") or "research")[:80]
    summary = str(item.get("summary") or item.get("content") or title)[:900]
    published_at = str(item.get("published_at") or item.get("published_date") or "")[:80]
    duplicate = conn.execute("select id from research_items where symbol = ? and title = ? and coalesce(url, '') = ?", (symbol, title, url)).fetchone()
    if duplicate:
        return
    conn.execute("insert into research_items (symbol, source, title, url, summary, published_at, created_at) values (?, ?, ?, ?, ?, ?, ?)", (symbol, source, title, url, summary, published_at, int(time.time() * 1000)))


def refresh_research(conn, symbol, asset_class):
    cutoff = int(time.time() * 1000) - RESEARCH_MAX_AGE_MS
    cached = conn.execute("select id from research_items where symbol = ? and created_at >= ? limit 1", (symbol, cutoff)).fetchone()
    if cached:
        return
    fundamental = fetch_fundamental_summary(symbol, asset_class)
    if fundamental:
        store_research_item(conn, symbol, fundamental)
    for result in tavily_search(f"{symbol} market news fundamentals technical analysis"):
        store_research_item(conn, symbol, {"source": "Tavily", "title": result.get("title"), "url": result.get("url"), "summary": result.get("content"), "published_at": result.get("published_date")})
    for item in yahoo_news(symbol):
        store_research_item(conn, symbol, {"source": "Yahoo Finance", "title": item.get("title"), "url": item.get("link"), "summary": item.get("publisher") or item.get("title"), "published_at": str(item.get("providerPublishTime") or "")})
    conn.execute("delete from research_items where id not in (select id from research_items where symbol = ? order by created_at desc limit 12) and symbol = ?", (symbol, symbol))


def rule_decide(agent, market_snapshot, reason=None):
    if not market_snapshot:
        return {"action": "HOLD", "symbol": "--", "confidence": 0, "thesis": "No synced market bars are available.", "horizon": "1 day", "source": "error"}
    scored = []
    for item in market_snapshot:
        score = item["six_day_return"] * 1.8 + item["one_day_return"] * 2.8 - item["volatility_12d"] * 0.2
        scored.append((score, item))
    score, item = max(scored, key=lambda row: abs(row[0]))
    action = "BUY" if score > 0.0025 else "SELL" if score < -0.003 else "HOLD"
    confidence = min(94, max(42, round(abs(score) * 5200 + 48)))
    fallback_reason = reason or f"{agent['provider']} is unavailable"
    return {"action": action, "symbol": item["symbol"], "confidence": confidence, "thesis": f"Fallback rule used because {fallback_reason}. Signal={score:.4f} on daily bars.", "horizon": "1-5 days", "source": "rule"}


def llm_decide(conn, agent, market_snapshot):
    key_env = provider_key_env(agent["provider"])
    api_key = env(key_env)
    if not api_key:
        decision = rule_decide(agent, market_snapshot)
        decision["source"] = "disabled"
        decision["thesis"] = f"{agent['provider']} key is not configured. Add {key_env} to .env.local to enable this LLM seat."
        decision["action"] = "HOLD"
        decision["symbol"] = "--"
        decision["confidence"] = 0
        decision["horizon"] = "disabled"
        return decision
    prompt = build_decision_prompt(agent, market_snapshot, portfolio_state(conn, agent["id"]))
    if agent["provider"] == "gemini":
        text = call_gemini(agent, prompt, api_key)
    else:
        text = call_chat_completions(agent, prompt, api_key)
    decision = parse_llm_decision(text, market_snapshot)
    decision["source"] = "llm"
    return decision


def build_decision_prompt(agent, market_snapshot, portfolio):
    tradable = [item["symbol"] for item in market_snapshot]
    payload = {"agent": {"name": agent["name"], "risk": agent["risk"], "style": agent["style"], "custom_prompt": effective_prompt(agent), "watchlist": agent.get("watchlist", [])}, "tools": {"portfolio_state": "cash, positions, equity from local SQLite", "market_snapshot": "daily candles and returns", "technical_indicators": "local SMA/EMA/MACD/RSI/ATR snapshots", "technical_news": "Tavily/Yahoo market technical-analysis headlines when configured", "fundamentals_news": "Alpha Vantage overview for stocks plus Tavily/Yahoo macro/news summaries; commodities use Yahoo Finance price bars", "risk_check": "server-side sizing, symbol whitelist, stock no-naked-short rule, 5-20 bps slippage"}, "account": {"starting_capital": STARTING_CAPITAL, "slippage_bps_range": [MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS], "portfolio": portfolio}, "timeframe": "1 day", "tradable_symbols": tradable, "market_snapshot": market_snapshot}
    return (
        "You are one seat in an Alpha Arena style paper-trading competition. "
        "Think and act like a top trader from an institutional/main-force perspective: infer liquidity, trapped positions, stop zones, accumulation/distribution, trend quality, macro pressure, and invalidation. "
        "Choose exactly one action for the next daily round. Action semantics: BUY means enter/add long, or cover/reduce an existing short. SELL means reduce/exit long; for forex/crypto/commodity it may also enter/add short. Stocks cannot be sold short, so for stocks SELL is only allowed when reducing an existing long. HOLD means wait/observe. "
        "Use only the provided market data and custom_prompt. "
        "Return one-line minified JSON only, no markdown, no code fence, no newline. "
        "Required keys: action, symbol, confidence, thesis, horizon. action must be BUY, SELL, or HOLD. symbol must be one of tradable_symbols. confidence is 0-100. Keep thesis under 220 characters. "
        f"Input: {json.dumps(payload, separators=(',', ':'))}"
    )


def call_chat_completions(agent, prompt, api_key):
    endpoints = {"openai": "https://api.openai.com/v1/chat/completions", "openrouter": "https://openrouter.ai/api/v1/chat/completions", "siliconflow": "https://api.siliconflow.com/v1/chat/completions"}
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    if agent["provider"] == "openrouter":
        headers["HTTP-Referer"] = "http://localhost:3000"
        headers["X-Title"] = "AI Trading Arena"
    payload = {"model": agent["model"], "messages": [{"role": "system", "content": "You are a disciplined paper-trading model. Output JSON only."}, {"role": "user", "content": prompt}], "temperature": 0.2}
    data = http_json(endpoints[agent["provider"]], payload=payload, headers=headers, timeout=LLM_TIMEOUT_SECONDS)
    try:
        return data["choices"][0]["message"]["content"]
    except Exception as exc:
        raise RuntimeError(f"Unexpected {agent['provider']} response: {data}") from exc


def call_gemini(agent, prompt, api_key):
    model = urllib.parse.quote(agent["model"], safe="")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={urllib.parse.quote(api_key)}"
    payload = {"contents": [{"parts": [{"text": prompt}]}], "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json"}}
    data = http_json(url, payload=payload, headers={"Content-Type": "application/json"}, timeout=LLM_TIMEOUT_SECONDS)
    try:
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except Exception as exc:
        raise RuntimeError(f"Unexpected gemini response: {data}") from exc


def salvage_llm_decision(text):
    def pick(key):
        match = re.search(r'"?' + re.escape(key) + r'"?\s*:\s*"?([^",}\n]+)', text, re.I)
        return match.group(1).strip() if match else None
    def quoted(key):
        match = re.search(r'"?' + re.escape(key) + r'"?\s*:\s*"([^"\n]{1,600})', text, re.I)
        return match.group(1).strip() if match else None
    return {"action": pick("action") or "HOLD", "symbol": pick("symbol") or "", "confidence": pick("confidence") or 0, "thesis": quoted("thesis") or "LLM returned malformed JSON; recovered partial decision.", "horizon": quoted("horizon") or "1-5 days"}


def parse_llm_decision(text, market_snapshot):
    raw = text.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?", "", raw).strip()
        raw = re.sub(r"```$", "", raw).strip()
    match = re.search(r"\{.*\}", raw, re.S)
    if match:
        raw = match.group(0)
    try:
        data = json.loads(raw)
    except Exception:
        data = salvage_llm_decision(raw)
    symbols = {item["symbol"] for item in market_snapshot}
    symbol = str(data.get("symbol", "")).upper()
    if symbol not in symbols:
        symbol = next(iter(symbols), "--")
    action = str(data.get("action", "HOLD")).upper()
    if action not in {"BUY", "SELL", "HOLD"}:
        action = "HOLD"
    confidence = int(max(0, min(100, float(data.get("confidence", 0)))))
    thesis = str(data.get("thesis", "LLM returned no thesis."))[:600]
    horizon = str(data.get("horizon", "1-5 days"))[:80]
    return {"action": action, "symbol": symbol, "confidence": confidence, "thesis": thesis, "horizon": horizon}


def remember_errors(conn, errors):
    if not errors:
        return
    now = int(time.time() * 1000)
    conn.executemany("insert into sync_errors (message, created_at) values (?, ?)", [(error, now) for error in errors])
    conn.execute("delete from sync_errors where id not in (select id from sync_errors order by created_at desc limit 12)")
    conn.commit()


def state(conn):
    symbols = [{"symbol": row["symbol"], "name": row["name"], "assetClass": row["asset_class"], "active": bool(row["active"])} for row in conn.execute("select symbol, name, asset_class, active from symbols where active = 1 order by created_at asc")]
    decisions = [{"agentId": row["agent_id"], "symbol": row["symbol"], "action": row["action"], "confidence": row["confidence"], "thesis": row["thesis"], "horizon": row["horizon"], "createdAt": row["created_at"], "provider": row["provider"], "model": row["model"], "source": row["source"], "slippageBps": row["slippage_bps"], "executionPrice": row["execution_price"], "orderStatus": row["order_status"], "orderReason": row["order_reason"], "executedQuantity": row["executed_quantity"], "notional": row["notional"]} for row in conn.execute("select agent_id, symbol, action, confidence, thesis, horizon, created_at, provider, model, source, slippage_bps, execution_price, order_status, order_reason, executed_quantity, notional from decisions order by created_at desc limit 32")]
    equity = [{"agentId": row["agent_id"], "timestamp": row["timestamp"], "equity": row["equity"]} for row in conn.execute("select agent_id, timestamp, equity from equity_points order by timestamp asc")]
    latest_prices = {row["symbol"]: row["close"] for row in conn.execute("select c.symbol, c.close from candles c join (select symbol, max(timestamp) timestamp from candles group by symbol) m on c.symbol = m.symbol and c.timestamp = m.timestamp")}
    indicators = {row["symbol"]: json.loads(row["payload"]) for row in conn.execute("select symbol, payload from indicator_snapshots")}
    cash = {row["agent_id"]: row["cash"] for row in conn.execute("select agent_id, cash from account_cash")}
    positions = [{"agentId": row["agent_id"], "symbol": row["symbol"], "quantity": row["quantity"], "avgPrice": row["avg_price"], "marketPrice": latest_prices.get(row["symbol"], row["avg_price"]), "marketValue": row["quantity"] * latest_prices.get(row["symbol"], row["avg_price"]), "unrealizedPnl": row["quantity"] * (latest_prices.get(row["symbol"], row["avg_price"]) - row["avg_price"])} for row in conn.execute("select agent_id, symbol, quantity, avg_price from positions where abs(quantity) > 0.000001 order by agent_id, symbol")]
    orders = [{"agentId": row["agent_id"], "symbol": row["symbol"], "action": row["requested_action"], "status": row["status"], "quantity": row["quantity"], "notional": row["notional"], "signalPrice": row["signal_price"], "executionPrice": row["execution_price"], "slippageBps": row["slippage_bps"], "reason": row["reason"], "createdAt": row["created_at"]} for row in conn.execute("select agent_id, symbol, requested_action, status, quantity, notional, signal_price, execution_price, slippage_bps, reason, created_at from orders order by created_at desc limit 40")]
    last_sync_row = conn.execute("select max(timestamp) as last_sync from candles").fetchone()
    errors = recent_active_errors(conn)
    return {"symbols": symbols, "agents": [public_agent(agent) for agent in list_seats(conn)], "decisions": decisions, "equity": equity, "positions": positions, "orders": orders, "cash": cash, "startingCapital": STARTING_CAPITAL, "indicators": indicators, "latestPrices": latest_prices, "dataStatus": {"source": DATA_SOURCE, "entitlement": ENTITLEMENT, "interval": INTERVAL, "errors": errors, "lastSyncAt": last_sync_row["last_sync"] if last_sync_row else None}, "updatedAt": int(time.time() * 1000)}


def reset_competition(conn):
    now = int(time.time() * 1000)
    conn.execute("delete from decisions")
    conn.execute("delete from equity_points")
    conn.execute("delete from account_cash")
    conn.execute("delete from positions")
    conn.execute("delete from orders")
    for row in conn.execute("select id from seats where active = 1").fetchall():
        conn.execute("insert into account_cash (agent_id, cash, updated_at) values (?, ?, ?)", (row["id"], STARTING_CAPITAL, now))
        conn.execute("insert into equity_points (agent_id, timestamp, equity) values (?, ?, ?)", (row["id"], now, STARTING_CAPITAL))
    conn.commit()
    return {"reset": True, "state": state(conn)}
def add_symbol(conn, symbol, name, asset_class):
    normalized = normalize_symbol(symbol, asset_class)
    now = int(time.time() * 1000)
    conn.execute("""insert into symbols (symbol, name, asset_class, active, created_at) values (?, ?, ?, 1, ?) on conflict(symbol) do update set name = excluded.name, asset_class = excluded.asset_class, active = 1""", (normalized, name or normalized, asset_class, now))
    conn.commit()
    return {"symbol": normalized}


def delete_symbol(conn, symbol):
    normalized = symbol.strip().upper()
    conn.execute("delete from symbols where symbol = ?", (normalized,))
    conn.execute("delete from candles where symbol = ?", (normalized,))
    conn.execute("delete from indicator_snapshots where symbol = ?", (normalized,))
    conn.execute("delete from research_items where symbol = ?", (normalized,))
    conn.execute("delete from sync_errors where upper(message) like ?", (normalized + ":%",))
    conn.commit()
    return {"symbol": normalized}


def add_seat(conn, payload):
    provider = str(payload.get("provider", "openai")).strip().lower()
    if provider not in PROVIDER_KEY_ENV:
        raise RuntimeError(f"Unsupported provider: {provider}")
    name = str(payload.get("name") or f"{provider.title()} Seat").strip()
    seat_id = normalize_id(str(payload.get("id") or name))
    model = str(payload.get("model") or default_model(provider)).strip()
    kind = str(payload.get("kind") or "llm").strip().lower()
    style = str(payload.get("style") or "Custom LLM strategy").strip()
    prompt = str(payload.get("prompt") or "").strip()
    risk = str(payload.get("risk") or "medium").strip().lower()
    color = str(payload.get("color") or "#111111").strip()
    watchlist = json.dumps(parse_watchlist(payload.get("watchlist"), active_symbol_set(conn)), separators=(",", ":"))
    if risk not in {"low", "medium", "high"}:
        risk = "medium"
    now = int(time.time() * 1000)
    conn.execute(
        """insert into seats (id, name, provider, model, kind, style, risk, color, prompt, watchlist, active, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?) on conflict(id) do update set name = excluded.name, provider = excluded.provider, model = excluded.model, kind = excluded.kind, style = excluded.style, risk = excluded.risk, color = excluded.color, prompt = excluded.prompt, watchlist = excluded.watchlist, active = 1""",
        (seat_id, name, provider, model, kind, style, risk, color, prompt, watchlist, now),
    )
    conn.commit()
    return {"id": seat_id}


def default_model(provider):
    return {"openai": "gpt-4o-mini", "openrouter": "openai/gpt-4o-mini", "gemini": "gemini-1.5-flash", "siliconflow": "Qwen/Qwen2.5-72B-Instruct", "local": "local-rule"}.get(provider, "")


def delete_seat(conn, seat_id):
    clean = normalize_id(seat_id)
    conn.execute("delete from seats where id = ?", (clean,))
    conn.execute("delete from decisions where agent_id = ?", (clean,))
    conn.execute("delete from equity_points where agent_id = ?", (clean,))
    conn.execute("delete from account_cash where agent_id = ?", (clean,))
    conn.execute("delete from positions where agent_id = ?", (clean,))
    conn.commit()
    return {"id": clean}


def list_provider_models(provider):
    provider = str(provider or "").strip().lower()
    if provider not in PROVIDER_KEY_ENV or provider == "local":
        return {"models": []}
    api_key = env(provider_key_env(provider))
    headers = {"User-Agent": "ai-arena/0.4"}
    if provider == "openai":
        if not api_key:
            return {"models": [], "error": "Missing OPENAI_API_KEY in .env.local"}
        headers["Authorization"] = f"Bearer {api_key}"
        payload = http_json("https://api.openai.com/v1/models", headers=headers, timeout=LLM_TIMEOUT_SECONDS)
        models = sorted([item.get("id", "") for item in payload.get("data", []) if item.get("id")])
        return {"models": models}
    if provider == "openrouter":
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        headers["HTTP-Referer"] = "http://localhost:3000"
        headers["X-Title"] = "AI Trading Arena"
        payload = http_json("https://openrouter.ai/api/v1/models", headers=headers, timeout=LLM_TIMEOUT_SECONDS)
        models = sorted([item.get("id", "") for item in payload.get("data", []) if item.get("id")])
        return {"models": models}
    if provider == "siliconflow":
        if not api_key:
            return {"models": [], "error": "Missing SILICONFLOW_API_KEY in .env.local"}
        headers["Authorization"] = f"Bearer {api_key}"
        payload = http_json("https://api.siliconflow.com/v1/models", headers=headers, timeout=LLM_TIMEOUT_SECONDS)
        models = sorted([item.get("id", "") for item in payload.get("data", []) if item.get("id")])
        return {"models": models}
    if provider == "gemini":
        if not api_key:
            return {"models": [], "error": "Missing GEMINI_API_KEY in .env.local"}
        url = "https://generativelanguage.googleapis.com/v1beta/models?key=" + urllib.parse.quote(api_key)
        payload = http_json(url, headers=headers, timeout=LLM_TIMEOUT_SECONDS)
        models = []
        for item in payload.get("models", []):
            name = item.get("name", "").replace("models/", "")
            methods = item.get("supportedGenerationMethods", [])
            if name and "generateContent" in methods:
                models.append(name)
        return {"models": sorted(models)}
    return {"models": []}


COMMODITY_PRODUCTS = [
    ("XAUUSD", "Gold USD proxy", "GC=F"), ("GC=F", "Gold Futures", "GC=F"),
    ("XAGUSD", "Silver Spot USD", "XAGUSD=X"), ("SI=F", "Silver Futures", "SI=F"),
]


FX_PRODUCTS = [
    ("EURUSD", "EUR/USD"), ("GBPUSD", "GBP/USD"), ("USDJPY", "USD/JPY"), ("USDCHF", "USD/CHF"),
    ("AUDUSD", "AUD/USD"), ("USDCAD", "USD/CAD"), ("NZDUSD", "NZD/USD"), ("EURJPY", "EUR/JPY"),
]

CRYPTO_PRODUCTS = [
    ("BTC-USD", "Bitcoin"), ("ETH-USD", "Ethereum"), ("SOL-USD", "Solana"), ("BNB-USD", "BNB"),
    ("XRP-USD", "XRP"), ("ADA-USD", "Cardano"), ("DOGE-USD", "Dogecoin"), ("AVAX-USD", "Avalanche"),
]


def search_products(query):
    keyword = query.strip()
    if not keyword:
        return []
    normalized = keyword.upper().replace("/", "").replace(" ", "")
    results = []
    for symbol, name in FX_PRODUCTS:
        if normalized in symbol or keyword.lower() in name.lower():
            results.append({"symbol": symbol, "name": name, "assetClass": "forex", "type": "FX", "region": "Global", "currency": ""})
    for symbol, name in CRYPTO_PRODUCTS:
        if normalized.replace("-", "") in symbol.replace("-", "") or keyword.lower() in name.lower():
            results.append({"symbol": symbol, "name": name, "assetClass": "crypto", "type": "Crypto", "region": "Global", "currency": "USD"})
    for symbol, name, yahoo_symbol in COMMODITY_PRODUCTS:
        aliases = {symbol.replace("-", ""), yahoo_symbol.replace("=", "").replace("-", ""), name.upper().replace(" ", "")}
        if normalized in aliases or any(normalized in alias for alias in aliases) or keyword.lower() in name.lower():
            results.append({"symbol": symbol, "name": name, "assetClass": "commodity", "type": "Commodity", "region": "Global", "currency": "USD"})
    try:
        payload = alpha_query({"function": "SYMBOL_SEARCH", "keywords": keyword})
        for item in payload.get("bestMatches", [])[:12]:
            symbol = item.get("1. symbol", "").strip()
            name = item.get("2. name", "").strip()
            product_type = item.get("3. type", "").strip()
            if not symbol or not name:
                continue
            results.append({
                "symbol": symbol,
                "name": name,
                "assetClass": "stock",
                "type": product_type or "Equity",
                "region": item.get("4. region", ""),
                "currency": item.get("8. currency", ""),
            })
    except Exception as exc:
        if not results:
            results.append({"symbol": "", "name": f"Alpha Vantage search failed: {exc}", "assetClass": "stock", "type": "error", "region": "", "currency": ""})
    seen = set()
    deduped = []
    for item in results:
        key = (item["symbol"], item["assetClass"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped[:20]


def run_cycle(conn):
    rows = conn.execute("select symbol, asset_class from symbols where active = 1").fetchall()
    synced = []
    updated = []
    backfilled = []
    failed = []
    errors = []
    for row in rows:
        symbol = row["symbol"]
        try:
            candles, did_backfill = load_market_history(conn, symbol, row["asset_class"])
            inserted = insert_new_candles(conn, candles)
            if inserted > 0 or did_backfill:
                upsert_indicators(conn, symbol)
                refresh_research(conn, symbol, row["asset_class"])
                updated.append(symbol)
                if did_backfill:
                    backfilled.append(symbol)
            synced.append(symbol)
        except Exception as exc:
            failed.append(symbol)
            errors.append(f"{symbol}: {exc}")
        if REQUEST_DELAY_SECONDS > 0:
            time.sleep(REQUEST_DELAY_SECONDS)
    conn.commit()
    remember_errors(conn, errors)
    now = int(time.time() * 1000)
    market_snapshot = build_market_snapshot(conn, updated or synced)
    if market_snapshot:
        for agent in list_seats(conn):
            agent_snapshot = filter_snapshot_for_agent(conn, agent, market_snapshot)
            try:
                decision = llm_decide(conn, agent, agent_snapshot)
            except Exception as exc:
                decision = rule_decide(agent, agent_snapshot, f"{agent['provider']} call failed: {exc}")
                decision["source"] = "error"
                errors.append(f"{agent['name']}: {exc}")
            update_equity(conn, agent, decision, now)
            insert_decision(conn, agent, decision, now)
    conn.commit()
    remember_errors(conn, errors)
    return {"synced": synced, "updated": updated, "backfilled": backfilled, "analyzed": bool(market_snapshot), "failed": failed, "errors": errors, "state": state(conn)}


def latest_price(conn, symbol):
    row = conn.execute("select close from candles where symbol = ? order by timestamp desc limit 1", (symbol,)).fetchone()
    return row["close"] if row else None


def ensure_account(conn, agent_id, now):
    row = conn.execute("select cash from account_cash where agent_id = ?", (agent_id,)).fetchone()
    if row:
        return row["cash"]
    conn.execute("insert into account_cash (agent_id, cash, updated_at) values (?, ?, ?)", (agent_id, STARTING_CAPITAL, now))
    return STARTING_CAPITAL


def account_equity(conn, agent_id):
    cash_row = conn.execute("select cash from account_cash where agent_id = ?", (agent_id,)).fetchone()
    cash = cash_row["cash"] if cash_row else STARTING_CAPITAL
    value = cash
    rows = conn.execute("select symbol, quantity, avg_price from positions where agent_id = ?", (agent_id,)).fetchall()
    for row in rows:
        price = latest_price(conn, row["symbol"]) or row["avg_price"]
        value += row["quantity"] * price
    return value


def portfolio_state(conn, agent_id):
    cash_row = conn.execute("select cash from account_cash where agent_id = ?", (agent_id,)).fetchone()
    cash = cash_row["cash"] if cash_row else STARTING_CAPITAL
    rows = conn.execute("select symbol, quantity, avg_price from positions where agent_id = ? and abs(quantity) > 0.000001", (agent_id,)).fetchall()
    positions = []
    for row in rows:
        price = latest_price(conn, row["symbol"]) or row["avg_price"]
        positions.append({"symbol": row["symbol"], "quantity": round(row["quantity"], 8), "avg_price": round(row["avg_price"], 6), "market_price": round(price, 6), "market_value": round(row["quantity"] * price, 2), "unrealized_pnl": round(row["quantity"] * (price - row["avg_price"]), 2)})
    return {"cash": round(cash, 2), "equity": round(account_equity(conn, agent_id), 2), "positions": positions}


def record_order(conn, agent_id, decision, status, quantity, notional, signal_price, execution_price, slippage, reason, now):
    decision["order_status"] = status
    decision["order_reason"] = reason
    decision["executed_quantity"] = round(quantity, 8)
    decision["notional"] = round(notional, 4)
    decision["slippage_bps"] = int(slippage or 0)
    decision["execution_price"] = round(execution_price, 6) if execution_price else None
    conn.execute("insert into orders (agent_id, symbol, requested_action, status, quantity, notional, signal_price, execution_price, slippage_bps, reason, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (agent_id, decision.get("symbol", "--"), decision.get("action", "HOLD"), status, round(quantity, 8), round(notional, 4), signal_price, execution_price, int(slippage or 0), reason, now))


def insert_decision(conn, agent, decision, now):
    conn.execute("insert into decisions (agent_id, symbol, action, confidence, thesis, horizon, created_at, provider, model, source, slippage_bps, execution_price, order_status, order_reason, executed_quantity, notional) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (agent["id"], decision["symbol"], decision["action"], int(decision["confidence"]), decision["thesis"], decision["horizon"], now, agent["provider"], agent["model"], decision.get("source", "llm"), int(decision.get("slippage_bps", 0)), decision.get("execution_price"), decision.get("order_status", "SKIPPED"), decision.get("order_reason", "No order generated."), float(decision.get("executed_quantity", 0)), float(decision.get("notional", 0))))


def asset_class_for(conn, symbol):
    row = conn.execute("select asset_class from symbols where symbol = ?", (symbol,)).fetchone()
    return row["asset_class"] if row else "stock"


def update_equity(conn, agent, decision, now):
    agent_id = agent["id"]
    cash = ensure_account(conn, agent_id, now)
    action = decision.get("action", "HOLD")
    symbol = decision.get("symbol", "--")
    if decision.get("source") in {"disabled", "error"} or symbol == "--":
        record_order(conn, agent_id, decision, "SKIPPED", 0, 0, None, None, 0, "No executable signal.", now)
        conn.execute("insert into equity_points (agent_id, timestamp, equity) values (?, ?, ?)", (agent_id, now, round(account_equity(conn, agent_id), 2)))
        return
    price = latest_price(conn, symbol)
    if not price:
        record_order(conn, agent_id, decision, "REJECTED", 0, 0, None, None, 0, "No market price available.", now)
        conn.execute("insert into equity_points (agent_id, timestamp, equity) values (?, ?, ?)", (agent_id, now, round(account_equity(conn, agent_id), 2)))
        return
    if action == "HOLD":
        record_order(conn, agent_id, decision, "SKIPPED", 0, 0, price, price, 0, "AI chose HOLD / wait for a cleaner setup.", now)
        conn.execute("insert into equity_points (agent_id, timestamp, equity) values (?, ?, ?)", (agent_id, now, round(account_equity(conn, agent_id), 2)))
        return
    slippage = random.randint(MIN_SLIPPAGE_BPS, MAX_SLIPPAGE_BPS)
    risk_scale = 1.35 if agent["risk"] == "high" else 0.55 if agent["risk"] == "low" else 0.9
    confidence_scale = max(0.15, min(1.0, int(decision["confidence"]) / 100))
    equity_before = account_equity(conn, agent_id)
    asset_class = asset_class_for(conn, symbol)
    pos = conn.execute("select quantity, avg_price from positions where agent_id = ? and symbol = ?", (agent_id, symbol)).fetchone()
    current_qty = pos["quantity"] if pos else 0
    current_avg = pos["avg_price"] if pos else 0

    if action == "BUY":
        execution_price = price * (1 + slippage / 10000)
        if current_qty < -0.000001:
            cover_notional = min(cash, abs(current_qty) * execution_price, equity_before * 0.45 * risk_scale * confidence_scale)
            if cover_notional < MIN_TRADE_NOTIONAL:
                record_order(conn, agent_id, decision, "REJECTED", 0, 0, price, execution_price, slippage, "Cash or short exposure is too small to cover.", now)
            else:
                cover_qty = cover_notional / execution_price
                new_qty = current_qty + cover_qty
                cash -= cover_notional
                if abs(new_qty) <= 0.000001:
                    conn.execute("delete from positions where agent_id = ? and symbol = ?", (agent_id, symbol))
                else:
                    conn.execute("update positions set quantity = ?, updated_at = ? where agent_id = ? and symbol = ?", (new_qty, now, agent_id, symbol))
                conn.execute("insert or replace into account_cash (agent_id, cash, updated_at) values (?, ?, ?)", (agent_id, round(cash, 6), now))
                record_order(conn, agent_id, decision, "FILLED", cover_qty, cover_notional, price, execution_price, slippage, "BUY covered/reduced an existing short position.", now)
        else:
            target_notional = cash * 0.55 * risk_scale * confidence_scale
            notional = min(cash, target_notional)
            if notional < MIN_TRADE_NOTIONAL:
                record_order(conn, agent_id, decision, "REJECTED", 0, 0, price, execution_price, slippage, "Insufficient cash for minimum long notional.", now)
            else:
                quantity = notional / execution_price
                old_qty = max(0, current_qty)
                new_qty = old_qty + quantity
                new_avg = ((old_qty * current_avg) + (quantity * execution_price)) / new_qty if new_qty else execution_price
                conn.execute("insert or replace into positions (agent_id, symbol, quantity, avg_price, updated_at) values (?, ?, ?, ?, ?)", (agent_id, symbol, new_qty, new_avg, now))
                cash -= notional
                conn.execute("insert or replace into account_cash (agent_id, cash, updated_at) values (?, ?, ?)", (agent_id, round(cash, 6), now))
                reason = "BUY added to existing long position." if current_qty > 0 else "BUY opened a long position."
                record_order(conn, agent_id, decision, "FILLED", quantity, notional, price, execution_price, slippage, reason, now)
    elif action == "SELL":
        execution_price = price * (1 - slippage / 10000)
        if current_qty > 0.000001:
            sell_qty = current_qty * min(1.0, 0.7 * risk_scale * confidence_scale)
            notional = sell_qty * execution_price
            if notional < MIN_TRADE_NOTIONAL:
                record_order(conn, agent_id, decision, "REJECTED", 0, 0, price, execution_price, slippage, "Reduce-long notional below minimum.", now)
            else:
                new_qty = current_qty - sell_qty
                cash += notional
                if new_qty <= 0.000001:
                    conn.execute("delete from positions where agent_id = ? and symbol = ?", (agent_id, symbol))
                else:
                    conn.execute("update positions set quantity = ?, updated_at = ? where agent_id = ? and symbol = ?", (new_qty, now, agent_id, symbol))
                conn.execute("insert or replace into account_cash (agent_id, cash, updated_at) values (?, ?, ?)", (agent_id, round(cash, 6), now))
                record_order(conn, agent_id, decision, "FILLED", sell_qty, notional, price, execution_price, slippage, "SELL reduced/exited an existing long position.", now)
        elif asset_class == "stock":
            record_order(conn, agent_id, decision, "REJECTED", 0, 0, price, execution_price, slippage, "Stocks cannot be sold short; no long position available to reduce.", now)
        else:
            target_notional = max(0, equity_before * 0.45 * risk_scale * confidence_scale)
            if target_notional < MIN_TRADE_NOTIONAL:
                record_order(conn, agent_id, decision, "REJECTED", 0, 0, price, execution_price, slippage, "Short notional below minimum.", now)
            else:
                short_qty = target_notional / execution_price
                old_abs = abs(min(0, current_qty))
                new_qty = current_qty - short_qty
                new_avg = ((old_abs * current_avg) + (short_qty * execution_price)) / (old_abs + short_qty) if old_abs else execution_price
                conn.execute("insert or replace into positions (agent_id, symbol, quantity, avg_price, updated_at) values (?, ?, ?, ?, ?)", (agent_id, symbol, new_qty, new_avg, now))
                cash += target_notional
                conn.execute("insert or replace into account_cash (agent_id, cash, updated_at) values (?, ?, ?)", (agent_id, round(cash, 6), now))
                reason = "SELL added to existing short position." if current_qty < 0 else "SELL opened a short position."
                record_order(conn, agent_id, decision, "FILLED", short_qty, target_notional, price, execution_price, slippage, reason, now)
    else:
        record_order(conn, agent_id, decision, "REJECTED", 0, 0, price, None, 0, "Unsupported action.", now)
    conn.execute("insert into equity_points (agent_id, timestamp, equity) values (?, ?, ?)", (agent_id, now, round(account_equity(conn, agent_id), 2)))

def main():
    command = sys.argv[1] if len(sys.argv) > 1 else "state"
    conn = connect()
    if command == "state":
        result = state(conn)
    elif command == "add-symbol":
        result = add_symbol(conn, sys.argv[2], sys.argv[3], sys.argv[4])
    elif command == "delete-symbol":
        result = delete_symbol(conn, sys.argv[2])
    elif command == "add-seat":
        result = add_seat(conn, json.loads(sys.argv[2]))
    elif command == "delete-seat":
        result = delete_seat(conn, sys.argv[2])
    elif command == "list-models":
        result = list_provider_models(sys.argv[2])
    elif command == "search-products":
        result = {"results": search_products(sys.argv[2])}
    elif command == "run":
        result = run_cycle(conn)
    elif command == "reset":
        result = reset_competition(conn)
    else:
        raise SystemExit(f"Unknown command: {command}")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()

