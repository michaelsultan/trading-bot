// ── Social Sentiment, Earnings, Enrichment Data ──────────────────────────────

import type { FearGreedData, VixData, ShortInterestData, CongressTrade, SocialStock, EnrichmentData } from "./types.ts";
import { ALPACA_DATA_URL, FINNHUB_BASE_URL } from "./config.ts";
import { fetchWithTimeout, withRetry } from "./utils.ts";
import { alpacaHeaders } from "./execution.ts";

// ── Finnhub: News Sentiment ──────────────────────────────────────────────────
export async function getFinnhubSentiment(symbol: string): Promise<{ sentiment: number; buzz: number; headlines: string[] }> {
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
export async function getUpcomingEarnings(symbols: string[]): Promise<Record<string, string>> {
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

// ── Earnings Exception: Hold positions through close if AMC earnings ─────────
export async function getEarningsExemptSymbols(heldSymbols: string[]): Promise<Set<string>> {
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
export async function getInsiderTransactions(symbol: string): Promise<string[]> {
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
export async function getFearGreedIndex(): Promise<FearGreedData> {
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
  } catch { return { score: 50, label: "Neutral", previous: 50 }; }
}

// ── VIX Volatility Index ─────────────────────────────────────────────────────
export async function getVixLevel(): Promise<VixData> {
  try {
    const res = await fetchWithTimeout(`${ALPACA_DATA_URL}/stocks/snapshots?symbols=VXX,UVXY`, {
      headers: alpacaHeaders,
    });
    const data = await res.json();
    const vxx = data?.VXX?.latestTrade?.p ?? data?.UVXY?.latestTrade?.p ?? null;
    if (!vxx) return { value: 20, label: "Normal" };
    let label = "Normal";
    if (vxx < 15) label = "Low Vol";
    else if (vxx < 25) label = "Normal";
    else if (vxx < 35) label = "Elevated";
    else if (vxx < 50) label = "High Vol";
    else label = "Extreme";
    return { value: Math.round(vxx * 10) / 10, label };
  } catch { return { value: 20, label: "Normal" }; }
}

// ── Short Interest ───────────────────────────────────────────────────────────
export async function getHighShortInterest(): Promise<ShortInterestData[]> {
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

// ── Congressional Trading ────────────────────────────────────────────────────
export async function getCongressTrades(): Promise<CongressTrade[]> {
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
export async function getWsbTrending(): Promise<SocialStock[]> {
  const results: SocialStock[] = [];

  try {
    const [wsbRes, stocksRes] = await Promise.all([
      fetchWithTimeout("https://apewisdom.io/api/v1.0/filter/wallstreetbets/page/1"),
      fetchWithTimeout("https://apewisdom.io/api/v1.0/filter/all-stocks/page/1"),
    ]);
    const wsbData = await wsbRes.json();
    const stocksData = await stocksRes.json();

    for (const r of (wsbData?.results ?? []).slice(0, 15)) {
      results.push({
        symbol: r.ticker, mentions: r.mentions ?? 0,
        mentions_24h_ago: r.mentions_24h_ago ?? 0,
        sentiment: (r.upvotes ?? 0) > 0 ? "bullish" : "neutral",
        source: "WSB",
      });
    }
    const wsbSymbols = new Set(results.map(r => r.symbol));
    for (const r of (stocksData?.results ?? []).slice(0, 15)) {
      if (!wsbSymbols.has(r.ticker)) {
        results.push({
          symbol: r.ticker, mentions: r.mentions ?? 0,
          mentions_24h_ago: r.mentions_24h_ago ?? 0,
          sentiment: (r.upvotes ?? 0) > 0 ? "bullish" : "neutral",
          source: "Reddit",
        });
      }
    }
  } catch (err) {
    console.error("ApeWisdom fetch failed:", (err as Error).message);
  }

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
            symbol: r.ticker, mentions: r.mentions ?? r.count ?? 0,
            mentions_24h_ago: 0,
            sentiment: (r.sentiment ?? 0) > 0 ? "bullish" : (r.sentiment ?? 0) < 0 ? "bearish" : "neutral",
            source: "QuiverWSB",
          });
        }
      }
    }
  } catch { /* QuiverQuant optional */ }

  results.sort((a, b) => b.mentions - a.mentions);
  for (const r of results) {
    if (r.mentions_24h_ago > 0 && r.mentions > r.mentions_24h_ago * 1.5) {
      r.sentiment = `🚀 SPIKING (${Math.round((r.mentions / r.mentions_24h_ago - 1) * 100)}% ↑) — ${r.sentiment}`;
    }
  }
  console.log(`Social sentiment: ${results.length} stocks tracked (${results.filter(r => r.source === "WSB").length} from WSB)`);
  return results;
}

// ── Options Flow ─────────────────────────────────────────────────────────────
export async function getOptionsFlow(symbols: string[]): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  try {
    const res = await fetchWithTimeout(
      "https://phx.unusualwhales.com/api/option_trades/flow_summary", {}, 5000
    );
    if (res.ok) {
      const data = await res.json();
      const flows = data?.data ?? [];
      for (const flow of flows) {
        if (symbols.includes(flow.ticker)) {
          const callRatio = flow.call_premium / (flow.call_premium + flow.put_premium + 1);
          result[flow.ticker] = (callRatio - 0.5) * 2;
        }
      }
    }
  } catch {
    console.log("Options flow API unavailable — skipping");
  }
  for (const sym of symbols) {
    if (result[sym] === undefined) result[sym] = 0;
  }
  return result;
}

// ── Combine all enrichment data ──────────────────────────────────────────────
export async function getEnrichmentData(symbols: string[]): Promise<EnrichmentData> {
  const [fearGreed, vix, earnings, socialSentiment, shortInterest, congressTrades] = await Promise.all([
    getFearGreedIndex(),
    getVixLevel(),
    getUpcomingEarnings(symbols),
    getWsbTrending(),
    getHighShortInterest(),
    getCongressTrades(),
  ]);

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
