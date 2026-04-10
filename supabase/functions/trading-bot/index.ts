import { createClient } from "jsr:@supabase/supabase-js@2";

const ALPACA_BASE_URL = "https://paper-api.alpaca.markets/v2";
const ALPACA_DATA_URL = "https://data.alpaca.markets/v2";
const GROK_BASE_URL = "https://api.x.ai/v1";
const FINNHUB_BASE_URL = "https://finnhub.io/api/v1";

const STARTING_CAPITAL = 100_000;
const MAX_POSITION_PCT = 0.18;    // 18% max per position — Config C: tighter sizing, more positions
const MAX_DRAWDOWN_PCT = 0.15;    // halt trading if equity drops 15%
const DEFAULT_STOP_LOSS_PCT = 0.02; // 2% stop — Config C: cut losers fast
const RISK_PER_TRADE_PCT = 0.025; // risk 2.5% of equity per trade
const ATR_STOP_MULTIPLIER = 1.5;  // tighter stop = entry - (1.5 × ATR) for quicker cuts
const MIN_CASH_PCT = 0.10;        // always keep 10% cash buffer
const DAILY_PROFIT_TARGET = 500;  // $500/day target

// ── TRADING MODE (set dynamically based on market phase) ─────────────────────
type TradingMode = "SCALP" | "MOMENTUM" | "HOLD_ONLY";

function getCurrentTradingMode(): { mode: TradingMode; label: string } {
  const now = new Date();
  const etStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const et = new Date(etStr);
  const etHour = et.getHours();
  const etMin = et.getMinutes();
  const etTime = etHour + etMin / 60;

  // SCALP windows: Open Rush + Power Hour (highest volatility = best for quick trades)
  if (etTime >= 9.5 && etTime < 10.25) {
    return { mode: "SCALP", label: "🔥 SCALP MODE — Open Rush (9:30-10:15 ET)" };
  }
  if (etTime >= 15.25 && etTime < 16) {
    return { mode: "SCALP", label: "🔥 SCALP MODE — Power Hour (3:15-4:00 ET)" };
  }
  // Lunch lull removed — trade all day to maximize opportunities
  // MOMENTUM: everything else
  return { mode: "MOMENTUM", label: "📈 MOMENTUM MODE — Ride trends" };
}

// Clients
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const alpacaHeaders = {
  "APCA-API-KEY-ID": Deno.env.get("ALPACA_API_KEY")!,
  "APCA-API-SECRET-KEY": Deno.env.get("ALPACA_SECRET_KEY")!,
  "Content-Type": "application/json",
};

// ── Fetch with Timeout ──────────────────────────────────────────────────────
// Every fetch gets an 8-second timeout to prevent hanging connections
function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// ── Retry Helper ─────────────────────────────────────────────────────────────
// Wraps any async function with exponential backoff retry logic.
// Reduced delays: 500ms, 1000ms (was 1000ms, 2000ms, 3000ms)
async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 500): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (err) {
      if (i === retries - 1) throw err;
      console.warn(`Retry ${i + 1}/${retries} after error:`, String(err));
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw new Error("unreachable");
}

// ── Helpers Alpaca — Trading ─────────────────────────────────────────────────
async function getAccount() {
  const res = await withRetry(() => fetchWithTimeout(`${ALPACA_BASE_URL}/account`, { headers: alpacaHeaders }));
  const data = await res.json();
  if (data?.code || data?.message) throw new Error(`Alpaca account error: ${JSON.stringify(data)}`);
  return data;
}

async function getPositions() {
  const res = await withRetry(() => fetchWithTimeout(`${ALPACA_BASE_URL}/positions`, { headers: alpacaHeaders }));
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`Alpaca positions error: ${JSON.stringify(data)}`);
  return data;
}

async function isClock() {
  try {
    const res = await fetchWithTimeout(`${ALPACA_BASE_URL}/clock`, { headers: alpacaHeaders });
    const clock = await res.json();
    return clock.is_open as boolean;
  } catch (err) {
    console.error("isClock() failed — assuming market closed:", err);
    return false;
  }
}

// Cancel all open orders for a symbol (needed before selling bracket-ordered positions)
async function cancelOrdersForSymbol(symbol: string) {
  try {
    const res = await fetchWithTimeout(`${ALPACA_BASE_URL}/orders?status=open&symbols=${symbol}`, {
      headers: alpacaHeaders,
    });
    const openOrders = await res.json();
    if (!Array.isArray(openOrders) || openOrders.length === 0) return;
    console.log(`Cancelling ${openOrders.length} open order(s) for ${symbol} before selling...`);
    for (const order of openOrders) {
      await fetchWithTimeout(`${ALPACA_BASE_URL}/orders/${order.id}`, {
        method: "DELETE",
        headers: alpacaHeaders,
      });
      console.log(`  Cancelled order ${order.id} (${order.type} ${order.side} ${order.qty})`);
    }
    // Brief pause for Alpaca to release the held shares
    await new Promise(r => setTimeout(r, 1000));
  } catch (err) {
    console.error(`Failed to cancel orders for ${symbol}:`, (err as Error).message);
  }
}

// Standard market order (used for SELL)
// HARD BLOCK: Never trade these symbols
const HARD_BLOCKED_SYMBOLS = new Set(["UVIX", "UVXY", "SVXY", "VXX", "VIXY", "SVOL"]);

async function placeOrder(symbol: string, qty: number, side: "buy" | "sell") {
  // Safety: prevent accidental short positions by verifying we actually hold shares before selling
  if (side === "sell") {
    try {
      const posCheck = await fetchWithTimeout(`${ALPACA_BASE_URL}/positions/${symbol}`, { headers: alpacaHeaders });
      if (posCheck.status === 404) {
        console.error(`\u{26D4} SELL BLOCKED: No position found for ${symbol} — would create accidental short`);
        return { code: 0, message: `${symbol} sell blocked: no position (prevent accidental short)` };
      }
      const posData = await posCheck.json();
      const heldQty = parseInt(String(posData.qty ?? 0));
      if (heldQty <= 0) {
        console.error(`\u{26D4} SELL BLOCKED: ${symbol} position qty is ${heldQty} — would create accidental short`);
        return { code: 0, message: `${symbol} sell blocked: qty ${heldQty} (prevent accidental short)` };
      }
      if (qty > heldQty) {
        console.warn(`\u{26A0} SELL QTY ADJUSTED: ${symbol} trying to sell ${qty} but only hold ${heldQty} — adjusting down`);
        qty = heldQty;
      }
    } catch (e) {
      console.warn(`Position check failed for ${symbol}, proceeding with sell:`, (e as Error).message);
    }
  }
  if (side === "buy" && HARD_BLOCKED_SYMBOLS.has(symbol)) {
    console.error("❌ HARD BLOCK: " + symbol + " is permanently excluded");
    return { code: 0, message: symbol + " is hard-blocked" };
  }
  const res = await withRetry(() => fetchWithTimeout(`${ALPACA_BASE_URL}/orders`, {
    method: "POST",
    headers: alpacaHeaders,
    body: JSON.stringify({
      symbol,
      qty: String(qty),
      side,
      type: "market",
      time_in_force: "day",
    }),
  }));
  return res.json();
}

// Buy with automatic stop-loss via Alpaca OTO (One-Triggers-Other) bracket order.
// Uses a fixed stop_price (required by Alpaca OTO), then optionally replaces with trailing stop.
async function placeOrderWithStopLoss(
  symbol: string,
  qty: number,
  entryPrice: number,
  stopLossPct = DEFAULT_STOP_LOSS_PCT
) {
  if (HARD_BLOCKED_SYMBOLS.has(symbol)) {
    console.error("❌ HARD BLOCK: " + symbol + " is permanently excluded");
    return { code: 0, message: symbol + " is hard-blocked" };
  }
  // Validate: entry price must be positive and stop % reasonable
  if (!entryPrice || entryPrice <= 0) {
    console.error(`BUY ${symbol} aborted — invalid entry price: $${entryPrice}`);
    return { code: 0, message: `Invalid entry price $${entryPrice}` };
  }

  // Clamp stop between 2% and 15%
  const clampedPct = Math.max(0.02, Math.min(0.15, stopLossPct));
  const stopPrice = +(entryPrice * (1 - clampedPct)).toFixed(2);

  console.log(`Placing BUY ${qty} ${symbol} @ ~$${entryPrice} with stop-loss at $${stopPrice} (${(clampedPct * 100).toFixed(1)}%)`);

  // Method 1: Try OTO with fixed stop_price (Alpaca requires stop_price for OTO)
  const res = await withRetry(() => fetchWithTimeout(`${ALPACA_BASE_URL}/orders`, {
    method: "POST",
    headers: alpacaHeaders,
    body: JSON.stringify({
      symbol,
      qty: String(qty),
      side: "buy",
      type: "market",
      time_in_force: "gtc",
      order_class: "oto",
      stop_loss: {
        stop_price: String(stopPrice),
      },
    }),
  }));

  const data = await res.json();

  // If OTO fails for any reason, fall back to a simple market buy (no stop attached)
  if (data?.code || data?.message?.includes?.("error")) {
    console.warn(`OTO order failed for ${symbol}: ${JSON.stringify(data).slice(0, 200)} — falling back to simple market buy`);
    const fallbackRes = await withRetry(() => fetchWithTimeout(`${ALPACA_BASE_URL}/orders`, {
      method: "POST",
      headers: alpacaHeaders,
      body: JSON.stringify({
        symbol,
        qty: String(qty),
        side: "buy",
        type: "market",
        time_in_force: "day",
      }),
    }));
    const fallbackData = await fallbackRes.json();
    if (fallbackData?.id) {
      console.log(`✅ Fallback market buy succeeded for ${symbol} (no stop-loss attached — profit-taking will manage exits)`);
    }
    return fallbackData;
  }

  return data;
}

// ── Helpers Alpaca — Market Data ─────────────────────────────────────────────
// Updated Bar type to include OHLCV (needed for ATR, VWAP, Bollinger Bands)
type Bar = { o: number; h: number; l: number; c: number; v: number };

// ── Pattern Detection Types ──────────────────────────────────────────────────
type PatternSignal = {
  name: string;             // e.g. "double_bottom", "bull_flag", "head_and_shoulders"
  direction: "bullish" | "bearish" | "neutral";
  confidence: number;       // 0-1
  description: string;      // human-readable summary for Grok
};

type VolumeProfile = {
  avg_volume_20: number | null;       // 20-bar average volume
  volume_ratio: number | null;        // current volume / avg volume (>1.5 = unusual)
  accumulation_dist: number | null;   // Accumulation/Distribution line value
  obv_trend: "rising" | "falling" | "flat" | null;  // On-Balance Volume trend
  is_climax_volume: boolean;          // volume > 3× average (potential reversal)
  institutional_signal: string | null; // human-readable signal for Grok
};

type MultiTimeframeSignal = {
  tf_5min: "bullish" | "bearish" | "neutral" | null;
  tf_15min: "bullish" | "bearish" | "neutral" | null;
  tf_1hr: "bullish" | "bearish" | "neutral" | null;
  tf_daily: "bullish" | "bearish" | "neutral" | null;
  confluence: number;       // -4 to +4 (sum of aligned signals)
  summary: string;          // human-readable summary
};

type SectorData = {
  sector: string | null;
  sector_performance: number | null;  // sector ETF change %
  relative_strength: number | null;   // stock change / sector change
};

type TechData = {
  price: number;
  change_pct: number;
  volume: number;
  sma20: number | null;
  sma50: number | null;
  rsi14: number | null;
  macd: number | null;
  macd_signal: number | null;
  macd_hist: number | null;
  atr14: number | null;
  bb_upper: number | null;
  bb_lower: number | null;
  bb_pct: number | null;
  vwap: number | null;
  // NEW: Advanced trading skills
  patterns: PatternSignal[];
  volume_profile: VolumeProfile;
  mtf: MultiTimeframeSignal | null;   // multi-timeframe analysis
  sector: SectorData;
};

