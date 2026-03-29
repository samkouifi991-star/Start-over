const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || "";
const API_BASE = "https://api.elections.kalshi.com/trade-api/v2";

// ── State ──────────────────────────────────────────────────────────────
let marketsCache = [];
let opportunities = [];
let lastFetchAt = null;
let fetchError = null;
let tickCount = 0;

// ── Market Fetcher ─────────────────────────────────────────────────────
async function fetchAllMarkets() {
  const all = [];
  let cursor = null;
  let pages = 0;

  while (pages < 5) {
    const params = new URLSearchParams({ limit: "200", status: "open" });
    if (cursor) params.set("cursor", cursor);

    const res = await fetch(`${API_BASE}/markets?${params}`, {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Kalshi API ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    const markets = data.markets || [];
    all.push(...markets);

    cursor = data.cursor || null;
    if (!cursor || markets.length === 0) break;
    pages++;
  }

  return all;
}

// ── Dip Buy Reversion Strategy ─────────────────────────────────────────
function findOpportunities(markets) {
  const results = [];

  for (const m of markets) {
    const price = m.yes_ask ?? m.last_price ?? null;
    const vol = m.volume ?? 0;

    if (price === null) continue;
    if (m.status !== "open") continue;
    if (price < 40 || price > 60) continue;
    if (vol < 1000) continue;

    // Score: closer to 50 = stronger opportunity
    const distFrom50 = Math.abs(price - 50);
    let strength = "medium";
    if (distFrom50 <= 3) strength = "strong";
    else if (distFrom50 <= 7) strength = "medium";
    else strength = "weak";

    results.push({
      ticker: m.ticker,
      title: m.title || m.ticker,
      price,
      volume: vol,
      edge: "Dip Buy Zone",
      strength,
      distFrom50,
    });
  }

  // Sort: strongest first (closest to 50)
  results.sort((a, b) => a.distFrom50 - b.distFrom50);
  return results;
}

// ── Background Loop ────────────────────────────────────────────────────
async function tick() {
  tickCount++;
  try {
    marketsCache = await fetchAllMarkets();
    opportunities = findOpportunities(marketsCache);
    lastFetchAt = new Date().toISOString();
    fetchError = null;
    console.log(
      `[${lastFetchAt}] Tick #${tickCount}: ${marketsCache.length} markets, ${opportunities.length} opportunities`
    );
  } catch (err) {
    fetchError = err.message;
    console.error(`[TICK ERROR] ${err.message}`);
  }
}

// Start loop (every 10s)
if (API_KEY) {
  tick();
  setInterval(tick, 10000);
  console.log("[BOT] Started market fetcher (10s interval)");
} else {
  console.warn("[BOT] No API_KEY set — running in demo mode with empty data");
}

// ── Bot Engine ─────────────────────────────────────────────────────────
const { BotEngine } = require("./bot/engine");
const bot = new BotEngine(10000);

function getStructuredMarkets() {
  return marketsCache.map(m => ({
    ticker: m.ticker,
    title: m.title || m.ticker,
    player1: m.subtitle || "",
    player2: "",
    lastPrice: m.yes_ask ?? m.last_price ?? 50,
    yesBid: m.yes_bid ?? null,
    yesAsk: m.yes_ask ?? null,
    spread: (m.yes_ask && m.yes_bid) ? (m.yes_ask - m.yes_bid) : 5,
    volume: m.volume ?? 0,
    status: m.status === "open" ? "active" : m.status,
  }));
}

// ── API Routes ─────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// CORS for frontend
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (_req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/status", (_req, res) => {
  res.json({
    running: !!API_KEY,
    tickCount,
    totalMarkets: marketsCache.length,
    opportunitiesFound: opportunities.length,
    lastFetchAt,
    error: fetchError,
    uptime: process.uptime(),
  });
});

app.get("/opportunities", (_req, res) => {
  res.json({ opportunities, count: opportunities.length, fetchedAt: lastFetchAt });
});

// Markets endpoint for the Lovable frontend scanner
// Returns ALL open markets (no sport filter — Kalshi doesn't tag sports in tickers)
app.get("/api/tennis-markets", (_req, res) => {
  const limit = parseInt(_req.query.limit) || 200;
  const mapped = marketsCache
    .filter(m => m.status === "open" && (m.yes_ask ?? m.last_price) !== null)
    .map(m => ({
      ticker: m.ticker,
      title: m.title || m.ticker,
      player1: m.subtitle || "",
      player2: "",
      lastPrice: m.yes_ask ?? m.last_price ?? 50,
      previousPrice: m.last_price ?? 50,
      yesBid: m.yes_bid ?? null,
      yesAsk: m.yes_ask ?? null,
      spread: (m.yes_ask && m.yes_bid) ? (m.yes_ask - m.yes_bid) : 5,
      volume: m.volume ?? 0,
      status: "active",
    }))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, limit);

  res.json({
    markets: mapped,
    count: mapped.length,
    fetchedAt: lastFetchAt || Date.now(),
  });
});

// ── Bot API ────────────────────────────────────────────────────────────
app.get("/api/bot/status", (_req, res) => {
  res.json(bot.getState());
});

app.post("/api/bot/start", (_req, res) => {
  bot.start(() => getStructuredMarkets());
  res.json({ success: true, state: bot.getState() });
});

app.post("/api/bot/stop", (_req, res) => {
  bot.stop();
  res.json({ success: true, state: bot.getState() });
});

app.post("/api/bot/mode", (req, res) => {
  bot.setMode(req.body.mode);
  res.json({ success: true, mode: req.body.mode });
});

app.post("/api/bot/paper", (req, res) => {
  bot.setPaperMode(req.body.enabled);
  res.json({ success: true });
});

app.post("/api/bot/risk", (req, res) => {
  bot.setRiskPct(req.body.pct);
  res.json({ success: true });
});

app.post("/api/bot/reset-pause", (_req, res) => {
  bot.resetGlobalPause();
  res.json({ success: true });
});

app.post("/api/bot/confirm", async (req, res) => {
  const result = await bot.confirmSignal(req.body.ticker);
  res.json(result);
});

app.post("/api/bot/dismiss", (req, res) => {
  const result = bot.dismissSignal(req.body.ticker);
  res.json(result);
});

// ── Serve Dashboard ────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── Start Server ───────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Kalshi Edge Bot running on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`API Key configured: ${API_KEY ? "Yes" : "No"}`);
  console.log(`Bot paper mode: ${bot.positionManager.paperMode}`);
});
