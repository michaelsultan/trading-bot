// ── Portfolio: Trade History, Metrics, Grok AI, Decisions ────────────────────

import { createClient } from "jsr:@supabase/supabase-js@2";
import type { TechData, EnrichmentData } from "./types.ts";
import {
  STARTING_CAPITAL, DAILY_PROFIT_TARGET, SECTOR_ETFS,
  GROK_BASE_URL,
} from "./config.ts";
import { fetchWithTimeout, withRetry, extractJson, getCurrentTradingMode, getCurrentWeekDeadline, estimateRemainingCycles } from "./utils.ts";
import { _sectorCache } from "./market-data.ts";

// ── Supabase Client ──────────────────────────────────────────────────────────
export const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// ── Trade History ────────────────────────────────────────────────────────────
export async function getTradeHistory(limit = 50) {
  const { data } = await supabase
    .from("trades")
    .select("created_at, symbol, action, quantity, price_entry, price_exit, pnl, reason, status")
    .neq("action", "HOLD")
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}

export async function logTrade(trade: Record<string, unknown>) {
  await supabase.from("trades").insert(trade);
}

export async function closeBuyTrade(symbol: string, priceExit: number) {
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

export async function logSnapshot(cash: number, equity: number, positions: unknown[]) {
  await supabase.from("portfolio_snapshots").insert({ cash, equity, positions });
}

export async function getLastAnalyses(): Promise<string | null> {
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

export async function getLatestMetrics(): Promise<string | null> {
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

export async function getCycleCount(): Promise<number> {
  const { count } = await supabase
    .from("portfolio_snapshots")
    .select("*", { count: "exact", head: true });
  return count ?? 0;
}

// ── Compute and Save Metrics ─────────────────────────────────────────────────
export async function computeAndSaveMetrics(
  cycleCount: number,
  account: Record<string, unknown>,
  positions: unknown[]
) {
  const currentEquity = parseFloat(String(account.equity));
  const currentCash = parseFloat(String(account.cash));

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
    ? winners.reduce((s, t) => s + (t.pnl as number), 0) / winners.length : null;
  const avgLoss = losers.length > 0
    ? losers.reduce((s, t) => s + (t.pnl as number), 0) / losers.length : null;

  const grossProfit = winners.reduce((s, t) => s + (t.pnl as number), 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + (t.pnl as number), 0));
  const profitFactor = grossLoss > 0 ? +(grossProfit / grossLoss).toFixed(2) : null;

  const totalPnlRealized = closedTrades.reduce((s, t) => s + ((t.pnl as number) || 0), 0);
  const totalPnlUnrealized = (positions as Record<string, unknown>[])
    .reduce((s, p) => s + parseFloat(String(p.unrealized_pl ?? 0)), 0);

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

  let sharpeRatio: number | null = null;
  if (snapshots && snapshots.length > 2) {
    const equities = snapshots.map(s => parseFloat(String(s.equity)));
    const returns = equities.slice(1).map((eq, i) => (eq - equities[i]) / equities[i]);
    const meanReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
    const stdDev = Math.sqrt(returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / returns.length);
    const annualizationFactor = Math.sqrt(13 * 252);
    sharpeRatio = stdDev > 0 ? +((meanReturn / stdDev) * annualizationFactor).toFixed(2) : null;
  }

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

  const { data: roundTrips } = await supabase
    .from("trades").select("created_at").eq("action", "BUY").eq("status", "closed")
    .order("created_at", { ascending: false }).limit(50);
  const { data: sellTrades } = await supabase
    .from("trades").select("created_at").eq("action", "SELL").eq("status", "closed")
    .order("created_at", { ascending: false }).limit(50);

  let avgHoldDuration: number | null = null;
  if (roundTrips?.length && sellTrades?.length) {
    const durations: number[] = [];
    const minLen = Math.min(roundTrips.length, sellTrades.length);
    for (let i = 0; i < minLen; i++) {
      const buyTime = new Date(roundTrips[i].created_at).getTime();
      const sellTime = new Date(sellTrades[i].created_at).getTime();
      if (sellTime > buyTime) durations.push((sellTime - buyTime) / (1000 * 60));
    }
    if (durations.length > 0) avgHoldDuration = Math.round(durations.reduce((s, d) => s + d, 0) / durations.length);
  }

  await supabase.from("performance_metrics").insert({
    cycle_count: cycleCount, equity: +currentEquity.toFixed(2), cash: +currentCash.toFixed(2),
    total_pnl_realized: +totalPnlRealized.toFixed(2), total_pnl_unrealized: +totalPnlUnrealized.toFixed(2),
    total_trades: totalTrades, winning_trades: winners.length, losing_trades: losers.length,
    win_rate: winRate != null ? +winRate.toFixed(4) : null,
    avg_win: avgWin != null ? +avgWin.toFixed(2) : null,
    avg_loss: avgLoss != null ? +avgLoss.toFixed(2) : null,
    profit_factor: profitFactor, max_drawdown_pct: +maxDrawdownPct.toFixed(4),
    current_drawdown_pct: +currentDrawdownPct.toFixed(4), sharpe_ratio: sharpeRatio,
    open_positions: (positions as unknown[]).length, avg_hold_duration_minutes: avgHoldDuration,
    current_streak: currentStreak, longest_win_streak: longestWin, longest_loss_streak: longestLoss,
  });

  console.log(`Performance metrics saved at cycle #${cycleCount}: equity=$${currentEquity.toFixed(2)} winRate=${winRate != null ? (winRate * 100).toFixed(1) + "%" : "N/A"} sharpe=${sharpeRatio ?? "N/A"} maxDD=${(maxDrawdownPct * 100).toFixed(1)}%`);
}

// ── Generate and Save Analysis ───────────────────────────────────────────────
export async function generateAndSaveAnalysis(
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
    trade_count: cycleCount, type: "analysis", analysis, trades_ref: lastDecisions,
  });
  console.log(`Auto-analyse générée au cycle #${cycleCount}`);
}