function sma(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function ema(prices: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    result.push(prices[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

// FIXED: Wilder's smoothed RSI (replaces the previous incorrect SMA-based RSI).
// Standard RSI uses Wilder's smoothing (RMA), not a simple average.
function wilderRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  const changes = closes.slice(1).map((v, i) => v - closes[i]);

  // Seed with simple average for first period
  let avgGain = changes.slice(0, period).reduce((s, c) => s + Math.max(c, 0), 0) / period;
  let avgLoss = changes.slice(0, period).reduce((s, c) => s + Math.max(-c, 0), 0) / period;

  // Wilder smoothing for all subsequent periods
  for (const change of changes.slice(period)) {
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  return avgLoss === 0 ? 100 : +(100 - 100 / (1 + avgGain / avgLoss)).toFixed(1);
}

// NEW: Wilder's ATR — measures volatility; used for adaptive position sizing and stop-loss sizing.
function wilderATR(bars: Bar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const trueRanges = bars.slice(1).map((bar, i) => {
    const prevClose = bars[i].c;
    return Math.max(
      bar.h - bar.l,
      Math.abs(bar.h - prevClose),
      Math.abs(bar.l - prevClose)
    );
  });

  // Seed with SMA for first period
  let atrVal = trueRanges.slice(0, period).reduce((s, v) => s + v, 0) / period;
  // Wilder smoothing
  for (const tr of trueRanges.slice(period)) {
    atrVal = (atrVal * (period - 1) + tr) / period;
  }
  return +atrVal.toFixed(4);
}

// NEW: Bollinger Bands (20-period SMA ± 2 standard deviations).
// bb_pct = where current price sits between the bands (0 = lower band, 1 = upper band).
function bollingerBands(closes: number[], period = 20): { upper: number; lower: number; pct: number } | null {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = sma(slice);
  const stdDev = Math.sqrt(slice.reduce((s, v) => s + (v - mid) ** 2, 0) / period);
  const upper = +(mid + 2 * stdDev).toFixed(2);
  const lower = +(mid - 2 * stdDev).toFixed(2);
  const last = closes[closes.length - 1];
  const pct = upper === lower ? 0.5 : +((last - lower) / (upper - lower)).toFixed(4);
  return { upper, lower, pct };
}

// NEW: VWAP — institutional intraday reference price.
// Price above VWAP = bullish bias; below VWAP = bearish bias.
function computeVWAP(bars: Bar[]): number | null {
  if (!bars.length) return null;
  const totalVolume = bars.reduce((s, b) => s + b.v, 0);
  if (totalVolume === 0) return null;
  const tpv = bars.reduce((s, b) => s + ((b.h + b.l + b.c) / 3) * b.v, 0);
  return +(tpv / totalVolume).toFixed(2);
}

// ══════════════════════════════════════════════════════════════════════════════
// SKILL 1: CHART PATTERN RECOGNITION
// Detects classic chart patterns from OHLC bars using pivot point analysis.
// ══════════════════════════════════════════════════════════════════════════════

function findPivots(bars: Bar[], lookback = 5): { highs: number[]; lows: number[]; highIdx: number[]; lowIdx: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  const highIdx: number[] = [];
  const lowIdx: number[] = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (bars[i].h <= bars[i - j].h || bars[i].h <= bars[i + j].h) isHigh = false;
      if (bars[i].l >= bars[i - j].l || bars[i].l >= bars[i + j].l) isLow = false;
    }
    if (isHigh) { highs.push(bars[i].h); highIdx.push(i); }
    if (isLow) { lows.push(bars[i].l); lowIdx.push(i); }
  }
  return { highs, lows, highIdx, lowIdx };
}

function detectPatterns(bars: Bar[]): PatternSignal[] {
  if (bars.length < 30) return [];
  const patterns: PatternSignal[] = [];
  const { highs, lows, highIdx, lowIdx } = findPivots(bars, 5);
  const last = bars[bars.length - 1].c;
  const tolerance = 0.02; // 2% tolerance for "equal" levels

  // ── Double Bottom ──────────────────────────────────────────────────────────
  if (lows.length >= 2) {
    const [l1, l2] = [lows[lows.length - 2], lows[lows.length - 1]];
    if (Math.abs(l1 - l2) / l1 < tolerance && last > l2) {
      // Find the neckline (highest point between the two lows)
      const neckIdx1 = lowIdx[lowIdx.length - 2];
      const neckIdx2 = lowIdx[lowIdx.length - 1];
      const between = bars.slice(neckIdx1, neckIdx2 + 1);
      const neckline = Math.max(...between.map(b => b.h));
      const breakout = last > neckline;
      patterns.push({
        name: "double_bottom",
        direction: "bullish",
        confidence: breakout ? 0.85 : 0.6,
        description: `Double bottom at $${l1.toFixed(2)}/${l2.toFixed(2)}, neckline $${neckline.toFixed(2)}${breakout ? " — BREAKOUT CONFIRMED" : " — watching for neckline break"}`,
      });
    }
  }

  // ── Double Top ─────────────────────────────────────────────────────────────
  if (highs.length >= 2) {
    const [h1, h2] = [highs[highs.length - 2], highs[highs.length - 1]];
    if (Math.abs(h1 - h2) / h1 < tolerance && last < h2) {
      const neckIdx1 = highIdx[highIdx.length - 2];
      const neckIdx2 = highIdx[highIdx.length - 1];
      const between = bars.slice(neckIdx1, neckIdx2 + 1);
      const neckline = Math.min(...between.map(b => b.l));
      const breakdown = last < neckline;
      patterns.push({
        name: "double_top",
        direction: "bearish",
        confidence: breakdown ? 0.85 : 0.6,
        description: `Double top at $${h1.toFixed(2)}/${h2.toFixed(2)}, neckline $${neckline.toFixed(2)}${breakdown ? " — BREAKDOWN CONFIRMED" : " — watching for neckline break"}`,
      });
    }
  }

  // ── Head and Shoulders ─────────────────────────────────────────────────────
  if (highs.length >= 3) {
    const [h1, h2, h3] = highs.slice(-3);
    // Head (h2) should be higher than both shoulders (h1, h3)
    if (h2 > h1 && h2 > h3 && Math.abs(h1 - h3) / h1 < tolerance * 2) {
      const shoulderAvg = (h1 + h3) / 2;
      const headRatio = (h2 - shoulderAvg) / shoulderAvg;
      if (headRatio > 0.02 && headRatio < 0.15) {
        patterns.push({
          name: "head_and_shoulders",
          direction: "bearish",
          confidence: last < shoulderAvg ? 0.8 : 0.55,
          description: `H&S: left shoulder $${h1.toFixed(2)}, head $${h2.toFixed(2)}, right shoulder $${h3.toFixed(2)}${last < shoulderAvg ? " — neckline broken" : ""}`,
        });
      }
    }
  }

  // ── Inverse Head and Shoulders ─────────────────────────────────────────────
  if (lows.length >= 3) {
    const [l1, l2, l3] = lows.slice(-3);
    if (l2 < l1 && l2 < l3 && Math.abs(l1 - l3) / l1 < tolerance * 2) {
      const shoulderAvg = (l1 + l3) / 2;
      const headRatio = (shoulderAvg - l2) / shoulderAvg;
      if (headRatio > 0.02 && headRatio < 0.15) {
        patterns.push({
          name: "inverse_head_and_shoulders",
          direction: "bullish",
          confidence: last > shoulderAvg ? 0.8 : 0.55,
          description: `Inv H&S: left $${l1.toFixed(2)}, head $${l2.toFixed(2)}, right $${l3.toFixed(2)}${last > shoulderAvg ? " — neckline broken" : ""}`,
        });
      }
    }
  }

  // ── Bull Flag / Bear Flag ──────────────────────────────────────────────────
  // Look for a strong move followed by a tight consolidation
  if (bars.length >= 40) {
    const flagPole = bars.slice(-40, -15); // the impulse move
    const flag = bars.slice(-15);          // the consolidation
    const poleStart = flagPole[0].c;
    const poleEnd = flagPole[flagPole.length - 1].c;
    const poleChange = (poleEnd - poleStart) / poleStart;
    const flagHighs = flag.map(b => b.h);
    const flagLows = flag.map(b => b.l);
    const flagRange = (Math.max(...flagHighs) - Math.min(...flagLows)) / poleEnd;

    // Bull flag: strong up move + tight sideways/down consolidation
    if (poleChange > 0.05 && flagRange < 0.04) {
      patterns.push({
        name: "bull_flag",
        direction: "bullish",
        confidence: 0.7,
        description: `Bull flag: ${(poleChange * 100).toFixed(1)}% pole, ${(flagRange * 100).toFixed(1)}% flag range — potential upside continuation`,
      });
    }
    // Bear flag: strong down move + tight sideways/up consolidation
    if (poleChange < -0.05 && flagRange < 0.04) {
      patterns.push({
        name: "bear_flag",
        direction: "bearish",
        confidence: 0.7,
        description: `Bear flag: ${(poleChange * 100).toFixed(1)}% pole, ${(flagRange * 100).toFixed(1)}% flag range — potential downside continuation`,
      });
    }
  }

  // ── Ascending / Descending Wedge ───────────────────────────────────────────
  if (highs.length >= 3 && lows.length >= 3) {
    const recentHighs = highs.slice(-3);
    const recentLows = lows.slice(-3);
    const highSlope = (recentHighs[2] - recentHighs[0]) / recentHighs[0];
    const lowSlope = (recentLows[2] - recentLows[0]) / recentLows[0];

    // Rising wedge (bearish): both trendlines rising but converging
    if (highSlope > 0.01 && lowSlope > 0.01 && lowSlope > highSlope) {
      patterns.push({
        name: "rising_wedge",
        direction: "bearish",
        confidence: 0.65,
        description: `Rising wedge: highs +${(highSlope * 100).toFixed(1)}%, lows +${(lowSlope * 100).toFixed(1)}% — converging, bearish reversal likely`,
      });
    }
    // Falling wedge (bullish): both trendlines falling but converging
    if (highSlope < -0.01 && lowSlope < -0.01 && highSlope < lowSlope) {
      patterns.push({
        name: "falling_wedge",
        direction: "bullish",
        confidence: 0.65,
        description: `Falling wedge: highs ${(highSlope * 100).toFixed(1)}%, lows ${(lowSlope * 100).toFixed(1)}% — converging, bullish reversal likely`,
      });
    }
  }

  // ── Cup and Handle ─────────────────────────────────────────────────────────
  if (bars.length >= 60 && highs.length >= 2 && lows.length >= 1) {
    const leftRim = highs[0]; // first high
    const cupBottom = Math.min(...lows);
    const rightRim = highs[highs.length - 1]; // most recent high
    const cupDepth = (leftRim - cupBottom) / leftRim;
    const rimDiff = Math.abs(leftRim - rightRim) / leftRim;

    // Cup: ~10-30% depth, rims roughly equal
    if (cupDepth > 0.05 && cupDepth < 0.35 && rimDiff < 0.04) {
      // Handle: slight pullback from right rim
      const recentBars = bars.slice(-10);
      const handleLow = Math.min(...recentBars.map(b => b.l));
      const handleDepth = (rightRim - handleLow) / rightRim;
      if (handleDepth > 0.01 && handleDepth < cupDepth * 0.5) {
        patterns.push({
          name: "cup_and_handle",
          direction: "bullish",
          confidence: last > rightRim ? 0.8 : 0.6,
          description: `Cup & Handle: rim $${leftRim.toFixed(2)}/$${rightRim.toFixed(2)}, cup depth ${(cupDepth * 100).toFixed(0)}%, handle ${(handleDepth * 100).toFixed(1)}%${last > rightRim ? " — BREAKOUT" : ""}`,
        });
      }
    }
  }

  return patterns;
}

// ══════════════════════════════════════════════════════════════════════════════
// SKILL 2: VOLUME PROFILE & ORDER FLOW ANALYSIS
// Detects institutional activity, accumulation/distribution, and volume anomalies.
// ══════════════════════════════════════════════════════════════════════════════

function analyzeVolumeProfile(bars: Bar[]): VolumeProfile {
  const empty: VolumeProfile = {
    avg_volume_20: null, volume_ratio: null, accumulation_dist: null,
    obv_trend: null, is_climax_volume: false, institutional_signal: null,
  };
  if (bars.length < 20) return empty;

  const recent20 = bars.slice(-20);
  const avgVol = recent20.reduce((s, b) => s + b.v, 0) / 20;
  const currentVol = bars[bars.length - 1].v;
  const volRatio = avgVol > 0 ? +(currentVol / avgVol).toFixed(2) : null;
  const isClimax = currentVol > avgVol * 3;

  // Accumulation/Distribution Line
  // AD = sum of ((close - low) - (high - close)) / (high - low) * volume
  let adLine = 0;
  for (const bar of bars) {
    const range = bar.h - bar.l;
    if (range > 0) {
      const clv = ((bar.c - bar.l) - (bar.h - bar.c)) / range; // Close Location Value
      adLine += clv * bar.v;
    }
  }

  // On-Balance Volume trend (last 20 bars)
  const obvValues: number[] = [0];
  for (let i = 1; i < recent20.length; i++) {
    const prev = obvValues[i - 1];
    if (recent20[i].c > recent20[i - 1].c) obvValues.push(prev + recent20[i].v);
    else if (recent20[i].c < recent20[i - 1].c) obvValues.push(prev - recent20[i].v);
    else obvValues.push(prev);
  }
  const obvStart = obvValues[0];
  const obvEnd = obvValues[obvValues.length - 1];
  const obvMid = obvValues[Math.floor(obvValues.length / 2)];
  let obvTrend: "rising" | "falling" | "flat" = "flat";
  if (obvEnd > obvStart * 1.05 && obvEnd > obvMid) obvTrend = "rising";
  else if (obvEnd < obvStart * 0.95 && obvEnd < obvMid) obvTrend = "falling";

  // Detect institutional signals
  const signals: string[] = [];
  if (volRatio && volRatio > 2.0) signals.push(`Unusual volume (${volRatio}× avg)`);
  if (isClimax) signals.push("CLIMAX volume — potential reversal");

  // Price up + high volume + rising OBV = institutional buying
  const priceUp = bars[bars.length - 1].c > bars[bars.length - 2]?.c;
  const priceDown = bars[bars.length - 1].c < bars[bars.length - 2]?.c;
  if (priceUp && volRatio && volRatio > 1.5 && obvTrend === "rising") {
    signals.push("Institutional ACCUMULATION detected (price up + high vol + rising OBV)");
  }
  // Price down + high volume + falling OBV = institutional selling
  if (priceDown && volRatio && volRatio > 1.5 && obvTrend === "falling") {
    signals.push("Institutional DISTRIBUTION detected (price down + high vol + falling OBV)");
  }
  // Price down but OBV rising = stealth accumulation (smart money buying dips)
  if (priceDown && obvTrend === "rising") {
    signals.push("Stealth accumulation — price falling but OBV rising (smart money buying)");
  }
  // Price up but OBV falling = distribution under cover
  if (priceUp && obvTrend === "falling") {
    signals.push("Hidden distribution — price rising but OBV falling (smart money selling)");
  }

  return {
    avg_volume_20: Math.round(avgVol),
    volume_ratio: volRatio,
    accumulation_dist: +adLine.toFixed(0),
    obv_trend: obvTrend,
    is_climax_volume: isClimax,
    institutional_signal: signals.length > 0 ? signals.join("; ") : null,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// SKILL 3: MULTI-TIMEFRAME ANALYSIS
// Analyzes trend alignment across 5min, 15min, 1hr, and daily timeframes.
// Confluence = number of timeframes in agreement (-4 to +4).
// ══════════════════════════════════════════════════════════════════════════════

// Determine bias for a set of bars: EMA20 vs EMA50 + RSI
function timeframeBias(bars: Bar[]): "bullish" | "bearish" | "neutral" {
  if (bars.length < 50) return "neutral";
  const closes = bars.map(b => b.c);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const last20 = ema20[ema20.length - 1];
  const last50 = ema50[ema50.length - 1];
  const rsi = wilderRSI(closes);

  // Strong bullish: EMA20 > EMA50 and RSI > 50
  if (last20 > last50 * 1.001 && rsi !== null && rsi > 50) return "bullish";
  // Strong bearish: EMA20 < EMA50 and RSI < 50
  if (last20 < last50 * 0.999 && rsi !== null && rsi < 50) return "bearish";
  return "neutral";
}

// Fetch bars at different timeframes for multi-TF analysis
async function fetchBarsMultiTF(symbol: string): Promise<{
  tf5min: Bar[]; tf15min: Bar[]; tf1hr: Bar[]; tfDaily: Bar[]
}> {
  const start14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const start90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const fetchTF = async (timeframe: string, limit: number, start: string): Promise<Bar[]> => {
    try {
      const res = await withRetry(() => fetchWithTimeout(
        `${ALPACA_DATA_URL}/stocks/${symbol}/bars?timeframe=${timeframe}&limit=${limit}&start=${start}&feed=iex`,
        { headers: alpacaHeaders }
      ));
      const data = await res.json();
      return data?.bars ?? [];
    } catch { return []; }
  };

  const [tf5min, tf15min, tf1hr, tfDaily] = await Promise.all([
    fetchTF("5Min", 100, start14d),
    fetchTF("15Min", 100, start14d),
    fetchTF("1Hour", 100, start90d),
    fetchTF("1Day", 100, start90d),
  ]);

  return { tf5min, tf15min, tf1hr, tfDaily };
}

function analyzeMultiTimeframe(
  tf5min: Bar[], tf15min: Bar[], tf1hr: Bar[], tfDaily: Bar[]
): MultiTimeframeSignal {
  const bias5 = tf5min.length >= 50 ? timeframeBias(tf5min) : null;
  const bias15 = tf15min.length >= 50 ? timeframeBias(tf15min) : null;
  const bias1h = tf1hr.length >= 50 ? timeframeBias(tf1hr) : null;
  const biasD = tfDaily.length >= 50 ? timeframeBias(tfDaily) : null;

  // Confluence: +1 for bullish, -1 for bearish, 0 for neutral/null
  const toNum = (b: string | null) => b === "bullish" ? 1 : b === "bearish" ? -1 : 0;
  const confluence = toNum(bias5) + toNum(bias15) + toNum(bias1h) + toNum(biasD);

  const labels = [
    bias5 ? `5m:${bias5}` : null,
    bias15 ? `15m:${bias15}` : null,
    bias1h ? `1h:${bias1h}` : null,
    biasD ? `D:${biasD}` : null,
  ].filter(Boolean).join(", ");

  let summary = "";
  if (confluence >= 3) summary = `STRONG BULLISH confluence (${confluence}/4): ${labels}`;
  else if (confluence >= 2) summary = `Moderate bullish confluence (${confluence}/4): ${labels}`;
  else if (confluence <= -3) summary = `STRONG BEARISH confluence (${confluence}/4): ${labels}`;
  else if (confluence <= -2) summary = `Moderate bearish confluence (${confluence}/4): ${labels}`;
  else summary = `Mixed/neutral signals (${confluence}/4): ${labels}`;

  return {
    tf_5min: bias5, tf_15min: bias15, tf_1hr: bias1h, tf_daily: biasD,
    confluence, summary,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// SKILL 4: SECTOR ROTATION & CORRELATION
// Maps symbols to sectors, fetches sector ETF performance, and computes
// relative strength so the bot avoids overweighting one sector.
// ══════════════════════════════════════════════════════════════════════════════

// Major sector ETFs for tracking
const SECTOR_ETFS: Record<string, string> = {
  Technology: "XLK", Energy: "XLE", Healthcare: "XLV", Financials: "XLF",
  "Consumer Discretionary": "XLY", "Consumer Staples": "XLP", Industrials: "XLI",
  Materials: "XLB", "Real Estate": "XLRE", Utilities: "XLU",
  "Communication Services": "XLC", "Broad Market": "SPY",
};

// Heuristic sector mapping (Grok can refine this via live search)
function guessSector(symbol: string): string {
  const techStocks = ["AAPL", "MSFT", "GOOGL", "GOOG", "META", "AMZN", "NVDA", "AMD", "INTC", "CRM", "ORCL", "ADBE", "TSLA", "AVGO", "QCOM", "MU", "ANET", "NOW", "SHOP", "SQ", "PLTR", "SNOW", "UBER", "ABNB", "COIN", "AMAT", "LRCX", "KLAC", "MRVL", "ARM", "SMCI", "DELL", "HPE", "NET", "CRWD", "PANW", "ZS", "DDOG", "MDB", "IONQ", "SOXL", "SOXS", "TQQQ", "SQQQ", "QLD", "SMH", "SOXX", "ARKK", "TECL"];
  const healthStocks = ["JNJ", "UNH", "PFE", "ABBV", "MRK", "LLY", "TMO", "ABT", "BMY", "AMGN", "GILD", "MRNA", "BNTX", "ISRG", "DXCM", "VEEV", "ZTS", "HCA", "CI", "ELV", "LABU", "XBI"];
  const finStocks = ["JPM", "BAC", "WFC", "GS", "MS", "C", "BLK", "SCHW", "AXP", "V", "MA", "PYPL", "MSTR", "HOOD", "SOFI", "FAS", "FAZ", "XLF"];
  const energyStocks = ["XOM", "CVX", "COP", "EOG", "SLB", "OXY", "MPC", "PSX", "VLO", "HAL", "DVN", "FANG", "MRO", "USO", "UCO", "GUSH", "DRIP", "XLE", "XOP", "OIH"];
  const consumerStocks = ["WMT", "COST", "TGT", "HD", "LOW", "NKE", "SBUX", "MCD", "DIS", "NFLX", "BABA", "JD", "PDD", "LULU", "ETSY", "DASH", "DKNG"];
  const industrialStocks = ["CAT", "DE", "BA", "HON", "GE", "RTX", "LMT", "UPS", "FDX", "WM", "RSG", "EMR", "ITW", "SAIA"];
  const materialStocks = ["MOS", "NEM", "FCX", "NUE", "STLD", "CLF", "AA", "X", "VALE", "RIO", "BHP", "GOLD", "GDX", "GDXJ", "SLV", "GLD", "XLB"];
  const cryptoStocks = ["MARA", "RIOT", "CLSK", "HUT", "BITF", "WULF", "CORZ", "BITO", "IBIT", "GBTC"];
  const evStocks = ["RIVN", "LCID", "NIO", "LI", "XPEV", "CHPT", "QS", "BLNK"];
  const commStocks = ["T", "VZ", "TMUS", "CMCSA", "CHTR", "PARA", "WBD", "ROKU", "SPOT", "TTD", "XLC"];

  if (techStocks.includes(symbol)) return "Technology";
  if (healthStocks.includes(symbol)) return "Healthcare";
  if (finStocks.includes(symbol)) return "Financials";
  if (energyStocks.includes(symbol)) return "Energy";
  if (consumerStocks.includes(symbol)) return "Consumer Discretionary";
  if (industrialStocks.includes(symbol)) return "Industrials";
  if (materialStocks.includes(symbol)) return "Materials";
  if (cryptoStocks.includes(symbol)) return "Crypto";
  if (evStocks.includes(symbol)) return "EV/Auto";
  if (commStocks.includes(symbol)) return "Communication Services";
  return "Unknown";
}

// Cache sector ETF data for the cycle (fetched once, shared across symbols)
let _sectorCache: Record<string, number> = {};

async function fetchSectorPerformance(): Promise<Record<string, number>> {
  const etfSymbols = Object.values(SECTOR_ETFS);
  const start = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  try {
    const symbolsParam = etfSymbols.join(",");
    const res = await withRetry(() => fetchWithTimeout(
      `${ALPACA_DATA_URL}/stocks/bars?symbols=${symbolsParam}&timeframe=1Day&limit=2&start=${start}&feed=iex`,
      { headers: alpacaHeaders }
    ));
    const data = await res.json();
    const performance: Record<string, number> = {};

    for (const [etf, bars] of Object.entries(data?.bars ?? {})) {
      const barsArr = bars as Bar[];
      if (barsArr.length >= 2) {
        const prev = barsArr[barsArr.length - 2].c;
        const curr = barsArr[barsArr.length - 1].c;
        performance[etf] = +((curr - prev) / prev * 100).toFixed(2);
      }
    }
    return performance;
  } catch {
    return {};
  }
}

function computeSectorData(symbol: string, symbolChangePct: number, sectorPerf: Record<string, number>): SectorData {
  const sector = guessSector(symbol);
  const etf = SECTOR_ETFS[sector] ?? "SPY";
  const sectorChangePct = sectorPerf[etf] ?? null;
  const relativeStrength = sectorChangePct != null && sectorChangePct !== 0
    ? +(symbolChangePct / Math.abs(sectorChangePct)).toFixed(2)
    : null;

  return { sector: sector !== "Unknown" ? sector : null, sector_performance: sectorChangePct, relative_strength: relativeStrength };
}

// Check if portfolio is over-exposed to a single sector
function checkSectorConcentration(
  positions: Record<string, unknown>[],
  newSymbol: string,
  maxSectorPct = 0.60 // max 60% of portfolio in one sector — Config C needs room for 8 positions
): { allowed: boolean; reason: string | null } {
  const sectorCounts: Record<string, number> = {};
  const total = positions.length + 1; // including the potential new position

  for (const pos of positions) {
    const sec = guessSector(String(pos.symbol));
    sectorCounts[sec] = (sectorCounts[sec] ?? 0) + 1;
  }

  const newSector = guessSector(newSymbol);
  const currentCount = sectorCounts[newSector] ?? 0;
  const newPct = (currentCount + 1) / total;

  if (newPct > maxSectorPct && total > 2) {
    return {
      allowed: false,
      reason: `Adding ${newSymbol} would put ${(newPct * 100).toFixed(0)}% of positions in ${newSector} (max ${maxSectorPct * 100}%)`,
    };
  }
  return { allowed: true, reason: null };
}

// NEW: ATR-based position sizing — calculates optimal share count so that a 2×ATR move
// against you only costs RISK_PER_TRADE_PCT of equity. This normalizes risk across volatile
// and stable stocks (you trade fewer shares of volatile stocks, more of stable ones).
function atrPositionSize(
  equity: number,
  entryPrice: number,
  atr: number | null,
): { qty: number; stopDistance: number; stopLossPct: number } {
  const { mode } = getCurrentTradingMode();

  // Mode-aware risk: scalp uses tighter stops + bigger positions
  const riskPct = mode === "SCALP" ? 0.035 : RISK_PER_TRADE_PCT;  // 3.5% in scalp, 2.5% in momentum
  const atrMult = mode === "SCALP" ? 1.0 : ATR_STOP_MULTIPLIER;   // 1× ATR in scalp (tight), 1.5× in momentum
  const defaultStop = mode === "SCALP" ? 0.02 : DEFAULT_STOP_LOSS_PCT; // 2% default in scalp, 2.5% in momentum

  // Fallback to fixed stop if ATR is unavailable
  if (!atr || atr <= 0) {
    const stopDistance = entryPrice * defaultStop;
    const riskDollars = equity * riskPct;
    const qty = Math.max(1, Math.floor(riskDollars / stopDistance));
    return { qty, stopDistance, stopLossPct: defaultStop };
  }

  const stopDistance = atr * atrMult;
  const stopLossPct = stopDistance / entryPrice;
  const riskDollars = equity * riskPct;
  const qty = Math.max(1, Math.floor(riskDollars / stopDistance));
  return { qty, stopDistance, stopLossPct };
}

// Reduced from 200 to 100 bars to stay within Supabase compute limits.
// Still enough for SMA-50, MACD, ATR, and RSI-14.
async function fetchBars(symbol: string, limit = 100): Promise<Bar[]> {
  try {
    const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const res = await withRetry(() => fetchWithTimeout(
      `${ALPACA_DATA_URL}/stocks/${symbol}/bars?timeframe=15Min&limit=${limit}&start=${start}&feed=iex`,
      { headers: alpacaHeaders }
    ));
    const data = await res.json();
    return data?.bars ?? [];
  } catch {
    return [];
  }
}

async function computeTechnicals(symbol: string): Promise<TechData & { symbol: string }> {
  const bars = await fetchBars(symbol, 100);
  const closes = bars.map((b) => b.c);

  const emptyVolProfile: VolumeProfile = {
    avg_volume_20: null, volume_ratio: null, accumulation_dist: null,
    obv_trend: null, is_climax_volume: false, institutional_signal: null,
  };
  const empty: TechData & { symbol: string } = {
    symbol, price: 0, change_pct: 0, volume: 0,
    sma20: null, sma50: null, rsi14: null,
    macd: null, macd_signal: null, macd_hist: null,
    atr14: null, bb_upper: null, bb_lower: null, bb_pct: null, vwap: null,
    patterns: [], volume_profile: emptyVolProfile, mtf: null,
    sector: { sector: null, sector_performance: null, relative_strength: null },
  };

  if (closes.length < 2) return empty;

  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const volume = bars[bars.length - 1].v;

  // SMA
  const sma20 = closes.length >= 20 ? +sma(closes.slice(-20)).toFixed(2) : null;
  const sma50 = closes.length >= 50 ? +sma(closes.slice(-50)).toFixed(2) : null;

  // RSI(14) — FIXED: now uses Wilder's smoothed method
  const rsi14 = wilderRSI(closes);

  // MACD(12, 26, 9)
  let macdVal: number | null = null;
  let macdSignal: number | null = null;
  let macdHist: number | null = null;
  if (closes.length >= 35) {
    const ema12 = ema(closes, 12);
    const ema26 = ema(closes, 26);
    const macdLine = ema12.map((v, i) => v - ema26[i]);
    const signalLine = ema(macdLine, 9);
    macdVal = +macdLine[macdLine.length - 1].toFixed(4);
    macdSignal = +signalLine[signalLine.length - 1].toFixed(4);
    macdHist = +(macdVal - macdSignal).toFixed(4);
  }

  // ATR(14)
  const atr14 = wilderATR(bars);

  // Bollinger Bands (20, 2)
  const bb = bollingerBands(closes);

  // VWAP
  const vwap = computeVWAP(bars);

  // NEW: Chart pattern recognition
  const patterns = detectPatterns(bars);

  // NEW: Volume profile & order flow
  const volume_profile = analyzeVolumeProfile(bars);

  return {
    symbol,
    price: +last.toFixed(2),
    change_pct: +(((last - prev) / prev) * 100).toFixed(2),
    volume,
    sma20,
    sma50,
    rsi14,
    macd: macdVal,
    macd_signal: macdSignal,
    macd_hist: macdHist,
    atr14,
    bb_upper: bb?.upper ?? null,
    bb_lower: bb?.lower ?? null,
    bb_pct: bb?.pct ?? null,
    vwap,
    patterns,
    volume_profile,
    mtf: null,   // populated separately in getMarketData (requires extra API calls)
    sector: { sector: null, sector_performance: null, relative_strength: null }, // populated in getMarketData
  };
}

async function getLatestPrice(symbol: string): Promise<number | null> {
  try {
    const res = await withRetry(() => fetchWithTimeout(
      `${ALPACA_DATA_URL}/stocks/${symbol}/quotes/latest?feed=iex`,
      { headers: alpacaHeaders }
    ));
    const data = await res.json();
    return data?.quote?.ap || data?.quote?.bp || null;
  } catch {
    return null;
  }
}

// Check bid-ask spread — returns spread as a % of midpoint, or null on failure
const MAX_SPREAD_PCT = 0.003; // 0.3% max spread — skip thinly-traded symbols
async function getSpreadPct(symbol: string): Promise<{ spreadPct: number; bid: number; ask: number } | null> {
  try {
    const res = await fetchWithTimeout(
      `${ALPACA_DATA_URL}/stocks/${symbol}/quotes/latest?feed=iex`,
      { headers: alpacaHeaders },
      5000
    );
    const data = await res.json();
    const bid = data?.quote?.bp;
    const ask = data?.quote?.ap;
    if (!bid || !ask || bid <= 0 || ask <= 0) return null;
    const mid = (bid + ask) / 2;
    const spreadPct = (ask - bid) / mid;
    return { spreadPct, bid, ask };
  } catch {
    return null;
  }
}

async function getNews(symbol: string, limit = 5): Promise<string[]> {
  try {
    const res = await withRetry(() => fetchWithTimeout(
      `https://data.alpaca.markets/v1beta1/news?symbols=${symbol}&limit=${limit}`,
      { headers: alpacaHeaders }
    ));
    const data = await res.json();
    return (data?.news ?? []).map((n: Record<string, string>) => n.headline);
  } catch {
    return [];
  }
}

// ── Finnhub: News Sentiment ──────────────────────────────────────────────────
async function getFinnhubSentiment(symbol: string): Promise<{ sentiment: number; buzz: number; headlines: string[] }> {
  const finnhubKey = Deno.env.get("FINNHUB_API_KEY");
  if (!finnhubKey) return { sentiment: 0, buzz: 0, headlines: [] };
  try {
    const now = new Date();
    const from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const to = now.toISOString().split("T")[0];
    const [sentRes, newsRes] = await Promise.all([
      fetchWithTimeout(`${FINNHUB_BASE_URL}/news-sentiment?symbol=${symbol}&token=${finnhubKey}`),
      fetchWithTimeout(`${FINNHUB_BASE_URL}/company-news?symbol=${symbol}&from=${from}&to=${to}&token=${finnhubKey}`),
    ]);
    const sentData = await sentRes.json();
    const newsData = await newsRes.json();
    return {
      sentiment: sentData?.sentiment?.bullishPercent ?? 0,
      buzz: sentData?.buzz?.buzz ?? 0,
      headlines: Array.isArray(newsData) ? newsData.slice(0, 3).map((n: Record<string, string>) => n.headline) : [],
    };
  } catch { return { sentiment: 0, buzz: 0, headlines: [] }; }
}

// ── Finnhub: Earnings Calendar ───────────────────────────────────────────────
async function getUpcomingEarnings(symbols: string[]): Promise<Record<string, string>> {
  const finnhubKey = Deno.env.get("FINNHUB_API_KEY");
  if (!finnhubKey) return {};
  try {
    const now = new Date();
    const from = now.toISOString().split("T")[0];
    const to = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const res = await fetchWithTimeout(`${FINNHUB_BASE_URL}/calendar/earnings?from=${from}&to=${to}&token=${finnhubKey}`);
    const data = await res.json();
    const earnings: Record<string, string> = {};
    for (const e of (data?.earningsCalendar ?? [])) {
      if (symbols.includes(e.symbol)) {
        earnings[e.symbol] = `${e.date} (${e.hour === "bmo" ? "before open" : e.hour === "amc" ? "after close" : e.hour})`;
      }
    }
    return earnings;
  } catch { return {}; }
}

// ── Earnings Exception: Hold positions through close if AMC earnings + strong signals ──
// Returns set of symbols that have after-market-close earnings TODAY and should
// be exempt from the EOD flatten rule (only if the position is profitable).
async function getEarningsExemptSymbols(heldSymbols: string[]): Promise<Set<string>> {
  const exempt = new Set<string>();
  const finnhubKey = Deno.env.get("FINNHUB_API_KEY");
  if (!finnhubKey || heldSymbols.length === 0) return exempt;
  try {
    const today = new Date().toISOString().split("T")[0];
    const res = await fetchWithTimeout(
      `${FINNHUB_BASE_URL}/calendar/earnings?from=${today}&to=${today}&token=${finnhubKey}`,
      undefined, 8000
    );
    const data = await res.json();
    for (const e of (data?.earningsCalendar ?? [])) {
      // Only exempt stocks with AFTER-MARKET-CLOSE earnings today
      // AMC earnings = potential gap up tomorrow if results are good
      if (heldSymbols.includes(e.symbol) && e.hour === "amc") {
        exempt.add(e.symbol);
      }
    }
    console.log(`📊 Earnings check: ${exempt.size} held symbols have AMC earnings today: ${[...exempt].join(", ") || "none"}`);
  } catch (err) {
    console.warn("Earnings calendar check failed:", err);
  }
  return exempt;
}

// ── Finnhub: Insider Transactions ────────────────────────────────────────────
async function getInsiderTransactions(symbol: string): Promise<string[]> {
  const finnhubKey = Deno.env.get("FINNHUB_API_KEY");
  if (!finnhubKey) return [];
  try {
    const res = await fetchWithTimeout(`${FINNHUB_BASE_URL}/stock/insider-transactions?symbol=${symbol}&token=${finnhubKey}`);
    const data = await res.json();
    return (data?.data ?? []).slice(0, 3).map((t: Record<string, unknown>) =>
      `${t.name}: ${t.transactionType} ${t.share} shares @ $${t.price} (${t.transactionDate})`
    );
  } catch { return []; }
}

// ── CNN Fear & Greed Index ───────────────────────────────────────────────────
interface FearGreedData {
  score: number;
  label: string;        // "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed"
  previous: number;
}

async function getFearGreedIndex(): Promise<FearGreedData> {
  try {
    const res = await fetchWithTimeout("https://production.dataviz.cnn.io/index/fearandgreed/graphdata");
    const data = await res.json();
    const current = data?.fear_and_greed?.score ?? 50;
    const previous = data?.fear_and_greed?.previous_close ?? 50;
    let label = "Neutral";
    if (current <= 25) label = "Extreme Fear";
    else if (current <= 45) label = "Fear";
    else if (current >= 75) label = "Extreme Greed";
    else if (current >= 55) label = "Greed";
    return { score: Math.round(current), label, previous: Math.round(previous) };
  } catch {
    return { score: 50, label: "Neutral", previous: 50 };
  }
}

// ── VIX Volatility Index (via Alpaca) ────────────────────────────────────────
interface VixData {
  value: number;
  label: string;  // "Low Vol" | "Normal" | "Elevated" | "High Vol" | "Extreme"
}

async function getVixLevel(): Promise<VixData> {
  try {
    // VIX is available as a snapshot from Alpaca
    const res = await fetchWithTimeout(`${ALPACA_DATA_URL}/stocks/snapshots?symbols=VXX,UVXY`, {
      headers: alpacaHeaders,
    });
    const data = await res.json();
    // Use VXX as VIX proxy (tracks VIX short-term futures)
    const vxx = data?.VXX?.latestTrade?.p ?? data?.UVXY?.latestTrade?.p ?? null;
    if (!vxx) return { value: 20, label: "Normal" };

    // Map VXX price to approximate VIX interpretation
    let label = "Normal";
    if (vxx < 15) label = "Low Vol";
    else if (vxx < 25) label = "Normal";
    else if (vxx < 35) label = "Elevated";
    else if (vxx < 50) label = "High Vol";
    else label = "Extreme";

    return { value: Math.round(vxx * 10) / 10, label };
  } catch {
    return { value: 20, label: "Normal" };
  }
}

// ── Short Interest Data (via Quiver Quant free tier) ─────────────────────────
interface ShortInterestData {
  symbol: string;
  shortInterest: number;   // % of float shorted
  daysTocover: number;
}

async function getHighShortInterest(): Promise<ShortInterestData[]> {
  try {
    const res = await fetchWithTimeout("https://api.quiverquant.com/beta/live/shortinterest", {
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data) ? data : [])
      .filter((s: Record<string, unknown>) => (s.shortInterest as number) > 10)
      .slice(0, 20)
      .map((s: Record<string, unknown>) => ({
        symbol: s.ticker as string,
        shortInterest: Math.round((s.shortInterest as number) * 10) / 10,
        daysTocover: Math.round((s.daysToCover as number ?? 0) * 10) / 10,
      }));
  } catch { return []; }
}

// ── Congressional Trading (via Quiver Quant free tier) ───────────────────────
interface CongressTrade {
  symbol: string;
  politician: string;
  type: string;       // "Purchase" | "Sale"
  amount: string;
  date: string;
}

async function getCongressTrades(): Promise<CongressTrade[]> {
  try {
    const res = await fetchWithTimeout("https://api.quiverquant.com/beta/live/congresstrading", {
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data) ? data : [])
      .slice(0, 15)
      .map((t: Record<string, unknown>) => ({
        symbol: t.ticker as string ?? "???",
        politician: t.Representative as string ?? "Unknown",
        type: t.Transaction as string ?? "Unknown",
        amount: t.Amount as string ?? "N/A",
        date: t.TransactionDate as string ?? "",
      }));
  } catch { return []; }
}

// ── Reddit / WallStreetBets Social Sentiment ─────────────────────────────────
interface SocialStock {
  symbol: string;
  mentions: number;
  mentions_24h_ago: number;
  sentiment: string;
  source: string;
}

async function getWsbTrending(): Promise<SocialStock[]> {
  const results: SocialStock[] = [];

  // Source 1: ApeWisdom — tracks WSB, r/stocks, r/options, r/pennystocks
  try {
    const [wsbRes, stocksRes] = await Promise.all([
      fetchWithTimeout("https://apewisdom.io/api/v1.0/filter/wallstreetbets/page/1"),
      fetchWithTimeout("https://apewisdom.io/api/v1.0/filter/all-stocks/page/1"),
    ]);
    const wsbData = await wsbRes.json();
    const stocksData = await stocksRes.json();

    for (const r of (wsbData?.results ?? []).slice(0, 15)) {
      results.push({
        symbol: r.ticker,
        mentions: r.mentions ?? 0,
        mentions_24h_ago: r.mentions_24h_ago ?? 0,
        sentiment: (r.upvotes ?? 0) > 0 ? "bullish" : "neutral",
        source: "WSB",
      });
    }

    // Add stocks trending on other subreddits but not already in WSB list
    const wsbSymbols = new Set(results.map(r => r.symbol));
    for (const r of (stocksData?.results ?? []).slice(0, 15)) {
      if (!wsbSymbols.has(r.ticker)) {
        results.push({
          symbol: r.ticker,
          mentions: r.mentions ?? 0,
          mentions_24h_ago: r.mentions_24h_ago ?? 0,
          sentiment: (r.upvotes ?? 0) > 0 ? "bullish" : "neutral",
          source: "Reddit",
        });
      }
    }
  } catch (err) {
    console.error("ApeWisdom fetch failed:", (err as Error).message);
  }

  // Source 2: Quiver Quant WSB API (free tier)
  try {
    const res = await fetchWithTimeout("https://api.quiverquant.com/beta/live/wallstreetbets", {
      headers: { "Accept": "application/json" },
    });
    if (res.ok) {
      const data = await res.json();
      const existingSymbols = new Set(results.map(r => r.symbol));
      for (const r of (Array.isArray(data) ? data : []).slice(0, 10)) {
        if (!existingSymbols.has(r.ticker)) {
          results.push({
            symbol: r.ticker,
            mentions: r.mentions ?? r.count ?? 0,
            mentions_24h_ago: 0,
            sentiment: (r.sentiment ?? 0) > 0 ? "bullish" : (r.sentiment ?? 0) < 0 ? "bearish" : "neutral",
            source: "QuiverWSB",
          });
        }
      }
    }
  } catch { /* QuiverQuant optional */ }

  // Sort by mentions and compute momentum (spike detection)
  results.sort((a, b) => b.mentions - a.mentions);

  // Flag stocks with mention spikes (>50% increase in 24h)
  for (const r of results) {
    if (r.mentions_24h_ago > 0 && r.mentions > r.mentions_24h_ago * 1.5) {
      r.sentiment = `🚀 SPIKING (${Math.round((r.mentions / r.mentions_24h_ago - 1) * 100)}% ↑) — ${r.sentiment}`;
    }
  }

  console.log(`Social sentiment: ${results.length} stocks tracked (${results.filter(r => r.source === "WSB").length} from WSB)`);
  return results;
}

// ── Combine all enrichment data ──────────────────────────────────────────────
interface EnrichmentData {
  fearGreed: FearGreedData;
  vix: VixData;
  earnings: Record<string, string>;
  socialSentiment: SocialStock[];
  shortInterest: ShortInterestData[];
  congressTrades: CongressTrade[];
  finnhubSentiment: Record<string, { sentiment: number; buzz: number; headlines: string[] }>;
  insiderTrades: Record<string, string[]>;
}

async function getEnrichmentData(symbols: string[]): Promise<EnrichmentData> {
  // Fetch global data in parallel
  const [fearGreed, vix, earnings, socialSentiment, shortInterest, congressTrades] = await Promise.all([
    getFearGreedIndex(),
    getVixLevel(),
    getUpcomingEarnings(symbols),
    getWsbTrending(),
    getHighShortInterest(),
    getCongressTrades(),
  ]);

  // Fetch per-symbol Finnhub data (reduced to top 8 to save compute)
  const topSymbols = symbols.slice(0, 8);
  const finnhubResults = await Promise.all(
    topSymbols.map(async (sym) => {
      const [sentiment, insider] = await Promise.all([
        getFinnhubSentiment(sym),
        getInsiderTransactions(sym),
      ]);
      return { sym, sentiment, insider };
    })
  );

  const finnhubSentiment: Record<string, { sentiment: number; buzz: number; headlines: string[] }> = {};
  const insiderTrades: Record<string, string[]> = {};
  for (const r of finnhubResults) {
    finnhubSentiment[r.sym] = r.sentiment;
    if (r.insider.length > 0) insiderTrades[r.sym] = r.insider;
  }

  console.log(`Enrichment: F&G=${fearGreed.score}(${fearGreed.label}), VIX=${vix.value}(${vix.label}), ${Object.keys(earnings).length} earnings, ${socialSentiment.length} social, ${shortInterest.length} high-SI, ${congressTrades.length} congress, ${Object.keys(insiderTrades).length} insider`);

  return { fearGreed, vix, earnings, socialSentiment, shortInterest, congressTrades, finnhubSentiment, insiderTrades };
}

async function getMarketData(symbols: string[]) {
  // Fetch sector ETF performance once for the cycle (shared across all symbols)
  const sectorPerf = await fetchSectorPerformance();
  _sectorCache = sectorPerf;

  // Process symbols in batches of 5 to avoid memory spikes
  const results: [string, { tech: TechData & { symbol: string }; news: string[] }][] = [];
  const batchSize = 5;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (sym) => {
        const [tech, news] = await Promise.all([
          computeTechnicals(sym),
          getNews(sym),
          // SKIP multi-timeframe (fetchBarsMultiTF) — too heavy for Edge Functions
        ]);

        tech.mtf = null; // skip MTF to save compute
        tech.sector = computeSectorData(sym, tech.change_pct, sectorPerf);

        return [sym, { tech, news }] as const;
      })
    );
    results.push(...batchResults);
  }
  return Object.fromEntries(results);
}

// ── Supabase History ─────────────────────────────────────────────────────────
async function getTradeHistory(limit = 50) {
  const { data } = await supabase
    .from("trades")
    .select("created_at, symbol, action, quantity, price_entry, price_exit, pnl, reason, status")
    .neq("action", "HOLD")
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}

async function logTrade(trade: Record<string, unknown>) {
  await supabase.from("trades").insert(trade);
}

async function closeBuyTrade(symbol: string, priceExit: number) {
  const { data } = await supabase
    .from("trades")
    .select("id, price_entry, quantity")
    .eq("symbol", symbol)
    .eq("action", "BUY")
    .eq("status", "open");

  if (!data?.length) return;

  await Promise.all(data.map((trade) => {
    const pnl = trade.price_entry
      ? +((priceExit - trade.price_entry) * trade.quantity).toFixed(2)
      : null;
    return supabase
      .from("trades")
      .update({ price_exit: priceExit, pnl, status: "closed" })
      .eq("id", trade.id);
  }));
}

async function logSnapshot(cash: number, equity: number, positions: unknown[]) {
  await supabase.from("portfolio_snapshots").insert({ cash, equity, positions });
}

async function getLastAnalyses(): Promise<string | null> {
  const { data } = await supabase
    .from("bot_analyses")
    .select("analysis, created_at, trade_count, type")
    .order("created_at", { ascending: false })
    .limit(2);
  if (!data?.length) return null;
  return data.map(a =>
    `### Analyse du cycle #${a.trade_count} (${new Date(a.created_at).toISOString().split("T")[0]})\n${a.analysis}`
  ).join("\n\n---\n\n");
}

// NEW P2: Fetch latest performance metrics to inject into Grok's decision context.
async function getLatestMetrics(): Promise<string | null> {
  const { data } = await supabase
    .from("performance_metrics")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(1);

  if (!data?.length) return null;
  const m = data[0];
  return `- Win Rate: ${m.win_rate != null ? (m.win_rate * 100).toFixed(1) + "%" : "N/A"} (${m.winning_trades}W / ${m.losing_trades}L / ${m.total_trades} total)
- Avg Win: $${m.avg_win ?? "N/A"} | Avg Loss: $${m.avg_loss ?? "N/A"} | Profit Factor: ${m.profit_factor ?? "N/A"}
- Sharpe Ratio: ${m.sharpe_ratio ?? "N/A"}
- Max Drawdown: ${m.max_drawdown_pct != null ? (m.max_drawdown_pct * 100).toFixed(1) + "%" : "N/A"} | Current Drawdown: ${m.current_drawdown_pct != null ? (m.current_drawdown_pct * 100).toFixed(1) + "%" : "N/A"}
- Streak: ${m.current_streak > 0 ? m.current_streak + " wins" : m.current_streak < 0 ? Math.abs(m.current_streak) + " losses" : "neutral"} (best: ${m.longest_win_streak}W / worst: ${m.longest_loss_streak}L)
- Avg Hold Duration: ${m.avg_hold_duration_minutes ? m.avg_hold_duration_minutes + " min" : "N/A"}`;
}

async function getCycleCount(): Promise<number> {
  const { count } = await supabase
    .from("portfolio_snapshots")
    .select("*", { count: "exact", head: true });
  return count ?? 0;
}

// NEW P2: Compute and persist portfolio-level performance metrics.
// These are stored every 5 cycles alongside the self-analysis, giving Grok
// (and your dashboard) a quantitative view of how the strategy is performing over time.
async function computeAndSaveMetrics(
  cycleCount: number,
  account: Record<string, unknown>,
  positions: unknown[]
) {
  const currentEquity = parseFloat(String(account.equity));
  const currentCash = parseFloat(String(account.cash));

  // Fetch all closed trades for lifetime stats
  const { data: allClosed } = await supabase
    .from("trades")
    .select("pnl, created_at, price_entry, price_exit, quantity, action")
    .eq("status", "closed")
    .not("pnl", "is", null)
    .order("created_at", { ascending: true });

  const closedTrades = allClosed ?? [];
  const totalTrades = closedTrades.length;
  const winners = closedTrades.filter(t => (t.pnl as number) > 0);
  const losers = closedTrades.filter(t => (t.pnl as number) < 0);

  const winRate = totalTrades > 0 ? winners.length / totalTrades : null;
  const avgWin = winners.length > 0
    ? winners.reduce((s, t) => s + (t.pnl as number), 0) / winners.length
    : null;
  const avgLoss = losers.length > 0
    ? losers.reduce((s, t) => s + (t.pnl as number), 0) / losers.length
    : null;

  const grossProfit = winners.reduce((s, t) => s + (t.pnl as number), 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + (t.pnl as number), 0));
  const profitFactor = grossLoss > 0 ? +(grossProfit / grossLoss).toFixed(2) : null;

  const totalPnlRealized = closedTrades.reduce((s, t) => s + ((t.pnl as number) || 0), 0);
  const totalPnlUnrealized = (positions as Record<string, unknown>[])
    .reduce((s, p) => s + parseFloat(String(p.unrealized_pl ?? 0)), 0);

  // Max drawdown from equity snapshots
  const { data: snapshots } = await supabase
    .from("portfolio_snapshots")
    .select("equity")
    .order("created_at", { ascending: true });

  let maxDrawdownPct = 0;
  let peak = STARTING_CAPITAL;
  for (const snap of (snapshots ?? [])) {
    const eq = parseFloat(String(snap.equity));
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }
  const currentDrawdownPct = peak > 0 ? (peak - currentEquity) / peak : 0;

  // Sharpe ratio (annualized, using daily returns approximation)
  // We use per-cycle returns from snapshots as a proxy
  let sharpeRatio: number | null = null;
  if (snapshots && snapshots.length > 2) {
    const equities = snapshots.map(s => parseFloat(String(s.equity)));
    const returns = equities.slice(1).map((eq, i) => (eq - equities[i]) / equities[i]);
    const meanReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
    const stdDev = Math.sqrt(returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / returns.length);
    // Annualize: ~13 cycles/day × 252 trading days
    const annualizationFactor = Math.sqrt(13 * 252);
    sharpeRatio = stdDev > 0 ? +((meanReturn / stdDev) * annualizationFactor).toFixed(2) : null;
  }

  // Win/loss streaks
  let currentStreak = 0;
  let longestWin = 0;
  let longestLoss = 0;
  let tempStreak = 0;
  for (const trade of closedTrades) {
    if ((trade.pnl as number) > 0) {
      tempStreak = tempStreak > 0 ? tempStreak + 1 : 1;
      longestWin = Math.max(longestWin, tempStreak);
    } else {
      tempStreak = tempStreak < 0 ? tempStreak - 1 : -1;
      longestLoss = Math.max(longestLoss, Math.abs(tempStreak));
    }
  }
  currentStreak = tempStreak;

  // Average hold duration (for trades that have both entry and exit timestamps)
  const { data: roundTrips } = await supabase
    .from("trades")
    .select("created_at")
    .eq("action", "BUY")
    .eq("status", "closed")
    .order("created_at", { ascending: false })
    .limit(50);

  const { data: sellTrades } = await supabase
    .from("trades")
    .select("created_at")
    .eq("action", "SELL")
    .eq("status", "closed")
    .order("created_at", { ascending: false })
    .limit(50);

  let avgHoldDuration: number | null = null;
  if (roundTrips?.length && sellTrades?.length) {
    const durations: number[] = [];
    const minLen = Math.min(roundTrips.length, sellTrades.length);
    for (let i = 0; i < minLen; i++) {
      const buyTime = new Date(roundTrips[i].created_at).getTime();
      const sellTime = new Date(sellTrades[i].created_at).getTime();
      if (sellTime > buyTime) {
        durations.push((sellTime - buyTime) / (1000 * 60)); // minutes
      }
    }
    if (durations.length > 0) {
      avgHoldDuration = Math.round(durations.reduce((s, d) => s + d, 0) / durations.length);
    }
  }

  await supabase.from("performance_metrics").insert({
    cycle_count: cycleCount,
    equity: +currentEquity.toFixed(2),
    cash: +currentCash.toFixed(2),
    total_pnl_realized: +totalPnlRealized.toFixed(2),
    total_pnl_unrealized: +totalPnlUnrealized.toFixed(2),
    total_trades: totalTrades,
    winning_trades: winners.length,
    losing_trades: losers.length,
    win_rate: winRate != null ? +winRate.toFixed(4) : null,
    avg_win: avgWin != null ? +avgWin.toFixed(2) : null,
    avg_loss: avgLoss != null ? +avgLoss.toFixed(2) : null,
    profit_factor: profitFactor,
    max_drawdown_pct: +maxDrawdownPct.toFixed(4),
    current_drawdown_pct: +currentDrawdownPct.toFixed(4),
    sharpe_ratio: sharpeRatio,
    open_positions: (positions as unknown[]).length,
    avg_hold_duration_minutes: avgHoldDuration,
    current_streak: currentStreak,
    longest_win_streak: longestWin,
    longest_loss_streak: longestLoss,
  });

  console.log(`Performance metrics saved at cycle #${cycleCount}: equity=$${currentEquity.toFixed(2)} winRate=${winRate != null ? (winRate * 100).toFixed(1) + "%" : "N/A"} sharpe=${sharpeRatio ?? "N/A"} maxDD=${(maxDrawdownPct * 100).toFixed(1)}%`);
}

async function generateAndSaveAnalysis(
  cycleCount: number,
  account: Record<string, unknown>,
  positions: unknown[]
) {
  const { data: lastDecisions } = await supabase
    .from("trades")
    .select("created_at, symbol, action, quantity, price_entry, price_exit, pnl, reason, status")
    .order("created_at", { ascending: false })
    .limit(20);

  if (!lastDecisions?.length) return;

  const closedTrades = lastDecisions.filter((t: Record<string, unknown>) => t.pnl != null);
  const winCount = closedTrades.filter((t: Record<string, unknown>) => (t.pnl as number) > 0).length;
  const winRate = closedTrades.length ? Math.round((winCount / closedTrades.length) * 100) : null;
  const totalPnl = closedTrades.reduce((s: number, t: Record<string, unknown>) => s + ((t.pnl as number) || 0), 0);
  const holdCount = lastDecisions.filter((t: Record<string, unknown>) => t.action === "HOLD").length;
  const holdRate = Math.round((holdCount / lastDecisions.length) * 100);

  const positionsStr = (positions as Record<string, unknown>[]).length
    ? (positions as Record<string, unknown>[]).map(p =>
        ` ${p.symbol}: ${p.qty} actions | PnL non réalisé : $${p.unrealized_pl} (${(parseFloat(String(p.unrealized_plpc ?? 0)) * 100).toFixed(2)}%)`
      ).join("\n")
    : " Aucune";

  const previousAnalyses = await getLastAnalyses();

  const prompt = `Tu es un trader IA qui analyse ses propres décisions pour s'améliorer.

## État du portfolio (maintenant)
- Equity totale : $${account.equity} | Cash disponible : $${account.cash}
- Positions ouvertes :
${positionsStr}

## Métriques sur les 20 dernières décisions
- PnL réalisé total : ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}
- Win rate : ${winRate !== null ? `${winRate}% (${winCount} gagnants / ${closedTrades.length} trades clôturés)` : "Aucun trade clôturé"}
- Ratio HOLD : ${holdRate}% des décisions (${holdCount}/${lastDecisions.length})

## 20 dernières décisions (récent → ancien)
${JSON.stringify(lastDecisions, null, 2)}
${previousAnalyses ? `\n## Analyses précédentes\n${previousAnalyses}\n` : ""}
Produis une auto-analyse structurée et actionnable :
1. **Performance réelle** : le portfolio progresse-t-il ? Analyse le PnL et l'equity.
2. **Décisions pertinentes** : quelles décisions étaient justifiées et pourquoi
3. **Décisions discutables** : quelles décisions auraient pu être différentes
4. **Patterns identifiés** : tendances récurrentes
${previousAnalyses ? "5. **Feedback analyses précédentes** : les ajustements recommandés ont-ils été appliqués ?\n6. **Ajustements concrets** : ce que tu vas changer dans les prochains cycles" : "5. **Ajustements concrets** : ce que tu vas changer dans les prochains cycles"}

Sois concis, factuel et actionnable.`;

  const analysis = await callGrok(prompt);

  await supabase.from("bot_analyses").insert({
    trade_count: cycleCount,
    type: "analysis",
    analysis,
    trades_ref: lastDecisions,
  });

  console.log(`Auto-analyse générée au cycle #${cycleCount}`);
}

function isLastCycleOfWeek(now: Date, deadline: Date): boolean {
  // Use ET day-of-week instead of UTC (handles DST correctly)
  const etDay = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" })).getDay();
  return etDay === 5 && (deadline.getTime() - now.getTime()) < 60 * 60 * 1000;
}

async function generateWeeklySummary(
  account: Record<string, unknown>,
  positions: unknown[],
  cycleCount: number
) {
  // Use ET for day calculation (DST-safe)
  const monday = new Date();
  const etDay = new Date(monday.toLocaleString("en-US", { timeZone: "America/New_York" })).getDay();
  monday.setDate(monday.getDate() - ((etDay + 6) % 7));
  monday.setUTCHours(5, 0, 0, 0); // ~midnight ET (safe for both EST/EDT)

  const { data: weekDecisions } = await supabase
    .from("trades")
    .select("created_at, symbol, action, quantity, price_entry, price_exit, pnl, reason, status")
    .gte("created_at", monday.toISOString())
    .order("created_at", { ascending: true });

  if (!weekDecisions?.length) return;

  const closedTrades = weekDecisions.filter((t: Record<string, unknown>) => t.pnl != null);
  const winCount = closedTrades.filter((t: Record<string, unknown>) => (t.pnl as number) > 0).length;
  const winRate = closedTrades.length ? Math.round((winCount / closedTrades.length) * 100) : null;
  const totalPnl = closedTrades.reduce((s: number, t: Record<string, unknown>) => s + ((t.pnl as number) || 0), 0);
  const holdCount = weekDecisions.filter((t: Record<string, unknown>) => t.action === "HOLD").length;

  const positionsStr = (positions as Record<string, unknown>[]).length
    ? (positions as Record<string, unknown>[]).map(p =>
        ` ${p.symbol}: ${p.qty} actions | PnL non réalisé : $${p.unrealized_pl}`
      ).join("\n")
    : " Aucune";

  const prompt = `Tu es un trader IA. La semaine de trading se termine. Produis un bilan complet.

## Performance de la semaine
- Equity finale : $${account.equity} | Départ : ~$100 000
- PnL réalisé cette semaine : ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}
- Win rate : ${winRate !== null ? `${winRate}% (${winCount}/${closedTrades.length} trades)` : "Aucun trade clôturé"}
- Total décisions : ${weekDecisions.length} (dont ${holdCount} HOLD)
- Positions encore ouvertes :
${positionsStr}

## Toutes les décisions de la semaine
${JSON.stringify(weekDecisions, null, 2)}

Produis un bilan hebdomadaire structuré :
1. **Résumé de la semaine** : performance globale
2. **Meilleures décisions** : quels trades ont le plus contribué
3. **Pires décisions** : quels trades ont coûté le plus cher
4. **Stratégie semaine prochaine** : que faire différemment
5. **3 règles concrètes** : pour améliorer les performances

Ce bilan sera injecté dans le premier cycle de la semaine prochaine.`;

  const analysis = await callGrok(prompt);

  await supabase.from("bot_analyses").insert({
    trade_count: cycleCount,
    type: "weekly_summary",
    analysis,
    trades_ref: weekDecisions,
  });

  console.log(`Bilan de fin de semaine généré au cycle #${cycleCount}`);
}

// ── Decision Validation ──────────────────────────────────────────────────────
function isValidSymbol(s: unknown): s is string {
  return typeof s === "string" && /^[A-Z]{1,5}$/.test(s);
}

function isValidQuantity(q: unknown): q is number {
  return typeof q === "number" && Number.isInteger(q) && q > 0 && q < 1_000_000;
}

// ── JSON Parsing ─────────────────────────────────────────────────────────────
function extractJson(content: string): unknown {
  try { return JSON.parse(content); } catch { /* continue */ }
  const stripped = content.replace(/^```(?:json)?\s*/im, "").replace(/\s*```\s*$/im, "").trim();
  try { return JSON.parse(stripped); } catch { /* continue */ }
  const arr = content.match(/\[[\s\S]*\]/);
  if (arr) { try { return JSON.parse(arr[0]); } catch { /* continue */ } }
  const obj = content.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch { /* continue */ } }
  throw new Error("No valid JSON found in Grok response");
}

// ── Grok API Calls ───────────────────────────────────────────────────────────
async function callGrok(prompt: string, systemPrompt?: string, _liveSearch = false): Promise<string> {
  const apiKey = Deno.env.get("GROK_API_KEY");
  if (!apiKey) {
    console.error("GROK_API_KEY is not set!");
    return "";
  }
  console.log("callGrok: using chat/completions, key starts with:", apiKey.slice(0, 8) + "...");

  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const res = await withRetry(() => fetchWithTimeout(`${GROK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "grok-3-mini-fast",
      messages,
      temperature: 0.2,
    }),
  }, 30000)); // 30s timeout for LLM calls (they're slower)

  const status = res.status;
  const data = await res.json();
  console.log("Grok API status:", status);

  if (status !== 200) {
    console.error("Grok API error:", JSON.stringify(data).slice(0, 500));
    return "";
  }

  const content = data.choices?.[0]?.message?.content ?? "";
  console.log("Grok response length:", content.length, "| first 200 chars:", content.slice(0, 200));
  return content;
}

// ══════════════════════════════════════════════════════════════════════════════
// MARKET SCANNER — Full NASDAQ Blue Chips + NYSE Majors Universe
// Scans 200+ stocks, pre-filters via Alpaca snapshots, then refines with Grok.
// ══════════════════════════════════════════════════════════════════════════════

// NASDAQ Blue Chips — Top 100 by market cap (mega & large cap)
const NASDAQ_BLUE_CHIPS = [
  // Mega-cap tech
  "AAPL", "MSFT", "GOOGL", "GOOG", "AMZN", "META", "NVDA", "TSLA", "AVGO", "COST",
  "NFLX", "ADBE", "AMD", "QCOM", "INTC", "TXN", "INTU", "AMAT", "MU", "LRCX",
  "ADI", "KLAC", "SNPS", "CDNS", "MRVL", "NXPI", "ON", "MCHP", "FTNT", "PANW",
  // Cloud / SaaS / Software
  "CRM", "ORCL", "NOW", "SHOP", "SNOW", "PLTR", "DDOG", "NET", "ZS", "CRWD",
  "WDAY", "TEAM", "MNDY", "TTD", "HUBS", "BILL", "MDB", "ESTC",
  // Internet / Digital
  "ABNB", "UBER", "LYFT", "DASH", "COIN", "SQ", "PYPL", "ROKU", "PINS", "SNAP",
  "RBLX", "HOOD", "SOFI", "AFRM",
  // Biotech / Healthcare
  "AMGN", "GILD", "MRNA", "BNTX", "REGN", "VRTX", "BIIB", "ILMN", "DXCM", "ISRG",
  "IDXX", "ALGN",
  // Consumer / Retail
  "PEP", "SBUX", "LULU", "MNST", "CPRT", "ROST", "DLTR", "PAYX", "FAST", "ODFL",
  // EV / Clean Energy
  "LCID", "RIVN", "ENPH", "SEDG", "FSLR",
  // Semiconductor ETF & Index
  "QQQ", "SMH",
];

// NYSE Major Stocks — Top 120+ by market cap & liquidity
const NYSE_MAJORS = [
  // Financials
  "JPM", "BAC", "WFC", "GS", "MS", "C", "BLK", "SCHW", "AXP", "USB",
  "PNC", "TFC", "COF", "BK", "STT", "ICE", "CME", "MCO", "SPGI", "FIS",
  // Healthcare / Pharma
  "JNJ", "UNH", "PFE", "ABBV", "MRK", "LLY", "TMO", "ABT", "BMY", "MDT",
  "DHR", "SYK", "BDX", "ZTS", "CI", "HUM", "ELV", "CVS",
  // Consumer
  "WMT", "HD", "LOW", "TGT", "NKE", "MCD", "SBUX", "DIS", "CMCSA", "T",
  "VZ", "KO", "PG", "CL", "EL", "GIS", "K", "HSY", "SJM",
  // Industrials
  "CAT", "DE", "BA", "HON", "GE", "RTX", "LMT", "NOC", "GD", "TDG",
  "UPS", "FDX", "WM", "RSG", "EMR", "ETN", "ITW", "PH",
  // Energy
  "XOM", "CVX", "COP", "EOG", "SLB", "OXY", "MPC", "PSX", "VLO", "HAL",
  "DVN", "FANG", "HES", "BKR",
  // Materials
  "LIN", "APD", "SHW", "ECL", "DD", "NEM", "FCX", "NUE",
  // Real Estate
  "AMT", "PLD", "CCI", "EQIX", "SPG", "PSA", "O", "WELL",
  // Utilities
  "NEE", "DUK", "SO", "D", "SRE", "AEP", "EXC", "XEL",
  // Broad Market ETFs
  "SPY", "DIA", "IWM", "VTI",
  // Payments
  "V", "MA",
];

// Mid-Cap Growth ($2B-$20B) — high growth, actively traded
const MID_CAP_GROWTH = [
  // Crypto / Blockchain
  "MARA", "RIOT", "CLSK", "MSTR", "CIFR", "HUT", "BTBT",
  // China tech / ADRs
  "BABA", "JD", "PDD", "BIDU", "NIO", "XPEV", "LI", "BILI", "FUTU",
  // Fintech / Digital finance
  "UPST", "LMND", "OPEN", "RDFN", "LC",
  // Cloud / SaaS (smaller)
  "FIVN", "VEEV", "SMAR", "UPWK", "ZI", "CFLT", "PATH", "S", "BRZE", "DOCN",
  // Hardware / Semiconductor (smaller)
  "SMCI", "WOLF", "ACLS", "CRUS", "DIOD", "SLAB",
  // Misc growth
  "TOST", "CAVA", "BROS", "DKNG", "PENN", "CHWY", "ETSY", "W", "CVNA",
];

// Small-Cap Momentum ($500M-$2B) — high volatility, day-trader favorites
const SMALL_CAP_MOMENTUM = [
  "SNDL", "TLRY", "ACB", "CGC", "GERN", "VXRT", "NKLA",
  "SPCE", "CLOV", "WISH", "ASTS", "IONQ", "RGTI", "QUBT", "MYPS",
  "BTDR", "SOUN", "GRAB", "BIRD", "SKLZ", "VLD", "DNA",
  "GEVO", "PLUG", "FCEL", "BE", "BLDP", "CLNE",
  "FFIE", "GOEV", "REE", "PSNY", "MULN",
];

// Meme Stocks — WSB and retail favorites
const MEME_STOCKS = [
  "GME", "AMC", "KOSS", "BBAI", "DJT", "RDDT", "CELH",
  "SMCI", "IONQ", "RGTI", "SOUN", "RKLB", "LUNR", "ASTS",
  "NVAX", "APLD", "CORZ", "IREN", "WULF",
];

// Biotech / Pharma Catalysts — FDA events, trial results
const BIOTECH_CATALYSTS = [
  "NVAX", "DVAX", "BMRN", "RXRX", "CRNX", "VERV", "BEAM",
  "CRSP", "NTLA", "EDIT", "BLUE", "SRPT", "ALNY", "RARE",
  "HALO", "PCVX", "LEGN", "IMVT", "KRTX", "KRYS", "RVMD",
  "EXAS", "MORF", "VRNA", "TGTX", "XENE", "PRCT", "ACAD",
];

// Missing Large-Caps — S&P 500 stocks not yet in the universe
const MISSING_LARGE_CAPS = [
  // Tech / Software
  "CSCO", "IBM", "DELL", "HPQ", "HPE", "AKAM", "JNPR", "KEYS", "ANSS", "CDNS",
  // Aerospace / Defense
  "TDG", "HWM", "TXT", "LHX", "LDOS",
  // Alt Asset Managers / Private Equity
  "KKR", "BX", "APO", "ARES", "CG",
  // Insurance
  "AIG", "MET", "PRU", "ALL", "TRV", "CB", "PGR", "AFL",
  // Transport
  "DAL", "UAL", "LUV", "AAL", "JBLU", "ALK",
  // Food / Beverage
  "MDLZ", "STZ", "BF.B", "TAP", "SAM", "KDP", "MNST",
  // Misc S&P 500
  "ABNB", "PANW", "LRCX", "SNPS", "CDNS", "CEG", "CARR", "OTIS", "DOV",
  "A", "WAT", "MTD", "PKG", "IP", "WRK",
];

// Sector ETFs — for broad market plays
const SECTOR_ETFS_TRADEABLE = [
  "XLF", "XLK", "XLE", "XLV", "XLI", "XLY", "XLP", "XLU", "XLB", "XLRE",
  "XBI", "IBB", "ARKK", "ARKG", "SOXX", "GDX", "SLV", "GLD", "USO",
];

// Commodities — Oil, Gold, Silver, Natural Gas (via ETFs tradeable on Alpaca)
const COMMODITIES = [
  // Gold
  "GLD", "IAU", "GDX", "GDXJ", "NEM", "GOLD", "AEM", "KGC", "AGI", "FNV", "WPM",
  // Silver
  "SLV", "PAAS", "AG", "HL", "CDE", "MAG", "FSM",
  // Oil & Gas
  "USO", "BNO", "XLE", "OIH", "XOP",
  "XOM", "CVX", "COP", "OXY", "EOG", "DVN", "FANG", "MPC", "PSX", "VLO",
  "PBR", "BP", "SHEL", "TTE", "ENB", "SU", "CNQ",
  // Natural Gas
  "UNG", "AR", "EQT", "RRC", "SWN", "CTRA",
  // Copper & Industrial Metals
  "COPX", "FCX", "SCCO", "TECK", "BHP", "RIO", "VALE",
  // Agriculture
  "DBA", "WEAT", "CORN", "SOYB", "MOO", "ADM", "BG", "CTVA",
];

// Crypto-Related Stocks & ETFs (tradeable on Alpaca — NOT actual crypto)
const CRYPTO_STOCKS = [
  // Bitcoin ETFs & proxies
  "IBIT", "GBTC", "FBTC", "ARKB", "BITB", "HODL", "BRRR",
  // Ethereum ETFs & proxies
  "ETHA", "ETHE", "FETH",
  // Crypto miners
  "MARA", "RIOT", "CLSK", "CIFR", "HUT", "BTBT", "BITF", "HIVE", "IREN", "CORZ", "WULF",
  // Crypto exchanges & infrastructure
  "COIN", "HOOD", "MSTR", "SQ", "PYPL",
  // Blockchain / Web3
  "DAPP", "BLOK",
];

// Combined full universe (deduped)
const EXTENDED_UNIVERSE = [...new Set([
  ...NASDAQ_BLUE_CHIPS,
  ...NYSE_MAJORS,
  ...MID_CAP_GROWTH,
  ...SMALL_CAP_MOMENTUM,
  ...MEME_STOCKS,
  ...BIOTECH_CATALYSTS,
  ...MISSING_LARGE_CAPS,
  ...SECTOR_ETFS_TRADEABLE,
  ...COMMODITIES,
  ...CRYPTO_STOCKS,
])];

// LITE UNIVERSE: Top 150 most liquid stocks for Supabase Edge Function limits
// These are the stocks most likely to produce $500/day in quick trades
const FULL_UNIVERSE = [
  // Mega-caps & high-volume (most liquid = best for scalping)
  "AAPL", "MSFT", "AMZN", "GOOGL", "META", "NVDA", "TSLA", "AMD", "AVGO", "CRM",
  "NFLX", "ADBE", "INTC", "CSCO", "QCOM", "MU", "AMAT", "LRCX", "KLAC", "MRVL",
  "PANW", "CRWD", "SNOW", "DDOG", "NET", "ZS", "FTNT", "PLTR", "SMCI", "ARM",
  // Finance & industrials
  "JPM", "BAC", "GS", "MS", "WFC", "V", "MA", "AXP", "C", "BX",
  "CAT", "DE", "GE", "HON", "UNP", "RTX", "LMT", "BA", "MMM", "UPS",
  // Healthcare & biotech
  "UNH", "JNJ", "LLY", "PFE", "ABBV", "MRK", "TMO", "ABT", "AMGN", "GILD",
  "MRNA", "BNTX", "REGN", "VRTX", "ISRG",
  // Consumer & retail
  "WMT", "COST", "HD", "TGT", "NKE", "SBUX", "MCD", "DIS", "ABNB", "BKNG",
  // Energy & commodities
  "XOM", "CVX", "COP", "SLB", "OXY", "GLD", "SLV", "USO", "FCX", "VALE",
  // Meme & momentum favorites
  "GME", "AMC", "RIVN", "LCID", "SOFI", "HOOD", "RKLB", "IONQ", "RGTI", "MARA",
  // Crypto proxies
  "COIN", "MSTR", "RIOT", "CLSK", "IBIT", "ETHA",
  // ETFs (sector rotation)
  "SPY", "QQQ", "IWM", "DIA", "XLF", "XLE", "XLK", "XLV", "XBI", "SMH", "ARKK",
  // Volatility plays — UVIX excluded (too volatile)
  // Small-cap momentum
  "PLUG", "FCEL", "SPCE", "OPEN", "CLOV",
  // ── Leveraged & Inverse ETFs (high-vol day-trade plays) ─────────────────────
  // 3x Leveraged Bull
  "TQQQ", "UPRO", "SPXL", "TECL", "SOXL", "FNGU", "LABU", "TNA", "FAS", "CURE",
  "NAIL", "DPST", "DFEN", "DUSL", "MIDU", "WANT", "HIBL", "BULZ", "PILL", "RETL",
  // 3x Leveraged Bear / Inverse
  "SQQQ", "SPXU", "SPXS", "TECS", "SOXS", "FNGD", "LABD", "TZA", "FAZ", "SDOW",
  "SRTY", "YANG", "ERY", "DRIP", "WEBS", "HIBS",
  // 2x Leveraged Bull
  "QLD", "SSO", "UWM", "UYG", "ROM", "UCC", "MVV",
  // 2x Leveraged Bear / Inverse
  "QID", "SDS", "SDD", "TWM", "SKF", "MZZ",
  // 2x Single-Stock ETFs (high beta plays)
  "NVDL", "NVDD", "TSLL", "TSLS", "AMDL", "AMZL", "MSFL", "GOOX", "CONL",
  // Volatility products — ALL VIX-based ETFs excluded
];

// ── BLACKLIST: Empty — leveraged/inverse ETFs now in FULL_UNIVERSE ────────────
const BLACKLISTED_TICKERS = new Set<string>([]);

// ── LEVERAGED ETF CLASSIFICATION (for correlation guard & intraday rules) ────
const LEVERAGED_BULL_ETFS = new Set([
  "TQQQ", "UPRO", "SPXL", "TECL", "SOXL", "FNGU", "LABU", "TNA", "FAS", "CURE",
  "NAIL", "DPST", "DFEN", "DUSL", "MIDU", "WANT", "HIBL", "BULZ", "PILL", "RETL",
  "QLD", "SSO", "UWM", "UYG", "ROM", "UCC", "MVV",
  "NVDL", "TSLL", "AMDL", "AMZL", "MSFL", "GOOX", "CONL",
]);
const LEVERAGED_BEAR_ETFS = new Set([
  "SQQQ", "SPXU", "SPXS", "TECS", "SOXS", "FNGD", "LABD", "TZA", "FAZ", "SDOW",
  "SRTY", "YANG", "ERY", "DRIP", "WEBS", "HIBS",
  "QID", "SDS", "SDD", "TWM", "SKF", "MZZ",
  "NVDD", "TSLS",
]);
const VOLATILITY_ETFS = new Set(["UVXY", "SVXY", "VXX", "VIXY", "SVOL", "UVIX"]);
const ALL_LEVERAGED_ETFS = new Set([...LEVERAGED_BULL_ETFS, ...LEVERAGED_BEAR_ETFS, ...VOLATILITY_ETFS]);

// Correlation guard limits — prevent concentrated directional bets
const MAX_LEVERAGED_BULL_POSITIONS = 2;
const MAX_LEVERAGED_BEAR_POSITIONS = 1;
const MAX_VOLATILITY_POSITIONS = 1;
const MAX_TOTAL_LEVERAGED_POSITIONS = 3;

// Opposing leveraged ETF pairs - block buying one side while holding the other
const LEVERAGED_INVERSE_PAIRS: [string, string][] = [
  ["SOXL", "SOXS"],   // semiconductors
  ["TQQQ", "SQQQ"],   // Nasdaq 100
  ["UPRO", "SPXU"],   // S&P 500 3x
  ["SPXL", "SPXS"],   // S&P 500 3x (alt)
  ["TECL", "TECS"],   // technology
  ["FNGU", "FNGD"],   // FANG+
  ["LABU", "LABD"],   // biotech
  ["TNA", "TZA"],     // small cap
  ["FAS", "FAZ"],     // financials
  ["QLD", "QID"],     // Nasdaq 2x
  ["SSO", "SDS"],     // S&P 500 2x
  ["NVDL", "NVDD"],   // NVIDIA
  ["TSLL", "TSLS"],   // Tesla
];

function checkCorrelationGuard(
  symbol: string,
  heldPositions: Record<string, unknown>[],
): { allowed: boolean; reason: string } {
  if (!ALL_LEVERAGED_ETFS.has(symbol)) return { allowed: true, reason: "" };

  const heldSymbols = heldPositions.map(p => p.symbol as string);

  // Block opposing pairs - never hold bull + bear of same sector
  for (const [bull, bear] of LEVERAGED_INVERSE_PAIRS) {
    if (symbol === bear && heldSymbols.includes(bull)) {
      return { allowed: false, reason: `Cannot buy ${bear} (bear) while holding ${bull} (bull) - opposing pair` };
    }
    if (symbol === bull && heldSymbols.includes(bear)) {
      return { allowed: false, reason: `Cannot buy ${bull} (bull) while holding ${bear} (bear) - opposing pair` };
    }
  }

  const heldBull = heldSymbols.filter(s => LEVERAGED_BULL_ETFS.has(s)).length;
  const heldBear = heldSymbols.filter(s => LEVERAGED_BEAR_ETFS.has(s)).length;
  const heldVol = heldSymbols.filter(s => VOLATILITY_ETFS.has(s)).length;
  const heldLevTotal = heldSymbols.filter(s => ALL_LEVERAGED_ETFS.has(s)).length;

  if (heldLevTotal >= MAX_TOTAL_LEVERAGED_POSITIONS) {
    return { allowed: false, reason: `Max ${MAX_TOTAL_LEVERAGED_POSITIONS} total leveraged positions reached (holding ${heldLevTotal})` };
  }
  if (LEVERAGED_BULL_ETFS.has(symbol) && heldBull >= MAX_LEVERAGED_BULL_POSITIONS) {
    return { allowed: false, reason: `Max ${MAX_LEVERAGED_BULL_POSITIONS} leveraged bull positions reached (holding ${heldBull})` };
  }
  if (LEVERAGED_BEAR_ETFS.has(symbol) && heldBear >= MAX_LEVERAGED_BEAR_POSITIONS) {
    return { allowed: false, reason: `Max ${MAX_LEVERAGED_BEAR_POSITIONS} leveraged bear positions reached (holding ${heldBear})` };
  }
  if (VOLATILITY_ETFS.has(symbol) && heldVol >= MAX_VOLATILITY_POSITIONS) {
    return { allowed: false, reason: `Max ${MAX_VOLATILITY_POSITIONS} volatility positions reached (holding ${heldVol})` };
  }
  return { allowed: true, reason: "" };
}

// Fetch Alpaca snapshots in bulk — returns price change %, volume, and latest price
// for up to 200 symbols at once (Alpaca's limit per request)
type SnapshotData = {
  symbol: string;
  price: number;
  change_pct: number;
  volume: number;
  prev_close: number;
};

async function fetchSnapshots(symbols: string[]): Promise<SnapshotData[]> {
  const results: SnapshotData[] = [];
  // Alpaca supports up to ~200 symbols per snapshot request
  const batchSize = 100;
  const batches: string[][] = [];
  for (let i = 0; i < symbols.length; i += batchSize) {
    batches.push(symbols.slice(i, i + batchSize));
  }

  await Promise.all(batches.map(async (batch) => {
    try {
      const symbolsParam = batch.join(",");
      const res = await withRetry(() => fetchWithTimeout(
        `${ALPACA_DATA_URL}/stocks/snapshots?symbols=${symbolsParam}&feed=iex`,
        { headers: alpacaHeaders },
        15000  // 15s timeout for bulk snapshots
      ));
      if (!res.ok) {
        console.error(`Snapshot batch HTTP ${res.status}: ${await res.text().catch(() => "no body")}`);
        return;
      }
      const data = await res.json();
      console.log(`Snapshot batch: ${batch.length} requested, ${Object.keys(data ?? {}).length} returned`);
      for (const [sym, snap] of Object.entries(data ?? {})) {
        const s = snap as Record<string, Record<string, number>>;
        const dailyBar = s.dailyBar;
        const prevDailyBar = s.prevDailyBar;
        if (dailyBar && prevDailyBar) {
          const price = dailyBar.c;
          const prevClose = prevDailyBar.c;
          const changePct = prevClose > 0 ? +((price - prevClose) / prevClose * 100).toFixed(2) : 0;
          results.push({
            symbol: sym,
            price,
            change_pct: changePct,
            volume: dailyBar.v ?? 0,
            prev_close: prevClose,
          });
        }
      }
    } catch (err) {
      console.error(`Snapshot batch failed:`, String(err));
    }
  }));

  return results;
}

// Fetch Alpaca most-actives (top movers by volume today)
async function fetchMostActives(top = 20): Promise<string[]> {
  try {
    const res = await withRetry(() => fetchWithTimeout(
      `https://data.alpaca.markets/v1beta1/screener/stocks/most-actives?top=${top}&by=volume`,
      { headers: alpacaHeaders }
    ));
    const data = await res.json();
    return (data?.most_actives ?? []).map((s: Record<string, string>) => s.symbol).filter(Boolean);
  } catch {
    return [];
  }
}

