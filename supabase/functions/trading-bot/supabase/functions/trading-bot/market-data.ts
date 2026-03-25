// ── Market Data: Technicals, Bars, Indicators ────────────────────────────────

import type { Bar, TechData, VolumeProfile, MultiTimeframeSignal, SectorData, PatternSignal } from "./types.ts";
import { ALPACA_DATA_URL, SECTOR_ETFS } from "./config.ts";
import { guessSector } from "./config.ts";
import { fetchWithTimeout, withRetry, sma, ema } from "./utils.ts";
import { alpacaHeaders } from "./execution.ts";

// ── Wilder's RSI ─────────────────────────────────────────────────────────────
export function wilderRSI(closes: number[], period = 14): number | null {
  if (closes.length < period + 1) return null;
  const changes = closes.slice(1).map((v, i) => v - closes[i]);
  let avgGain = changes.slice(0, period).reduce((s, c) => s + Math.max(c, 0), 0) / period;
  let avgLoss = changes.slice(0, period).reduce((s, c) => s + Math.max(-c, 0), 0) / period;
  for (const change of changes.slice(period)) {
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }
  return avgLoss === 0 ? 100 : +(100 - 100 / (1 + avgGain / avgLoss)).toFixed(1);
}

// ── Wilder's ATR ─────────────────────────────────────────────────────────────
export function wilderATR(bars: Bar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const trueRanges = bars.slice(1).map((bar, i) => {
    const prevClose = bars[i].c;
    return Math.max(bar.h - bar.l, Math.abs(bar.h - prevClose), Math.abs(bar.l - prevClose));
  });
  let atrVal = trueRanges.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (const tr of trueRanges.slice(period)) {
    atrVal = (atrVal * (period - 1) + tr) / period;
  }
  return +atrVal.toFixed(4);
}

