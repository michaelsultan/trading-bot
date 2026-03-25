import { createClient } from "jsr:@supabase/supabase-js@2";

const ALPACA_BASE_URL = "https://paper-api.alpaca.markets/v2";
const ALPACA_DATA_URL = "https://data.alpaca.markets/v2";
const GROK_BASE_URL = "https://api.x.ai/v1";

const STARTING_CAPITAL = 100_000;
const MAX_POSITION_PCT = 0.25;    // 25% max per position (enforced in code)
const MAX_DRAWDOWN_PCT = 0.15;    // halt trading if equity drops 15%
const DEFAULT_STOP_LOSS_PCT = 0.05; // fallback stop-loss if ATR unavailable
const RISK_PER_TRADE_PCT = 0.02;  // risk 2% of equity per trade (ATR-based sizing)
const ATR_STOP_MULTIPLIER = 2;    // stop-loss = entry - (2 × ATR)

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

// ── Retry Helper ─────────────────────────────────────────────────────────────
// Wraps any async function with exponential backoff retry logic.
async function withRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 1000): Promise<T> {
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
  const res = await withRetry(() => fetch(`${ALPACA_BASE_URL}/account`, { headers: alpacaHeaders }));
  const data = await res.json();
  if (data?.code || data?.message) throw new Error(`Alpaca account error: ${JSON.stringify(data)}`);
  return data;
}

async function getPositions() {
  const res = await withRetry(() => fetch(`${ALPACA_BASE_URL}/positions`, { headers: alpacaHeaders }));
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`Alpaca positions error: ${JSON.stringify(data)}`);
  return data;
}

async function isClock() {
  try {
    const res = await fetch(`${ALPACA_BASE_URL}/clock`, { headers: alpacaHeaders });
    const clock = await res.json();
    return clock.is_open as boolean;
  } catch (err) {
    console.error("isClock() failed — assuming market closed:", err);
    return false;
  }
}