// Fetch Alpaca top movers (biggest gainers + losers)
async function fetchTopMovers(top = 10): Promise<{ gainers: string[]; losers: string[] }> {
  try {
    const res = await withRetry(() => fetchWithTimeout(
      `https://data.alpaca.markets/v1beta1/screener/stocks/movers?top=${top}`,
      { headers: alpacaHeaders }
    ));
    const data = await res.json();
    const gainers = (data?.gainers ?? []).map((s: Record<string, string>) => s.symbol);
    const losers = (data?.losers ?? []).map((s: Record<string, string>) => s.symbol);
    return { gainers, losers };
  } catch {
    return { gainers: [], losers: [] };
  }
}

// Pre-screen the universe: filter for stocks showing momentum, unusual volume, or big moves
function preScreenSymbols(snapshots: SnapshotData[]): {
  momentum: string[];
  volumeSpikes: string[];
  gappers: string[];
  oversold: string[];
} {
  // Sort by absolute change for momentum
  const sorted = [...snapshots].sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct));

  // Momentum: top 15 biggest movers (up or down) with decent volume
  const momentum = sorted
    .filter(s => s.volume > 100_000)
    .slice(0, 15)
    .map(s => s.symbol);

  // Volume spikes: average daily volume is hard to know from snapshots,
  // so we pick top 15 by raw volume today
  const byVolume = [...snapshots].sort((a, b) => b.volume - a.volume);
  const volumeSpikes = byVolume.slice(0, 15).map(s => s.symbol);

  // Gappers: stocks that opened above/below yesterday's close (lowered to 2% for more candidates)
  const gappers = snapshots
    .filter(s => Math.abs(s.change_pct) > 2 && s.volume > 300_000)
    .sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct))
    .slice(0, 15)
    .map(s => s.symbol);

  // Potential oversold bounces: down more than 3% today with volume (mean-reversion plays)
  const oversold = snapshots
    .filter(s => s.change_pct < -3 && s.volume > 300_000)
    .sort((a, b) => a.change_pct - b.change_pct)
    .slice(0, 8)
    .map(s => s.symbol);

  return { momentum, volumeSpikes, gappers, oversold };
}