// ── Weekly Summary ───────────────────────────────────────────────────────────
export async function generateWeeklySummary(
  account: Record<string, unknown>,
  positions: unknown[],
  cycleCount: number
) {
  const monday = new Date();
  const etDay = new Date(monday.toLocaleString("en-US", { timeZone: "America/New_York" })).getDay();
  monday.setDate(monday.getDate() - ((etDay + 6) % 7));
  monday.setUTCHours(5, 0, 0, 0);

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
    trade_count: cycleCount, type: "weekly_summary", analysis, trades_ref: weekDecisions,
  });
  console.log(`Bilan de fin de semaine généré au cycle #${cycleCount}`);
}

export function isLastCycleOfWeek(now: Date, deadline: Date): boolean {
  const etDay = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" })).getDay();
  return etDay === 5 && (deadline.getTime() - now.getTime()) < 60 * 60 * 1000;
}

// ── Grok API Calls ───────────────────────────────────────────────────────────
export async function callGrok(prompt: string, systemPrompt?: string, _liveSearch = false): Promise<string> {
  const apiKey = Deno.env.get("GROK_API_KEY");
  if (!apiKey) { console.error("GROK_API_KEY is not set!"); return ""; }
  console.log("callGrok: using chat/completions, key starts with:", apiKey.slice(0, 8) + "...");

  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const res = await withRetry(() => fetchWithTimeout(`${GROK_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "grok-3-mini-fast", messages, temperature: 0.2 }),
  }, 30000));

  const status = res.status;
  const data = await res.json();
  console.log("Grok API status:", status);
  if (status !== 200) { console.error("Grok API error:", JSON.stringify(data).slice(0, 500)); return ""; }

  const content = data.choices?.[0]?.message?.content ?? "";
  console.log("Grok response length:", content.length, "| first 200 chars:", content.slice(0, 200));
  return content;
}

// ── Make Decision (Grok) ─────────────────────────────────────────────────────
export async function makeDecision(
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
      const vp = tech.volume_profile;
      block += `\n  Volume: ${tech.volume?.toLocaleString()} (${vp.volume_ratio ?? "?"}× avg) | OBV: ${vp.obv_trend ?? "N/A"}`;
      if (vp.institutional_signal) block += `\n  ⚡ ORDER FLOW: ${vp.institutional_signal}`;
      if (tech.patterns.length > 0) {
        block += `\n  📊 PATTERNS:`;
        for (const p of tech.patterns) {
          block += `\n    → ${p.name.toUpperCase()} (${p.direction}, ${(p.confidence * 100).toFixed(0)}% conf): ${p.description}`;
        }
      }
      if (tech.mtf) block += `\n  🔍 MULTI-TF: ${tech.mtf.summary}`;
      if (tech.sector.sector) {
        block += `\n  🏢 Sector: ${tech.sector.sector} (${tech.sector.sector_performance != null ? (tech.sector.sector_performance > 0 ? "+" : "") + tech.sector.sector_performance + "%" : "N/A"}) | Relative Strength: ${tech.sector.relative_strength ?? "N/A"}`;
      }
      const fhSent = enrichment?.finnhubSentiment?.[sym];
      if (fhSent && fhSent.sentiment > 0) {
        block += `\n  📰 Sentiment: ${(fhSent.sentiment * 100).toFixed(0)}% bullish | Buzz: ${fhSent.buzz.toFixed(1)}×`;
        if (fhSent.headlines.length > 0) block += `\n  Headlines: ${fhSent.headlines.join(" | ")}`;
      } else {
        block += `\n  News: ${news.length ? news.slice(0, 3).join(" | ") : "aucune"}`;
      }
      const insider = enrichment?.insiderTrades?.[sym];
      if (insider && insider.length > 0) block += `\n  🔑 INSIDER: ${insider.join(" | ")}`;
      const earningsDate = enrichment?.earnings?.[sym];
      if (earningsDate) block += `\n  ⚠️ EARNINGS: ${earningsDate}`;
      return block;
    }).join("\n\n");

  const now = new Date();
  const DEADLINE = getCurrentWeekDeadline();
  const hoursLeft = Math.max(0, Math.floor((DEADLINE.getTime() - now.getTime()) / (1000 * 60 * 60)));
  const cyclesLeft = estimateRemainingCycles(now, DEADLINE);
  const etHour = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" })).getHours();
  const etMin = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" })).getMinutes();
  const etTime = etHour + etMin / 60;
  let marketPhase = "Mid-Day (normal)";
  if (etTime >= 9.5 && etTime < 10) marketPhase = "🔥 OPEN RUSH (9:30-10:00 ET)";
  else if (etTime >= 10 && etTime < 10.5) marketPhase = "Opening Continuation (10:00-10:30 ET)";
  else if (etTime >= 10.5 && etTime < 12) marketPhase = "Late Morning (10:30-12:00 ET)";
  else if (etTime >= 12 && etTime < 14) marketPhase = "⚠️ Lunch Lull (12:00-2:00 ET)";
  else if (etTime >= 14 && etTime < 15.5) marketPhase = "Afternoon Recovery (2:00-3:30 ET)";
  else if (etTime >= 15.5 && etTime < 16) marketPhase = "🔥 POWER HOUR (3:30-4:00 ET)";

  // NOTE: The full system prompt and user prompt are very long. We build them inline.
  // For brevity, only the SELL decisions from Grok are used (buys come from quant engine).
  const systemPrompt = `Tu es le moteur de décision d'un bot de trading autonome. MODE: ${tradingModeLabel}. Tu analyses les positions existantes et recommandes des SELLs.

CRITICAL RULES:
- ONLY recommend SELL when a position has a REAL problem: loss exceeding -1.5%, confirmed pattern breakdown, or fundamental catalyst change.
- DO NOT sell positions that are slightly negative (-0.5% or less). Small drawdowns are NORMAL — give trades room to work.
- DO NOT sell positions that are profitable unless they hit a clear resistance or show reversal signals.
- HOLD is the DEFAULT. You need a strong, specific reason to SELL.
- When in doubt, HOLD. Overtrading destroys returns.`;

  const userPrompt = `Cycle #${cycleCount} — ${cyclesLeft} cycles left (~${hoursLeft}h). Phase: ${marketPhase}
P&L du jour: $${todayPnl.toFixed(2)} / $${DAILY_PROFIT_TARGET}${hitDailyTarget ? " ✅ TARGET HIT" : ""}

Portfolio: Cash=$${account.cash} Equity=$${account.equity}
Positions:
${(positions as Record<string, unknown>[]).map((p) =>
  ` ${p.symbol}: ${p.qty} shares | Avg: $${p.avg_entry_price} | PnL: $${p.unrealized_pl}`
).join("\n") || " None"}

Sector rotation:
${Object.entries(SECTOR_ETFS).map(([sector, etf]) => {
  const perf = _sectorCache[etf];
  return perf != null ? `  ${sector} (${etf}): ${perf > 0 ? "+" : ""}${perf}%` : null;
}).filter(Boolean).join("\n") || "  N/A"}

Market sentiment: F&G=${enrichment ? `${enrichment.fearGreed.score}(${enrichment.fearGreed.label})` : "N/A"} VIX=${enrichment ? `${enrichment.vix.value}(${enrichment.vix.label})` : "N/A"}

Market Data:
${marketSummary}

History (last ${history.length}):
${JSON.stringify(history, null, 2)}
${lastAnalysis ? `\nLast analysis:\n${lastAnalysis}\n` : ""}
${latestMetrics ? `\nPerformance:\n${latestMetrics}\n` : ""}
Hot List:
${hotList.summary || "N/A"}

Respond ONLY in valid JSON array. For each HELD position, decide SELL or HOLD:
[{"action": "SELL"|"HOLD", "symbol": "TICKER", "quantity": number, "reason": "..."}]`;

  let content = "";
  try {
    content = await callGrok(userPrompt, systemPrompt, true);
    if (!content || content.trim().length === 0) return null;
    const parsed = extractJson(content);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    console.error("Decision parse error:", (err as Error).message);
    try {
      content = await callGrok(userPrompt, systemPrompt, false);
      if (!content || content.trim().length === 0) return null;
      const parsed = extractJson(content);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (err2) {
      console.error("Fallback also failed:", (err2 as Error).message);
      return null;
    }
  }
}
