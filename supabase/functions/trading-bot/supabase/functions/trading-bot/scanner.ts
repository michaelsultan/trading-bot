// ── Market Scanner: Snapshots, Screening, Hot List, Discovery ────────────────

import type { SnapshotData } from "./types.ts";
import { ALPACA_DATA_URL, FULL_UNIVERSE, BLACKLISTED_TICKERS } from "./config.ts";
import { fetchWithTimeout, withRetry } from "./utils.ts";
import { getCurrentTradingMode } from "./utils.ts";
import { alpacaHeaders } from "./execution.ts";
import { getWsbTrending, getHighShortInterest } from "./social.ts";

// ── Fetch Alpaca Snapshots ───────────────────────────────────────────────────
export async function fetchSnapshots(symbols: string[]): Promise<SnapshotData[]> {
  const results: SnapshotData[] = [];
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
        { headers: alpacaHeaders }, 15000
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
          results.push({ symbol: sym, price, change_pct: changePct, volume: dailyBar.v ?? 0, prev_close: prevClose });
        }
      }
    } catch (err) {
      console.error(`Snapshot batch failed:`, String(err));
    }
  }));
  return results;
}

// ── Most Actives ─────────────────────────────────────────────────────────────
export async function fetchMostActives(top = 20): Promise<string[]> {
  try {
    const res = await withRetry(() => fetchWithTimeout(
      `https://data.alpaca.markets/v1beta1/screener/stocks/most-actives?top=${top}&by=volume`,
      { headers: alpacaHeaders }
    ));
    const data = await res.json();
    return (data?.most_actives ?? []).map((s: Record<string, string>) => s.symbol).filter(Boolean);
  } catch { return []; }
}

// ── Top Movers ───────────────────────────────────────────────────────────────
export async function fetchTopMovers(top = 10): Promise<{ gainers: string[]; losers: string[] }> {
  try {
    const res = await withRetry(() => fetchWithTimeout(
      `https://data.alpaca.markets/v1beta1/screener/stocks/movers?top=${top}`,
      { headers: alpacaHeaders }
    ));
    const data = await res.json();
    const gainers = (data?.gainers ?? []).map((s: Record<string, string>) => s.symbol);
    const losers = (data?.losers ?? []).map((s: Record<string, string>) => s.symbol);
    return { gainers, losers };
  } catch { return { gainers: [], losers: [] }; }
}

// ── Pre-Screen Symbols ───────────────────────────────────────────────────────
export function preScreenSymbols(snapshots: SnapshotData[]): {
  momentum: string[]; volumeSpikes: string[]; gappers: string[]; oversold: string[];
} {
  const sorted = [...snapshots].sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct));
  const momentum = sorted.filter(s => s.volume > 100_000).slice(0, 15).map(s => s.symbol);
  const byVolume = [...snapshots].sort((a, b) => b.volume - a.volume);
  const volumeSpikes = byVolume.slice(0, 15).map(s => s.symbol);
  const gappers = snapshots
    .filter(s => Math.abs(s.change_pct) > 2 && s.volume > 300_000)
    .sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct))
    .slice(0, 15).map(s => s.symbol);
  const oversold = snapshots
    .filter(s => s.change_pct < -3 && s.volume > 300_000)
    .sort((a, b) => a.change_pct - b.change_pct)
    .slice(0, 8).map(s => s.symbol);
  return { momentum, volumeSpikes, gappers, oversold };
}

// ── HOT LIST ─────────────────────────────────────────────────────────────────
export function buildHotList(snapshots: SnapshotData[], maxItems = 25): { symbols: string[]; summary: string } {
  const { mode } = getCurrentTradingMode();
  const scored = snapshots
    .filter(s =>
      s.price >= 5 && s.price <= 500 && s.volume > 100_000 &&
      !BLACKLISTED_TICKERS.has(s.symbol) && Math.abs(s.change_pct) >= 0.3
    )
    .map(s => {
      let score = Math.abs(s.change_pct) * Math.log10(Math.max(s.volume, 1));
      if (s.volume > 5_000_000) score *= 2;
      else if (s.volume > 2_000_000) score *= 1.5;
      if (mode === "SCALP" && s.price >= 10 && s.price <= 100) score *= 1.3;
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

// ── Discover Symbols ─────────────────────────────────────────────────────────
export async function discoverSymbols(
  positions: unknown[],
  _history: unknown[],
  _lastAnalysis: string | null
): Promise<{ symbols: string[]; hotList: { symbols: string[]; summary: string }; allSnapshots: SnapshotData[] }> {
  const openSymbols = (positions as Record<string, string>[]).map((p) => p.symbol);

  console.log(`Scanning ${FULL_UNIVERSE.length} stocks across NASDAQ + NYSE...`);
  const [snapshots, mostActives, topMovers, wsbTrending, highSI] = await Promise.all([
    fetchSnapshots(FULL_UNIVERSE),
    fetchMostActives(20),
    fetchTopMovers(10),
    getWsbTrending(),
    getHighShortInterest(),
  ]);

  const wsbSymbols = wsbTrending
    .filter(s => /^[A-Z]{1,5}$/.test(s.symbol))
    .slice(0, 10).map(s => s.symbol);
  const shortSqueezeSymbols = highSI
    .filter(s => /^[A-Z]{1,5}$/.test(s.symbol))
    .slice(0, 5).map(s => s.symbol);
  const squeezeOverlap = wsbSymbols.filter(s => shortSqueezeSymbols.includes(s));
  if (squeezeOverlap.length > 0) {
    console.log(`🚀 SQUEEZE ALERT: ${squeezeOverlap.join(", ")} — trending on WSB AND high short interest!`);
  }

  console.log(`Got ${snapshots.length} snapshots, ${mostActives.length} most-actives, ${topMovers.gainers.length} gainers, ${topMovers.losers.length} losers, ${wsbSymbols.length} WSB, ${shortSqueezeSymbols.length} high-SI`);

  const extraSymbols = [...new Set([...wsbSymbols, ...shortSqueezeSymbols])];
  const missingExtras = extraSymbols.filter(s => !FULL_UNIVERSE.includes(s));
  let extraSnapshots: SnapshotData[] = [];
  if (missingExtras.length > 0) {
    extraSnapshots = await fetchSnapshots(missingExtras);
    console.log(`Fetched ${extraSnapshots.length} extra snapshots for: ${missingExtras.join(", ")}`);
  }
  const allSnapshots = [...snapshots, ...extraSnapshots];

  const screened = preScreenSymbols(allSnapshots);
  const hotList = buildHotList(allSnapshots, 20);

  const finalSymbols = [...new Set([
    ...openSymbols,
    ...hotList.symbols.slice(0, 10),
    ...screened.momentum.slice(0, 5),
    ...screened.gappers.slice(0, 3),
    ...(squeezeOverlap.length ? squeezeOverlap : shortSqueezeSymbols.slice(0, 2)),
    ...wsbSymbols.slice(0, 3),
  ])].slice(0, 20);

  console.log(`Discovery complete (LITE): ${finalSymbols.length} symbols — ${finalSymbols.join(", ")}`);
  return { symbols: finalSymbols, hotList, allSnapshots };
}