// ── HOT LIST: Top 20 movers ranked by momentum score ─────────────────────────
// Focuses the bot on the stocks most likely to produce $500/day in profits.
// Score = |change%| × log10(volume) × (volume_spike ? 2 : 1)
function buildHotList(snapshots: SnapshotData[], maxItems = 25): { symbols: string[]; summary: string } {
  const { mode } = getCurrentTradingMode();

  const scored = snapshots
    .filter(s =>
      s.price >= 5 &&           // no penny stocks (too risky, wide spreads)
      s.price <= 500 &&         // avoid ultra-high-priced stocks (small qty = less flexibility)
      s.volume > 100_000 &&     // decent liquidity (lowered for more candidates)
      !BLACKLISTED_TICKERS.has(s.symbol) &&
      Math.abs(s.change_pct) >= 0.3  // must be moving at least 0.3% (lowered)
    )
    .map(s => {
      // Score = movement × liquidity × bonuses
      let score = Math.abs(s.change_pct) * Math.log10(Math.max(s.volume, 1));

      // Bonus for high volume (institutional activity)
      if (s.volume > 5_000_000) score *= 2;
      else if (s.volume > 2_000_000) score *= 1.5;

      // In SCALP mode, bonus for mid-price stocks ($10-100) — easiest to scalp
      if (mode === "SCALP" && s.price >= 10 && s.price <= 100) score *= 1.3;

      // Penalty for stocks barely moving (noise)
      if (Math.abs(s.change_pct) < 1) score *= 0.5;

      return { ...s, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxItems);

  const symbols = scored.map(s => s.symbol);
  const summary = scored.map(s =>
    `${s.symbol}: $${s.price.toFixed(2)} (${s.change_pct > 0 ? "+" : ""}${s.change_pct}%) vol=${(s.volume / 1_000_000).toFixed(1)}M score=${s.score.toFixed(1)}`
  ).join("\n");

  console.log(`🔥 HOT LIST (${symbols.length}): ${symbols.join(", ")}`);
  return { symbols, summary };
}

// ══════════════════════════════════════════════════════════════════════════════
// ── QUANT SCORING ENGINE — Replaces Grok as primary stock picker ─────────────
// Scores each stock on 0-100 scale using pure math. No LLM needed.
// Score = momentum + volume + RSI signal + MACD signal + pattern + social buzz
// ══════════════════════════════════════════════════════════════════════════════

type QuantScore = {
  symbol: string;
  score: number;          // 0-100 composite
  momentum: number;       // price movement score
  volumeScore: number;    // volume spike score
  rsiSignal: number;      // oversold bounce / momentum
  macdSignal: number;     // trend direction
  patternScore: number;   // chart pattern breakout
  socialBuzz: number;     // Reddit/WSB mentions
  optionsFlow: number;    // unusual options activity
  reason: string;         // human-readable explanation
  suggestedQty: number;   // position size
  suggestedStop: number;  // stop-loss %
};

function quantScore(
  tech: TechData & { symbol: string },
  snapshot: SnapshotData | undefined,
  socialData: { mentions: number; sentiment: string } | undefined,
  optionsSignal: number, // -1 to +1 from options flow
  equity: number,
): QuantScore {
  const reasons: string[] = [];
  let score = 0;

  // 1. MOMENTUM (0-25 pts) — price change × direction
  const changePct = snapshot?.change_pct ?? tech.change_pct;
  const absChange = Math.abs(changePct);
  let momentum = 0;
  if (changePct > 0) {
    // Bullish momentum — sweet spot is 1-5% (too much = overextended)
    if (absChange >= 1 && absChange <= 5) momentum = Math.min(25, absChange * 5);
    else if (absChange > 5) momentum = 15; // overextended, reduced score
    else momentum = absChange * 8; // small move, modest score
    reasons.push(`📈 +${changePct.toFixed(1)}%`);
  } else if (changePct < -3 && tech.rsi14 !== null && tech.rsi14 < 35) {
    // Oversold bounce play
    momentum = 15;
    reasons.push(`🔄 oversold bounce (RSI=${tech.rsi14})`);
  }
  score += momentum;

  // 2. VOLUME (0-20 pts) — higher volume = more conviction
  let volumeScore = 0;
  const volProfile = tech.volume_profile;
  if (volProfile.volume_ratio !== null) {
    if (volProfile.volume_ratio > 3) { volumeScore = 20; reasons.push(`🔊 ${volProfile.volume_ratio.toFixed(1)}× vol`); }
    else if (volProfile.volume_ratio > 2) { volumeScore = 15; reasons.push(`📊 ${volProfile.volume_ratio.toFixed(1)}× vol`); }
    else if (volProfile.volume_ratio > 1.5) { volumeScore = 10; }
    else if (volProfile.volume_ratio > 1) { volumeScore = 5; }
  } else if (snapshot && snapshot.volume > 2_000_000) {
    volumeScore = 10;
  }
  // Institutional accumulation bonus
  if (volProfile.institutional_signal === "accumulation") {
    volumeScore += 5;
    reasons.push("🏦 accumulation");
  }
  score += Math.min(20, volumeScore);

  // 3. RSI SIGNAL (0-15 pts)
  let rsiSignal = 0;
  if (tech.rsi14 !== null) {
    if (tech.rsi14 < 30) { rsiSignal = 15; reasons.push(`RSI=${tech.rsi14} deeply oversold`); } // sweet spot — momentum without overextension
    else if (tech.rsi14 >= 30 && tech.rsi14 < 35) { rsiSignal = 12; reasons.push(`RSI=${tech.rsi14} oversold`); } // oversold bounce
    else if (tech.rsi14 >= 35 && tech.rsi14 < 40) { rsiSignal = 10; } else if (tech.rsi14 >= 40 && tech.rsi14 <= 65) { rsiSignal = 15; }
    else if (tech.rsi14 > 65 && tech.rsi14 <= 75) { rsiSignal = 3; } // momentum but stretched
    else if (tech.rsi14 > 75) { rsiSignal = 0; } // overbought — skip
  }
  score += rsiSignal;

  // 4. MACD SIGNAL (0-10 pts)
  let macdSignal = 0;
  if (tech.macd_hist !== null) {
    if (tech.macd_hist > 0 && tech.macd !== null && tech.macd > 0) {
      macdSignal = 10; // bullish and accelerating
      reasons.push("MACD bullish");
    } else if (tech.macd_hist > 0) {
      macdSignal = 5; // hist positive but MACD still negative (early)
    }
  }
  score += macdSignal;

  // 5. PATTERN BREAKOUT (0-15 pts)
  let patternScore = 0;
  const bullishPatterns = tech.patterns.filter(p =>
    p.type === "bullish" && p.confidence > 50
  );
  if (bullishPatterns.length > 0) {
    const best = bullishPatterns.sort((a, b) => b.confidence - a.confidence)[0];
    if (best.status === "confirmed") {
      patternScore = 15;
      reasons.push(`✅ ${best.name} confirmed (${best.confidence}%)`);
    } else {
      patternScore = Math.min(10, Math.floor(best.confidence / 10));
      reasons.push(`📐 ${best.name} (${best.confidence}%)`);
    }
  }
  score += patternScore;

  // 6. SOCIAL BUZZ (0-10 pts)
  let socialBuzz = 0;
  if (socialData && socialData.mentions > 5) {
    if (socialData.sentiment === "bullish" || socialData.sentiment === "Bullish") {
      socialBuzz = Math.min(10, Math.floor(socialData.mentions / 5));
      if (socialData.mentions > 50) reasons.push(`🦍 ${socialData.mentions} Reddit mentions`);
    } else if (socialData.mentions > 20) {
      socialBuzz = 3; // high buzz but not bullish
    }
  }
  score += socialBuzz;

  // 7. OPTIONS FLOW (0-10 pts)
  let optionsFlowScore = 0;
  if (optionsSignal > 0.5) {
    optionsFlowScore = 10;
    reasons.push("🐋 bullish options flow");
  } else if (optionsSignal > 0.2) {
    optionsFlowScore = 5;
  } else if (optionsSignal < -0.5) {
    score -= 10; // bearish options = penalty
    reasons.push("⚠️ bearish options flow");
  }
  score += optionsFlowScore;

  // PRICE FILTER — skip penny stocks and ultra-expensive
  if (tech.price < 5 || tech.price > 500) score = 0;

  // VWAP CHECK — prefer stocks above VWAP (bullish intraday bias)
  if (tech.vwap && tech.price > tech.vwap) {
    score += 3;
    reasons.push("above VWAP");
  }

  // SMA TREND — price above SMA20 > SMA50 = strong uptrend
  if (tech.sma20 && tech.sma50 && tech.price > tech.sma20 && tech.sma20 > tech.sma50) {
    score += 3;
  }

  // Clamp to 0-100
  score = Math.max(0, Math.min(100, score));

  // Position sizing — cap at 20% per position (backtest-proven optimal)
  const riskPct = Math.min(0.20, score >= 70 ? 0.20 : score >= 50 ? 0.15 : 0.10);
  const targetValue = equity * riskPct;
  const suggestedQty = tech.price > 0 ? Math.max(1, Math.floor(targetValue / tech.price)) : 0;
  const suggestedStop = tech.atr14 ? Math.min(0.05, Math.max(0.015, (tech.atr14 * 1.5) / tech.price)) : 0.025;

  return {
    symbol: tech.symbol,
    score,
    momentum,
    volumeScore: Math.min(20, volumeScore),
    rsiSignal,
    macdSignal,
    patternScore,
    socialBuzz,
    optionsFlow: optionsFlowScore,
    reason: reasons.length > 0 ? reasons.join(" | ") : "weak signals",
    suggestedQty,
    suggestedStop,
  };
}

// ── Unusual Whales Options Flow API ──────────────────────────────────────────
// Returns options flow signal per symbol: +1 = heavy call buying, -1 = heavy put buying
async function getOptionsFlow(symbols: string[]): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  try {
    // Unusual Whales free tier: flow summary endpoint
    const res = await fetchWithTimeout(
      "https://phx.unusualwhales.com/api/option_trades/flow_summary",
      {}, 5000
    );
    if (res.ok) {
      const data = await res.json();
      const flows = data?.data ?? [];
      for (const flow of flows) {
        if (symbols.includes(flow.ticker)) {
          // Ratio of calls vs puts — >0.6 = bullish, <0.4 = bearish
          const callRatio = flow.call_premium / (flow.call_premium + flow.put_premium + 1);
          result[flow.ticker] = (callRatio - 0.5) * 2; // normalize to -1..+1
        }
      }
    }
  } catch {
    // Options flow is optional — don't break the bot
    console.log("Options flow API unavailable — skipping");
  }
  // Fallback: try Alpaca options data for missing symbols
  for (const sym of symbols) {
    if (result[sym] === undefined) result[sym] = 0;
  }
  return result;
}

// ── QUANT PICK: Score all candidates, return top N buy decisions ──────────────
function quantPick(
  marketData: Record<string, { tech: TechData & { symbol: string }; news: string[] }>,
  snapshots: SnapshotData[],
  socialData: Array<{ symbol: string; mentions: number; sentiment: string }>,
  optionsFlow: Record<string, number>,
  heldSymbols: Set<string>,
  cooldownSymbols: Set<string>,
  equity: number,
  maxPicks = 8,
): { decisions: Array<{ action: string; symbol: string; quantity: number; reason: string }>; scores: QuantScore[] } {
  const snapshotMap = new Map(snapshots.map(s => [s.symbol, s]));
  const socialMap = new Map(socialData.map(s => [s.symbol, s]));

  // Score every stock with market data
  const allScores: QuantScore[] = [];
  for (const [sym, data] of Object.entries(marketData)) {
    if (heldSymbols.has(sym)) continue;       // skip already held
    if (cooldownSymbols.has(sym)) continue;   // skip recently sold
    if (BLACKLISTED_TICKERS.has(sym)) continue;
    // Crash filter
    const snap = snapshotMap.get(sym);
    if (snap && snap.change_pct < -10) continue;

    const scored = quantScore(
      data.tech,
      snap,
      socialMap.get(sym),
      optionsFlow[sym] ?? 0,
      equity,
    );
    allScores.push(scored);
  }

  // Sort by score descending — top scores get bought
  allScores.sort((a, b) => b.score - a.score);

  // Minimum score threshold: backtest-proven optimal — more trades = more edge
  const MIN_SCORE = 28;  // Config C: very low bar — take more trades for higher volume
  const topPicks = allScores.filter(s => s.score >= MIN_SCORE).slice(0, maxPicks);

  console.log(`🧮 QUANT SCORES (top 10): ${allScores.slice(0, 10).map(s => `${s.symbol}=${s.score}`).join(", ")}`);
  console.log(`🎯 QUANT PICKS (${topPicks.length}): ${topPicks.map(s => `${s.symbol}(${s.score}pts)`).join(", ")}`);

  const decisions = topPicks.map(pick => ({
    action: "BUY" as const,
    symbol: pick.symbol,
    quantity: pick.suggestedQty,
    reason: `🧮 QUANT SCORE ${pick.score}/100: ${pick.reason} | stop=${(pick.suggestedStop * 100).toFixed(1)}%`,
  }));

  return { decisions, scores: allScores };
}

async function discoverSymbols(
  positions: unknown[],
  history: unknown[],
  lastAnalysis: string | null
): Promise<{ symbols: string[]; hotList: { symbols: string[]; summary: string }; allSnapshots: SnapshotData[] }> {
  const openSymbols = (positions as Record<string, string>[]).map((p) => p.symbol);

  // STEP 1: Scan the full universe + social sentiment in parallel
  console.log(`Scanning ${FULL_UNIVERSE.length} stocks across NASDAQ + NYSE...`);
  const [snapshots, mostActives, topMovers, wsbTrending, highSI] = await Promise.all([
    fetchSnapshots(FULL_UNIVERSE),
    fetchMostActives(20),
    fetchTopMovers(10),
    getWsbTrending(),
    getHighShortInterest(),
  ]);

  // Extract WSB trending symbols (top 10 most mentioned)
  const wsbSymbols = wsbTrending
    .filter(s => /^[A-Z]{1,5}$/.test(s.symbol))
    .slice(0, 10)
    .map(s => s.symbol);

  // High short interest symbols (squeeze candidates)
  const shortSqueezeSymbols = highSI
    .filter(s => /^[A-Z]{1,5}$/.test(s.symbol))
    .slice(0, 5)
    .map(s => s.symbol);

  // Find WSB + high SI overlap = 🚀 prime squeeze candidates
  const squeezeOverlap = wsbSymbols.filter(s => shortSqueezeSymbols.includes(s));
  if (squeezeOverlap.length > 0) {
    console.log(`🚀 SQUEEZE ALERT: ${squeezeOverlap.join(", ")} — trending on WSB AND high short interest!`);
  }

  console.log(`Got ${snapshots.length} snapshots, ${mostActives.length} most-actives, ${topMovers.gainers.length} gainers, ${topMovers.losers.length} losers, ${wsbSymbols.length} WSB, ${shortSqueezeSymbols.length} high-SI`);

  // Fetch snapshots for non-universe stocks (WSB + short squeeze)
  const extraSymbols = [...new Set([...wsbSymbols, ...shortSqueezeSymbols])];
  const missingExtras = extraSymbols.filter(s => !FULL_UNIVERSE.includes(s));
  let extraSnapshots: SnapshotData[] = [];
  if (missingExtras.length > 0) {
    extraSnapshots = await fetchSnapshots(missingExtras);
    console.log(`Fetched ${extraSnapshots.length} extra snapshots for: ${missingExtras.join(", ")}`);
  }
  const allSnapshots = [...snapshots, ...extraSnapshots];

  // STEP 2: Pre-screen for interesting candidates
  const screened = preScreenSymbols(allSnapshots);

  // STEP 2.5: Build HOT LIST — top 20 by momentum score
  const hotList = buildHotList(allSnapshots, 20);

  // Combine all candidates (deduped)
  const allCandidates = [...new Set([
    ...openSymbols,                // always include current positions
    ...hotList.symbols,            // 🔥 HOT LIST — highest momentum score
    ...screened.momentum,          // biggest movers in our universe
    ...screened.volumeSpikes,      // highest volume today
    ...screened.gappers,           // gap up/down > 3%
    ...screened.oversold,          // mean-reversion plays
    ...mostActives,                // Alpaca most-actives (may include stocks outside our universe)
    ...topMovers.gainers,          // top gainers market-wide
    ...topMovers.losers,           // top losers (potential shorts or bounces)
    ...wsbSymbols,                 // WSB trending stocks (retail momentum)
    ...shortSqueezeSymbols,        // high short interest (squeeze candidates)
  ])];

  // Build a summary of the scan for Grok
  const scanSummary = allSnapshots
    .filter(s => allCandidates.includes(s.symbol))
    .sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct))
    .slice(0, 50)
    .map(s => `${s.symbol}: $${s.price.toFixed(2)} (${s.change_pct > 0 ? "+" : ""}${s.change_pct}%) vol=${(s.volume / 1000).toFixed(0)}K`)
    .join("\n");

  // WSB summary for Grok
  const wsbSummary = wsbTrending.slice(0, 10)
    .map(s => `${s.symbol}: ${s.mentions} mentions [${s.source}] — ${s.sentiment}`)
    .join("\n");

  // STEP 3: Skip Grok discovery (saves compute) — use hot list + pre-screened directly
  // Pick top 10 from hot list + all open positions + squeeze candidates
  const finalSymbols = [...new Set([
    ...openSymbols,                          // always include held positions
    ...hotList.symbols.slice(0, 10),         // top 10 from hot list
    ...screened.momentum.slice(0, 5),        // top 5 momentum
    ...screened.gappers.slice(0, 3),         // top 3 gappers
    ...(squeezeOverlap.length ? squeezeOverlap : shortSqueezeSymbols.slice(0, 2)), // squeeze plays
    ...wsbSymbols.slice(0, 3),               // top 3 WSB trending
  ])].slice(0, 20); // cap at 20 to stay within compute limits

  console.log(`Discovery complete (LITE): ${finalSymbols.length} symbols — ${finalSymbols.join(", ")}`);
  return { symbols: finalSymbols, hotList, allSnapshots };
}