// Standard market order (used for SELL)
async function placeOrder(symbol: string, qty: number, side: "buy" | "sell") {
  const res = await withRetry(() => fetch(`${ALPACA_BASE_URL}/orders`, {
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
// The stop-loss leg fires automatically if price drops DEFAULT_STOP_LOSS_PCT from entry.
async function placeOrderWithStopLoss(
  symbol: string,
  qty: number,
  entryPrice: number,
  stopLossPct = DEFAULT_STOP_LOSS_PCT
) {
  const stopPrice = +(entryPrice * (1 - stopLossPct)).toFixed(2);
  console.log(`Placing BUY ${qty} ${symbol} @ ~$${entryPrice} with stop-loss at $${stopPrice}`);
  const res = await withRetry(() => fetch(`${ALPACA_BASE_URL}/orders`, {
    method: "POST",
    headers: alpacaHeaders,
    body: JSON.stringify({
      symbol,
      qty: String(qty),
      side: "buy",
      type: "market",
      time_in_force: "gtc",       // GTC required for bracket/OTO legs
      order_class: "oto",
      stop_loss: { stop_price: String(stopPrice) },
    }),
  }));
  return res.json();
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
      const res = await withRetry(() => fetch(
        `${ALPACA_DATA_URL}/stocks/${symbol}/bars?timeframe=${timeframe}&limit=${limit}&start=${start}&feed=sip`,
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
  const techStocks = ["AAPL", "MSFT", "GOOGL", "GOOG", "META", "AMZN", "NVDA", "AMD", "INTC", "CRM", "ORCL", "ADBE", "TSLA", "AVGO", "QCOM", "MU", "ANET", "NOW", "SHOP", "SQ", "PLTR", "SNOW", "UBER", "ABNB", "COIN"];
  const healthStocks = ["JNJ", "UNH", "PFE", "ABBV", "MRK", "LLY", "TMO", "ABT", "BMY", "AMGN", "GILD", "MRNA", "BNTX"];
  const finStocks = ["JPM", "BAC", "WFC", "GS", "MS", "C", "BLK", "SCHW", "AXP", "V", "MA", "PYPL"];
  const energyStocks = ["XOM", "CVX", "COP", "EOG", "SLB", "OXY", "MPC", "PSX", "VLO"];
  const consumerStocks = ["WMT", "COST", "TGT", "HD", "LOW", "NKE", "SBUX", "MCD", "DIS", "NFLX"];
  const industrialStocks = ["CAT", "DE", "BA", "HON", "GE", "RTX", "LMT", "UPS", "FDX"];

  if (techStocks.includes(symbol)) return "Technology";
  if (healthStocks.includes(symbol)) return "Healthcare";
  if (finStocks.includes(symbol)) return "Financials";
  if (energyStocks.includes(symbol)) return "Energy";
  if (consumerStocks.includes(symbol)) return "Consumer Discretionary";
  if (industrialStocks.includes(symbol)) return "Industrials";
  return "Unknown";
}

// Cache sector ETF data for the cycle (fetched once, shared across symbols)
let _sectorCache: Record<string, number> = {};

async function fetchSectorPerformance(): Promise<Record<string, number>> {
  const etfSymbols = Object.values(SECTOR_ETFS);
  const start = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  try {
    const symbolsParam = etfSymbols.join(",");
    const res = await withRetry(() => fetch(
      `${ALPACA_DATA_URL}/stocks/bars?symbols=${symbolsParam}&timeframe=1Day&limit=2&start=${start}&feed=sip`,
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
  maxSectorPct = 0.50 // max 50% of portfolio in one sector
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
  // Fallback to fixed 5% stop if ATR is unavailable
  if (!atr || atr <= 0) {
    const stopDistance = entryPrice * DEFAULT_STOP_LOSS_PCT;
    const riskDollars = equity * RISK_PER_TRADE_PCT;
    const qty = Math.max(1, Math.floor(riskDollars / stopDistance));
    return { qty, stopDistance, stopLossPct: DEFAULT_STOP_LOSS_PCT };
  }

  const stopDistance = atr * ATR_STOP_MULTIPLIER;
  const stopLossPct = stopDistance / entryPrice;
  const riskDollars = equity * RISK_PER_TRADE_PCT;
  const qty = Math.max(1, Math.floor(riskDollars / stopDistance));
  return { qty, stopDistance, stopLossPct };
}

// FIXED: Increased from 60 to 200 bars for reliable SMA-50, MACD, and ATR calculations.
async function fetchBars(symbol: string, limit = 200): Promise<Bar[]> {
  try {
    const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const res = await withRetry(() => fetch(
      `${ALPACA_DATA_URL}/stocks/${symbol}/bars?timeframe=15Min&limit=${limit}&start=${start}&feed=sip`,
      { headers: alpacaHeaders }
    ));
    const data = await res.json();
    return data?.bars ?? [];
  } catch {
    return [];
  }
}

async function computeTechnicals(symbol: string): Promise<TechData & { symbol: string }> {
  const bars = await fetchBars(symbol, 200);
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
    const res = await withRetry(() => fetch(
      `${ALPACA_DATA_URL}/stocks/${symbol}/quotes/latest?feed=iex`,
      { headers: alpacaHeaders }
    ));
    const data = await res.json();
    return data?.quote?.ap || data?.quote?.bp || null;
  } catch {
    return null;
  }
}

async function getNews(symbol: string, limit = 5): Promise<string[]> {
  try {
    const res = await withRetry(() => fetch(
      `https://data.alpaca.markets/v1beta1/news?symbols=${symbol}&limit=${limit}`,
      { headers: alpacaHeaders }
    ));
    const data = await res.json();
    return (data?.news ?? []).map((n: Record<string, string>) => n.headline);
  } catch {
    return [];
  }
}

async function getMarketData(symbols: string[]) {
  // Fetch sector ETF performance once for the cycle (shared across all symbols)
  const sectorPerf = await fetchSectorPerformance();
  _sectorCache = sectorPerf;

  const results = await Promise.all(
    symbols.map(async (sym) => {
      const [tech, news, mtfBars] = await Promise.all([
        computeTechnicals(sym),
        getNews(sym),
        fetchBarsMultiTF(sym),
      ]);

      // Enrich with multi-timeframe analysis
      tech.mtf = analyzeMultiTimeframe(mtfBars.tf5min, mtfBars.tf15min, mtfBars.tf1hr, mtfBars.tfDaily);

      // Enrich with sector data
      tech.sector = computeSectorData(sym, tech.change_pct, sectorPerf);

      return [sym, { tech, news }] as const;
    })
  );
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
  return now.getUTCDay() === 5 && (deadline.getTime() - now.getTime()) < 60 * 60 * 1000;
}

async function generateWeeklySummary(
  account: Record<string, unknown>,
  positions: unknown[],
  cycleCount: number
) {
  const monday = new Date();
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  monday.setUTCHours(0, 0, 0, 0);

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
  return typeof q === "number" && Number.isInteger(q) && q > 0 && q < 100_000;
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
async function callGrok(prompt: string, systemPrompt?: string, liveSearch = false): Promise<string> {
  if (liveSearch) {
    const input: Array<{ role: string; content: string }> = [];
    if (systemPrompt) input.push({ role: "system", content: systemPrompt });
    input.push({ role: "user", content: prompt });

    const res = await withRetry(() => fetch(`${GROK_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("GROK_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // NOTE: Verify this model name is correct for your X.AI account.
        // Common valid names: "grok-3", "grok-3-latest", "grok-3-mini"
        model: "grok-3-latest",
        input,
        tools: [{ type: "web_search" }],
      }),
    }));
    const data = await res.json();
    const output = (data.output ?? []) as Array<Record<string, unknown>>;
    for (const item of output) {
      if (item.type === "message") {
        const content = (item.content ?? []) as Array<Record<string, unknown>>;
        for (const c of content) {
          if (c.type === "output_text") return (c.text as string) ?? "";
        }
      }
    }
    console.error("Unexpected Responses API reply:", JSON.stringify(data));
    return "";
  }

  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const res = await withRetry(() => fetch(`${GROK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Deno.env.get("GROK_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "grok-3",
      messages,
      temperature: 0.2,
    }),
  }));
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
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

// Combined full universe (deduped)
const FULL_UNIVERSE = [...new Set([...NASDAQ_BLUE_CHIPS, ...NYSE_MAJORS])];

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
      const res = await withRetry(() => fetch(
        `${ALPACA_DATA_URL}/stocks/snapshots?symbols=${symbolsParam}&feed=sip`,
        { headers: alpacaHeaders }
      ));
      const data = await res.json();
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
    const res = await withRetry(() => fetch(
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
    const res = await withRetry(() => fetch(
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

  // Gappers: stocks that opened significantly above/below yesterday's close
  // (big change_pct + reasonable volume)
  const gappers = snapshots
    .filter(s => Math.abs(s.change_pct) > 3 && s.volume > 500_000)
    .sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct))
    .slice(0, 10)
    .map(s => s.symbol);

  // Potential oversold bounces: down more than 5% today with high volume (mean-reversion plays)
  const oversold = snapshots
    .filter(s => s.change_pct < -5 && s.volume > 500_000)
    .sort((a, b) => a.change_pct - b.change_pct)
    .slice(0, 5)
    .map(s => s.symbol);

  return { momentum, volumeSpikes, gappers, oversold };
}

async function discoverSymbols(
  positions: unknown[],
  history: unknown[],
  lastAnalysis: string | null
): Promise<string[]> {
  const openSymbols = (positions as Record<string, string>[]).map((p) => p.symbol);

  // STEP 1: Scan the full universe via Alpaca snapshots (fast bulk API)
  console.log(`Scanning ${FULL_UNIVERSE.length} stocks across NASDAQ + NYSE...`);
  const [snapshots, mostActives, topMovers] = await Promise.all([
    fetchSnapshots(FULL_UNIVERSE),
    fetchMostActives(20),
    fetchTopMovers(10),
  ]);

  console.log(`Got ${snapshots.length} snapshots, ${mostActives.length} most-actives, ${topMovers.gainers.length} gainers, ${topMovers.losers.length} losers`);

  // STEP 2: Pre-screen for interesting candidates
  const screened = preScreenSymbols(snapshots);

  // Combine all candidates (deduped)
  const allCandidates = [...new Set([
    ...openSymbols,                // always include current positions
    ...screened.momentum,          // biggest movers in our universe
    ...screened.volumeSpikes,      // highest volume today
    ...screened.gappers,           // gap up/down > 3%
    ...screened.oversold,          // mean-reversion plays
    ...mostActives,                // Alpaca most-actives (may include stocks outside our universe)
    ...topMovers.gainers,          // top gainers market-wide
    ...topMovers.losers,           // top losers (potential shorts or bounces)
  ])];

  // Build a summary of the scan for Grok
  const scanSummary = snapshots
    .filter(s => allCandidates.includes(s.symbol))
    .sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct))
    .slice(0, 30)
    .map(s => `${s.symbol}: $${s.price.toFixed(2)} (${s.change_pct > 0 ? "+" : ""}${s.change_pct}%) vol=${(s.volume / 1000).toFixed(0)}K`)
    .join("\n");

  // STEP 3: Let Grok refine — pick the best 8-12 from the pre-screened candidates
  const prompt = `Tu es un trader IA. Le scanner de marché a identifié les candidats suivants.

## Scan results (NASDAQ blue chips + NYSE majors, triés par mouvement)
${scanSummary}

## Candidats par catégorie
- Momentum (biggest movers) : ${screened.momentum.join(", ")}
- Volume spikes : ${screened.volumeSpikes.join(", ")}
- Gappers (>3%) : ${screened.gappers.length ? screened.gappers.join(", ") : "aucun"}
- Oversold bounces (<-5%) : ${screened.oversold.length ? screened.oversold.join(", ") : "aucun"}
- Most actives market-wide : ${mostActives.join(", ")}
- Top gainers : ${topMovers.gainers.join(", ")}
- Top losers : ${topMovers.losers.join(", ")}

## Positions actuelles
${openSymbols.length ? openSymbols.join(", ") : "aucune"}

## Contexte
- Derniers trades : ${JSON.stringify(history.slice(0, 10), null, 2)}
${lastAnalysis ? `\nAuto-analyses récentes :\n${lastAnalysis}\n` : ""}

## Mission
À partir de ces candidats pré-scannés ET de ta propre recherche live (X, Reddit, news), sélectionne les **8 à 12 meilleures opportunités** RIGHT NOW.

Critères de sélection :
1. Momentum technique confirmé (gap + volume)
2. Catalyseur identifiable (earnings, news, sector rotation)
3. Rapport risque/récompense favorable
4. Diversification sectorielle

Réponds UNIQUEMENT en JSON valide, sans markdown :
{
  "symbols": ["TICKER1", "TICKER2", ...],
  "rationale": "résumé en 3 phrases : thèmes principaux et pourquoi ces symboles maintenant"
}`;

  try {
    const content = await callGrok(prompt, undefined, true);
    const parsed = extractJson(content) as Record<string, unknown>;
    const grokPicks: string[] = (parsed.symbols as string[]) ?? [];
    const final = [...new Set([...grokPicks, ...openSymbols])];
    console.log(`Discovery complete: ${final.length} symbols (${grokPicks.length} Grok picks + ${openSymbols.length} open positions)`);
    return final;
  } catch {
    // Fallback: use the top pre-screened candidates if Grok fails
    console.error("Grok discovery failed — using pre-screened candidates");
    const fallback = [...new Set([...openSymbols, ...screened.momentum.slice(0, 8)])];
    return fallback.length ? fallback : ["SPY", "QQQ"];
  }
}

function getCurrentWeekDeadline(): Date {
  const now = new Date();
  const daysUntilFriday = ((5 - now.getUTCDay()) + 7) % 7;
  const friday = new Date(now);
  friday.setUTCDate(now.getUTCDate() + daysUntilFriday);
  friday.setUTCHours(20, 0, 0, 0);
  if (friday <= now) friday.setUTCDate(friday.getUTCDate() + 7);
  return friday;
}

function estimateRemainingCycles(now: Date, deadline: Date): number {
  const MARKET_OPEN_UTC = 13 * 60 + 30;
  const MARKET_CLOSE_UTC = 20 * 60;
  let remaining = 0;
  const cursor = new Date(now);
  while (cursor < deadline) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) {
      const minutesUTC = cursor.getUTCHours() * 60 + cursor.getUTCMinutes();
      if (minutesUTC >= MARKET_OPEN_UTC && minutesUTC < MARKET_CLOSE_UTC) {
        remaining += 30;
      }
    }
    cursor.setTime(cursor.getTime() + 30 * 60 * 1000);
  }
  return Math.floor(remaining / 30);
}

async function makeDecision(
  account: Record<string, unknown>,
  positions: unknown[],
  history: unknown[],
  marketData: Record<string, { tech: TechData & { symbol: string }; news: string[] }>,
  lastAnalysis: string | null,
  cycleCount: number,
  latestMetrics: string | null = null
) {
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

      // News
      block += `\n  News: ${news.length ? news.slice(0, 3).join(" | ") : "aucune"}`;
      return block;
    })
    .join("\n\n");

  const now = new Date();
  const DEADLINE = getCurrentWeekDeadline();
  const hoursLeft = Math.max(0, Math.floor((DEADLINE.getTime() - now.getTime()) / (1000 * 60 * 60)));
  const cyclesLeft = estimateRemainingCycles(now, DEADLINE);

  const systemPrompt = `Tu es le moteur de décision d'un bot de trading autonome opérant sur les marchés américains.

## Comment tu fonctionnes
Toutes les 30 minutes pendant les heures de marché, tu reçois l'état complet du portfolio et les données de marché en temps réel.

## Ton objectif
Faire croître un portfolio de $100 000 au maximum sur la semaine en cours.

## Règles non négociables
1. Maximum 25% du portfolio total par position
2. Ne jamais perdre plus de 15% du portfolio initial
3. Tu peux placer plusieurs ordres simultanément
4. Maximum 50% du portfolio dans un même secteur

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

## Stratégie de décision (Balanced)
1. **Évalue chaque position ouverte** : PnL, momentum, patterns, volume
2. **Score de conviction** : Un bon trade doit combiner ≥2 signaux alignés parmi : pattern confirmé + confluence multi-TF positive + accumulation détectée + indicateurs techniques favorables
3. **Scanne le marché** : quelles opportunités ont le meilleur score de conviction RIGHT NOW
4. **Diversification sectorielle** : vérifie la répartition sectorielle avant d'acheter
5. **Décide au niveau du portfolio** : quelle combinaison maximise le gain ajusté au risque`;

  const userPrompt = `## Horodatage
${now.toISOString()} — Cycle #${cycleCount} — Il te reste ~${cyclesLeft} cycles (~${hoursLeft}h de marché).

## Portfolio actuel
- Cash disponible : $${account.cash}
- Valeur totale : $${account.equity}
- Positions ouvertes :
${(positions as Record<string, unknown>[]).map((p) =>
  ` ${p.symbol}: ${p.qty} actions | Prix moyen : $${p.avg_entry_price} | PnL : $${p.unrealized_pl}`
).join("\n") || " Aucune"}

## Rotation sectorielle (performance ETFs sectoriels)
${Object.entries(SECTOR_ETFS).map(([sector, etf]) => {
  const perf = _sectorCache[etf];
  return perf != null ? `  ${sector} (${etf}): ${perf > 0 ? "+" : ""}${perf}%` : null;
}).filter(Boolean).join("\n") || "  Données sectorielles non disponibles"}

## Données de marché
${marketSummary}

## Historique des ${history.length} derniers trades
${JSON.stringify(history, null, 2)}
${lastAnalysis ? `\n## Tes dernières auto-analyses\n${lastAnalysis}\n` : ""}
${latestMetrics ? `\n## Performance cumulée du bot\n${latestMetrics}\n` : ""}
## Instructions
Réponds UNIQUEMENT en JSON valide (tableau) :
[
  {
    "action": "BUY" | "SELL" | "HOLD",
    "symbol": "TICKER ou null",
    "quantity": nombre ou null,
    "reason": "justification concise"
  }
]`;

  let content = "";
  try {
    content = await callGrok(userPrompt, systemPrompt, true);
    const parsed = extractJson(content);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    console.error("Decision parse error — raw Grok response:", content);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ADAPTIVE TWO-TIER CYCLE ENGINE
//
// FAST SCAN (every 5 min):
//   Lightweight — snapshot-only scan of full universe + open positions.
//   Checks for triggers: volume spikes, big moves, position alerts.
//   If a trigger fires → immediately launches a full cycle.
//   Cost: 2-3 Alpaca API calls. Zero Grok calls. ~2 seconds.
//
// FULL CYCLE (every 30 min, OR on trigger from fast scan):
//   Heavy — multi-TF analysis, patterns, Grok AI decisions, order execution.
//   Cost: 50+ Alpaca API calls + 2-3 Grok calls. ~15-30 seconds.
//
// Call with ?mode=scan for fast scan, ?mode=full for full cycle.
// pg_cron schedules: scan every 5 min, full every 30 min.
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

  // 1. Big movers in the universe (>4% move with volume)
  for (const snap of snapshots) {
    if (Math.abs(snap.change_pct) > 6 && snap.volume > 1_000_000) {
      triggers.push({
        type: "big_move",
        symbol: snap.symbol,
        detail: `${snap.change_pct > 0 ? "+" : ""}${snap.change_pct}% on ${(snap.volume / 1_000_000).toFixed(1)}M volume`,
        severity: "high",
      });
    } else if (Math.abs(snap.change_pct) > 4 && snap.volume > 500_000) {
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

    // Position down more than 3% since entry — potential exit signal
    if (unrealizedPct < -3) {
      triggers.push({
        type: "position_alert",
        symbol: String(pos.symbol),
        detail: `Open position down ${unrealizedPct.toFixed(1)}% — consider exit`,
        severity: unrealizedPct < -5 ? "high" : "medium",
      });
    }

    // Position up more than 5% — potential profit-taking signal
    if (unrealizedPct > 5) {
      triggers.push({
        type: "position_alert",
        symbol: String(pos.symbol),
        detail: `Open position up +${unrealizedPct.toFixed(1)}% — consider taking profit`,
        severity: unrealizedPct > 10 ? "high" : "medium",
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

  // 3. Gappers — stocks gapping hard with unusual volume (potential entries)
  for (const snap of snapshots) {
    if (Math.abs(snap.change_pct) > 5 && snap.volume > 2_000_000) {
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
  // - 3+ high-severity signals, OR
  // - Any high-severity position alert (our money is at risk), OR
  // - 5+ medium+ signals (market is unusually active)
  return highCount >= 3 || positionAlerts >= 1 || triggers.filter(t => t.severity !== "low").length >= 5;
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

  const [account, positions] = await Promise.all([getAccount(), getPositions()]);
  const currentEquity = parseFloat(account.equity);

  // Drawdown circuit breaker
  if (currentEquity < STARTING_CAPITAL * (1 - MAX_DRAWDOWN_PCT)) {
    const threshold = STARTING_CAPITAL * (1 - MAX_DRAWDOWN_PCT);
    console.warn(`DRAWDOWN LIMIT HIT — equity $${currentEquity.toFixed(2)} is below $${threshold.toFixed(2)}. Halting.`);
    return new Response(JSON.stringify({ status: "drawdown_limit", equity: currentEquity }), { status: 200 });
  }

  await logSnapshot(parseFloat(account.cash), currentEquity, positions);

  const [history, lastAnalysis, latestMetrics] = await Promise.all([
    getTradeHistory(50),
    getLastAnalyses(),
    getLatestMetrics(),
  ]);

  const symbols = await discoverSymbols(positions, history, lastAnalysis);
  console.log("Symbols to analyze:", symbols);

  const marketData = await getMarketData(symbols);
  const cycleCount = await getCycleCount();
  const decisions = await makeDecision(account, positions, history, marketData, lastAnalysis, cycleCount, latestMetrics);

  if (!decisions) {
    return new Response(JSON.stringify({ status: "grok_parse_error" }), { status: 200 });
  }

  console.log("Grok decisions:", decisions);

  const executedOrders = [];
  for (const decision of decisions) {
    let alpacaOrder = null;
    let priceEntry: number | null = null;

    if (decision.action === "BUY" && isValidSymbol(decision.symbol) && isValidQuantity(decision.quantity)) {
      const alreadyOpen = (positions as Record<string, string>[]).some(p => p.symbol === decision.symbol);
      if (alreadyOpen) {
        console.warn(`BUY ignored — position already open on ${decision.symbol}`);
        continue;
      }

      // ATR-Based Position Sizing
      const symbolPrice = marketData[decision.symbol]?.tech.price ?? 0;
      const symbolATR = marketData[decision.symbol]?.tech.atr14 ?? null;
      priceEntry = await getLatestPrice(decision.symbol) || symbolPrice;
      const effectivePrice = priceEntry ?? symbolPrice;

      const sizing = atrPositionSize(currentEquity, effectivePrice, symbolATR);
      const finalQty = Math.min(decision.quantity, sizing.qty);

      // Position size guard — 25% cap
      const orderValue = finalQty * effectivePrice;
      const maxAllowed = currentEquity * MAX_POSITION_PCT;
      if (orderValue > maxAllowed) {
        console.warn(`BUY blocked — $${orderValue.toFixed(0)} exceeds 25% cap ($${maxAllowed.toFixed(0)}) for ${decision.symbol}`);
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
        console.warn(`BUY blocked — sector concentration: ${sectorCheck.reason}`);
        await logTrade({
          symbol: decision.symbol,
          action: "BUY_BLOCKED",
          quantity: finalQty,
          reason: sectorCheck.reason!,
          status: "error",
        });
        continue;
      }

      console.log(`Position sizing: Grok=${decision.quantity}, ATR-optimal=${sizing.qty}, final=${finalQty} | stopDist=$${sizing.stopDistance.toFixed(2)} (${(sizing.stopLossPct * 100).toFixed(1)}%)`);
      decision.quantity = finalQty;

      // Bracket order with dynamic ATR stop-loss
      alpacaOrder = await placeOrderWithStopLoss(decision.symbol, finalQty, effectivePrice, sizing.stopLossPct);
      if (alpacaOrder?.code || alpacaOrder?.message) {
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

    } else if (decision.action === "HOLD") {
      // No action taken — skip logging to keep trades table clean
      console.log(`HOLD on ${decision.symbol || 'portfolio'}: ${decision.reason}`);
      continue;
    } else {
      console.warn("Invalid decision ignored:", JSON.stringify(decision));
      continue;
    }

    await logTrade({
      symbol: decision.symbol ?? null,
      action: decision.action,
      quantity: decision.quantity ?? null,
      reason: decision.reason,
      price_entry: priceEntry,
      alpaca_order_id: alpacaOrder?.id ?? null,
      status: decision.action === "SELL" ? "closed" : "open",
    });

    if (alpacaOrder) executedOrders.push(alpacaOrder);
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
    triggers: scanTriggers.length,
    decisions,
    executedOrders,
  }), { status: 200 });
}

// ── Main Handler ─────────────────────────────────────────────────────────────
// Called by pg_cron with ?mode=scan (every 5 min) or ?mode=full (every 30 min)
Deno.serve(async (req) => {

  // Auth: shared secret
  const expectedSecret = Deno.env.get("BOT_SECRET");
  const authHeader = req.headers.get("Authorization") ?? "";
  const providedSecret = authHeader.replace("Bearer ", "").trim();
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
    const marketOpen = await isClock();
    if (!marketOpen) {
      console.log("Market closed — skipping.");
      await supabase.rpc("release_bot_run");
      return new Response(JSON.stringify({ status: "market_closed", mode }), { status: 200 });
    }

    let response: Response;
    if (mode === "scan") {
      response = await runFastScan();
    } else {
      response = await runFullCycle();
    }

    await supabase.rpc("release_bot_run");
    return response;
  } catch (err) {
    console.error(err);
    await supabase.rpc("release_bot_run");
    return new Response(JSON.stringify({ status: "error", mode, message: String(err) }), { status: 500 });
  }
});
