// ══════════════════════════════════════════════════════════════════════════════
// RULE-BASED SELL ENGINE — replaces Grok AI for sell decisions
// Pure logic: faster, free, consistent, no hallucinated P&L thresholds.
//
// Sell signals (checked in priority order):
//   1. Trailing stop — lock in gains once position is up >1%
//   2. Hard stop-loss — cut at configured ATR stop
//   3. Time decay — exit stale positions after 45 min
//   4. RSI reversal — entered oversold, now overbought → take profit
//   5. VWAP breakdown — entered above VWAP, price dropped below → exit
//   6. Momentum fade — strong entry fading (change_pct reversed)
// ══════════════════════════════════════════════════════════════════════════════

import { DEFAULT_STOP_LOSS_PCT } from "./config.ts";

export interface SellSignal {
  action: "SELL";
  symbol: string;
  quantity: number;
  reason: string;
  priority: number; // lower = higher priority
}

interface PositionData {
  symbol: string;
  qty: number;
  avg_entry_price: number;
  current_price: number;
  unrealized_plpc: number; // fractional, e.g. 0.015 = +1.5%
  unrealized_pl: number;
  market_value: number;
}

interface MarketDataEntry {
  tech: {
    price: number;
    rsi14: number | null;
    atr14: number | null;
    vwap: number | null;
    change_pct: number;
    sma20: number | null;
    macd_histogram: number | null;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ── Config ──────────────────────────────────────────────────────────────────
const TRAILING_STOP_ACTIVATE_PCT = 0.01;   // activate trailing stop after +1% gain
const TRAILING_STOP_DISTANCE_PCT = 0.005;  // trail by 0.5% from peak (sell if drops 0.5% from high)
const TIME_DECAY_MINUTES = 45;             // exit stale positions after 45 min
const TIME_DECAY_MIN_LOSS_PCT = -0.003;    // only time-decay if position is flat/negative (< +0.3%)
const RSI_EXIT_THRESHOLD = 70;             // sell if RSI entered oversold and now hits 70+
const RSI_ENTRY_WAS_OVERSOLD = 35;         // consider "entered oversold" if RSI was below this
const VWAP_BREAKDOWN_MIN_LOSS_PCT = -0.005; // VWAP breakdown + down 0.5% → sell
const MOMENTUM_FADE_REVERSAL_PCT = -0.02;  // if stock was up on entry but now down 2% → sell
const HARD_STOP_LOSS_PCT = DEFAULT_STOP_LOSS_PCT; // 2% hard stop from config

// Track entry timestamps and conditions per symbol (in-memory, resets each deploy)
// For persistence across cycles, we use the trade log created_at as entry time
const _peakPrices = new Map<string, number>();

/**
 * Evaluate all held positions and generate rule-based sell signals.
 * Returns an array of sell decisions, sorted by priority.
 */
export function evaluateSells(
  positions: Record<string, unknown>[],
  marketData: Record<string, MarketDataEntry>,
  tradeHistory: Array<{ symbol: string; action: string; created_at: string; reason?: string }>,
): SellSignal[] {
  const signals: SellSignal[] = [];

  for (const rawPos of positions) {
    const pos: PositionData = {
      symbol: String(rawPos.symbol),
      qty: parseInt(String(rawPos.qty)) || 0,
      avg_entry_price: parseFloat(String(rawPos.avg_entry_price)) || 0,
      current_price: parseFloat(String(rawPos.current_price ?? 0)),
      unrealized_plpc: parseFloat(String(rawPos.unrealized_plpc ?? 0)),
      unrealized_pl: parseFloat(String(rawPos.unrealized_pl ?? 0)),
      market_value: parseFloat(String(rawPos.market_value ?? 0)),
    };

    if (pos.qty <= 0 || pos.avg_entry_price <= 0) continue;

    const md = marketData[pos.symbol];
    const pnlPct = pos.unrealized_plpc; // already fractional from Alpaca

    // Find the BUY trade for this position to get entry time and conditions
    const buyTrade = [...tradeHistory]
      .reverse()
      .find(t => t.symbol === pos.symbol && t.action === "BUY");

    const entryTime = buyTrade ? new Date(buyTrade.created_at) : null;
    const holdMinutes = entryTime
      ? (Date.now() - entryTime.getTime()) / (1000 * 60)
      : 0;

    // Was entry based on oversold RSI?
    const entryReason = buyTrade?.reason ?? "";
    const enteredOversold = entryReason.includes("oversold") ||
      entryReason.includes("RSI=") && parseFloat(entryReason.match(/RSI=(\d+\.?\d*)/)?.[1] ?? "50") < RSI_ENTRY_WAS_OVERSOLD;

    // ── 1. HARD STOP-LOSS ──────────────────────────────────────────────────
    // The ATR bracket order handles this on Alpaca's side, but as a fallback:
    if (pnlPct <= -HARD_STOP_LOSS_PCT) {
      signals.push({
        action: "SELL",
        symbol: pos.symbol,
        quantity: pos.qty,
        reason: `🛑 HARD STOP: ${pos.symbol} down ${(pnlPct * 100).toFixed(2)}% (limit -${(HARD_STOP_LOSS_PCT * 100).toFixed(1)}%) — cutting loss`,
        priority: 1,
      });
      continue; // Don't check other signals, this is definitive
    }

    // ── 2. TRAILING STOP ───────────────────────────────────────────────────
    // Track peak price, sell if price drops 0.5% from peak after being up 1%+
    const peakKey = pos.symbol;
    const prevPeak = _peakPrices.get(peakKey) ?? pos.avg_entry_price;
    const currentPeak = Math.max(prevPeak, pos.current_price);
    _peakPrices.set(peakKey, currentPeak);

    const peakGainPct = (currentPeak - pos.avg_entry_price) / pos.avg_entry_price;
    const dropFromPeak = (currentPeak - pos.current_price) / currentPeak;

    if (peakGainPct >= TRAILING_STOP_ACTIVATE_PCT && dropFromPeak >= TRAILING_STOP_DISTANCE_PCT) {
      signals.push({
        action: "SELL",
        symbol: pos.symbol,
        quantity: pos.qty,
        reason: `📉 TRAILING STOP: ${pos.symbol} peaked at +${(peakGainPct * 100).toFixed(1)}%, now dropped ${(dropFromPeak * 100).toFixed(1)}% from peak — locking in gains`,
        priority: 2,
      });
      _peakPrices.delete(peakKey); // Reset for next position
      continue;
    }

    // ── 3. RSI REVERSAL ────────────────────────────────────────────────────
    // If we entered on oversold RSI and now it's overbought → take profit
    if (md && enteredOversold && md.tech.rsi14 !== null && md.tech.rsi14 >= RSI_EXIT_THRESHOLD && pnlPct > 0) {
      signals.push({
        action: "SELL",
        symbol: pos.symbol,
        quantity: pos.qty,
        reason: `🔄 RSI REVERSAL: ${pos.symbol} entered oversold, RSI now ${md.tech.rsi14.toFixed(0)} (≥${RSI_EXIT_THRESHOLD}) — taking profit at +${(pnlPct * 100).toFixed(1)}%`,
        priority: 3,
      });
      continue;
    }

    // ── 4. VWAP BREAKDOWN ──────────────────────────────────────────────────
    // Entered above VWAP, price now below VWAP and losing money → exit
    if (md && md.tech.vwap && md.tech.vwap > 0) {
      const enteredAboveVwap = entryReason.includes("above VWAP");
      const nowBelowVwap = pos.current_price < md.tech.vwap;

      if (enteredAboveVwap && nowBelowVwap && pnlPct <= VWAP_BREAKDOWN_MIN_LOSS_PCT) {
        signals.push({
          action: "SELL",
          symbol: pos.symbol,
          quantity: pos.qty,
          reason: `📊 VWAP BREAKDOWN: ${pos.symbol} entered above VWAP ($${md.tech.vwap.toFixed(2)}), now below at $${pos.current_price.toFixed(2)} — thesis broken, exit at ${(pnlPct * 100).toFixed(1)}%`,
          priority: 4,
        });
        continue;
      }
    }

    // ── 5. TIME DECAY ──────────────────────────────────────────────────────
    // Position held >45 min and going nowhere → free up capital
    if (holdMinutes >= TIME_DECAY_MINUTES && pnlPct < TIME_DECAY_MIN_LOSS_PCT) {
      signals.push({
        action: "SELL",
        symbol: pos.symbol,
        quantity: pos.qty,
        reason: `⏰ TIME DECAY: ${pos.symbol} held ${Math.round(holdMinutes)}min with ${(pnlPct * 100).toFixed(1)}% P&L — stale position, freeing capital`,
        priority: 5,
      });
      continue;
    }

    // ── 6. MOMENTUM FADE ───────────────────────────────────────────────────
    // Stock was up when we entered but has completely reversed
    if (md && md.tech.change_pct <= MOMENTUM_FADE_REVERSAL_PCT * 100 && pnlPct < -0.01) {
      signals.push({
        action: "SELL",
        symbol: pos.symbol,
        quantity: pos.qty,
        reason: `💨 MOMENTUM FADE: ${pos.symbol} now ${md.tech.change_pct.toFixed(1)}% today (was positive on entry) — momentum reversed, exit at ${(pnlPct * 100).toFixed(1)}%`,
        priority: 6,
      });
      continue;
    }

    // No sell signal → position is fine, hold
  }

  // Sort by priority (lower number = execute first)
  signals.sort((a, b) => a.priority - b.priority);

  return signals;
}

/**
 * Clear peak price tracking for a symbol (call after a sell is executed)
 */
export function clearPeakPrice(symbol: string): void {
  _peakPrices.delete(symbol);
}
