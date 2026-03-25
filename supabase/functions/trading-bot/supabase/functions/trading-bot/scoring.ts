// ── Quant Scoring Engine ─────────────────────────────────────────────────────

import type { TechData, SnapshotData, QuantScore } from "./types.ts";
import { BLACKLISTED_TICKERS, MIN_SCORE } from "./config.ts";
import { supabase } from "./portfolio.ts";

// ── BigData (RavenPack) Signals ──────────────────────────────────────────────
export interface BigDataSignals {
  earningsDaysAway: number | null;   // days until next earnings (null = unknown)
  earningsPeriod: string | null;     // e.g. "Q1 2027"
  analystScore: number | null;       // -1 (strong sell) to +1 (strong buy)
  analystConsensus: string | null;   // "Strong Buy", "Buy", "Hold", "Sell"
  priceTargetUpside: number | null;  // decimal, e.g. 0.59 = 59% upside
  sentiment: number | null;          // -1 to +1 RavenPack sentiment
}

export async function getBigDataSignals(symbols: string[]): Promise<Map<string, BigDataSignals>> {
  const result = new Map<string, BigDataSignals>();
  try {
    const { data } = await supabase
      .from("bigdata_signals")
      .select("symbol, signal_type, data, score")
      .in("symbol", symbols)
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .order("created_at", { ascending: false });

    if (!data || data.length === 0) return result;

    for (const row of data) {
      if (!result.has(row.symbol)) {
        result.set(row.symbol, {
          earningsDaysAway: null, earningsPeriod: null,
          analystScore: null, analystConsensus: null,
          priceTargetUpside: null, sentiment: null,
        });
      }
      const sig = result.get(row.symbol)!;
      const d = row.data as Record<string, unknown>;

      if (row.signal_type === "earnings_date" && sig.earningsDaysAway === null) {
        sig.earningsDaysAway = (d.days_away as number) ?? null;
        sig.earningsPeriod = (d.period as string) ?? null;
      } else if (row.signal_type === "analyst_rating" && sig.analystScore === null) {
        sig.analystScore = row.score != null ? Number(row.score) : null;
        sig.analystConsensus = (d.consensus as string) ?? null;
      } else if (row.signal_type === "price_target" && sig.priceTargetUpside === null) {
        sig.priceTargetUpside = row.score != null ? Number(row.score) : null;
      } else if (row.signal_type === "sentiment" && sig.sentiment === null) {
        sig.sentiment = row.score != null ? Number(row.score) : null;
      }
    }
    console.log(`📊 BIGDATA: loaded signals for ${result.size} symbols`);
  } catch (err) {
    console.warn("BigData signals fetch failed (non-fatal):", (err as Error).message);
  }
  return result;
}

// ── Massive Market Data Signals ──────────────────────────────────────────────
export interface MassiveSignals {
  newsSentiment: number | null;  // -1 to +1
  newsHeadlines: string[];
  dailyRsi: number | null;
  dailyMacd: { value: number; signal: number; histogram: number } | null;
  dailySma20: number | null;
}

export async function getMassiveSignals(symbols: string[]): Promise<Map<string, MassiveSignals>> {
  const result = new Map<string, MassiveSignals>();
  try {
    const { data } = await supabase
      .from("massive_signals")
      .select("symbol, signal_type, data, score")
      .in("symbol", symbols)
      .gte("created_at", new Date(Date.now() - 30 * 60 * 1000).toISOString())
      .order("created_at", { ascending: false });

    if (!data || data.length === 0) return result;

    for (const row of data) {
      if (!result.has(row.symbol)) {
        result.set(row.symbol, {
          newsSentiment: null, newsHeadlines: [],
          dailyRsi: null, dailyMacd: null, dailySma20: null,
        });
      }
      const sig = result.get(row.symbol)!;
      const d = row.data as Record<string, unknown>;

      if (row.signal_type === "news_sentiment" && sig.newsSentiment === null) {
        sig.newsSentiment = row.score ?? null;
        sig.newsHeadlines = (d.headlines as string[] ?? []).slice(0, 2);
      } else if (row.signal_type === "rsi" && sig.dailyRsi === null) {
        sig.dailyRsi = (d.value as number) ?? null;
      } else if (row.signal_type === "macd" && sig.dailyMacd === null) {
        sig.dailyMacd = {
          value: (d.value as number) ?? 0,
          signal: (d.signal as number) ?? 0,
          histogram: (d.histogram as number) ?? 0,
        };
      } else if (row.signal_type === "sma" && sig.dailySma20 === null) {
        sig.dailySma20 = (d.value as number) ?? null;
      }
    }
    console.log(`📡 MASSIVE: loaded signals for ${result.size} symbols`);
  } catch (err) {
    console.warn("Massive signals fetch failed (non-fatal):", (err as Error).message);
  }
  return result;
}

