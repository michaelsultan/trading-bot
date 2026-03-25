// ══════════════════════════════════════════════════════════════════════════════
// TRADING BOT — Thin Orchestrator (refactored from monolith)
// All logic lives in modules. This file wires them together.
// ══════════════════════════════════════════════════════════════════════════════

// ── Module Imports ───────────────────────────────────────────────────────────
import type { SnapshotData, ScanTrigger } from "./types.ts";
import {
  STARTING_CAPITAL, MAX_DRAWDOWN_PCT, DAILY_PROFIT_TARGET, MIN_CASH_PCT,
  MAX_POSITION_PCT, MAX_SPREAD_PCT, MAX_POSITIONS,
  FLATTEN_HOUR, FLATTEN_MINUTE, EARNINGS_HOLD_MIN_PROFIT_PCT,
  SCALP_FLOOR_PCT, MOMENTUM_PARTIAL_FLOOR, MOMENTUM_FULL_FLOOR,
  SCALP_ATR_MULT, MOMENTUM_PARTIAL_ATR_MULT, MOMENTUM_FULL_ATR_MULT,
  LOSS_COOLDOWN_MS, PROFIT_COOLDOWN_MS,
  LUNCH_MIN_SCORE, SPY_OVERRIDE_SCORE,
  FULL_UNIVERSE, ALL_LEVERAGED_ETFS, LEVERAGED_BEAR_ETFS, VOLATILITY_ETFS,
  ALPACA_DATA_URL, FINNHUB_BASE_URL,
} from "./config.ts";
import { fetchWithTimeout, isValidSymbol, isValidQuantity, getCurrentTradingMode, getCurrentWeekDeadline } from "./utils.ts";
import { alpacaHeaders, getAccount, getPositions, isClock, cancelOrdersForSymbol, placeOrder, placeOrderWithStopLoss } from "./execution.ts";
import { getMarketData, getLatestPrice, getSpreadPct } from "./market-data.ts";
import { getEnrichmentData, getEarningsExemptSymbols, getOptionsFlow } from "./social.ts";
import { fetchSnapshots, discoverSymbols } from "./scanner.ts";
import { quantPick } from "./scoring.ts";
import { checkSectorConcentration, checkCorrelationGuard, checkDirectionalConflict, atrPositionSize } from "./risk.ts";
import { evaluateSells, clearPeakPrice } from "./sell-engine.ts";
import {
  supabase, getTradeHistory, logTrade, closeBuyTrade, logSnapshot,
  getLastAnalyses, getLatestMetrics, getCycleCount,
  computeAndSaveMetrics, generateAndSaveAnalysis, generateWeeklySummary,
  isLastCycleOfWeek,
} from "./portfolio.ts";

// ══════════════════════════════════════════════════════════════════════════════
// ADAPTIVE TWO-TIER CYCLE ENGINE
//
// FAST SCAN:  Lightweight — snapshot-only scan of full universe + open positions.
//             Checks for triggers: volume spikes, big moves, position alerts.
//             If a trigger fires → immediately launches a full cycle.
//
// FULL CYCLE: Heavy — multi-TF analysis, patterns, rule-based decisions, order execution.
//             pg_cron: every 2 min full cycle.
// ══════════════════════════════════════════════════════════════════════════════

// ── Detect triggers from snapshot data + current positions ──────────────────
function detectTriggers(
  snapshots: SnapshotData[],
  positions: Record<string, unknown>[],
): ScanTrigger[] {
  const triggers: ScanTrigger[] = [];

  // 1. Big movers in the universe
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

    if (unrealizedPct < -1.5) {
      triggers.push({
        type: "position_alert",
        symbol: String(pos.symbol),
        detail: `Open position down ${unrealizedPct.toFixed(1)}% — consider exit`,
        severity: unrealizedPct < -3 ? "high" : "medium",
      });
    }

    if (unrealizedPct > 2) {
      triggers.push({
        type: "position_alert",
        symbol: String(pos.symbol),
        detail: `Open position up +${unrealizedPct.toFixed(1)}% — consider taking profit`,
        severity: unrealizedPct > 5 ? "high" : "medium",
      });
    }

    if (snap.change_pct < -2 && unrealizedPct > 0) {
      triggers.push({
        type: "position_alert",
        symbol: String(pos.symbol),
        detail: `Intraday reversal: position profitable but stock dropping ${snap.change_pct}% today`,
        severity: "high",
      });
    }
  }

  // 3. Gappers — stocks gapping with unusual volume
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