function getCurrentWeekDeadline(): Date {
  // Get current time in ET (handles EST/EDT automatically)
  const now = new Date();
  const etStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const etNow = new Date(etStr);
  const etDay = etNow.getDay();

  // Find next Friday 4:00 PM ET
  const daysUntilFriday = ((5 - etDay) + 7) % 7;
  const friday = new Date(now);
  friday.setTime(now.getTime() + daysUntilFriday * 24 * 60 * 60 * 1000);
  // Set to 4:00 PM ET by converting ET target back to UTC
  const fridayEtStr = friday.toLocaleString("en-US", { timeZone: "America/New_York" });
  const fridayEt = new Date(fridayEtStr);
  fridayEt.setHours(16, 0, 0, 0); // 4:00 PM ET
  // Calculate UTC offset from ET
  const etOffset = friday.getTime() - new Date(fridayEtStr).getTime();
  const deadline = new Date(fridayEt.getTime() + etOffset);
  if (deadline <= now) deadline.setTime(deadline.getTime() + 7 * 24 * 60 * 60 * 1000);
  return deadline;
}

function estimateRemainingCycles(now: Date, deadline: Date): number {
  // Use America/New_York timezone to handle EST/EDT automatically
  // Market hours: 9:30 AM - 4:00 PM ET (regardless of DST)
  let remaining = 0;
  const cursor = new Date(now);
  while (cursor < deadline) {
    const etStr = cursor.toLocaleString("en-US", { timeZone: "America/New_York" });
    const et = new Date(etStr);
    const day = et.getDay();
    if (day !== 0 && day !== 6) {
      const etMinutes = et.getHours() * 60 + et.getMinutes();
      const MARKET_OPEN_ET = 9 * 60 + 30;  // 9:30 AM ET
      const MARKET_CLOSE_ET = 16 * 60;      // 4:00 PM ET
      if (etMinutes >= MARKET_OPEN_ET && etMinutes < MARKET_CLOSE_ET) {
        remaining += 10;
      }
    }
    cursor.setTime(cursor.getTime() + 10 * 60 * 1000);
  }
  return Math.floor(remaining / 10);
}