// ── Market Regime (VIX) ──────────────────────────────────────────────────────
export interface MarketRegime {
  vix: number;
  regime: "calm" | "normal" | "elevated" | "panic";
  positionScale: number;  // multiplier for position sizes (0.25 to 1.0)
  scoreBoost: number;     // added to MIN_SCORE threshold
}

export async function getMarketRegime(): Promise<MarketRegime> {
  const defaultRegime: MarketRegime = { vix: 20, regime: "normal", positionScale: 1.0, scoreBoost: 0 };
  try {
    const { data } = await supabase
      .from("bigdata_signals")
      .select("data, score")
      .eq("symbol", "_VIX")
      .eq("signal_type", "market_regime")
      .gte("created_at", new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString())
      .order("created_at", { ascending: false })
      .limit(1);

    if (!data || data.length === 0) return defaultRegime;

    const vix = Number(data[0].score) || 20;
    if (vix < 18) return { vix, regime: "calm", positionScale: 1.0, scoreBoost: -5 };
    if (vix < 25) return { vix, regime: "normal", positionScale: 1.0, scoreBoost: 0 };
    if (vix < 35) return { vix, regime: "elevated", positionScale: 0.6, scoreBoost: 10 };
    return { vix, regime: "panic", positionScale: 0.3, scoreBoost: 20 };
  } catch (err) {
    console.warn("Market regime fetch failed (non-fatal):", (err as Error).message);
    return defaultRegime;
  }
}

// ── Macro Economic Calendar ──────────────────────────────────────────────────
export interface MacroCalendar {
  highImpactToday: boolean;
  highImpactEvents: string[];   // event names
  positionScale: number;        // 0.5 for HIGH impact days, 1.0 for calm days
}

export async function getMacroCalendar(): Promise<MacroCalendar> {
  const defaultCal: MacroCalendar = { highImpactToday: false, highImpactEvents: [], positionScale: 1.0 };
  try {
    const { data } = await supabase
      .from("bigdata_signals")
      .select("data, score")
      .eq("symbol", "_MACRO")
      .eq("signal_type", "economic_calendar")
      .gte("created_at", new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString())
      .order("created_at", { ascending: false })
      .limit(1);

    if (!data || data.length === 0) return defaultCal;

    const d = data[0].data as Record<string, unknown>;
    const highEvents = (d.high_impact_events as string[]) ?? [];
    const maxImpact = (d.max_impact as string) ?? "LOW";

    if (maxImpact === "HIGH") {
      return { highImpactToday: true, highImpactEvents: highEvents, positionScale: 0.5 };
    } else if (maxImpact === "MEDIUM" && highEvents.length >= 3) {
      // Multiple medium events = treat as elevated
      return { highImpactToday: false, highImpactEvents: highEvents, positionScale: 0.7 };
    }
    return defaultCal;
  } catch (err) {
    console.warn("Macro calendar fetch failed (non-fatal):", (err as Error).message);
    return defaultCal;
  }
}

// ── Short Interest Signals ───────────────────────────────────────────────────
export interface ShortInterestData {
  shortVolumeRatio: number | null;  // 0-100%, daily short volume / total volume
}