// ── Check if any triggers warrant an immediate full cycle ───────────────────
function shouldTriggerFullCycle(triggers: ScanTrigger[]): boolean {
  const highCount = triggers.filter(t => t.severity === "high").length;
  const positionAlerts = triggers.filter(t => t.type === "position_alert" && t.severity === "high").length;
  return highCount >= 2 || positionAlerts >= 1 || triggers.filter(t => t.severity !== "low").length >= 3;
}

// ── Log scan results to DB ──────────────────────────────────────────────────
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

// ── FAST SCAN: Lightweight market pulse check ───────────────────────────────
async function runFastScan(): Promise<Response> {
  console.log("⚡ FAST SCAN — checking market pulse...");

  const [account, positions] = await Promise.all([getAccount(), getPositions()]);
  const currentEquity = parseFloat(account.equity);

  if (currentEquity < STARTING_CAPITAL * (1 - MAX_DRAWDOWN_PCT)) {
    console.warn(`DRAWDOWN LIMIT — equity $${currentEquity.toFixed(2)}. Skipping.`);
    return new Response(JSON.stringify({ status: "drawdown_limit", mode: "scan" }), { status: 200 });
  }

  const snapshots = await fetchSnapshots(FULL_UNIVERSE);
  console.log(`Scanned ${snapshots.length} stocks`);

  const triggers = detectTriggers(snapshots, positions as Record<string, unknown>[]);
  const fullCycleNeeded = shouldTriggerFullCycle(triggers);

  if (triggers.length > 0) {
    console.log(`Found ${triggers.length} triggers (${triggers.filter(t => t.severity === "high").length} high):`,
      triggers.slice(0, 8).map(t => `${t.symbol}[${t.severity}]`).join(", "));
  }

  if (fullCycleNeeded) {
    console.log("🚨 TRIGGERS DETECTED — launching full cycle immediately!");
    await logScanResult(triggers, true);
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

// ── FULL CYCLE: Heavy analysis + trading ────────────────────────────────────
async function runFullCycle(scanTriggers: ScanTrigger[] = []): Promise<Response> {
  console.log(`🔄 FULL CYCLE starting${scanTriggers.length > 0 ? ` (triggered by ${scanTriggers.length} signals)` : ""}...`);

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
  const heldSymbolSet = new Set((positions as Record<string, string>[]).map(p => p.symbol));

  // ── SMART COOLDOWN: longer after losses, shorter after wins ────────────────
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

  // ── Quick snapshot test: diagnose API health ──────────────────────────────
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

  // ── DIAGNOSTICS ───────────────────────────────────────────────────────────
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

  const { decisions: quantDecisions, scores: quantScores } = await quantPick(
    marketData,
    cachedSnapshots,
    enrichment?.socialSentiment ?? [],
    optionsFlow,
    heldSymbolSet,
    cooldownSymbols,
    currentEquity,
    6,
  );

  // ── RULE-BASED SELL ENGINE (replaces Grok AI) ────────────────────────────
  let ruleSellDecisions: Array<{ action: string; symbol: string; quantity: number; reason: string }> = [];
  if ((positions as unknown[]).length > 0) {
    const sellSignals = evaluateSells(
      positions as Record<string, unknown>[],
      marketData,
      history,
    );
    ruleSellDecisions = sellSignals.map(s => ({
      action: s.action,
      symbol: s.symbol,
      quantity: s.quantity,
      reason: s.reason,
    }));
    if (ruleSellDecisions.length > 0) {
      console.log(`📏 RULE-BASED SELLS: ${ruleSellDecisions.length} signals`);
      for (const s of sellSignals) {
        console.log(`  ${s.reason}`);
      }
    }
  }

  // Merge: quant BUYs + rule-based SELLs
  const decisions = [...ruleSellDecisions, ...quantDecisions];
  console.log(`📊 FINAL DECISIONS: ${quantDecisions.length} quant BUYs + ${ruleSellDecisions.length} rule SELLs`);

  if (decisions.length === 0) {
    console.log("No actionable decisions from quant engine or sell engine");
  }

  // Get trading mode for profit-taking
  const { mode: tradingMode, label: tradingModeLabel } = getCurrentTradingMode();
  console.log(`Trading mode: ${tradingModeLabel}`);

  // ── EOD FULL FLATTEN ──────────────────────────────────────────────────────
  if (etHour > FLATTEN_HOUR || (etHour === FLATTEN_HOUR && etMin >= FLATTEN_MINUTE)) {
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

      if (earningsExempt.has(sym) && !isLev && pnlPct >= EARNINGS_HOLD_MIN_PROFIT_PCT) {
        console.log(`🎯 EARNINGS HOLD: Keeping ${sym} (${qty} shares, +${(pnlPct * 100).toFixed(2)}%) — AMC earnings today, betting on gap-up`);
        await logTrade({
          symbol: sym, action: "HOLD", quantity: qty,
          reason: `Earnings exception: ${sym} has AMC earnings today, position +${(pnlPct * 100).toFixed(2)}% — holding for potential gap-up`,
          price_entry: entryPrice,
          price_exit: currentPrice,
          alpaca_order_id: "earnings-hold", status: "open",
        });
        continue;
      }

      console.log(`🌙 EOD FLATTEN: Closing ${sym} (${qty} shares)${isLev ? " [leveraged]" : ""} — no overnight holds`);
      await cancelOrdersForSymbol(sym);
      const order = await placeOrder(sym, qty, "sell");
      if (order?.id) {
        await logTrade({
          symbol: sym, action: "SELL", quantity: qty,
          reason: `EOD flatten: pure day-trading — close all positions before 4 PM ET${isLev ? " (leveraged)" : ""}`,
          price_entry: entryPrice,
          price_exit: currentPrice,
          alpaca_order_id: order.id, status: "closed",
        });
      }
    }
  }

  // ── DYNAMIC ATR-BASED PROFIT-TAKING ───────────────────────────────────────
  const isScalp = tradingMode === "SCALP";
  const profitTakeOrders = [];
  for (const pos of (positions as Record<string, unknown>[])) {
    const unrealizedPct = parseFloat(String(pos.unrealized_plpc ?? 0));
    const qty = parseInt(String(pos.qty));
    const sym = pos.symbol as string;
    const entryPrice = parseFloat(String(pos.avg_entry_price ?? 0));

    // Skip profit-taking if the sell engine already flagged this position
    const ruleWantsSell = decisions.some((d: Record<string, unknown>) => d.symbol === sym && d.action === "SELL");
    if (ruleWantsSell) continue;

    const symATR = marketData[sym]?.tech.atr14 ?? null;
    const atrPct = (symATR && entryPrice > 0) ? symATR / entryPrice : 0;

    const scalpTarget = Math.max(SCALP_FLOOR_PCT, atrPct * SCALP_ATR_MULT);
    const momentumPartial = Math.max(MOMENTUM_PARTIAL_FLOOR, atrPct * MOMENTUM_PARTIAL_ATR_MULT);
    const momentumFull = Math.max(MOMENTUM_FULL_FLOOR, atrPct * MOMENTUM_FULL_ATR_MULT);

    let sellQty = 0;
    let reason = "";

    if (isScalp && unrealizedPct >= scalpTarget && qty >= 1) {
      sellQty = qty;
      reason = `⚡ SCALP exit: +${(unrealizedPct * 100).toFixed(1)}% (target ${(scalpTarget * 100).toFixed(1)}%) — selling ALL ${qty} shares`;
    } else if (!isScalp && unrealizedPct >= momentumFull && qty >= 1) {
      sellQty = qty;
      reason = `🎯 MOMENTUM full exit: +${(unrealizedPct * 100).toFixed(1)}% (target ${(momentumFull * 100).toFixed(1)}%) — selling ALL ${qty} shares`;
    } else if (!isScalp && unrealizedPct >= momentumPartial && qty > 1) {
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
          symbol: sym, action: "PROFIT_TAKE", quantity: sellQty, reason,
          price_entry: parseFloat(String(pos.avg_entry_price)),
          price_exit: parseFloat(String(pos.current_price ?? 0)),
          alpaca_order_id: order.id, status: "closed",
        });
      } else {
        console.error(`Profit-take order failed for ${sym}:`, order);
      }
    }
  }
  if (profitTakeOrders.length > 0) {
    console.log(`💰 Profit-taking: ${profitTakeOrders.length} orders placed (${tradingMode} mode)`);
  }

  // Build allowed symbol set
  const scannedSymbols = new Set(Object.keys(marketData));
  const fullUniverseSet = new Set(FULL_UNIVERSE);
  const hotListSet = new Set(hotList.symbols);
  const allowedSymbols = new Set([...fullUniverseSet, ...scannedSymbols, ...heldSymbolSet, ...hotListSet]);
  console.log(`Allowed symbols: ${allowedSymbols.size} (universe=${fullUniverseSet.size}, scanned=${scannedSymbols.size}, held=${heldSymbolSet.size}, hotList=${hotListSet.size})`);

  // ── SPY TREND FILTER ──────────────────────────────────────────────────────
  let spyTrendBullish = true;
  try {
    const spyData = marketData["SPY"];
    if (spyData?.tech.sma20 && spyData?.tech.price) {
      spyTrendBullish = spyData.tech.price > spyData.tech.sma20;
      console.log(`📈 SPY trend: ${spyTrendBullish ? "BULLISH" : "⚠️ BEARISH"} (price=$${spyData.tech.price.toFixed(2)} vs SMA20=$${spyData.tech.sma20.toFixed(2)})`);
    }
  } catch { /* SPY check is optional */ }

  // ── EARNINGS BLACKOUT ─────────────────────────────────────────────────────
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

  // ── EXECUTE DECISIONS ─────────────────────────────────────────────────────
  const executedOrders = [...profitTakeOrders];
  const debugLog: string[] = [];

  for (const decision of decisions) {
    let alpacaOrder = null;
    let priceEntry: number | null = null;

    // Block decisions on symbols outside our universe
    if (decision.action !== "HOLD" && isValidSymbol(decision.symbol) && !allowedSymbols.has(decision.symbol)) {
      debugLog.push(`${decision.symbol}: BLOCKED — not in scanned/held universe (${allowedSymbols.size} allowed)`);
      console.warn(`${decision.action} blocked — ${decision.symbol} not in scanned/held universe`);
      continue;
    }

    // Block ALL buys near market close
    if (decision.action === "BUY" &&
        (etHour > FLATTEN_HOUR || (etHour === FLATTEN_HOUR && etMin >= FLATTEN_MINUTE))) {
      debugLog.push(`${decision.symbol}: BLOCKED — too close to market close (EOD flatten at ${FLATTEN_HOUR}:${FLATTEN_MINUTE} ET)`);
      continue;
    }

    // Lunch lull filter (12-2 PM ET)
    if (decision.action === "BUY" && etHour >= 12 && etHour < 14) {
      const lunchScore = quantScores.find(s => s.symbol === decision.symbol)?.score ?? 0;
      if (lunchScore < LUNCH_MIN_SCORE) {
        debugLog.push(`${decision.symbol}: BLOCKED — lunch lull (score ${lunchScore} < ${LUNCH_MIN_SCORE} threshold)`);
        continue;
      }
      debugLog.push(`${decision.symbol}: LUNCH PASS — score ${lunchScore} >= ${LUNCH_MIN_SCORE}`);
      console.log(`🍽️ LUNCH PASS: ${decision.symbol} score=${lunchScore} — letting it through`);
    }

    // Earnings blackout
    if (decision.action === "BUY" && earningsBlackoutSymbols.has(decision.symbol)) {
      debugLog.push(`${decision.symbol}: BLOCKED — earnings blackout (reporting today)`);
      console.warn(`📅 EARNINGS BLACKOUT: ${decision.symbol} blocked — stock has earnings today, too unpredictable`);
      await logTrade({
        symbol: decision.symbol, action: "BUY_BLOCKED", quantity: decision.quantity,
        reason: `Earnings blackout: ${decision.symbol} reports earnings today — price action unpredictable, spreads wide`,
        status: "error",
      });
      continue;
    }

    // SPY trend filter
    if (decision.action === "BUY" && !spyTrendBullish &&
        !LEVERAGED_BEAR_ETFS.has(decision.symbol) && !VOLATILITY_ETFS.has(decision.symbol)) {
      const trendScore = quantScores.find(s => s.symbol === decision.symbol)?.score ?? 0;
      if (trendScore < SPY_OVERRIDE_SCORE) {
        debugLog.push(`${decision.symbol}: BLOCKED — SPY bearish trend (score ${trendScore} < ${SPY_OVERRIDE_SCORE})`);
        continue;
      }
      debugLog.push(`${decision.symbol}: SPY BEARISH OVERRIDE — score ${trendScore} >= ${SPY_OVERRIDE_SCORE}`);
    }

    // Correlation guard (leveraged ETF limits)
    if (decision.action === "BUY" && ALL_LEVERAGED_ETFS.has(decision.symbol)) {
      const guard = checkCorrelationGuard(decision.symbol, positions as Record<string, unknown>[]);
      if (!guard.allowed) {
        console.warn(`🛡️ CORRELATION GUARD: ${decision.symbol} blocked — ${guard.reason}`);
        debugLog.push(`${decision.symbol}: BLOCKED — CORRELATION GUARD (${guard.reason})`);
        await logTrade({
          symbol: decision.symbol, action: "BUY_BLOCKED", quantity: decision.quantity,
          reason: `Correlation guard: ${guard.reason}`, status: "error",
        });
        continue;
      }
    }

    // Directional conflict guard (no opposing bets on same sector)
    if (decision.action === "BUY") {
      const conflict = checkDirectionalConflict(decision.symbol, positions as Record<string, unknown>[]);
      if (!conflict.allowed) {
        console.warn(`⚔️ DIRECTIONAL CONFLICT: ${decision.symbol} blocked — ${conflict.reason}`);
        debugLog.push(`${decision.symbol}: BLOCKED — DIRECTIONAL CONFLICT (${conflict.reason})`);
        await logTrade({
          symbol: decision.symbol, action: "BUY_BLOCKED", quantity: decision.quantity,
          reason: `Directional conflict: ${conflict.reason}`, status: "error",
        });
        continue;
      }
    }

    if (decision.action === "BUY" && isValidSymbol(decision.symbol) && isValidQuantity(decision.quantity)) {

      // ══ HARD POSITION CAP — never hold more than MAX_POSITIONS ══
      const openCount = (positions as unknown[]).length + executedOrders.filter(o => o.side === "buy").length;
      if (openCount >= MAX_POSITIONS) {
        debugLog.push(`${decision.symbol}: BLOCKED — MAX_POSITIONS cap (${openCount}/${MAX_POSITIONS} open)`);
        console.warn(`🚫 MAX_POSITIONS: ${decision.symbol} blocked — already ${openCount} open (cap=${MAX_POSITIONS})`);
        continue;
      }

      // ══ HARD CASH FLOOR — never buy if cash is negative or below $1000 ══
      const rawCash = parseFloat(account.cash);
      if (rawCash < 1000) {
        debugLog.push(`${decision.symbol}: BLOCKED — CASH FLOOR (cash=$${rawCash.toFixed(0)}, min=$1000)`);
        console.warn(`🚫 CASH FLOOR: ${decision.symbol} blocked — cash=$${rawCash.toFixed(0)} below $1000 floor`);
        continue;
      }

      // Crash filter
      const symData = marketData[decision.symbol];
      if (symData && symData.tech.change_pct < -10) {
        debugLog.push(`${decision.symbol}: BLOCKED — CRASH FILTER (down ${symData.tech.change_pct}% today, likely bad news)`);
        console.warn(`🚨 CRASH FILTER: ${decision.symbol} down ${symData.tech.change_pct}% — blocking buy (falling knife)`);
        await logTrade({
          symbol: decision.symbol, action: "BUY_BLOCKED", quantity: decision.quantity,
          reason: `Crash filter: ${decision.symbol} down ${symData.tech.change_pct}% today — falling knife blocked`,
          status: "error",
        });
        continue;
      }

      // Block new buys when daily target is hit
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

      // Spread check
      const spread = await getSpreadPct(decision.symbol);
      if (spread && spread.spreadPct > MAX_SPREAD_PCT) {
        debugLog.push(`${decision.symbol}: BLOCKED — spread too wide (${(spread.spreadPct * 100).toFixed(2)}% > ${(MAX_SPREAD_PCT * 100).toFixed(1)}%, bid=$${spread.bid} ask=$${spread.ask})`);
        console.warn(`💧 SPREAD FILTER: ${decision.symbol} spread ${(spread.spreadPct * 100).toFixed(2)}% > max ${(MAX_SPREAD_PCT * 100).toFixed(1)}%`);
        continue;
      }

      // ATR-Based Position Sizing
      const symbolPrice = marketData[decision.symbol]?.tech.price ?? 0;
      const symbolATR = marketData[decision.symbol]?.tech.atr14 ?? null;
      priceEntry = await getLatestPrice(decision.symbol) || symbolPrice;
      const effectivePrice = priceEntry ?? symbolPrice;

      const sizing = atrPositionSize(currentEquity, effectivePrice, symbolATR);
      let finalQty = Math.min(decision.quantity, sizing.qty);

      // Cash buffer guard — use non_marginable_buying_power to avoid margin debt
      // Falls back to account.cash if field not available
      const availableCash = parseFloat(account.non_marginable_buying_power ?? account.cash);
      const orderCost = finalQty * effectivePrice;
      const minCashRequired = currentEquity * MIN_CASH_PCT;
      const cashAfterBuy = availableCash - orderCost;

      // HARD BLOCK: never let cash go below $1000
      if (cashAfterBuy < 1000) {
        const maxSpend = Math.max(0, availableCash - Math.max(minCashRequired, 1000));
        if (maxSpend < effectivePrice) {
          debugLog.push(`${decision.symbol}: BLOCKED — cash guard (cash=$${availableCash.toFixed(0)}, order=$${orderCost.toFixed(0)}, floor=$1000)`);
          console.warn(`🚫 CASH GUARD: ${decision.symbol} blocked — $${availableCash.toFixed(0)} cash, order=$${orderCost.toFixed(0)}`);
          continue;
        }
        const adjustedQty = Math.floor(maxSpend / effectivePrice);
        if (adjustedQty < 1) continue;
        console.log(`BUY qty adjusted: ${finalQty} → ${adjustedQty} to stay above cash floor`);
        finalQty = adjustedQty;
      } else if (cashAfterBuy < minCashRequired) {
        const maxSpend = availableCash - minCashRequired;
        if (maxSpend < effectivePrice) {
          debugLog.push(`${decision.symbol}: BLOCKED — 10% cash buffer (cash=$${availableCash.toFixed(0)}, need=$${minCashRequired.toFixed(0)})`);
          continue;
        }
        const adjustedQty = Math.floor(maxSpend / effectivePrice);
        if (adjustedQty < 1) continue;
        console.log(`BUY qty adjusted: ${finalQty} → ${adjustedQty} to maintain 10% cash buffer`);
        finalQty = adjustedQty;
      }

      // Position size guard — 18% cap
      const orderValue = finalQty * effectivePrice;
      const maxAllowed = currentEquity * MAX_POSITION_PCT;
      if (orderValue > maxAllowed) {
        debugLog.push(`${decision.symbol}: BLOCKED — 18% cap (order=$${orderValue.toFixed(0)}, max=$${maxAllowed.toFixed(0)})`);
        console.warn(`BUY blocked — $${orderValue.toFixed(0)} exceeds 18% cap ($${maxAllowed.toFixed(0)}) for ${decision.symbol}`);
        await logTrade({
          symbol: decision.symbol, action: "BUY_BLOCKED", quantity: finalQty,
          reason: `Order value $${orderValue.toFixed(0)} exceeds 18% position cap`,
          status: "error",
        });
        continue;
      }

      // Sector concentration guard
      const sectorCheck = checkSectorConcentration(positions as Record<string, unknown>[], decision.symbol);
      if (!sectorCheck.allowed) {
        debugLog.push(`${decision.symbol}: BLOCKED — sector concentration: ${sectorCheck.reason}`);
        console.warn(`BUY blocked — sector concentration: ${sectorCheck.reason}`);
        await logTrade({
          symbol: decision.symbol, action: "BUY_BLOCKED", quantity: finalQty,
          reason: sectorCheck.reason!, status: "error",
        });
        continue;
      }

      console.log(`Position sizing: requested=${decision.quantity}, ATR-optimal=${sizing.qty}, final=${finalQty} | stopDist=$${sizing.stopDistance.toFixed(2)} (${(sizing.stopLossPct * 100).toFixed(1)}%)`);
      decision.quantity = finalQty;

      // Bracket order with dynamic ATR stop-loss
      debugLog.push(`${decision.symbol}: ATTEMPTING BUY ${finalQty} @ $${effectivePrice} (stop=${(sizing.stopLossPct * 100).toFixed(1)}%)`);
      alpacaOrder = await placeOrderWithStopLoss(decision.symbol, finalQty, effectivePrice, sizing.stopLossPct);
      if (alpacaOrder?.code || (alpacaOrder?.message && !alpacaOrder?.id)) {
        debugLog.push(`${decision.symbol}: ALPACA REJECTED — ${JSON.stringify(alpacaOrder).slice(0, 200)}`);
        console.error("Alpaca BUY rejected:", alpacaOrder);
        await logTrade({
          symbol: decision.symbol, action: "BUY_REJECTED", quantity: decision.quantity,
          reason: JSON.stringify(alpacaOrder), status: "error",
        });
        continue;
      }

    } else if (decision.action === "SELL" && isValidSymbol(decision.symbol) && isValidQuantity(decision.quantity)) {

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

      await cancelOrdersForSymbol(decision.symbol);
      const priceExit = await getLatestPrice(decision.symbol) || marketData[decision.symbol]?.tech.price;
      alpacaOrder = await placeOrder(decision.symbol, sellQty, "sell");
      if (alpacaOrder?.code || alpacaOrder?.message) {
        console.error("Alpaca SELL rejected:", alpacaOrder);
        await logTrade({
          symbol: decision.symbol, action: "SELL_REJECTED", quantity: sellQty,
          reason: JSON.stringify(alpacaOrder), status: "error",
        });
        continue;
      }
      if (priceExit) await closeBuyTrade(decision.symbol, priceExit);
      clearPeakPrice(decision.symbol); // Reset trailing stop tracker
      priceEntry = priceExit;
      decision.quantity = sellQty;

    } else if (decision.action === "SHORT" && isValidSymbol(decision.symbol) && isValidQuantity(decision.quantity)) {

      const shortData = marketData[decision.symbol];
      const shortRsi = shortData?.tech.rsi14 ?? 50;
      if (spyTrendBullish && shortRsi < 75) {
        debugLog.push(`${decision.symbol}: SHORT BLOCKED — market bullish and RSI ${shortRsi} < 75`);
        continue;
      }
      const existingPos = (positions as Record<string, unknown>[]).find(p => p.symbol === decision.symbol);
      if (existingPos) {
        debugLog.push(`${decision.symbol}: SHORT BLOCKED — already have position`);
        continue;
      }
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

    // Attach quant score breakdown to BUY trades
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
// Called by pg_cron every 2 min — always runs full cycle
Deno.serve(async (req) => {

  // Auth: shared secret (check header first, then body)
  const expectedSecret = Deno.env.get("BOT_SECRET");
  const authHeader = req.headers.get("Authorization") ?? "";
  let providedSecret = authHeader.replace("Bearer ", "").trim();

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
    const marketOpen = await isClock();
    if (!marketOpen) {
      console.log("Market closed — skipping.");
      await supabase.rpc("release_bot_run");
      return new Response(JSON.stringify({ status: "market_closed", mode }), { status: 200 });
    }

    // ALWAYS run full cycle — every 2 min = more trades = closer to $500/day
    const response = await runFullCycle();

    await supabase.rpc("release_bot_run");
    return response;
  } catch (err) {
    console.error(err);
    await supabase.rpc("release_bot_run");
    return new Response(JSON.stringify({ status: "error", mode, message: String(err) }), { status: 500 });
  }
});