async function makeDecision(
  account: Record<string, unknown>,
  positions: unknown[],
  history: unknown[],
  marketData: Record<string, { tech: TechData & { symbol: string }; news: string[] }>,
  lastAnalysis: string | null,
  cycleCount: number,
  latestMetrics: string | null = null,
  enrichment: EnrichmentData | null = null,
  todayPnl = 0,
  hitDailyTarget = false,
  hotList: { symbols: string[]; summary: string } = { symbols: [], summary: "" },
) {
  const { mode: tradingMode, label: tradingModeLabel } = getCurrentTradingMode();
  const currentEquity = parseFloat(String(account.equity));
  const marketSummary = Object.entries(marketData)
    .map(([sym, { tech, news }]) => {
      let block =
        `### ${sym}: $${tech.price} (${tech.change_pct > 0 ? "+" : ""}${tech.change_pct}%)\n` +
        `  Indicators: SMA20=${tech.sma20 ?? "N/A"} SMA50=${tech.sma50 ?? "N/A"} | RSI=${tech.rsi14 ?? "N/A"} | MACD=${tech.macd ?? "N/A"} Hist=${tech.macd_hist ?? "N/A"} | ATR=${tech.atr14 ?? "N/A"}\n` +
        `  Bollinger: ${tech.bb_lower ?? "N/A"} / ${tech.bb_upper ?? "N/A"} (${tech.bb_pct != null ? (tech.bb_pct * 100).toFixed(0) + "%" : "N/A"}) | VWAP: ${tech.vwap ?? "N/A"}`;

      // Volume profile
      const vp = tech.volume_profile;
      block += `\n  Volume: ${tech.volume?.toLocaleString()} (${vp.volume_ratio ?? "?"}× avg) | OBV: ${vp.obv_trend ?? "N/A"}`;
      if (vp.institutional_signal) block += `\n  ⚡ ORDER FLOW: ${vp.institutional_signal}`;

      // Chart patterns
      if (tech.patterns.length > 0) {
        block += `\n  📊 PATTERNS:`;
        for (const p of tech.patterns) {
          block += `\n    → ${p.name.toUpperCase()} (${p.direction}, ${(p.confidence * 100).toFixed(0)}% conf): ${p.description}`;
        }
      }

      // Multi-timeframe
      if (tech.mtf) {
        block += `\n  🔍 MULTI-TF: ${tech.mtf.summary}`;
      }

      // Sector
      if (tech.sector.sector) {
        block += `\n  🏢 Sector: ${tech.sector.sector} (${tech.sector.sector_performance != null ? (tech.sector.sector_performance > 0 ? "+" : "") + tech.sector.sector_performance + "%" : "N/A"}) | Relative Strength: ${tech.sector.relative_strength ?? "N/A"}`;
      }

      // Finnhub sentiment & news
      const fhSent = enrichment?.finnhubSentiment?.[sym];
      if (fhSent && fhSent.sentiment > 0) {
        block += `\n  📰 Sentiment: ${(fhSent.sentiment * 100).toFixed(0)}% bullish | Buzz: ${fhSent.buzz.toFixed(1)}×`;
        if (fhSent.headlines.length > 0) block += `\n  Headlines: ${fhSent.headlines.join(" | ")}`;
      } else {
        block += `\n  News: ${news.length ? news.slice(0, 3).join(" | ") : "aucune"}`;
      }

      // Insider trades
      const insider = enrichment?.insiderTrades?.[sym];
      if (insider && insider.length > 0) {
        block += `\n  🔑 INSIDER: ${insider.join(" | ")}`;
      }

      // Earnings warning
      const earningsDate = enrichment?.earnings?.[sym];
      if (earningsDate) {
        block += `\n  ⚠️ EARNINGS: ${earningsDate}`;
      }

      return block;
    })
    .join("\n\n");

  const now = new Date();
  const DEADLINE = getCurrentWeekDeadline();
  const hoursLeft = Math.max(0, Math.floor((DEADLINE.getTime() - now.getTime()) / (1000 * 60 * 60)));
  const cyclesLeft = estimateRemainingCycles(now, DEADLINE);

  // Market timing context
  const etHour = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" })).getHours();
  const etMin = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" })).getMinutes();
  const etTime = etHour + etMin / 60;
  let marketPhase = "Mid-Day (normal)";
  if (etTime >= 9.5 && etTime < 10) marketPhase = "🔥 OPEN RUSH (9:30-10:00 ET) — highest volatility, big gaps, momentum trades";
  else if (etTime >= 10 && etTime < 10.5) marketPhase = "Opening Continuation (10:00-10:30 ET) — trends establishing";
  else if (etTime >= 10.5 && etTime < 12) marketPhase = "Late Morning (10:30-12:00 ET) — good momentum setups";
  else if (etTime >= 12 && etTime < 14) marketPhase = "⚠️ Lunch Lull (12:00-2:00 ET) — low volume, choppy, avoid new entries";
  else if (etTime >= 14 && etTime < 15.5) marketPhase = "Afternoon Recovery (2:00-3:30 ET) — volume returns, trends resume";
  else if (etTime >= 15.5 && etTime < 16) marketPhase = "🔥 POWER HOUR (3:30-4:00 ET) — MAXIMUM volume, institutional positioning, biggest moves";

  const systemPrompt = `Tu es le moteur de décision d'un bot de trading autonome opérant sur les marchés américains.

## Comment tu fonctionnes
Toutes les 10 minutes pendant les heures de marché, tu reçois l'état complet du portfolio et les données de marché en temps réel.

## Ton objectif PRIMAIRE
🎯 **GAGNER $500 PAR JOUR MINIMUM** sur un portfolio de ~$100K. C'est 0.5% par jour — agressif mais réalisable.
- À $500/jour × 252 jours de marché = $126,000/an de profits.
- Chaque cycle sans trade est $50+ de perdu. AGIS.

## MODE ACTUEL : ${tradingModeLabel}
${tradingMode === "SCALP" ? `🔥 SCALP MODE ACTIF — TRADES RAPIDES:
- Cible des gains de 0.5% à 2% par trade
- Positions plus grosses (15-25% du portfolio)
- Rentre et sors en quelques minutes
- Cherche: gaps, momentum, volume spikes
- 5-8 trades par cycle en scalp mode
- Les profits s'accumulent: 5 trades × $100 chacun = $500/jour` :
tradingMode === "MOMENTUM" ? `📈 MOMENTUM MODE ACTIF — RIDE LES TENDANCES:
- Cible des gains de 2-5% par trade
- Positions moyennes (10-20% du portfolio)
- Laisse courir les gagnants, coupe vite les perdants
- Cherche: breakouts confirmés, secteur fort, catalyst
- 3-5 trades par cycle` :
`⏸️ HOLD ONLY — PAS DE NOUVELLES ENTRÉES:
- Lunch lull, volume faible, mouvements erratiques
- Garde les positions existantes
- Ne BUY rien de nouveau (0 BUY orders)
- Peux SELL si un signal de sortie se présente`}

## Règles non négociables
1. Maximum 25% du portfolio total par position
2. Ne jamais perdre plus de 15% du portfolio initial
3. Tu DOIS placer plusieurs ordres simultanément — vise ${tradingMode === "SCALP" ? "5 à 8" : tradingMode === "MOMENTUM" ? "3 à 5" : "0"} trades par cycle
4. Maximum 50% du portfolio dans un même secteur
5. NE JAMAIS laisser plus de 30% du portfolio en cash — le cash inactif COÛTE de l'argent
6. **PRIORITÉ AUX STOCKS DU HOT LIST** — ce sont les meilleures opportunités du moment

## Comment lire les indicateurs techniques
- **RSI < 30** : survendu → signal d'achat potentiel | **RSI > 70** : suracheté → signal de vente
- **MACD Hist positif** : momentum haussier | **MACD Hist négatif** : momentum baissier
- **BB % < 10%** : prix proche bande basse (rebond) | **BB % > 90%** : proche bande haute
- **Prix > VWAP** : biais haussier intraday | **Prix < VWAP** : biais baissier
- **ATR** : volatilité; ATR élevé = risque plus important
- **SMA20 > SMA50** : tendance haussière | **SMA20 < SMA50** : tendance baissière

## Comment lire les PATTERNS (chart patterns)
Les patterns ont un score de confiance (0-100%). Priorise les patterns à haute confiance et ceux qui sont CONFIRMÉS (breakout/breakdown).
- **Double bottom / Inverse H&S / Falling wedge / Cup & Handle / Bull flag** → signaux d'ACHAT
- **Double top / H&S / Rising wedge / Bear flag** → signaux de VENTE
- Un pattern confirmé (breakout) vaut plus qu'un pattern en formation

## Comment lire l'ORDER FLOW (volume profile)
- **Volume ratio > 1.5×** : activité inhabituelle — attire l'attention
- **Volume ratio > 3×** : CLIMAX volume — souvent un signal de retournement
- **Accumulation détectée** (prix ↑ + vol élevé + OBV rising) → institutionnels achètent = BULLISH
- **Distribution détectée** (prix ↓ + vol élevé + OBV falling) → institutionnels vendent = BEARISH
- **Accumulation furtive** (prix ↓ mais OBV rising) → smart money achète les dips = BULLISH caché
- **Distribution cachée** (prix ↑ mais OBV falling) → smart money vend = BEARISH caché

## Comment lire le MULTI-TIMEFRAME
Le score de confluence va de -4 (all bearish) à +4 (all bullish).
- **Confluence ≥ +3** : FORT signal d'achat — toutes les timeframes sont alignées haussières
- **Confluence ≤ -3** : FORT signal de vente — toutes les timeframes sont alignées baissières
- **Confluence entre -1 et +1** : marché indécis — attendre ou éviter

## Comment utiliser les SECTEURS
- **Relative Strength > 1** : le titre surperforme son secteur → signe de force
- **Relative Strength < -1** : le titre sous-performe son secteur → signe de faiblesse
- Évite de concentrer le portfolio dans un seul secteur (max 50%)
- Privilégie les secteurs en momentum positif

## Comment utiliser le FEAR & GREED INDEX
- **Score 0-25 (Extreme Fear)** : Le marché a peur → OPPORTUNITÉ D'ACHAT agressif (buy the dip)
- **Score 25-45 (Fear)** : Prudence mais cherche les bargains
- **Score 45-55 (Neutral)** : Trade normalement selon les signaux techniques
- **Score 55-75 (Greed)** : Le marché est euphorique → commence à prendre des profits
- **Score 75-100 (Extreme Greed)** : DANGER → réduis les positions, prends les profits, stops serrés

## Comment utiliser le SENTIMENT FINNHUB
- **Bullish > 70%** : Sentiment très positif dans les médias → confirme les signaux d'achat
- **Bullish < 30%** : Sentiment très négatif → soit contrarian (achat), soit confirmation de vente
- **Buzz élevé (>2×)** : Stock très discuté → attention à la volatilité, bonne pour le day trading

## Comment utiliser les INSIDER TRADES
- **CEO/CFO achète** : Signal TRÈS bullish — les insiders connaissent leur entreprise
- **Multiple insiders achètent** : Signal EXTRÊMEMENT bullish
- **Insiders vendent massivement** : Signal bearish (mais les ventes sont souvent pour raisons perso)

## Comment utiliser le REDDIT/SOCIAL SENTIMENT
- **Mentions élevées + sentiment bullish** : Momentum retail, peut pousser le prix à court terme
- **Stock trending sur Reddit** : Attention à la volatilité — bon pour des trades rapides
- **Combo insider buy + Reddit buzz** : Signal très puissant
- **🚀 SPIKING** : Mentions en forte hausse (>50% en 24h) — momentum explosif, agis vite

## Comment utiliser le VIX (Volatilité)
- **VIX < 15 (Low Vol)** : Marché calme, trades directionnels fonctionnent bien, stops serrés OK
- **VIX 15-25 (Normal)** : Conditions standard, trade normalement
- **VIX 25-35 (Elevated)** : Volatilité montante — réduis taille des positions, élargis les stops
- **VIX > 35 (High/Extreme)** : Marché en panique — opportunités de rebond MAIS risque élevé, petites positions

## Comment utiliser le SHORT INTEREST
- **Short Interest > 20%** : Beaucoup de vendeurs à découvert → potentiel SHORT SQUEEZE si catalyst positif
- **Short Interest > 20% + WSB trending** : 🚀 COMBO EXPLOSIF — les shorts sont piégés, le retail pousse
- **Days to Cover > 5** : Les shorts mettront des jours à couvrir → le squeeze dure plus longtemps

## Comment utiliser les CONGRESSIONAL TRADES
- **Politician achète** : Les élus ont souvent accès à des infos non-publiques — signal d'achat fiable
- **Multiple politiciens achètent le même stock** : Signal TRÈS puissant
- **Politician vend** : Moins fiable (raisons diverses), mais à noter si combiné avec d'autres signaux bearish

## Stratégie $500/JOUR
1. **Coupe les pertes VITE** : >-1.5% en scalp, >-2.5% en momentum → SELL immédiatement
2. **Score de conviction FAIBLE requis** : 1 signal fort OU 2 signaux moyens = GO. N'attends pas la perfection.
3. **DÉPLOIE LE CAPITAL** : tu DOIS identifier au minimum ${tradingMode === "SCALP" ? "5-8" : "3-5"} BUY par cycle si du cash est disponible
4. **Taille des positions AGRESSIVE** : ${tradingMode === "SCALP" ? "15-25%" : "10-20%"} du portfolio par trade
5. **PRIORITÉ HOT LIST** : les stocks dans le Hot List ont le meilleur momentum × volume = meilleurs pour des gains rapides
6. **Objectif mathématique** : 5 trades gagnants de $100 chacun = $500/jour. Chaque trade doit viser AU MOINS $80-150 de gain.
7. **Quand SELL** : en scalp mode, sors à +1-2%. En momentum, laisse le trailing stop faire le travail.
8. **Ne JAMAIS moyenner à la baisse** — si un trade perd, SELL, ne rajoute pas.

## Profit-taking automatique (le bot gère déjà — ATR-dynamique)
- **SCALP mode** : vend 100% à 1× ATR (floor 1.5%)
- **MOMENTUM mode** : vend 50% à 2× ATR (floor 3%), 100% à 4× ATR (floor 6%)
- **PURE DAY-TRADING**: TOUTES les positions sont fermées automatiquement à 15h50 ET. Aucune position overnight.
- **EXCEPTION EARNINGS**: Si un stock a des earnings AMC (after-market-close) aujourd'hui ET la position est en profit (+0.5%+), on la garde overnight pour le gap-up potentiel. Les ETFs leveragés sont TOUJOURS fermés.
- Après 15h30 ET, évite les nouveaux BUY — pas assez de temps pour que le trade se développe.
- Tu n'as PAS besoin de gérer les profit-takes — concentre-toi sur les ENTRÉES et les EXITS de perdants.`;

  const userPrompt = `## Horodatage
${now.toISOString()} — Cycle #${cycleCount} — Il te reste ~${cyclesLeft} cycles (~${hoursLeft}h de marché).
Phase du marché: ${marketPhase}
Mode de trading: ${tradingModeLabel}
🎯 Objectif du jour: +$${DAILY_PROFIT_TARGET} (=${(DAILY_PROFIT_TARGET / currentEquity * 100).toFixed(2)}% du portfolio)
📊 P&L du jour: $${todayPnl.toFixed(2)} / $${DAILY_PROFIT_TARGET} (${(todayPnl / DAILY_PROFIT_TARGET * 100).toFixed(0)}%)${hitDailyTarget ? " ✅ TARGET HIT — PROTECT MODE" : ""}

## Portfolio actuel
- Cash disponible : $${account.cash}
- Valeur totale : $${account.equity}
- Positions ouvertes :
${(positions as Record<string, unknown>[]).map((p) =>
  ` ${p.symbol}: ${p.qty} actions | Prix moyen : $${p.avg_entry_price} | PnL : $${p.unrealized_pl}`
).join("\n") || " Aucune"}

🚫 **STOCKS DÉJÀ EN PORTEFEUILLE — NE PAS ACHETER** : ${(positions as Record<string, unknown>[]).map(p => p.symbol).join(", ") || "aucun"}
Tu possèdes DÉJÀ ces stocks. N'envoie AUCUN BUY pour ces symboles. Choisis des stocks DIFFÉRENTS que tu ne possèdes pas encore.

## Rotation sectorielle (performance ETFs sectoriels)
${Object.entries(SECTOR_ETFS).map(([sector, etf]) => {
  const perf = _sectorCache[etf];
  return perf != null ? `  ${sector} (${etf}): ${perf > 0 ? "+" : ""}${perf}%` : null;
}).filter(Boolean).join("\n") || "  Données sectorielles non disponibles"}

## Sentiment du marché
- Fear & Greed: ${enrichment ? `${enrichment.fearGreed.score}/100 — ${enrichment.fearGreed.label} (précédent: ${enrichment.fearGreed.previous})` : "N/A"}
- Volatilité (VIX proxy): ${enrichment ? `${enrichment.vix.value} — ${enrichment.vix.label}` : "N/A"}

## 🦍 WallStreetBets & Reddit Trending
${enrichment?.socialSentiment?.length ? enrichment.socialSentiment.slice(0, 15).map(r => `  ${r.symbol}: ${r.mentions} mentions [${r.source}] — ${r.sentiment}`).join("\n") : "  Pas de données sociales"}

## 📉 High Short Interest (squeeze candidates)
${enrichment?.shortInterest?.length ? enrichment.shortInterest.slice(0, 10).map(s => `  ${s.symbol}: ${s.shortInterest}% short, ${s.daysTocover} days to cover`).join("\n") : "  Pas de données"}

## 🏛️ Congressional Trades (dernières transactions)
${enrichment?.congressTrades?.length ? enrichment.congressTrades.slice(0, 8).map(t => `  ${t.politician}: ${t.type} ${t.symbol} — ${t.amount} (${t.date})`).join("\n") : "  Pas de données"}

## Données de marché
${marketSummary}

## Historique des ${history.length} derniers trades
${JSON.stringify(history, null, 2)}
${lastAnalysis ? `\n## Tes dernières auto-analyses\n${lastAnalysis}\n` : ""}
${latestMetrics ? `\n## Performance cumulée du bot\n${latestMetrics}\n` : ""}
## 🔥 HOT LIST — Stocks avec le meilleur momentum × volume
${hotList.summary || "Pas de données hot list"}

## Instructions OBLIGATOIRES
⚠️ RÈGLES ABSOLUES (violation = réponse rejetée):
1. Tu ne peux trader QUE les symboles listés dans "Données de marché" ou "Hot List" ci-dessus. N'invente PAS de symboles.
2. JAMAIS de ETFs leveragés/inversés (TQQQ, SQQQ, TZA, UVXY, PLU, NVDL, etc.)
3. 🚨 JAMAIS acheter un stock CRASH (>10% en baisse). Le buzz Reddit pendant un crash ≠ signal bullish.
4. 🚫 ZÉRO DOUBLON — chaque symbole apparaît UNE SEULE FOIS dans ta réponse.
5. 💰 CHAQUE trade doit cibler $80-200 de gain. Calcule: qty × prix × gain% = $80-200.

🎯 RÈGLE DE DIVERSITÉ OBLIGATOIRE:
- Tu DOIS proposer EXACTEMENT ${tradingMode === "SCALP" ? "5 à 8" : "3 à 5"} symboles DIFFÉRENTS en BUY.
- PIOCHE DANS LE HOT LIST CI-DESSUS. Ce sont les stocks avec le plus de momentum.
- Si tu ne trouves pas assez de BUY dans le Hot List, pioche dans les données de marché.
- INTERDICTION de n'envoyer qu'un seul BUY. Minimum 3 BUY différents.
- Diversifie les SECTEURS : tech + santé + finance + énergie, etc.
- Si tu envoies moins de 3 BUY différents, ta réponse sera REJETÉE et remplacée par des picks automatiques.
- **SHORT SELLING**: Si le marché est baissier (SPY sous SMA20) ou si un stock est suracheté (RSI > 75), tu peux proposer SHORT. On profite quand le prix BAISSE. Utilise SHORT pour les stocks en chute libre, après mauvaises nouvelles, ou overbought.
- SHORT = vendre sans posséder, on rachète plus bas. Max 1-2 SHORTs par cycle, petites positions.

