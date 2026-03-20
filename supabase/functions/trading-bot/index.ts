import { createClient } from "jsr:@supabase/supabase-js@2";

const ALPACA_BASE_URL = "https://paper-api.alpaca.markets/v2";
const ALPACA_DATA_URL = "https://data.alpaca.markets/v2";
const GROK_BASE_URL = "https://api.x.ai/v1";


// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const alpacaHeaders = {
  "APCA-API-KEY-ID": Deno.env.get("ALPACA_API_KEY")!,
  "APCA-API-SECRET-KEY": Deno.env.get("ALPACA_SECRET_KEY")!,
  "Content-Type": "application/json",
};

// ---------------------------------------------------------------------------
// Helpers Alpaca — Trading
// ---------------------------------------------------------------------------

async function getAccount() {
  const res = await fetch(`${ALPACA_BASE_URL}/account`, { headers: alpacaHeaders });
  const data = await res.json();
  if (data?.code || data?.message) throw new Error(`Alpaca account error: ${JSON.stringify(data)}`);
  return data;
}

async function getPositions() {
  const res = await fetch(`${ALPACA_BASE_URL}/positions`, { headers: alpacaHeaders });
  return res.json();
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

async function placeOrder(symbol: string, qty: number, side: "buy" | "sell") {
  const res = await fetch(`${ALPACA_BASE_URL}/orders`, {
    method: "POST",
    headers: alpacaHeaders,
    body: JSON.stringify({
      symbol,
      qty: String(qty),
      side,
      type: "market",
      time_in_force: "day",
    }),
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// Helpers Alpaca — Données de marché
// ---------------------------------------------------------------------------

type Bar = { c: number; v: number };
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

async function fetchBars(symbol: string, limit = 200): Promise<Bar[]> {
  try {
    const start = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const res = await fetch(
      `${ALPACA_DATA_URL}/stocks/${symbol}/bars?timeframe=15Min&limit=${limit}&start=${start}&feed=sip`,
      { headers: alpacaHeaders }
    );
    const data = await res.json();
    return data?.bars ?? [];
  } catch {
    return [];
  }
}

async function computeTechnicals(symbol: string): Promise<TechData & { symbol: string }> {
  const bars = await fetchBars(symbol, 60);
  const closes = bars.map((b) => b.c);

  if (closes.length < 2) {
    return { symbol, price: 0, change_pct: 0, volume: 0, sma20: null, sma50: null, rsi14: null, macd: null, macd_signal: null, macd_hist: null };
  }

  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const volume = bars[bars.length - 1].v;

  // SMA
  const sma20 = closes.length >= 20 ? +sma(closes.slice(-20)).toFixed(2) : null;
  const sma50 = closes.length >= 50 ? +sma(closes.slice(-50)).toFixed(2) : null;

  // RSI(14) — utilise les 15 dernières valeurs
  let rsi14: number | null = null;
  if (closes.length >= 15) {
    const slice = closes.slice(-15);
    const changes = slice.slice(1).map((v, i) => v - slice[i]);
    const avgGain = sma(changes.map((c) => Math.max(c, 0)));
    const avgLoss = sma(changes.map((c) => Math.max(-c, 0)));
    rsi14 = avgLoss === 0 ? 100 : +(100 - 100 / (1 + avgGain / avgLoss)).toFixed(1);
  }

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
  };
}

async function getLatestPrice(symbol: string): Promise<number | null> {
  try {
    const res = await fetch(
      `${ALPACA_DATA_URL}/stocks/${symbol}/quotes/latest?feed=iex`,
      { headers: alpacaHeaders }
    );
    const data = await res.json();
    return data?.quote?.ap || data?.quote?.bp || null;
  } catch {
    return null;
  }
}

async function getNews(symbol: string, limit = 5): Promise<string[]> {
  try {
    const res = await fetch(
      `https://data.alpaca.markets/v1beta1/news?symbols=${symbol}&limit=${limit}`,
      { headers: alpacaHeaders }
    );
    const data = await res.json();
    return (data?.news ?? []).map((n: Record<string, string>) => n.headline);
  } catch {
    return [];
  }
}

async function getMarketData(symbols: string[]) {
  const results = await Promise.all(
    symbols.map(async (sym) => {
      const [tech, news] = await Promise.all([computeTechnicals(sym), getNews(sym)]);
      return [sym, { tech, news }] as const;
    })
  );
  return Object.fromEntries(results);
}

// ---------------------------------------------------------------------------
// Historique Supabase
// ---------------------------------------------------------------------------

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

async function getCycleCount(): Promise<number> {
  const { count } = await supabase
    .from("portfolio_snapshots")
    .select("*", { count: "exact", head: true });
  return count ?? 0;
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

  // Métriques calculées localement
  const closedTrades = lastDecisions.filter((t: Record<string, unknown>) => t.pnl != null);
  const winCount = closedTrades.filter((t: Record<string, unknown>) => (t.pnl as number) > 0).length;
  const winRate = closedTrades.length ? Math.round((winCount / closedTrades.length) * 100) : null;
  const totalPnl = closedTrades.reduce((s: number, t: Record<string, unknown>) => s + ((t.pnl as number) || 0), 0);
  const holdCount = lastDecisions.filter((t: Record<string, unknown>) => t.action === "HOLD").length;
  const holdRate = Math.round((holdCount / lastDecisions.length) * 100);

  const positionsStr = (positions as Record<string, unknown>[]).length
    ? (positions as Record<string, unknown>[]).map(p =>
        `  ${p.symbol}: ${p.qty} actions | PnL non réalisé : $${p.unrealized_pl} (${(parseFloat(String(p.unrealized_plpc ?? 0)) * 100).toFixed(2)}%)`
      ).join("\n")
    : "  Aucune";

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
4. **Patterns identifiés** : tendances récurrentes (ex: trop de HOLD, entrées trop tôt, mauvais timing...)
${previousAnalyses ? "5. **Feedback analyses précédentes** : les ajustements recommandés ont-ils été appliqués ? Avec quel résultat ?\n6. **Ajustements concrets** : ce que tu vas changer dans les prochains cycles" : "5. **Ajustements concrets** : ce que tu vas changer dans les prochains cycles"}

Sois concis, factuel et actionnable. Cette analyse sera injectée dans tes prochains prompts de décision.`;

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
        `  ${p.symbol}: ${p.qty} actions | PnL non réalisé : $${p.unrealized_pl}`
      ).join("\n")
    : "  Aucune";

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
1. **Résumé de la semaine** : performance globale, est-ce une bonne semaine ?
2. **Meilleures décisions** : quels trades ont le plus contribué au résultat
3. **Pires décisions** : quels trades ont coûté le plus cher
4. **Stratégie semaine prochaine** : que faire différemment lundi ? Sur quels secteurs se concentrer ?
5. **3 règles concrètes** pour améliorer les performances la semaine prochaine

Ce bilan sera injecté dans le premier cycle de la semaine prochaine. Sois factuel et stratégique.`;

  const analysis = await callGrok(prompt);

  await supabase.from("bot_analyses").insert({
    trade_count: cycleCount,
    type: "weekly_summary",
    analysis,
    trades_ref: weekDecisions,
  });

  console.log(`Bilan de fin de semaine généré au cycle #${cycleCount}`);
}

// ---------------------------------------------------------------------------
// Validation des décisions Grok
// ---------------------------------------------------------------------------

function isValidSymbol(s: unknown): s is string {
  return typeof s === "string" && /^[A-Z]{1,5}$/.test(s);
}

function isValidQuantity(q: unknown): q is number {
  return typeof q === "number" && Number.isInteger(q) && q > 0 && q < 100_000;
}

// ---------------------------------------------------------------------------
// Helpers parsing JSON robuste
// ---------------------------------------------------------------------------

function extractJson(content: string): unknown {
  // 1. Parse direct
  try { return JSON.parse(content); } catch { /* suite */ }
  // 2. Strip blocs markdown ```json ... ```
  const stripped = content.replace(/^```(?:json)?\s*/im, "").replace(/\s*```\s*$/im, "").trim();
  try { return JSON.parse(stripped); } catch { /* suite */ }
  // 3. Extraire le premier tableau JSON trouvé dans le texte
  const arr = content.match(/\[[\s\S]*\]/);
  if (arr) { try { return JSON.parse(arr[0]); } catch { /* suite */ } }
  // 4. Extraire le premier objet JSON trouvé dans le texte
  const obj = content.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch { /* suite */ } }
  throw new Error("No valid JSON found in Grok response");
}

// ---------------------------------------------------------------------------
// Appels Grok — Discovery puis Decision
// ---------------------------------------------------------------------------

async function callGrok(prompt: string, systemPrompt?: string, liveSearch = false): Promise<string> {
  if (liveSearch) {
    // Nouvelle Responses API avec web_search (search_parameters déprécié)
    const input: Array<{ role: string; content: string }> = [];
    if (systemPrompt) input.push({ role: "system", content: systemPrompt });
    input.push({ role: "user", content: prompt });

    const res = await fetch(`${GROK_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("GROK_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "grok-4.20-beta-latest-non-reasoning",
        input,
        tools: [{ type: "web_search" }],
      }),
    });
    const data = await res.json();
    // Extraire le texte depuis output[].content[].text
    const output = (data.output ?? []) as Array<Record<string, unknown>>;
    for (const item of output) {
      if (item.type === "message") {
        const content = (item.content ?? []) as Array<Record<string, unknown>>;
        for (const c of content) {
          if (c.type === "output_text") return (c.text as string) ?? "";
        }
      }
    }
    console.error("Réponse Responses API inattendue:", JSON.stringify(data));
    return "";
  }

  // chat/completions classique (sans web search)
  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: prompt });

  const res = await fetch(`${GROK_BASE_URL}/chat/completions`, {
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
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// Étape 1 — Grok scanne X, Reddit, les news et choisit les symboles à analyser
async function discoverSymbols(
  positions: unknown[],
  history: unknown[],
  lastAnalysis: string | null
): Promise<string[]> {
  const openSymbols = (positions as Record<string, string>[]).map((p) => p.symbol);

  const prompt = `Tu es un trader IA. Scanne X (Twitter), Reddit (r/wallstreetbets, r/stocks, r/investing), les news financières et le web en ce moment.

Contexte :
- Positions actuellement ouvertes : ${openSymbols.length ? openSymbols.join(", ") : "aucune"}
- Derniers trades : ${JSON.stringify(history.slice(0, 10), null, 2)}
${lastAnalysis ? `\n## Tes dernières auto-analyses de performance\n${lastAnalysis}\n` : ""}
Ta mission : identifier les actions américaines (NYSE/NASDAQ) les plus prometteuses RIGHT NOW — que ce soit pour un BUY, un SELL potentiel ou surveiller une position ouverte.

Critères : buzz, catalyseurs (earnings, annonce produit, macro), momentum technique, sentiment social.

Réponds UNIQUEMENT en JSON valide, sans markdown :
{
  "symbols": ["TICKER1", "TICKER2", ...],
  "rationale": "en 2 phrases : pourquoi ces symboles maintenant"
}`;

  try {
    const content = await callGrok(prompt, undefined, true);
    const parsed = extractJson(content) as Record<string, unknown>;
    const discovered: string[] = (parsed.symbols as string[]) ?? [];
    // Toujours inclure les positions ouvertes
    return [...new Set([...discovered, ...openSymbols])];
  } catch {
    console.error("Discovery parse error — falling back to open positions");
    return openSymbols.length ? openSymbols : ["SPY"];
  }
}

// Étape 2 — Grok prend la décision finale avec les données techniques
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
  // Compte les minutes de marché ouvert restantes (Lu-Ve, 09:30-16:00 ET = 13:30-20:00 UTC en EDT)
  const MARKET_OPEN_UTC  = 13 * 60 + 30; // 13h30 UTC
  const MARKET_CLOSE_UTC = 20 * 60;       // 20h00 UTC
  let remaining = 0;
  const cursor = new Date(now);
  while (cursor < deadline) {
    const day = cursor.getUTCDay(); // 0=dim, 6=sam
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
  cycleCount: number
) {
  const marketSummary = Object.entries(marketData)
    .map(([sym, { tech, news }]) =>
      `${sym}: $${tech.price} (${tech.change_pct > 0 ? "+" : ""}${tech.change_pct}%) | ` +
      `Vol: ${tech.volume?.toLocaleString()} | ` +
      `SMA20: ${tech.sma20 ?? "N/A"} SMA50: ${tech.sma50 ?? "N/A"} | ` +
      `RSI: ${tech.rsi14 ?? "N/A"} | ` +
      `MACD: ${tech.macd ?? "N/A"} Sig: ${tech.macd_signal ?? "N/A"} Hist: ${tech.macd_hist ?? "N/A"}\n` +
      `  News: ${news.length ? news.slice(0, 3).join(" | ") : "aucune"}`
    )
    .join("\n\n");

  const now = new Date();
  const DEADLINE = getCurrentWeekDeadline();
  const hoursLeft = Math.max(0, Math.floor((DEADLINE.getTime() - now.getTime()) / (1000 * 60 * 60)));
  const cyclesLeft = estimateRemainingCycles(now, DEADLINE);

  const systemPrompt = `Tu es le moteur de décision d'un bot de trading autonome opérant sur les marchés américains (NYSE / NASDAQ).

## Comment tu fonctionnes
Toutes les 30 minutes pendant les heures de marché (09h30–16h00 ET, lundi–vendredi), tu reçois l'état complet du portfolio, les données de marché en temps réel, et l'historique de tes trades. Tu n'as pas de mémoire entre les appels — tout le contexte est fourni à chaque fois.

## Ton objectif
Faire croître un portfolio de $100 000 au maximum sur la semaine en cours (lundi → vendredi 16h00 ET). Chaque semaine repart de zéro avec un nouvel objectif.

## Règles non négociables
1. Maximum 25% du portfolio total par position (ex: si equity = $100k, max $25k par symbole)
2. Ne jamais perdre plus de 15% du portfolio initial dans la semaine (seuil : $85 000)
3. Tu peux placer plusieurs ordres simultanément dans le même cycle

## Comment décider
Raisonne étape par étape :
1. **Évalue chaque position ouverte** : PnL non réalisé, momentum, risque — vaut-il mieux tenir ou couper ?
2. **Scanne le marché** : quelles opportunités existent RIGHT NOW (buzz, catalyseurs, technicals) ?
3. **Décide au niveau du portfolio** : quelle combinaison d'actions maximise le gain tout en respectant les règles ?`;

  const userPrompt = `## Horodatage
${now.toISOString()} — Cycle #${cycleCount} — Il te reste ~${cyclesLeft} cycles (~${hoursLeft}h de marché) avant la deadline.

## Portfolio actuel
- Cash disponible : $${account.cash}
- Valeur totale : $${account.equity}
- Positions ouvertes (avec PnL non réalisé) :
${(positions as Record<string, unknown>[]).map((p) =>
  `  ${p.symbol}: ${p.qty} actions | Prix moyen : $${p.avg_entry_price} | Prix actuel : $${p.current_price} | PnL : $${p.unrealized_pl} (${parseFloat(String(p.unrealized_plpc ?? 0) ) > 0 ? "+" : ""}${(parseFloat(String(p.unrealized_plpc ?? 0)) * 100).toFixed(2)}%)`
).join("\n") || "  Aucune"}

## Données de marché (symboles présélectionnés ce cycle)
${marketSummary}

## Historique de tes ${history.length} derniers trades BUY/SELL (récent → ancien)
${JSON.stringify(history, null, 2)}
${lastAnalysis ? `\n## Tes dernières auto-analyses de performance\n${lastAnalysis}\n` : ""}
## Instructions
1. Scanne X, Reddit et les news financières en ce moment
2. Applique le raisonnement en 3 étapes (positions → marché → portfolio)
3. Retourne TOUTES tes décisions pour ce cycle

Réponds UNIQUEMENT en JSON valide (tableau), sans markdown :
[
  {
    "action": "BUY" | "SELL" | "HOLD",
    "symbol": "TICKER ou null si HOLD global",
    "quantity": nombre entier ou null si HOLD,
    "reason": "justification concise avec les signaux clés"
  }
]
Si tu n'as aucun trade à faire, retourne un tableau avec un seul HOLD : [{"action":"HOLD","symbol":null,"quantity":null,"reason":"..."}]`;

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

// ---------------------------------------------------------------------------
// Handler principal
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  // Vérifier que le JWT est bien service_role ET émis par ce projet Supabase.
  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const payload = JSON.parse(atob(token.split(".")[1]));
    if (payload.role !== "service_role" || payload.ref !== "bhumjspdeveqybkilcxc") {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }
  } catch {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  // 0. Lock distribué — évite deux instances simultanées
  const { data: claimed } = await supabase.rpc("try_claim_bot_run");
  if (!claimed) {
    console.log("Bot already running — skipping.");
    return new Response(JSON.stringify({ status: "already_running" }), { status: 200 });
  }

  try {
    // 1. Vérifier que le marché est ouvert
    const marketOpen = await isClock();
    if (!marketOpen) {
      console.log("Market closed — skipping.");
      await supabase.rpc("release_bot_run");
      return new Response(JSON.stringify({ status: "market_closed" }), { status: 200 });
    }

    // 2. Récupérer l'état du portfolio
    const [account, positions] = await Promise.all([getAccount(), getPositions()]);

    // 3. Snapshot
    await logSnapshot(parseFloat(account.cash), parseFloat(account.equity), positions);

    // 4. Historique des trades + dernières analyses (en parallèle)
    const [history, lastAnalysis] = await Promise.all([
      getTradeHistory(50),
      getLastAnalyses(),
    ]);

    // 5. Grok scanne X, Reddit, les news et choisit les symboles à analyser
    const symbols = await discoverSymbols(positions, history, lastAnalysis);
    console.log("Symbols discovered by Grok:", symbols);

    // 6. Données de marché (technicals + news) en parallèle pour tous les symboles
    const marketData = await getMarketData(symbols);

    // 7. Grok prend la décision finale avec les données techniques
    const cycleCount = await getCycleCount();
    const decisions = await makeDecision(account, positions, history, marketData, lastAnalysis, cycleCount);
    if (!decisions) {
      await supabase.rpc("release_bot_run");
      return new Response(JSON.stringify({ status: "grok_parse_error" }), { status: 200 });
    }

    console.log("Grok decisions:", decisions);

    // 8. Exécuter chaque décision et tout logger (y compris HOLD)
    const executedOrders = [];
    for (const decision of decisions) {
      let alpacaOrder = null;
      let priceEntry: number | null = null;

      if (decision.action === "BUY" && isValidSymbol(decision.symbol) && isValidQuantity(decision.quantity)) {
        const alreadyOpen = (positions as Record<string, string>[]).some(p => p.symbol === decision.symbol);
        if (alreadyOpen) {
          console.warn(`BUY ignoré — position déjà ouverte sur ${decision.symbol}`);
          continue;
        }
        alpacaOrder = await placeOrder(decision.symbol, decision.quantity, "buy");
        if (alpacaOrder?.code || alpacaOrder?.message) {
          console.error("Alpaca BUY rejected:", alpacaOrder);
          await logTrade({ symbol: decision.symbol, action: "BUY_REJECTED", quantity: decision.quantity, reason: JSON.stringify(alpacaOrder), status: "error" });
          continue;
        }
        priceEntry = await getLatestPrice(decision.symbol) || marketData[decision.symbol]?.tech.price;

      } else if (decision.action === "SELL" && isValidSymbol(decision.symbol) && isValidQuantity(decision.quantity)) {
        const priceExit = await getLatestPrice(decision.symbol) || marketData[decision.symbol]?.tech.price;
        alpacaOrder = await placeOrder(decision.symbol, decision.quantity, "sell");
        if (alpacaOrder?.code || alpacaOrder?.message) {
          console.error("Alpaca SELL rejected:", alpacaOrder);
          await logTrade({ symbol: decision.symbol, action: "SELL_REJECTED", quantity: decision.quantity, reason: JSON.stringify(alpacaOrder), status: "error" });
          continue;
        }
        if (priceExit) await closeBuyTrade(decision.symbol, priceExit);
        priceEntry = priceExit;
      } else if (decision.action !== "HOLD") {
        console.warn("Decision invalide ignorée:", JSON.stringify(decision));
        continue;
      }

      // Logger toutes les décisions (BUY, SELL, HOLD)
      await logTrade({
        symbol: decision.symbol ?? null,
        action: decision.action,
        quantity: decision.quantity ?? null,
        reason: decision.reason,
        price_entry: priceEntry,
        alpaca_order_id: alpacaOrder?.id ?? null,
        status: decision.action === "SELL" ? "closed" : decision.action === "BUY" ? "open" : "hold",
      });

      if (alpacaOrder) executedOrders.push(alpacaOrder);
    }

    // 9. Auto-analyse tous les 5 cycles
    if (cycleCount > 0 && cycleCount % 5 === 0) {
      await generateAndSaveAnalysis(cycleCount, account, positions);
    }

    // 10. Bilan de fin de semaine (dernier cycle du vendredi)
    const weekDeadline = getCurrentWeekDeadline();
    if (isLastCycleOfWeek(new Date(), weekDeadline)) {
      await generateWeeklySummary(account, positions, cycleCount);
    }

    await supabase.rpc("release_bot_run");
    return new Response(JSON.stringify({ status: "ok", decisions, executedOrders }), { status: 200 });
  } catch (err) {
    console.error(err);
    await supabase.rpc("release_bot_run");
    return new Response(JSON.stringify({ status: "error", message: String(err) }), { status: 500 });
  }
});
