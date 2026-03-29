const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();

// ✅ MUST be defined BEFORE listen
const PORT = process.env.PORT || 8080;

const API_KEY = process.env.API_KEY || "";
const API_BASE = "https://api.elections.kalshi.com/trade-api/v2";

// ── State ─────────────────────────────────────────────
let marketsCache = [];
let opportunities = [];
let lastFetchAt = null;
let fetchError = null;
let tickCount = 0;

// ── Market Fetcher ────────────────────────────────────
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

// ── Strategy ──────────────────────────────────────────
function findOpportunities(markets) {
  const results = [];

  for (const m of markets) {
    const price = m.yes_ask ?? m.last_price ?? null;
    const vol = m.volume ?? 0;

    if (price === null) continue;
    if (m.status !== "open") continue;
    if (price < 40 || price > 60) continue;
    if (vol < 1000) continue;

    const distFrom50 = Math.abs(price - 50);

    let strength = "weak";
    if (distFrom50 <= 3) strength = "strong";
    else if (distFrom50 <= 7) strength = "medium";

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

  return results.sort((a, b) => a.distFrom50 - b.distFrom50);
}

// ── Background Loop ───────────────────────────────────
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

// Start loop
if (API_KEY) {
  tick();
  setInterval(tick, 10000);
  console.log("✅ Market fetcher started (10s)");
} else {
  console.warn("⚠️ No API_KEY — demo mode");
}

// ── Bot Engine ───────────────────────────────────────
const { BotEngine } = require("./bot/engine");
const bot = new BotEngine(10000);

function getStructuredMarkets() {
  return marketsCache.map((m) => ({
    ticker: m.ticker,
    title: m.title || m.ticker,
    lastPrice: m.yes_ask ?? m.last_price ?? 50,
    yesBid: m.yes_bid ?? null,
    yesAsk: m.yes_ask ?? null,
    spread:
      m.yes_ask && m.yes_bid ? m.yes_ask - m.yes_bid : 5,
    volume: m.volume ?? 0,
    status: m.status === "open" ? "active" : m.status,
  }));
}

// ── Middleware ───────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ── Health Check (IMPORTANT) ─────────────────────────
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// ── API Routes ──────────────────────────────────────
app.get("/status", (req, res) => {
  res.json({
    running: !!API_KEY,
    tickCount,
    totalMarkets: marketsCache.length,
    opportunitiesFound: opportunities.length,
    lastFetchAt,
    error: fetchError,
  });
});

app.get("/opportunities", (req, res) => {
  res.json({
    opportunities,
    count: opportunities.length,
    fetchedAt: lastFetchAt,
  });
});

app.get("/api/tennis-markets", (req, res) => {
  const mapped = marketsCache
    .filter((m) => m.status === "open")
    .map((m) => ({
      ticker: m.ticker,
      title: m.title,
      lastPrice: m.yes_ask ?? m.last_price ?? 50,
      previousPrice: m.last_price ?? 50,
      spread:
        m.yes_ask && m.yes_bid ? m.yes_ask - m.yes_bid : 5,
      volume: m.volume ?? 0,
      status: "active",
    }));

  res.json({
    markets: mapped,
    count: mapped.length,
    fetchedAt: Date.now(),
  });
});

// ── Bot Routes ──────────────────────────────────────
app.get("/api/bot/status", (req, res) => {
  res.json(bot.getState());
});

app.post("/api/bot/start", (req, res) => {
  bot.start(() => getStructuredMarkets());
  res.json({ success: true });
});

app.post("/api/bot/stop", (req, res) => {
  bot.stop();
  res.json({ success: true });
});

// ── Serve UI ────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ── START SERVER (ONLY ONCE) ────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});