export async function getShortInterest(symbols: string[]): Promise<Map<string, ShortInterestData>> {
  const result = new Map<string, ShortInterestData>();
  try {
    const { data } = await supabase
      .from("massive_signals")
      .select("symbol, data, score")
      .in("symbol", symbols)
      .eq("signal_type", "short_volume")
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .order("created_at", { ascending: false });

    if (!data || data.length === 0) return result;

    for (const row of data) {
      if (!result.has(row.symbol)) {
        result.set(row.symbol, {
          shortVolumeRatio: row.score != null ? Number(row.score) : null,
        });
      }
    }
    console.log(`📉 SHORT INTEREST: loaded for ${result.size} symbols`);
  } catch (err) {
    console.warn("Short interest fetch failed (non-fatal):", (err as Error).message);
  }
  return result;
}

// ── Score a single stock ─────────────────────────────────────────────────────
export function quantScore(
  tech: TechData & { symbol: string },
  snapshot: SnapshotData | undefined,
  socialData: { mentions: number; sentiment: string } | undefined,
  optionsSignal: number,
  equity: number,
  massiveSignals?: MassiveSignals | null,
  bigDataSignals?: BigDataSignals | null,
  shortInterest?: ShortInterestData | null,
): QuantScore {
  const reasons: string[] = [];
  let score = 0;

  // 1. MOMENTUM (0-25 pts)
  const changePct = snapshot?.change_pct ?? tech.change_pct;
  const absChange = Math.abs(changePct);
  let momentum = 0;
  if (changePct > 0) {
    if (absChange >= 1 && absChange <= 5) momentum = Math.min(25, absChange * 5);
    else if (absChange > 5) momentum = 15;
    else momentum = absChange * 8;
    reasons.push(`📈 +${changePct.toFixed(1)}%`);
  } else if (changePct < -3 && tech.rsi14 !== null && tech.rsi14 < 35) {
    momentum = 15;
    reasons.push(`🔄 oversold bounce (RSI=${tech.rsi14})`);
  }
  score += momentum;

  // 2. VOLUME (0-20 pts)
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
  if (volProfile.institutional_signal === "accumulation") {
    volumeScore += 5;
    reasons.push("🏦 accumulation");
  }
  score += Math.min(20, volumeScore);

  // 3. RSI SIGNAL (0-15 pts) — tightened: "normal" RSI no longer maxes out
  let rsiSignal = 0;
  if (tech.rsi14 !== null) {
    if (tech.rsi14 < 30) { rsiSignal = 15; reasons.push(`RSI=${tech.rsi14} deeply oversold`); }
    else if (tech.rsi14 >= 30 && tech.rsi14 < 35) { rsiSignal = 12; reasons.push(`RSI=${tech.rsi14} oversold`); }
    else if (tech.rsi14 >= 35 && tech.rsi14 < 40) { rsiSignal = 10; }
    else if (tech.rsi14 >= 40 && tech.rsi14 <= 65) { rsiSignal = 8; }
    else if (tech.rsi14 > 65 && tech.rsi14 <= 75) { rsiSignal = 3; }
    else if (tech.rsi14 > 75) { rsiSignal = 0; }
  }
  score += rsiSignal;

  // 4. MACD SIGNAL (0-10 pts)
  let macdSignal = 0;
  if (tech.macd_hist !== null) {
    if (tech.macd_hist > 0 && tech.macd !== null && tech.macd > 0) {
      macdSignal = 10;
      reasons.push("MACD bullish");
    } else if (tech.macd_hist > 0) {
      macdSignal = 5;
    }
  }
  score += macdSignal;

  // 5. PATTERN BREAKOUT (0-15 pts)
  let patternScore = 0;
  const bullishPatterns = tech.patterns.filter(p =>
    p.direction === "bullish" && p.confidence > 0.5
  );
  if (bullishPatterns.length > 0) {
    const best = bullishPatterns.sort((a, b) => b.confidence - a.confidence)[0];
    if (best.confidence >= 0.8) {
      patternScore = 15;
      reasons.push(`✅ ${best.name} confirmed (${(best.confidence * 100).toFixed(0)}%)`);
    } else {
      patternScore = Math.min(10, Math.floor(best.confidence * 10));
      reasons.push(`📐 ${best.name} (${(best.confidence * 100).toFixed(0)}%)`);
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
      socialBuzz = 3;
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
    score -= 10;
    reasons.push("⚠️ bearish options flow");
  }
  score += optionsFlowScore;

  // 8. MASSIVE NEWS SENTIMENT (0-10 pts / -5 penalty)
  let massiveNewsScore = 0;
  if (massiveSignals?.newsSentiment != null) {
    const sent = massiveSignals.newsSentiment;
    if (sent >= 0.5) {
      massiveNewsScore = 10;
      reasons.push(`📰 Massive: strong bullish news (${sent.toFixed(2)})`);
    } else if (sent >= 0.2) {
      massiveNewsScore = 5;
      reasons.push(`📰 Massive: bullish news (${sent.toFixed(2)})`);
    } else if (sent <= -0.5) {
      massiveNewsScore = -5;
      reasons.push(`⚠️ Massive: bearish news (${sent.toFixed(2)})`);
    } else if (sent <= -0.2) {
      massiveNewsScore = -3;
    }
    // Daily RSI confirmation: if Massive daily RSI agrees with intraday, bonus
    if (massiveSignals.dailyRsi != null && tech.rsi14 != null) {
      const bothOversold = massiveSignals.dailyRsi < 35 && tech.rsi14 < 40;
      const bothHealthy = massiveSignals.dailyRsi >= 40 && massiveSignals.dailyRsi <= 65 && tech.rsi14 >= 40 && tech.rsi14 <= 65;
      if (bothOversold || bothHealthy) {
        massiveNewsScore += 3;
        reasons.push(`🔗 daily+intraday RSI aligned`);
      }
    }
    // Daily MACD confirmation
    if (massiveSignals.dailyMacd && massiveSignals.dailyMacd.histogram > 0 && tech.macd_hist !== null && tech.macd_hist > 0) {
      massiveNewsScore += 2;
      reasons.push(`🔗 daily+intraday MACD bullish`);
    }
  }
  score += massiveNewsScore;

  // 9. BIGDATA: EARNINGS PLAY + ANALYST CONSENSUS + PRICE TARGET (max +17 / -10 penalty)
  let bigDataScore = 0;
  if (bigDataSignals) {
    // ANALYST CONSENSUS: -5 to +7 pts (always applied)
    if (bigDataSignals.analystScore != null) {
      if (bigDataSignals.analystScore >= 0.6) {
        bigDataScore += 7;
        reasons.push(`🏦 analysts: Strong Buy (${bigDataSignals.analystScore.toFixed(2)})`);
      } else if (bigDataSignals.analystScore >= 0.3) {
        bigDataScore += 4;
        reasons.push(`🏦 analysts: Buy`);
      } else if (bigDataSignals.analystScore <= -0.3) {
        bigDataScore -= 5;
        reasons.push(`⚠️ analysts: Sell (${bigDataSignals.analystScore.toFixed(2)})`);
      }
    }

    // PRICE TARGET UPSIDE: -3 to +5 pts (always applied)
    if (bigDataSignals.priceTargetUpside != null) {
      if (bigDataSignals.priceTargetUpside >= 0.30) {
        bigDataScore += 5;
        reasons.push(`🎯 target +${(bigDataSignals.priceTargetUpside * 100).toFixed(0)}% upside`);
      } else if (bigDataSignals.priceTargetUpside >= 0.15) {
        bigDataScore += 3;
      } else if (bigDataSignals.priceTargetUpside <= -0.10) {
        bigDataScore -= 3;
        reasons.push(`⚠️ below target (${(bigDataSignals.priceTargetUpside * 100).toFixed(0)}%)`);
      }
    }

    // EARNINGS PROXIMITY: context-dependent (within 2 days)
    if (bigDataSignals.earningsDaysAway != null && bigDataSignals.earningsDaysAway <= 2) {
      const hasStrongBuy = bigDataSignals.analystScore != null && bigDataSignals.analystScore >= 0.5;
      const hasUpside = bigDataSignals.priceTargetUpside != null && bigDataSignals.priceTargetUpside >= 0.15;
      if (hasStrongBuy && hasUpside) {
        // Analysts love it + big upside target = earnings catalyst play
        bigDataScore += 5;
        reasons.push(`🚀 earnings in ${bigDataSignals.earningsDaysAway}d — analysts bullish, riding it`);
      } else if (bigDataSignals.analystScore != null && bigDataSignals.analystScore <= 0) {
        // Weak/negative analyst consensus near earnings = danger
        bigDataScore -= 10;
        reasons.push(`🚫 earnings in ${bigDataSignals.earningsDaysAway}d — weak consensus, risky`);
      } else {
        // Mixed signals near earnings = small caution
        bigDataScore -= 5;
        reasons.push(`⚠️ earnings in ${bigDataSignals.earningsDaysAway}d — uncertain`);
      }
    }
  }
  score += bigDataScore;

  // 10. SHORT INTEREST: squeeze detection + bearish warning (-5 to +8 pts)
  let shortScore = 0;
  if (shortInterest?.shortVolumeRatio != null) {
    const ratio = shortInterest.shortVolumeRatio;
    const analystBullish = bigDataSignals?.analystScore != null && bigDataSignals.analystScore >= 0.3;
    const priceRising = (snapshot?.change_pct ?? tech.change_pct) > 1;

    if (ratio >= 50 && analystBullish && priceRising) {
      // High short + analysts bullish + price rising = squeeze setup
      shortScore = 8;
      reasons.push(`🩳🔥 squeeze setup: ${ratio.toFixed(0)}% short + rising + analysts bullish`);
    } else if (ratio >= 50 && !analystBullish) {
      // High short + weak fundamentals = smart money is right, stay away
      shortScore = -5;
      reasons.push(`⚠️ ${ratio.toFixed(0)}% short vol — bearish pressure`);
    } else if (ratio >= 40 && analystBullish) {
      // Moderate short + bullish = mild squeeze potential
      shortScore = 3;
      reasons.push(`🩳 ${ratio.toFixed(0)}% short + bullish consensus`);
    }
  }
  score += shortScore;

  // PRICE FILTER
  if (tech.price < 5 || tech.price > 500) score = 0;

  // VWAP CHECK
  if (tech.vwap && tech.price > tech.vwap) {
    score += 3;
    reasons.push("above VWAP");
  }

  // SMA TREND
  if (tech.sma20 && tech.sma50 && tech.price > tech.sma20 && tech.sma20 > tech.sma50) {
    score += 3;
  }

  // MULTI-SIGNAL GATE: require at least 2 non-zero core signals to avoid single-signal junk trades
  const nonZeroSignals = [momentum, volumeScore, rsiSignal, macdSignal, patternScore, socialBuzz, optionsFlowScore]
    .filter(s => s > 0).length;
  if (nonZeroSignals < 2) {
    score = Math.min(score, 20); // cap at 20 — never clears MIN_SCORE of 35
    reasons.push(`⛔ single-signal (${nonZeroSignals}/7)`);
  }

  score = Math.max(0, Math.min(100, score));

  const riskPct = Math.min(0.20, score >= 70 ? 0.20 : score >= 50 ? 0.15 : 0.10);
  const targetValue = equity * riskPct;
  const suggestedQty = tech.price > 0 ? Math.max(1, Math.floor(targetValue / tech.price)) : 0;
  const suggestedStop = tech.atr14 ? Math.min(0.05, Math.max(0.015, (tech.atr14 * 1.5) / tech.price)) : 0.025;

  return {
    symbol: tech.symbol, score, momentum, volumeScore: Math.min(20, volumeScore),
    rsiSignal, macdSignal, patternScore, socialBuzz, optionsFlow: optionsFlowScore,
    reason: reasons.length > 0 ? reasons.join(" | ") : "weak signals",
    suggestedQty, suggestedStop,
  };
}

// ── QUANT PICK: Score all candidates, return top N buy decisions ──────────────
export async function quantPick(
  marketData: Record<string, { tech: TechData & { symbol: string }; news: string[] }>,
  snapshots: SnapshotData[],
  socialData: Array<{ symbol: string; mentions: number; sentiment: string }>,
  optionsFlow: Record<string, number>,
  heldSymbols: Set<string>,
  cooldownSymbols: Set<string>,
  equity: number,
  maxPicks = 8,
): Promise<{ decisions: Array<{ action: string; symbol: string; quantity: number; reason: string }>; scores: QuantScore[] }> {
  const snapshotMap = new Map(snapshots.map(s => [s.symbol, s]));
  const socialMap = new Map(socialData.map(s => [s.symbol, s]));

  // Fetch Massive Market Data signals for all candidate symbols
  const candidateSymbols = Object.keys(marketData).filter(sym =>
    !heldSymbols.has(sym) && !cooldownSymbols.has(sym) && !BLACKLISTED_TICKERS.has(sym)
  );
  const massiveMap = await getMassiveSignals(candidateSymbols);
  const bigDataMap = await getBigDataSignals(candidateSymbols);
  const shortMap = await getShortInterest(candidateSymbols);
  const regime = await getMarketRegime();
  const macro = await getMacroCalendar();

  console.log(`🌡️ MARKET REGIME: VIX=${regime.vix.toFixed(1)} → ${regime.regime} (scale=${regime.positionScale}, minScore+=${regime.scoreBoost})`);
  if (macro.highImpactToday) {
    console.log(`📅 MACRO: HIGH impact day — ${macro.highImpactEvents.join(", ")} (scale=${macro.positionScale})`);
  } else if (macro.positionScale < 1.0) {
    console.log(`📅 MACRO: elevated event load (scale=${macro.positionScale})`);
  }

  // Combine VIX + macro position scaling (multiplicative)
  const combinedPositionScale = regime.positionScale * macro.positionScale;
  const effectiveMinScore = MIN_SCORE + regime.scoreBoost;

  const allScores: QuantScore[] = [];
  for (const [sym, data] of Object.entries(marketData)) {
    if (heldSymbols.has(sym)) continue;
    if (cooldownSymbols.has(sym)) continue;
    if (BLACKLISTED_TICKERS.has(sym)) continue;
    const snap = snapshotMap.get(sym);
    if (snap && snap.change_pct < -10) continue;

    const scored = quantScore(data.tech, snap, socialMap.get(sym), optionsFlow[sym] ?? 0, equity, massiveMap.get(sym), bigDataMap.get(sym), shortMap.get(sym));
    // Apply VIX + macro position scaling
    scored.suggestedQty = Math.max(1, Math.floor(scored.suggestedQty * combinedPositionScale));
    allScores.push(scored);
  }

  allScores.sort((a, b) => b.score - a.score);
  const topPicks = allScores.filter(s => s.score >= effectiveMinScore).slice(0, maxPicks);

  console.log(`🧮 QUANT SCORES (top 10): ${allScores.slice(0, 10).map(s => `${s.symbol}=${s.score}`).join(", ")}`);
  console.log(`🎯 QUANT PICKS (${topPicks.length}): ${topPicks.map(s => `${s.symbol}(${s.score}pts)`).join(", ")}`);

  const decisions = topPicks.map(pick => ({
    action: "BUY" as const,
    symbol: pick.symbol,
    quantity: pick.suggestedQty,
    reason: `🧮 QUANT SCORE ${pick.score}/100 [VIX=${regime.vix.toFixed(0)}/${regime.regime}]${macro.highImpactToday ? " [📅 MACRO DAY]" : ""}: ${pick.reason} | stop=${(pick.suggestedStop * 100).toFixed(1)}%`,
  }));

  return { decisions, scores: allScores };
}