Réponds UNIQUEMENT en JSON valide (tableau) — CHAQUE symbole UNE SEULE FOIS :
[
  {
    "action": "BUY" | "SELL" | "SHORT" | "HOLD",
    "symbol": "TICKER ou null",
    "quantity": nombre ou null,
    "reason": "justification concise incluant le gain $ estimé"
  }
]`;

  let content = "";
  try {
    content = await callGrok(userPrompt, systemPrompt, true);
    console.log("Grok raw response length:", content.length, "| first 500 chars:", content.slice(0, 500));
    if (!content || content.trim().length === 0) {
      console.error("Grok returned empty response — is GROK_API_KEY set? Check: npx supabase secrets list");
      return null;
    }
    const parsed = extractJson(content);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    console.error("Decision parse error:", (err as Error).message);
    console.error("Raw Grok response:", content.slice(0, 1000));
    // Fallback: try without live search (chat/completions instead of responses API)
    try {
      console.log("Retrying with chat/completions fallback...");
      content = await callGrok(userPrompt, systemPrompt, false);
      console.log("Fallback response length:", content.length);
      if (!content || content.trim().length === 0) return null;
      const parsed = extractJson(content);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (err2) {
      console.error("Fallback also failed:", (err2 as Error).message);
      console.error("Fallback raw:", content.slice(0, 1000));
      return null;
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ADAPTIVE TWO-TIER CYCLE ENGINE
//
// FAST SCAN (every 3 min):
//   Lightweight — snapshot-only scan of full universe + open positions.
//   Checks for triggers: volume spikes, big moves, position alerts.
//   If a trigger fires → immediately launches a full cycle.
//   Cost: 2-3 Alpaca API calls. Zero Grok calls. ~2 seconds.
//
// FULL CYCLE (every 10 min, OR on trigger from fast scan):
//   Heavy — multi-TF analysis, patterns, Grok AI decisions, order execution.
//   Cost: 50+ Alpaca API calls + 2-3 Grok calls. ~15-30 seconds.
//   $500/DAY TARGET = must execute 15-25 trades/day across ~40 cycles
//
// Call with ?mode=scan for fast scan, ?mode=full for full cycle.
// pg_cron: every 3 min full cycle (scan-only mode removed — always trades).
// ══════════════════════════════════════════════════════════════════════════════

type ScanTrigger = {
  type: "volume_spike" | "big_move" | "position_alert" | "gapper" | "sector_rotation";
  symbol: string;
  detail: string;
  severity: "low" | "medium" | "high";
};

// Detect triggers from snapshot data + current positions
function detectTriggers(
  snapshots: SnapshotData[],
  positions: Record<string, unknown>[],
): ScanTrigger[] {
  const triggers: ScanTrigger[] = [];

  // 1. Big movers in the universe — LOWERED thresholds for more opportunities
  for (const snap of snapshots) {
    if (Math.abs(snap.change_pct) > 4 && snap.volume > 500_000) {
      triggers.push({
        type: "big_move",
        symbol: snap.symbol,
        detail: `${snap.change_pct > 0 ? "+" : ""}${snap.change_pct}% on ${(snap.volume / 1_000_000).toFixed(1)}M volume`,
        severity: "high",
      });
    } else if (Math.abs(snap.change_pct) > 2 && snap.volume > 300_000) {
      triggers.push({
        type: "big_move",
        symbol: snap.symbol,
        detail: `${snap.change_pct > 0 ? "+" : ""}${snap.change_pct}% on ${(snap.volume / 1_000).toFixed(0)}K volume`,
        severity: "medium",
      });
    }
  }

  // 2. Position alerts — open positions moving sharply
  for (const pos of positions) {
    const snap = snapshots.find(s => s.symbol === String(pos.symbol));
    if (!snap) continue;

    const unrealizedPct = parseFloat(String(pos.unrealized_plpc ?? 0)) * 100;

    // Position down more than 1.5% since entry — react FAST to losses
    if (unrealizedPct < -1.5) {
      triggers.push({
        type: "position_alert",
        symbol: String(pos.symbol),
        detail: `Open position down ${unrealizedPct.toFixed(1)}% — consider exit`,
        severity: unrealizedPct < -3 ? "high" : "medium",
      });
    }

    // Position up more than 2% — potential profit-taking signal
    if (unrealizedPct > 2) {
      triggers.push({
        type: "position_alert",
        symbol: String(pos.symbol),
        detail: `Open position up +${unrealizedPct.toFixed(1)}% — consider taking profit`,
        severity: unrealizedPct > 5 ? "high" : "medium",
      });
    }

    // Sudden intraday reversal on open position (was up, now down, or vice versa)
    if (snap.change_pct < -2 && unrealizedPct > 0) {
      triggers.push({
        type: "position_alert",
        symbol: String(pos.symbol),
        detail: `Intraday reversal: position profitable but stock dropping ${snap.change_pct}% today`,
        severity: "high",
      });
    }
  }

  // 3. Gappers — stocks gapping with unusual volume (lowered threshold)
  for (const snap of snapshots) {
    if (Math.abs(snap.change_pct) > 3 && snap.volume > 1_000_000) {
      const alreadyTracked = triggers.some(t => t.symbol === snap.symbol);
      if (!alreadyTracked) {
        triggers.push({
          type: "gapper",
          symbol: snap.symbol,
          detail: `Gap ${snap.change_pct > 0 ? "up" : "down"} ${snap.change_pct}% on massive volume`,
          severity: "high",
        });
      }
    }
  }

  return triggers;
}

// Check if any triggers warrant an immediate full cycle
function shouldTriggerFullCycle(triggers: ScanTrigger[]): boolean {
  const highCount = triggers.filter(t => t.severity === "high").length;
  const positionAlerts = triggers.filter(t => t.type === "position_alert" && t.severity === "high").length;

  // Trigger full cycle if:
  // - 2+ high-severity signals, OR
  // - Any high-severity position alert (our money is at risk), OR
  // - 3+ medium+ signals (market is active — we need to trade more to hit $500/day)
  return highCount >= 2 || positionAlerts >= 1 || triggers.filter(t => t.severity !== "low").length >= 3;
}

// Log scan results to DB for dashboard visibility
async function logScanResult(triggers: ScanTrigger[], triggeredFull: boolean) {
  await supabase.from("trades").insert({
    symbol: null,
    action: triggeredFull ? "SCAN_TRIGGERED" : "SCAN_QUIET",
    quantity: triggers.length,
    reason: triggers.length > 0
      ? `Detected ${triggers.length} signals: ${triggers.slice(0, 5).map(t => `${t.symbol}(${t.type}:${t.severity})`).join(", ")}${triggers.length > 5 ? "..." : ""}`
      : "No significant signals detected",
    status: "scan",
  });
}

// ── FAST SCAN: Lightweight market pulse check ────────────────────────────────
async function runFastScan(): Promise<Response> {
  console.log("⚡ FAST SCAN — checking market pulse...");

  const [account, positions] = await Promise.all([getAccount(), getPositions()]);
  const currentEquity = parseFloat(account.equity);

  // Drawdown check even in fast scan
  if (currentEquity < STARTING_CAPITAL * (1 - MAX_DRAWDOWN_PCT)) {
    console.warn(`DRAWDOWN LIMIT — equity $${currentEquity.toFixed(2)}. Skipping.`);
    return new Response(JSON.stringify({ status: "drawdown_limit", mode: "scan" }), { status: 200 });
  }

  // Snapshot the full universe (2-3 API calls, very fast)
  const snapshots = await fetchSnapshots(FULL_UNIVERSE);
  console.log(`Scanned ${snapshots.length} stocks`);

  // Detect triggers
  const triggers = detectTriggers(snapshots, positions as Record<string, unknown>[]);
  const fullCycleNeeded = shouldTriggerFullCycle(triggers);

  if (triggers.length > 0) {
    console.log(`Found ${triggers.length} triggers (${triggers.filter(t => t.severity === "high").length} high):`,
      triggers.slice(0, 8).map(t => `${t.symbol}[${t.severity}]`).join(", "));
  }

  if (fullCycleNeeded) {
    console.log("🚨 TRIGGERS DETECTED — launching full cycle immediately!");
    await logScanResult(triggers, true);
    // Run the full cycle inline (not a separate HTTP call, to avoid auth overhead)
    return await runFullCycle(triggers);
  }

  await logScanResult(triggers, false);
  console.log("✅ FAST SCAN complete — market quiet, no action needed.");
  return new Response(JSON.stringify({
    status: "scan_complete",
    triggers_found: triggers.length,
    high_severity: triggers.filter(t => t.severity === "high").length,
    full_cycle_triggered: false,
  }), { status: 200 });
}

// ── FULL CYCLE: Heavy analysis + trading ─────────────────────────────────────
async function runFullCycle(scanTriggers: ScanTrigger[] = []): Promise<Response> {
  console.log(`🔄 FULL CYCLE starting${scanTriggers.length > 0 ? ` (triggered by ${scanTriggers.length} signals)` : ""}...`);

  // ET timezone for time-based rules (flatten, market phase)
  const _now = new Date();
  const etHour = new Date(_now.toLocaleString("en-US", { timeZone: "America/New_York" })).getHours();
  const etMin = new Date(_now.toLocaleString("en-US", { timeZone: "America/New_York" })).getMinutes();

  const [account, positions] = await Promise.all([getAccount(), getPositions()]);
  const currentEquity = parseFloat(account.equity);

  // Drawdown circuit breaker
  if (currentEquity < STARTING_CAPITAL * (1 - MAX_DRAWDOWN_PCT)) {
    const threshold = STARTING_CAPITAL * (1 - MAX_DRAWDOWN_PCT);
    console.warn(`DRAWDOWN LIMIT HIT — equity $${currentEquity.toFixed(2)} is below $${threshold.toFixed(2)}. Halting.`);
    return new Response(JSON.stringify({ status: "drawdown_limit", equity: currentEquity }), { status: 200 });
  }

  // ── DAILY P&L TRACKER ──────────────────────────────────────────────────────
  // Track today's realized P&L. Once we hit $500+, switch to conservative mode.
  const todayPnl = parseFloat(String(account.equity)) - parseFloat(String(account.last_equity ?? account.equity));
  const hitDailyTarget = todayPnl >= DAILY_PROFIT_TARGET;
  if (hitDailyTarget) {
    console.log(`🎯🎯🎯 DAILY TARGET HIT! Today's P&L: +$${todayPnl.toFixed(2)} — switching to PROTECT MODE (no new buys, only sells to lock profits)`);
  } else {
    const pnlEmoji = todayPnl >= 0 ? "📈" : "📉";
    console.log(`${pnlEmoji} Today's P&L: $${todayPnl.toFixed(2)} / $${DAILY_PROFIT_TARGET} target (${(todayPnl / DAILY_PROFIT_TARGET * 100).toFixed(0)}%)`);
  }

  await logSnapshot(parseFloat(account.cash), currentEquity, positions);

  const [history, lastAnalysis, latestMetrics] = await Promise.all([
    getTradeHistory(50),
    getLastAnalyses(),
    getLatestMetrics(),
  ]);

  const discovery = await discoverSymbols(positions, history, lastAnalysis);
  const symbols = discovery.symbols;
  const hotList = discovery.hotList;
  const cachedSnapshots = discovery.allSnapshots;
  console.log("Symbols to analyze:", symbols);
  console.log(`🔥 Hot list: ${hotList.symbols.slice(0, 10).join(", ")}`);

  const [marketData, enrichment, cycleCount, optionsFlow] = await Promise.all([
    getMarketData(symbols),
    getEnrichmentData(symbols),
    getCycleCount(),
    getOptionsFlow(symbols),
  ]);

  // ── QUANT-FIRST DECISION ENGINE ────────────────────────────────────────────
  // Step 1: Quant scorer picks top 6 stocks by pure math (no LLM)
  // Step 2: Grok only used as optional risk-check for existing positions
  const heldSymbolSet = new Set((positions as Record<string, string>[]).map(p => p.symbol));
  // ── SMART COOLDOWN: longer after losses, shorter after wins ──────────────
  // Loss exits: 60-min cooldown (avoid re-buying a loser)
  // Profit exits: 15-min cooldown (re-entry OK if still strong)
  const LOSS_COOLDOWN_MS = 60 * 60 * 1000;   // 60 minutes
  const PROFIT_COOLDOWN_MS = 15 * 60 * 1000;  // 15 minutes
  const { data: recentSellsForCount } = await supabase
    .from("trades").select("symbol, action, price_entry, price_exit, created_at")
    .in("action", ["SELL", "PROFIT_TAKE"])
    .gte("created_at", new Date(Date.now() - LOSS_COOLDOWN_MS).toISOString())
    .not("symbol", "is", null);
  const cooldownSymbols = new Set<string>();
  for (const r of (recentSellsForCount ?? []) as Record<string, unknown>[]) {
    const sym = r.symbol as string;
    const sellTime = new Date(r.created_at as string).getTime();
    const wasProfit = r.action === "PROFIT_TAKE" || ((r.price_exit as number) > (r.price_entry as number));
    const cooldownMs = wasProfit ? PROFIT_COOLDOWN_MS : LOSS_COOLDOWN_MS;
    if (Date.now() - sellTime < cooldownMs) {
      cooldownSymbols.add(sym);
    }
  }

  // Auto-blacklist: skip symbols with 3+ consecutive losses in 7 days
  const repeatLoserSymbols = new Set<string>();
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recentLossTrades } = await supabase
      .from("trades").select("symbol, price_entry, price_exit, created_at")
      .in("action", ["SELL", "PROFIT_TAKE"])
      .gte("created_at", sevenDaysAgo)
      .not("price_entry", "is", null).not("price_exit", "is", null)
      .order("created_at", { ascending: false });
    const symbolTrades: Record<string, boolean[]> = {};
    for (const t of (recentLossTrades ?? []) as Record<string, unknown>[]) {
      const sym = t.symbol as string;
      if (!symbolTrades[sym]) symbolTrades[sym] = [];
      symbolTrades[sym].push((t.price_exit as number) < (t.price_entry as number));
    }
    for (const [sym, results] of Object.entries(symbolTrades)) {
      if (results.slice(0, 3).length >= 3 && results.slice(0, 3).every(r => r)) repeatLoserSymbols.add(sym);
    }
    if (repeatLoserSymbols.size > 0) console.log(`🚫 REPEAT LOSERS (3+ consecutive losses): ${[...repeatLoserSymbols].join(", ")}`);
  } catch (err) { console.warn("Repeat loser check failed:", err); }

  // Churn limiter: stop re-trading symbols with 5+ trades today & near-zero P&L
  const churnedSymbols = new Set<string>();
  try {
    const todayStart = new Date().toISOString().split("T")[0] + "T00:00:00Z";
    const { data: todayTrades } = await supabase
      .from("trades").select("symbol, action, price_entry, price_exit")
      .in("action", ["SELL", "PROFIT_TAKE"]).gte("created_at", todayStart).not("symbol", "is", null);
    const symbolStats: Record<string, { count: number; pnl: number }> = {};
    for (const t of (todayTrades ?? []) as Record<string, unknown>[]) {
      const sym = t.symbol as string;
      if (!symbolStats[sym]) symbolStats[sym] = { count: 0, pnl: 0 };
      symbolStats[sym].count++;
      if (t.price_entry && t.price_exit) symbolStats[sym].pnl += (t.price_exit as number) - (t.price_entry as number);
    }
    for (const [sym, stats] of Object.entries(symbolStats)) {
      if (stats.count >= 5 && Math.abs(stats.pnl) < 50) churnedSymbols.add(sym);
    }
    if (churnedSymbols.size > 0) console.log(`🔄 CHURN LIMIT: ${[...churnedSymbols].join(", ")} (5+ trades, ~$0 P&L)`);
  } catch (err) { console.warn("Churn limiter failed:", err); }

  // ── Quick snapshot test: try fetching just 3 symbols to diagnose ──
  let _snapTestResult = "not_run";
  try {
    const testRes = await fetchWithTimeout(
      `${ALPACA_DATA_URL}/stocks/snapshots?symbols=AAPL,MSFT,TSLA&feed=iex`,
      { headers: alpacaHeaders },
      10000
    );
    _snapTestResult = `HTTP ${testRes.status} - ${testRes.ok ? Object.keys(await testRes.clone().json()).length + " symbols" : await testRes.text().catch(() => "no body")}`;
  } catch (e) {
    _snapTestResult = `ERROR: ${String(e)}`;
  }

  // ── DIAGNOSTICS: track pipeline state for debugging ──
  const _diag = {
    discoveredSymbols: symbols.length,
    symbolList: symbols.slice(0, 20).join(","),
    hotListCount: hotList.symbols.length,
    hotListTop5: hotList.symbols.slice(0, 5).join(","),
    snapshotsCount: cachedSnapshots.length,
    marketDataKeys: Object.keys(marketData).length,
    marketDataSymbols: Object.keys(marketData).slice(0, 15).join(","),
    heldCount: heldSymbolSet.size,
    heldSymbols: [...heldSymbolSet].join(","),
    cooldownCount: cooldownSymbols.size,
    cooldownSymbols: [...cooldownSymbols].join(","),
    optionsFlowKeys: Object.keys(optionsFlow).length,
    snapshotTest: _snapTestResult,
  };
  console.log("🔍 DIAGNOSTICS:", JSON.stringify(_diag));

  const { decisions: quantDecisions, scores: quantScores } = quantPick(
    marketData,
    cachedSnapshots,
    enrichment?.socialSentiment ?? [],
    optionsFlow,
    heldSymbolSet,
    cooldownSymbols,
    currentEquity,
    6, // pick top 6
  );

  // Use Grok ONLY for sell decisions on existing positions (risk management)
  let grokSellDecisions: Array<{ action: string; symbol: string; quantity: number; reason: string }> = [];
  if ((positions as unknown[]).length > 0) {
    try {
      const grokDecisions = await makeDecision(account, positions, history, marketData, lastAnalysis, cycleCount, latestMetrics, enrichment, todayPnl, hitDailyTarget, hotList);
      if (grokDecisions) {
        grokSellDecisions = grokDecisions.filter((d: Record<string, unknown>) => d.action === "SELL");
        console.log(`Grok sell recommendations: ${grokSellDecisions.length}`);
      }
    } catch (err) {
      console.warn("Grok failed (non-critical, quant engine handles buys):", String(err));
    }
  }

  // Merge: quant BUYs + Grok SELLs
  const decisions = [...grokSellDecisions, ...quantDecisions];
  console.log(`📊 FINAL DECISIONS: ${quantDecisions.length} quant BUYs + ${grokSellDecisions.length} Grok SELLs`);

  if (decisions.length === 0) {
    console.log("No actionable decisions from quant engine or Grok");
  }

  // Get trading mode for profit-taking
  const { mode: tradingMode, label: tradingModeLabel } = getCurrentTradingMode();
  console.log(`Trading mode: ${tradingModeLabel}`);

  // Track symbols already sold by EOD flatten to prevent double-sell
  const soldSymbols = new Set<string>();

  // ── EOD FULL FLATTEN: Close ALL positions before market close ──────────────
  // Pure day-trading strategy — no overnight holds for any position.
  // EXCEPTION: Stocks with after-market-close (AMC) earnings today that are
  //   (a) in profit AND (b) NOT leveraged ETFs can be held overnight.
  //   Rationale: strong earnings can produce 5-15% gap-ups overnight.
  //   Leveraged ETFs are ALWAYS flattened (decay + unpredictable gaps).
  const FLATTEN_HOUR = 15; const FLATTEN_MINUTE = 45; // 3:45 PM ET — earlier cutoff, nuclear liquidation handles the rest
  const EARNINGS_HOLD_MIN_PROFIT_PCT = 0.005; // must be at least +0.5% to hold through earnings
  if (etHour > FLATTEN_HOUR || (etHour === FLATTEN_HOUR && etMin >= FLATTEN_MINUTE)) {
    // Check which held symbols have AMC earnings today
    const heldSymbols = (positions as Record<string, unknown>[]).map(p => p.symbol as string);
    const earningsExempt = await getEarningsExemptSymbols(heldSymbols);

    for (const pos of (positions as Record<string, unknown>[])) {
      const sym = pos.symbol as string;
      const qty = parseInt(String(pos.qty));
      if (qty <= 0) continue;
      const isLev = ALL_LEVERAGED_ETFS.has(sym);
      const entryPrice = parseFloat(String(pos.avg_entry_price));
      const currentPrice = parseFloat(String(pos.current_price ?? 0));
      const pnlPct = entryPrice > 0 ? (currentPrice - entryPrice) / entryPrice : 0;

      // Earnings exception: hold profitable non-leveraged positions with AMC earnings
      if (earningsExempt.has(sym) && !isLev && pnlPct >= EARNINGS_HOLD_MIN_PROFIT_PCT) {
        console.log(`🎯 EARNINGS HOLD: Keeping ${sym} (${qty} shares, +${(pnlPct * 100).toFixed(2)}%) — AMC earnings today, betting on gap-up`);
        await logTrade({
          symbol: sym, action: "HOLD", quantity: qty,
          reason: `Earnings exception: ${sym} has AMC earnings today, position +${(pnlPct * 100).toFixed(2)}% — holding for potential gap-up`,
          price_entry: entryPrice,
          price_exit: currentPrice,
          alpaca_order_id: "earnings-hold", status: "open",
        });
        continue; // skip flatten for this symbol
      }

      console.log(`🌙 EOD FLATTEN: Closing ${sym} (${qty} shares)${isLev ? " [leveraged]" : ""} — no overnight holds`);
      await cancelOrdersForSymbol(sym);
      const order = await placeOrder(sym, qty, "sell");
      soldSymbols.add(sym);
      if (order?.id) {
        await logTrade({
          symbol: sym, action: "SELL", quantity: qty,
          reason: `EOD flatten: pure day-trading — close all positions before 4 PM ET${isLev ? " (leveraged)" : ""}`,
          price_entry: entryPrice,
          price_exit: currentPrice,
          alpaca_order_id: order.id, status: "closed",
        });
        await closeBuyTrade(sym, currentPrice);
        await closeBuyTrade(sym, currentPrice);
      }
    }
  }

  // ── DYNAMIC ATR-BASED PROFIT-TAKING ─────────────────────────────────────────
  // Profit targets scale to each stock's volatility (ATR).
  // High-vol stocks (TQQQ, SOXL) get wider targets; low-vol (AAPL) get tighter.
  // SCALP:    exit 100% at 1× ATR (or 1.5% floor)
  // MOMENTUM: partial 50% at 2× ATR (or 3% floor), full exit at 4× ATR (or 6% floor)
  const SCALP_FLOOR_PCT = 0.006;        // 0.6% scalp floor — Config C: quick wins, high volume
  const MOMENTUM_PARTIAL_FLOOR = 0.015; // 1.5% partial exit — Config C: faster profit taking
  const MOMENTUM_FULL_FLOOR = 0.03;     // 3% full exit — Config C: tighter targets
  const SCALP_ATR_MULT = 0.5;           // 0.5× ATR for scalp — Config C: grab small wins fast
  const MOMENTUM_PARTIAL_ATR_MULT = 1.2; // 1.2× ATR for partial — Config C
  const MOMENTUM_FULL_ATR_MULT = 2.5;   // 2.5× ATR for full exit — Config C
  const isScalp = tradingMode === "SCALP";

  const profitTakeOrders = [];
  for (const pos of (positions as Record<string, unknown>[])) {
    const unrealizedPct = parseFloat(String(pos.unrealized_plpc ?? 0));
    const qty = parseInt(String(pos.qty));
    const sym = pos.symbol as string;
    const entryPrice = parseFloat(String(pos.avg_entry_price ?? 0));

    // Skip if already sold by EOD flatten (prevents double-sell -> accidental short)
    if (soldSymbols.has(sym)) {
      debugLog.push(`${sym}: SKIP profit-take — already sold by EOD flatten`);
      continue;
    }

    // Skip if Grok already wants to sell
    const grokWantsSell = decisions.some((d: Record<string, unknown>) => d.symbol === sym && d.action === "SELL");
    if (grokWantsSell) continue;

    // Get ATR for this symbol to compute dynamic targets
    const symATR = marketData[sym]?.tech.atr14 ?? null;
    const atrPct = (symATR && entryPrice > 0) ? symATR / entryPrice : 0;

    // Dynamic thresholds: ATR-scaled with floor minimums
    const scalpTarget = Math.max(SCALP_FLOOR_PCT, atrPct * SCALP_ATR_MULT);
    const momentumPartial = Math.max(MOMENTUM_PARTIAL_FLOOR, atrPct * MOMENTUM_PARTIAL_ATR_MULT);
    const momentumFull = Math.max(MOMENTUM_FULL_FLOOR, atrPct * MOMENTUM_FULL_ATR_MULT);

    let sellQty = 0;
    let reason = "";

    if (isScalp && unrealizedPct >= scalpTarget && qty >= 1) {
      // SCALP: quick full exit at ATR-scaled target
      sellQty = qty;
      reason = `⚡ SCALP exit: +${(unrealizedPct * 100).toFixed(1)}% (target ${(scalpTarget * 100).toFixed(1)}%) — selling ALL ${qty} shares`;
    } else if (!isScalp && unrealizedPct >= momentumFull && qty >= 1) {
      // MOMENTUM: full exit at 4× ATR
      sellQty = qty;
      reason = `🎯 MOMENTUM full exit: +${(unrealizedPct * 100).toFixed(1)}% (target ${(momentumFull * 100).toFixed(1)}%) — selling ALL ${qty} shares`;
    } else if (!isScalp && unrealizedPct >= momentumPartial && qty > 1) {
      // MOMENTUM: partial exit at 2× ATR
      sellQty = Math.max(1, Math.floor(qty * 0.5));
      reason = `📈 MOMENTUM partial: +${(unrealizedPct * 100).toFixed(1)}% (target ${(momentumPartial * 100).toFixed(1)}%) — selling ${sellQty}/${qty} shares`;
    }

    if (sellQty > 0) {
      console.log(`💰 PROFIT TAKE: ${reason}`);
      await cancelOrdersForSymbol(sym);
      const order = await placeOrder(sym, sellQty, "sell");
      if (order?.id) {
        profitTakeOrders.push(order);
        await logTrade({
          symbol: sym,
          action: "PROFIT_TAKE",
          quantity: sellQty,
          reason,
          price_entry: parseFloat(String(pos.avg_entry_price)),
          price_exit: parseFloat(String(pos.current_price ?? 0)),
          alpaca_order_id: order.id,
          status: "closed",
        });
        if (reason.includes("ALL")) await closeBuyTrade(sym, parseFloat(String(pos.current_price ?? 0)));
        if (reason.includes("ALL")) await closeBuyTrade(sym, parseFloat(String(pos.current_price ?? 0)));
      } else {
        console.error(`Profit-take order failed for ${sym}:`, order);
      }
    }
  }
  if (profitTakeOrders.length > 0) {
    console.log(`💰 Profit-taking: ${profitTakeOrders.length} orders placed (${tradingMode} mode)`);
  }

  // Build allowed symbol set: full universe + scanned + held + hot list
  // Previously only used scanned symbols, which blocked valid picks like TSLA/NVDA
  const scannedSymbols = new Set(Object.keys(marketData));
  const fullUniverseSet = new Set(FULL_UNIVERSE);
  const hotListSet = new Set(hotList.symbols);
  const allowedSymbols = new Set([...fullUniverseSet, ...scannedSymbols, ...heldSymbolSet, ...hotListSet]);
  console.log(`Allowed symbols: ${allowedSymbols.size} (universe=${fullUniverseSet.size}, scanned=${scannedSymbols.size}, held=${heldSymbolSet.size}, hotList=${hotListSet.size})`);

  // ── SPY TREND FILTER: Only buy when broad market is trending up ─────────────
  // If SPY is below its 20-day SMA, the market is in a downtrend — reduce exposure.
  // We still allow SELLs and existing position management, just block new BUYs.
  let spyTrendBullish = true;
  let marketRegime: "NORMAL" | "CAUTIOUS" | "DEFENSIVE" = "NORMAL";
  let regimeSizeMultiplier = 1.0;
  try {
    const spyData = marketData["SPY"];
    if (spyData?.tech.sma20 && spyData?.tech.price) {
      spyTrendBullish = spyData.tech.price > spyData.tech.sma20;
      const spyChangePct = spyData.tech.change_pct ?? 0;
      if (spyChangePct <= -2.0) { marketRegime = "DEFENSIVE"; regimeSizeMultiplier = 0.25; }
      else if (spyChangePct <= -1.0) { marketRegime = "CAUTIOUS"; regimeSizeMultiplier = 0.5; }
      const regimeEmoji = marketRegime === "DEFENSIVE" ? "🔴" : marketRegime === "CAUTIOUS" ? "🟡" : "🟢";
      console.log(`📈 SPY trend: ${spyTrendBullish ? "BULLISH" : "⚠️ BEARISH"} (price=$${spyData.tech.price.toFixed(2)} vs SMA20=$${spyData.tech.sma20.toFixed(2)})`);
      console.log(`${regimeEmoji} MARKET REGIME: ${marketRegime} (SPY ${spyChangePct >= 0 ? "+" : ""}${spyChangePct.toFixed(2)}%) — position size multiplier: ${regimeSizeMultiplier}x`);
    }
  } catch { /* SPY check is optional */ }

  // ── EARNINGS BLACKOUT: Fetch today's earnings calendar, block new BUYs ─────
  // Don't buy stocks reporting earnings today — price action is unpredictable,
  // spreads widen, and moves are already priced in from social/news buzz.
  let earningsBlackoutSymbols = new Set<string>();
  try {
    const finnhubKey = Deno.env.get("FINNHUB_API_KEY");
    if (finnhubKey) {
      const today = new Date().toISOString().split("T")[0];
      const earningsRes = await fetchWithTimeout(
        `${FINNHUB_BASE_URL}/calendar/earnings?from=${today}&to=${today}&token=${finnhubKey}`,
        undefined, 8000
      );
      const earningsData = await earningsRes.json();
      for (const e of (earningsData?.earningsCalendar ?? [])) {
        earningsBlackoutSymbols.add(e.symbol);
      }
      console.log(`📅 Earnings blackout: ${earningsBlackoutSymbols.size} stocks reporting today${earningsBlackoutSymbols.size > 0 ? " — " + [...earningsBlackoutSymbols].slice(0, 15).join(", ") + (earningsBlackoutSymbols.size > 15 ? "..." : "") : ""}`);
    }
  } catch (err) {
    console.warn("Earnings blackout calendar fetch failed:", err);
  }

  // Cooldown already handled by quant engine — no duplicate check needed
  const executedOrders = [...profitTakeOrders];
  const debugLog: string[] = [];  // Track why each decision succeeded or was blocked
  for (const decision of decisions) {
    let alpacaOrder = null;
    let priceEntry: number | null = null;

    // Auto-blacklist: skip repeat losers
    if (decision.action === "BUY" && repeatLoserSymbols.has(decision.symbol)) {
      debugLog.push(`${decision.symbol}: BLOCKED - repeat loser (3+ consecutive losses)`);
      console.warn(`🚫 REPEAT LOSER: ${decision.symbol} blocked`);
      await logTrade({ symbol: decision.symbol, action: "BUY_BLOCKED", quantity: decision.quantity,
        reason: `Repeat loser: 3+ consecutive losses in 7 days`, status: "error" });
      continue;
    }
    // Churn limiter
    if (decision.action === "BUY" && churnedSymbols.has(decision.symbol)) {
      debugLog.push(`${decision.symbol}: BLOCKED - churn limit (5+ trades, ~$0 P&L today)`);
      console.warn(`🔄 CHURN: ${decision.symbol} blocked`);
      continue;
    }

    // Block decisions on symbols outside our universe
    if (decision.action !== "HOLD" && isValidSymbol(decision.symbol) && !allowedSymbols.has(decision.symbol)) {
      debugLog.push(`${decision.symbol}: BLOCKED — not in scanned/held universe (${allowedSymbols.size} allowed)`);
      console.warn(`${decision.action} blocked — ${decision.symbol} not in scanned/held universe`);
      continue;
    }

    // Block ALL buys after 3:00 PM ET - gives positions time to hit targets before flatten
    const LAST_BUY_HOUR = 15; const LAST_BUY_MINUTE = 0;
    if (decision.action === "BUY" && (etHour > LAST_BUY_HOUR || (etHour === LAST_BUY_HOUR && etMin >= LAST_BUY_MINUTE))) {
      debugLog.push(`${decision.symbol}: BLOCKED - past 3:00 PM ET buy cutoff`);
      continue;
    }

    // Lunch lull filter — avoid new buys during low-volume choppy hours (12-2 PM ET)
    // Config C: lowered threshold to 30 — still filters garbage but doesn't block the bulk of trades.
    // Previous threshold of 60 was blocking ALL candidates during lunch (contradicts Config C "max trades" philosophy).
    if (decision.action === "BUY" && etHour >= 12 && etHour < 14) {
      const lunchScore = quantScores.find(s => s.symbol === decision.symbol)?.score ?? 0;
      const LUNCH_MIN_SCORE = 34;  // Config C: 25 (was 60 — too aggressive, killed all midday trades)
      if (lunchScore < LUNCH_MIN_SCORE) {
        debugLog.push(`${decision.symbol}: BLOCKED — lunch lull (score ${lunchScore} < ${LUNCH_MIN_SCORE} threshold)`);
        continue;
      }
      debugLog.push(`${decision.symbol}: LUNCH PASS — score ${lunchScore} >= ${LUNCH_MIN_SCORE}`);
      console.log(`🍽️ LUNCH PASS: ${decision.symbol} score=${lunchScore} — letting it through`);
    }

    // Earnings blackout — don't buy stocks reporting earnings today
    if (decision.action === "BUY" && earningsBlackoutSymbols.has(decision.symbol)) {
      debugLog.push(`${decision.symbol}: BLOCKED — earnings blackout (reporting today)`);
      console.warn(`📅 EARNINGS BLACKOUT: ${decision.symbol} blocked — stock has earnings today, too unpredictable`);
      await logTrade({
        symbol: decision.symbol,
        action: "BUY_BLOCKED",
        quantity: decision.quantity,
        reason: `Earnings blackout: ${decision.symbol} reports earnings today — price action unpredictable, spreads wide`,
        status: "error",
      });
      continue;
    }

    // SPY trend filter — block long buys in bearish market (except inverse/bear ETFs which profit)
    // Config C: lowered override threshold from 65 → 35 to allow more trades through
    if (decision.action === "BUY" && !spyTrendBullish &&
        !LEVERAGED_BEAR_ETFS.has(decision.symbol) && !VOLATILITY_ETFS.has(decision.symbol)) {
      const trendScore = quantScores.find(s => s.symbol === decision.symbol)?.score ?? 0;
      const SPY_OVERRIDE_SCORE = 35;  // Config C: 35 (was 65 — too restrictive for max-trades strategy)
      if (trendScore < SPY_OVERRIDE_SCORE) {
        debugLog.push(`${decision.symbol}: BLOCKED — SPY bearish trend (score ${trendScore} < ${SPY_OVERRIDE_SCORE})`);
        continue;
      }
      debugLog.push(`${decision.symbol}: SPY BEARISH OVERRIDE — score ${trendScore} >= ${SPY_OVERRIDE_SCORE}`);
    }

    // Correlation guard — limit concentrated leveraged/inverse ETF positions
    if (decision.action === "BUY" && ALL_LEVERAGED_ETFS.has(decision.symbol)) {
      const guard = checkCorrelationGuard(decision.symbol, positions as Record<string, unknown>[]);
      if (!guard.allowed) {
        console.warn(`🛡️ CORRELATION GUARD: ${decision.symbol} blocked — ${guard.reason}`);
        debugLog.push(`${decision.symbol}: BLOCKED — CORRELATION GUARD (${guard.reason})`);
        await logTrade({
          symbol: decision.symbol,
          action: "BUY_BLOCKED",
          quantity: decision.quantity,
          reason: `Correlation guard: ${guard.reason}`,
          status: "error",
        });
        continue;
      }
    }

    if (decision.action === "BUY" && isValidSymbol(decision.symbol) && isValidQuantity(decision.quantity)) {
      // 🚨 CRASH FILTER — block buys on stocks crashing >10% in a day
      // Reddit buzz during a crash ≠ bullish momentum. It's people reacting to disaster.
      const symData = marketData[decision.symbol];
      if (symData && symData.tech.change_pct < -10) {
        debugLog.push(`${decision.symbol}: BLOCKED — CRASH FILTER (down ${symData.tech.change_pct}% today, likely bad news)`);
        console.warn(`🚨 CRASH FILTER: ${decision.symbol} down ${symData.tech.change_pct}% — blocking buy (falling knife)`);
        await logTrade({
          symbol: decision.symbol,
          action: "BUY_BLOCKED",
          quantity: decision.quantity,
          reason: `Crash filter: ${decision.symbol} down ${symData.tech.change_pct}% today — falling knife blocked`,
          status: "error",
        });
        continue;
      }

      // Cooldown + crash filter already handled by quant engine upstream

      // Block new buys when daily target is hit — protect profits
      if (hitDailyTarget) {
        debugLog.push(`${decision.symbol}: BLOCKED — daily target hit`);
        continue;
      }

      const alreadyOpen = (positions as Record<string, string>[]).some(p => p.symbol === decision.symbol);
      const alreadyBoughtThisCycle = executedOrders.some(o => o.symbol === decision.symbol && o.side === "buy");
      if (alreadyOpen || alreadyBoughtThisCycle) {
        debugLog.push(`${decision.symbol}: BLOCKED — ${alreadyOpen ? "position already open" : "already bought this cycle (duplicate)"}`);
        continue;
      }

      // 💧 SPREAD CHECK — skip thinly-traded stocks with wide bid-ask spreads
      const spread = await getSpreadPct(decision.symbol);
      if (spread && spread.spreadPct > MAX_SPREAD_PCT) {
        debugLog.push(`${decision.symbol}: BLOCKED — spread too wide (${(spread.spreadPct * 100).toFixed(2)}% > ${(MAX_SPREAD_PCT * 100).toFixed(1)}%, bid=$${spread.bid} ask=$${spread.ask})`);
        console.warn(`💧 SPREAD FILTER: ${decision.symbol} spread ${(spread.spreadPct * 100).toFixed(2)}% > max ${(MAX_SPREAD_PCT * 100).toFixed(1)}%`);
        continue; // don't log to trades table — just skip silently
      }

      // ATR-Based Position Sizing
      const symbolPrice = marketData[decision.symbol]?.tech.price ?? 0;
      const symbolATR = marketData[decision.symbol]?.tech.atr14 ?? null;
      priceEntry = await getLatestPrice(decision.symbol) || symbolPrice;
      const effectivePrice = priceEntry ?? symbolPrice;

      const sizing = atrPositionSize(currentEquity, effectivePrice, symbolATR);
      let finalQty = Math.min(decision.quantity, sizing.qty);

      // Market regime: reduce position size on bad days
      if (regimeSizeMultiplier < 1.0) {
        const regimeAdjusted = Math.max(1, Math.floor(finalQty * regimeSizeMultiplier));
        if (regimeAdjusted < finalQty) {
          console.log(`🟡 REGIME SIZING: ${decision.symbol} qty ${finalQty} -> ${regimeAdjusted} (${marketRegime} mode, ${regimeSizeMultiplier}x)`);
          finalQty = regimeAdjusted;
        }
      }

      // Cash buffer guard — always keep 10% cash
      const availableCash = parseFloat(account.cash);
      const cashAfterBuy = availableCash - (finalQty * effectivePrice);
      const minCashRequired = currentEquity * MIN_CASH_PCT;
      if (cashAfterBuy < minCashRequired) {
        const maxSpend = availableCash - minCashRequired;
        if (maxSpend < effectivePrice) {
          debugLog.push(`${decision.symbol}: BLOCKED — cash buffer (cash=$${availableCash.toFixed(0)}, need=$${minCashRequired.toFixed(0)}, price=$${effectivePrice})`);
          continue;
        }
        // Reduce quantity to maintain cash buffer
        const adjustedQty = Math.floor(maxSpend / effectivePrice);
        if (adjustedQty < 1) continue;
        console.log(`BUY qty adjusted: ${finalQty} → ${adjustedQty} to maintain 10% cash buffer`);
        finalQty = adjustedQty;
      }

      // Position size guard — 18% cap (Config C)
      const orderValue = finalQty * effectivePrice;
      const maxAllowed = currentEquity * MAX_POSITION_PCT;
      if (orderValue > maxAllowed) {
        debugLog.push(`${decision.symbol}: BLOCKED — 18% cap (order=$${orderValue.toFixed(0)}, max=$${maxAllowed.toFixed(0)})`);
        console.warn(`BUY blocked — $${orderValue.toFixed(0)} exceeds 18% cap ($${maxAllowed.toFixed(0)}) for ${decision.symbol}`);
        await logTrade({
          symbol: decision.symbol,
          action: "BUY_BLOCKED",
          quantity: finalQty,
          reason: `Order value $${orderValue.toFixed(0)} exceeds 25% position cap`,
          status: "error",
        });
        continue;
      }

      // Sector concentration guard
      const sectorCheck = checkSectorConcentration(positions as Record<string, unknown>[], decision.symbol);
      if (!sectorCheck.allowed) {
        debugLog.push(decision.symbol + ": BLOCKED sector: " + sectorCheck.reason);
        console.warn("BUY blocked sector: " + sectorCheck.reason);
        await logTrade({ symbol: decision.symbol, action: "BUY_BLOCKED", quantity: finalQty, reason: sectorCheck.reason, status: "error" });
        continue;
      }

      // Sector momentum gate - skip buys when sector ETF is red
      if (!LEVERAGED_BEAR_ETFS.has(decision.symbol) && !VOLATILITY_ETFS.has(decision.symbol)) {
        const symSector = guessSector(decision.symbol);
        const sectorEtf = SECTOR_ETFS[symSector] ?? "SPY";
        const sectorChg = marketData[sectorEtf]?.tech.change_pct ?? null;
        if (sectorChg !== null && sectorChg < -0.3) {
          const symScore = quantScores.find(s => s.symbol === decision.symbol)?.score ?? 0;
          if (symScore < 40) {
            debugLog.push(`${decision.symbol}: BLOCKED - sector red (${symSector}/${sectorEtf} ${sectorChg.toFixed(2)}%, score ${symScore} < 40)`);
            console.warn(`📉 SECTOR GATE: ${decision.symbol} blocked - ${symSector} down ${sectorChg.toFixed(2)}%`);
            await logTrade({ symbol: decision.symbol, action: "BUY_BLOCKED", quantity: finalQty,
              reason: `Sector gate: ${symSector} (${sectorEtf}) down ${sectorChg.toFixed(2)}%, score ${symScore} too low`, status: "error" });
            continue;
          }
          debugLog.push(`${decision.symbol}: SECTOR OVERRIDE - ${symSector} red but score ${symScore} >= 40`);
        }
      }

      console.log(`Position sizing: Grok=${decision.quantity}, ATR-optimal=${sizing.qty}, final=${finalQty} | stopDist=$${sizing.stopDistance.toFixed(2)} (${(sizing.stopLossPct * 100).toFixed(1)}%)`);
      decision.quantity = finalQty;

      // Bracket order with dynamic ATR stop-loss
      debugLog.push(`${decision.symbol}: ATTEMPTING BUY ${finalQty} @ $${effectivePrice} (stop=${(sizing.stopLossPct * 100).toFixed(1)}%)`);
      alpacaOrder = await placeOrderWithStopLoss(decision.symbol, finalQty, effectivePrice, sizing.stopLossPct);
      if (alpacaOrder?.code || (alpacaOrder?.message && !alpacaOrder?.id)) {
        debugLog.push(`${decision.symbol}: ALPACA REJECTED — ${JSON.stringify(alpacaOrder).slice(0, 200)}`);
        console.error("Alpaca BUY rejected:", alpacaOrder);
        await logTrade({
          symbol: decision.symbol,
          action: "BUY_REJECTED",
          quantity: decision.quantity,
          reason: JSON.stringify(alpacaOrder),
          status: "error",
        });
        continue;
      }

    } else if (decision.action === "SELL" && isValidSymbol(decision.symbol) && isValidQuantity(decision.quantity)) {

      // Validate sell quantity against held position
      const heldPosition = (positions as Record<string, unknown>[]).find(p => p.symbol === decision.symbol);
      const heldQty = heldPosition ? parseInt(String(heldPosition.qty)) : 0;
      if (heldQty <= 0) {
        console.warn(`SELL ignored — no open position in ${decision.symbol}`);
        continue;
      }
      const sellQty = Math.min(decision.quantity, heldQty);
      if (sellQty !== decision.quantity) {
        console.warn(`SELL qty adjusted: requested ${decision.quantity}, holding ${heldQty} — selling ${sellQty}`);
      }

      // Cancel any open orders (stop-loss, etc.) that hold shares before selling
      await cancelOrdersForSymbol(decision.symbol);
      const priceExit = await getLatestPrice(decision.symbol) || marketData[decision.symbol]?.tech.price;
      alpacaOrder = await placeOrder(decision.symbol, sellQty, "sell");
      if (alpacaOrder?.code || alpacaOrder?.message) {
        console.error("Alpaca SELL rejected:", alpacaOrder);
        await logTrade({
          symbol: decision.symbol,
          action: "SELL_REJECTED",
          quantity: sellQty,
          reason: JSON.stringify(alpacaOrder),
          status: "error",
        });
        continue;
      }
      if (priceExit) await closeBuyTrade(decision.symbol, priceExit);
      priceEntry = priceExit;
      decision.quantity = sellQty;

    } else if (decision.action === "SHORT" && isValidSymbol(decision.symbol) && isValidQuantity(decision.quantity)) {
      // SHORT SELLING — profit from price drops in bearish/overextended stocks
      // Alpaca paper accounts support short selling — place a sell order without holding shares
      // Only short when SPY is bearish OR stock is overbought (RSI > 75)
      const shortData = marketData[decision.symbol];
      const shortRsi = shortData?.tech.rsi14 ?? 50;
      if (spyTrendBullish && shortRsi < 75) {
        debugLog.push(`${decision.symbol}: SHORT BLOCKED — market bullish and RSI ${shortRsi} < 75`);
        continue;
      }
      // Check we don't already have a position (long or short) in this symbol
      const existingPos = (positions as Record<string, unknown>[]).find(p => p.symbol === decision.symbol);
      if (existingPos) {
        debugLog.push(`${decision.symbol}: SHORT BLOCKED — already have position`);
        continue;
      }
      // Position sizing: smaller for shorts (more risky) — max 10% of equity
      const shortPrice = shortData?.tech.price ?? 0;
      const shortEquity = currentEquity * 0.10;
      let shortQty = shortPrice > 0 ? Math.max(1, Math.floor(shortEquity / shortPrice)) : 0;
      shortQty = Math.min(shortQty, decision.quantity);
      if (shortQty <= 0) continue;

      alpacaOrder = await placeOrder(decision.symbol, shortQty, "sell");
      if (alpacaOrder?.code || alpacaOrder?.message) {
        console.error("Alpaca SHORT rejected:", alpacaOrder);
        continue;
      }
      console.log(`🔻 SHORT: ${decision.symbol} × ${shortQty} shares @ ~$${shortPrice.toFixed(2)}`);
      priceEntry = shortPrice;
      decision.quantity = shortQty;

    } else if (decision.action === "HOLD") {
      continue;
    } else {
      debugLog.push(`${decision.symbol}: SKIPPED — failed validation (action=${decision.action}, validSym=${isValidSymbol(decision.symbol)}, validQty=${isValidQuantity(decision.quantity)}, qty=${decision.quantity}, type=${typeof decision.quantity})`);
      console.warn("Invalid decision ignored:", JSON.stringify(decision));
      continue;
    }

    // Attach quant score breakdown to BUY trades for later analysis
    let tradeReason = decision.reason;
    if (decision.action === "BUY") {
      const qs = quantScores.find(s => s.symbol === decision.symbol);
      if (qs) {
        const atrVal = marketData[decision.symbol]?.tech.atr14 ?? null;
        const isLev = ALL_LEVERAGED_ETFS.has(decision.symbol);
        tradeReason += ` | [QS:${qs.score} M:${qs.momentum} V:${qs.volumeScore} R:${qs.rsiSignal} MACD:${qs.macdSignal} P:${qs.patternScore} S:${qs.socialBuzz} O:${qs.optionsFlow} ATR:${atrVal ?? "N/A"}${isLev ? " LEV" : ""}]`;
      }
    }
    await logTrade({
      symbol: decision.symbol ?? null,
      action: decision.action,
      quantity: decision.quantity ?? null,
      reason: tradeReason,
      price_entry: priceEntry,
      alpaca_order_id: alpacaOrder?.id ?? null,
      status: decision.action === "SELL" ? "closed" : "open",
    });

    if (alpacaOrder) {
      debugLog.push(`${decision.symbol}: ✅ ORDER EXECUTED (id=${alpacaOrder.id})`);
      executedOrders.push(alpacaOrder);
    }
  }

  if (cycleCount > 0 && cycleCount % 5 === 0) {
    await Promise.all([
      generateAndSaveAnalysis(cycleCount, account, positions),
      computeAndSaveMetrics(cycleCount, account, positions),
    ]);
  }

  const weekDeadline = getCurrentWeekDeadline();
  if (isLastCycleOfWeek(new Date(), weekDeadline)) {
    await generateWeeklySummary(account, positions, cycleCount);
  }

  console.log(`🔄 FULL CYCLE complete — ${executedOrders.length} orders executed.`);
  return new Response(JSON.stringify({
    status: "ok",
    mode: scanTriggers.length > 0 ? "trigger" : "scheduled",
    tradingMode,
    todayPnl: todayPnl.toFixed(2),
    triggers: scanTriggers.length,
    decisions,
    quantScores: quantScores.slice(0, 10).map(s => ({ sym: s.symbol, score: s.score, reason: s.reason })),
    executedOrders,
    debugLog,
    diagnostics: _diag,
  }), { status: 200 });
}