// ── Bollinger Bands ──────────────────────────────────────────────────────────
export function bollingerBands(closes: number[], period = 20): { upper: number; lower: number; pct: number } | null {
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

// ── VWAP ─────────────────────────────────────────────────────────────────────
export function computeVWAP(bars: Bar[]): number | null {
  if (!bars.length) return null;
  const totalVolume = bars.reduce((s, b) => s + b.v, 0);
  if (totalVolume === 0) return null;
  const tpv = bars.reduce((s, b) => s + ((b.h + b.l + b.c) / 3) * b.v, 0);
  return +(tpv / totalVolume).toFixed(2);
}

// ── Pivot Points ─────────────────────────────────────────────────────────────
export function findPivots(bars: Bar[], lookback = 5): { highs: number[]; lows: number[]; highIdx: number[]; lowIdx: number[] } {
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

// ── Chart Pattern Detection ──────────────────────────────────────────────────
export function detectPatterns(bars: Bar[]): PatternSignal[] {
  if (bars.length < 30) return [];
  const patterns: PatternSignal[] = [];
  const { highs, lows, highIdx, lowIdx } = findPivots(bars, 5);
  const last = bars[bars.length - 1].c;
  const tolerance = 0.02;

  // Double Bottom
  if (lows.length >= 2) {
    const [l1, l2] = [lows[lows.length - 2], lows[lows.length - 1]];
    if (Math.abs(l1 - l2) / l1 < tolerance && last > l2) {
      const neckIdx1 = lowIdx[lowIdx.length - 2];
      const neckIdx2 = lowIdx[lowIdx.length - 1];
      const between = bars.slice(neckIdx1, neckIdx2 + 1);
      const neckline = Math.max(...between.map(b => b.h));
      const breakout = last > neckline;
      patterns.push({
        name: "double_bottom", direction: "bullish",
        confidence: breakout ? 0.85 : 0.6,
        description: `Double bottom at $${l1.toFixed(2)}/${l2.toFixed(2)}, neckline $${neckline.toFixed(2)}${breakout ? " — BREAKOUT CONFIRMED" : " — watching for neckline break"}`,
      });
    }
  }

  // Double Top
  if (highs.length >= 2) {
    const [h1, h2] = [highs[highs.length - 2], highs[highs.length - 1]];
    if (Math.abs(h1 - h2) / h1 < tolerance && last < h2) {
      const neckIdx1 = highIdx[highIdx.length - 2];
      const neckIdx2 = highIdx[highIdx.length - 1];
      const between = bars.slice(neckIdx1, neckIdx2 + 1);
      const neckline = Math.min(...between.map(b => b.l));
      const breakdown = last < neckline;
      patterns.push({
        name: "double_top", direction: "bearish",
        confidence: breakdown ? 0.85 : 0.6,
        description: `Double top at $${h1.toFixed(2)}/${h2.toFixed(2)}, neckline $${neckline.toFixed(2)}${breakdown ? " — BREAKDOWN CONFIRMED" : " — watching for neckline break"}`,
      });
    }
  }

  // Head and Shoulders
  if (highs.length >= 3) {
    const [h1, h2, h3] = highs.slice(-3);
    if (h2 > h1 && h2 > h3 && Math.abs(h1 - h3) / h1 < tolerance * 2) {
      const shoulderAvg = (h1 + h3) / 2;
      const headRatio = (h2 - shoulderAvg) / shoulderAvg;
      if (headRatio > 0.02 && headRatio < 0.15) {
        patterns.push({
          name: "head_and_shoulders", direction: "bearish",
          confidence: last < shoulderAvg ? 0.8 : 0.55,
          description: `H&S: left shoulder $${h1.toFixed(2)}, head $${h2.toFixed(2)}, right shoulder $${h3.toFixed(2)}${last < shoulderAvg ? " — neckline broken" : ""}`,
        });
      }
    }
  }

  // Inverse Head and Shoulders
  if (lows.length >= 3) {
    const [l1, l2, l3] = lows.slice(-3);
    if (l2 < l1 && l2 < l3 && Math.abs(l1 - l3) / l1 < tolerance * 2) {
      const shoulderAvg = (l1 + l3) / 2;
      const headRatio = (shoulderAvg - l2) / shoulderAvg;
      if (headRatio > 0.02 && headRatio < 0.15) {
        patterns.push({
          name: "inverse_head_and_shoulders", direction: "bullish",
          confidence: last > shoulderAvg ? 0.8 : 0.55,
          description: `Inv H&S: left $${l1.toFixed(2)}, head $${l2.toFixed(2)}, right $${l3.toFixed(2)}${last > shoulderAvg ? " — neckline broken" : ""}`,
        });
      }
    }
  }

  // Bull Flag / Bear Flag
  if (bars.length >= 40) {
    const flagPole = bars.slice(-40, -15);
    const flag = bars.slice(-15);
    const poleStart = flagPole[0].c;
    const poleEnd = flagPole[flagPole.length - 1].c;
    const poleChange = (poleEnd - poleStart) / poleStart;
    const flagHighs = flag.map(b => b.h);
    const flagLows = flag.map(b => b.l);
    const flagRange = (Math.max(...flagHighs) - Math.min(...flagLows)) / poleEnd;

    if (poleChange > 0.05 && flagRange < 0.04) {
      patterns.push({
        name: "bull_flag", direction: "bullish", confidence: 0.7,
        description: `Bull flag: ${(poleChange * 100).toFixed(1)}% pole, ${(flagRange * 100).toFixed(1)}% flag range — potential upside continuation`,
      });
    }
    if (poleChange < -0.05 && flagRange < 0.04) {
      patterns.push({
        name: "bear_flag", direction: "bearish", confidence: 0.7,
        description: `Bear flag: ${(poleChange * 100).toFixed(1)}% pole, ${(flagRange * 100).toFixed(1)}% flag range — potential downside continuation`,
      });
    }
  }

  // Ascending / Descending Wedge
  if (highs.length >= 3 && lows.length >= 3) {
    const recentHighs = highs.slice(-3);
    const recentLows = lows.slice(-3);
    const highSlope = (recentHighs[2] - recentHighs[0]) / recentHighs[0];
    const lowSlope = (recentLows[2] - recentLows[0]) / recentLows[0];
    if (highSlope > 0.01 && lowSlope > 0.01 && lowSlope > highSlope) {
      patterns.push({
        name: "rising_wedge", direction: "bearish", confidence: 0.65,
        description: `Rising wedge: highs +${(highSlope * 100).toFixed(1)}%, lows +${(lowSlope * 100).toFixed(1)}% — converging, bearish reversal likely`,
      });
    }
    if (highSlope < -0.01 && lowSlope < -0.01 && highSlope < lowSlope) {
      patterns.push({
        name: "falling_wedge", direction: "bullish", confidence: 0.65,
        description: `Falling wedge: highs ${(highSlope * 100).toFixed(1)}%, lows ${(lowSlope * 100).toFixed(1)}% — converging, bullish reversal likely`,
      });
    }
  }

  // Cup and Handle
  if (bars.length >= 60 && highs.length >= 2 && lows.length >= 1) {
    const leftRim = highs[0];
    const cupBottom = Math.min(...lows);
    const rightRim = highs[highs.length - 1];
    const cupDepth = (leftRim - cupBottom) / leftRim;
    const rimDiff = Math.abs(leftRim - rightRim) / leftRim;
    if (cupDepth > 0.05 && cupDepth < 0.35 && rimDiff < 0.04) {
      const recentBars = bars.slice(-10);
      const handleLow = Math.min(...recentBars.map(b => b.l));
      const handleDepth = (rightRim - handleLow) / rightRim;
      if (handleDepth > 0.01 && handleDepth < cupDepth * 0.5) {
        patterns.push({
          name: "cup_and_handle", direction: "bullish",
          confidence: last > rightRim ? 0.8 : 0.6,
          description: `Cup & Handle: rim $${leftRim.toFixed(2)}/$${rightRim.toFixed(2)}, cup depth ${(cupDepth * 100).toFixed(0)}%, handle ${(handleDepth * 100).toFixed(1)}%${last > rightRim ? " — BREAKOUT" : ""}`,
        });
      }
    }
  }

  return patterns;
}

// ── Volume Profile & Order Flow ──────────────────────────────────────────────
export function analyzeVolumeProfile(bars: Bar[]): VolumeProfile {
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

  let adLine = 0;
  for (const bar of bars) {
    const range = bar.h - bar.l;
    if (range > 0) {
      const clv = ((bar.c - bar.l) - (bar.h - bar.c)) / range;
      adLine += clv * bar.v;
    }
  }

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

  const signals: string[] = [];
  if (volRatio && volRatio > 2.0) signals.push(`Unusual volume (${volRatio}× avg)`);
  if (isClimax) signals.push("CLIMAX volume — potential reversal");
  const priceUp = bars[bars.length - 1].c > bars[bars.length - 2]?.c;
  const priceDown = bars[bars.length - 1].c < bars[bars.length - 2]?.c;
  if (priceUp && volRatio && volRatio > 1.5 && obvTrend === "rising") {
    signals.push("Institutional ACCUMULATION detected (price up + high vol + rising OBV)");
  }
  if (priceDown && volRatio && volRatio > 1.5 && obvTrend === "falling") {
    signals.push("Institutional DISTRIBUTION detected (price down + high vol + falling OBV)");
  }
  if (priceDown && obvTrend === "rising") {
    signals.push("Stealth accumulation — price falling but OBV rising (smart money buying)");
  }
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

// ── Multi-Timeframe Analysis ─────────────────────────────────────────────────
export function timeframeBias(bars: Bar[]): "bullish" | "bearish" | "neutral" {
  if (bars.length < 50) return "neutral";
  const closes = bars.map(b => b.c);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const last20 = ema20[ema20.length - 1];
  const last50 = ema50[ema50.length - 1];
  const rsi = wilderRSI(closes);
  if (last20 > last50 * 1.001 && rsi !== null && rsi > 50) return "bullish";
  if (last20 < last50 * 0.999 && rsi !== null && rsi < 50) return "bearish";
  return "neutral";
}

export async function fetchBarsMultiTF(symbol: string): Promise<{
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

export function analyzeMultiTimeframe(
  tf5min: Bar[], tf15min: Bar[], tf1hr: Bar[], tfDaily: Bar[]
): MultiTimeframeSignal {
  const bias5 = tf5min.length >= 50 ? timeframeBias(tf5min) : null;
  const bias15 = tf15min.length >= 50 ? timeframeBias(tf15min) : null;
  const bias1h = tf1hr.length >= 50 ? timeframeBias(tf1hr) : null;
  const biasD = tfDaily.length >= 50 ? timeframeBias(tfDaily) : null;
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
  return { tf_5min: bias5, tf_15min: bias15, tf_1hr: bias1h, tf_daily: biasD, confluence, summary };
}

// ── Sector Performance ───────────────────────────────────────────────────────
export let _sectorCache: Record<string, number> = {};

export async function fetchSectorPerformance(): Promise<Record<string, number>> {
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
  } catch { return {}; }
}

export function computeSectorData(symbol: string, symbolChangePct: number, sectorPerf: Record<string, number>): SectorData {
  const sector = guessSector(symbol);
  const etf = SECTOR_ETFS[sector] ?? "SPY";
  const sectorChangePct = sectorPerf[etf] ?? null;
  const relativeStrength = sectorChangePct != null && sectorChangePct !== 0
    ? +(symbolChangePct / Math.abs(sectorChangePct)).toFixed(2) : null;
  return { sector: sector !== "Unknown" ? sector : null, sector_performance: sectorChangePct, relative_strength: relativeStrength };
}

// ── Fetch Bars ───────────────────────────────────────────────────────────────
export async function fetchBars(symbol: string, limit = 100): Promise<Bar[]> {
  try {
    const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const res = await withRetry(() => fetchWithTimeout(
      `${ALPACA_DATA_URL}/stocks/${symbol}/bars?timeframe=15Min&limit=${limit}&start=${start}&feed=iex`,
      { headers: alpacaHeaders }
    ));
    const data = await res.json();
    return data?.bars ?? [];
  } catch { return []; }
}

// ── Compute Technicals ───────────────────────────────────────────────────────
export async function computeTechnicals(symbol: string): Promise<TechData & { symbol: string }> {
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
  const sma20 = closes.length >= 20 ? +sma(closes.slice(-20)).toFixed(2) : null;
  const sma50 = closes.length >= 50 ? +sma(closes.slice(-50)).toFixed(2) : null;
  const rsi14 = wilderRSI(closes);

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

  const atr14 = wilderATR(bars);
  const bb = bollingerBands(closes);
  const vwap = computeVWAP(bars);
  const patterns = detectPatterns(bars);
  const volume_profile = analyzeVolumeProfile(bars);

  return {
    symbol,
    price: +last.toFixed(2),
    change_pct: +(((last - prev) / prev) * 100).toFixed(2),
    volume,
    sma20, sma50, rsi14,
    macd: macdVal, macd_signal: macdSignal, macd_hist: macdHist,
    atr14,
    bb_upper: bb?.upper ?? null, bb_lower: bb?.lower ?? null, bb_pct: bb?.pct ?? null,
    vwap, patterns, volume_profile,
    mtf: null,
    sector: { sector: null, sector_performance: null, relative_strength: null },
  };
}

// ── Get Latest Price ─────────────────────────────────────────────────────────
export async function getLatestPrice(symbol: string): Promise<number | null> {
  try {
    const res = await withRetry(() => fetchWithTimeout(
      `${ALPACA_DATA_URL}/stocks/${symbol}/quotes/latest?feed=iex`,
      { headers: alpacaHeaders }
    ));
    const data = await res.json();
    return data?.quote?.ap || data?.quote?.bp || null;
  } catch { return null; }
}

// ── Spread Check ─────────────────────────────────────────────────────────────
export async function getSpreadPct(symbol: string): Promise<{ spreadPct: number; bid: number; ask: number } | null> {
  try {
    const res = await fetchWithTimeout(
      `${ALPACA_DATA_URL}/stocks/${symbol}/quotes/latest?feed=iex`,
      { headers: alpacaHeaders }, 5000
    );
    const data = await res.json();
    const bid = data?.quote?.bp;
    const ask = data?.quote?.ap;
    if (!bid || !ask || bid <= 0 || ask <= 0) return null;
    const mid = (bid + ask) / 2;
    const spreadPct = (ask - bid) / mid;
    return { spreadPct, bid, ask };
  } catch { return null; }
}

// ── News ─────────────────────────────────────────────────────────────────────
export async function getNews(symbol: string, limit = 5): Promise<string[]> {
  try {
    const res = await withRetry(() => fetchWithTimeout(
      `https://data.alpaca.markets/v1beta1/news?symbols=${symbol}&limit=${limit}`,
      { headers: alpacaHeaders }
    ));
    const data = await res.json();
    return (data?.news ?? []).map((n: Record<string, string>) => n.headline);
  } catch { return []; }
}

// ── Get Market Data (batch) ──────────────────────────────────────────────────
export async function getMarketData(symbols: string[]) {
  const sectorPerf = await fetchSectorPerformance();
  _sectorCache = sectorPerf;

  const results: [string, { tech: TechData & { symbol: string }; news: string[] }][] = [];
  const batchSize = 5;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (sym) => {
        const [tech, news] = await Promise.all([computeTechnicals(sym), getNews(sym)]);
        tech.mtf = null;
        tech.sector = computeSectorData(sym, tech.change_pct, sectorPerf);
        return [sym, { tech, news }] as const;
      })
    );
    results.push(...batchResults);
  }
  return Object.fromEntries(results);
}