// ── Main Handler ─────────────────────────────────────────────────────────────
// Called by pg_cron every 3 min — always runs full cycle
Deno.serve(async (req) => {

  // Auth: shared secret (check header first, then body)
  const expectedSecret = Deno.env.get("BOT_SECRET");
  const authHeader = req.headers.get("Authorization") ?? "";
  let providedSecret = authHeader.replace("Bearer ", "").trim();

  // Also check body for secret (pg_cron sends it in the body)
  let bodyData: Record<string, unknown> = {};
  if (!providedSecret || providedSecret !== expectedSecret) {
    try {
      bodyData = await req.clone().json();
      if (bodyData?.secret) providedSecret = String(bodyData.secret);
    } catch { /* no body or not JSON */ }
  }

  if (!expectedSecret || providedSecret !== expectedSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  // Parse mode from URL: ?mode=scan or ?mode=full (default: full)
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "full";

  // Distributed lock
  const { data: claimed } = await supabase.rpc("try_claim_bot_run");
  if (!claimed) {
    console.log("Bot already running — skipping.");
    return new Response(JSON.stringify({ status: "already_running", mode }), { status: 200 });
  }

  try {
    // ── EOD NUCLEAR LIQUIDATION MODE ──────────────────────────────────────────
    // Dedicated mode that BYPASSES market-closed check and force-sells everything.
    // Called by a separate cron job at 3:50 and 3:55 PM ET.
    if (mode === "eod_liquidate") {
      console.log("🔴 EOD NUCLEAR LIQUIDATION — force-closing ALL positions");

      // Step 1: Cancel ALL open orders (frees shares held by bracket orders)
      try {
        const cancelRes = await fetchWithTimeout(`${ALPACA_BASE_URL}/orders`, {
          method: "DELETE",
          headers: alpacaHeaders,
        });
        console.log(`  Cancelled all open orders: ${cancelRes.status}`);
      } catch (e) {
        console.error("  Failed to cancel all orders:", (e as Error).message);
      }
      await new Promise(r => setTimeout(r, 2000)); // wait for Alpaca to release shares

      // Step 2: Get current positions
      let positions: Record<string, unknown>[] = [];
      try {
        const posRes = await fetchWithTimeout(`${ALPACA_BASE_URL}/positions`, {
          headers: alpacaHeaders,
        });
        positions = await posRes.json() as Record<string, unknown>[];
      } catch (e) {
        console.error("  Failed to fetch positions:", (e as Error).message);
      }

      if (!Array.isArray(positions) || positions.length === 0) {
        console.log("  ✅ No positions to close — portfolio is flat");
        await supabase.rpc("release_bot_run");
        return new Response(JSON.stringify({ status: "eod_liquidate_done", positions_closed: 0 }), { status: 200 });
      }

      console.log(`  Found ${positions.length} open position(s) to liquidate`);

      // Step 3: Nuclear option — bulk liquidate via DELETE /positions?cancel_orders=true
      let bulkSuccess = false;
      try {
        const liquidateRes = await fetchWithTimeout(`${ALPACA_BASE_URL}/positions?cancel_orders=true`, {
          method: "DELETE",
          headers: alpacaHeaders,
        });
        const liquidateData = await liquidateRes.json();
        console.log(`  Bulk liquidation response: ${liquidateRes.status}`, JSON.stringify(liquidateData).substring(0, 500));
        bulkSuccess = liquidateRes.status >= 200 && liquidateRes.status < 300;
      } catch (e) {
        console.error("  Bulk liquidation failed:", (e as Error).message);
      }

      // Step 4: Fallback — individually sell any remaining positions
      if (!bulkSuccess) {
        console.log("  ⚠️ Bulk liquidation failed — selling positions individually");
        for (const pos of positions) {
          const sym = pos.symbol as string;
          const qty = parseInt(String(pos.qty));
          if (qty <= 0) continue;
          try {
            await cancelOrdersForSymbol(sym);
            const order = await placeOrder(sym, qty, "sell");
            console.log(`  Sold ${qty} ${sym}: ${order?.id ?? "no order id"}`);
          } catch (e) {
            console.error(`  Failed to sell ${sym}:`, (e as Error).message);
          }
        }
      }

      // Step 5: Log all liquidations to Supabase
      for (const pos of positions) {
        const sym = pos.symbol as string;
        const qty = parseInt(String(pos.qty));
        const entryPrice = parseFloat(String(pos.avg_entry_price ?? 0));
        const currentPrice = parseFloat(String(pos.current_price ?? 0));
        await logTrade({
          symbol: sym, action: "SELL", quantity: qty,
          reason: `🔴 EOD NUCLEAR LIQUIDATION — day trading, no overnight holds`,
          price_entry: entryPrice,
          price_exit: currentPrice,
          alpaca_order_id: "eod-nuclear-liquidate", status: "closed",
        });
      }

      await supabase.rpc("release_bot_run");
      return new Response(JSON.stringify({
        status: "eod_liquidate_done",
        positions_closed: positions.length,
        symbols: positions.map(p => p.symbol),
      }), { status: 200 });
    }

    const marketOpen = await isClock();
    if (!marketOpen) {
      console.log("Market closed — skipping.");
      await supabase.rpc("release_bot_run");
      return new Response(JSON.stringify({ status: "market_closed", mode }), { status: 200 });
    }

    // ALWAYS run full cycle — scan-only was too conservative and missed opportunities.
    // Pro plan can handle the compute. Every 3 min = more trades = closer to $500/day.
    const response = await runFullCycle();

    await supabase.rpc("release_bot_run");
    return response;
  } catch (err) {
    console.error(err);
    await supabase.rpc("release_bot_run");
    return new Response(JSON.stringify({ status: "error", mode, message: String(err) }), { status: 500 });
  }
});
