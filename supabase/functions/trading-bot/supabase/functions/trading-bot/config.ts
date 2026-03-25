// ══════════════════════════════════════════════════════════════════════════════
// CONFIG C: "Max Trades + Fast Compound" — Backtest winner (+34.35% return)
// All tunable parameters in one place. Change configs here, not scattered in code.
// ══════════════════════════════════════════════════════════════════════════════

// ── Core Risk Parameters ─────────────────────────────────────────────────────
export const STARTING_CAPITAL = 100_000;
export const MAX_POSITION_PCT = 0.18;       // 18% max per position
export const MAX_DRAWDOWN_PCT = 0.15;       // halt trading if equity drops 15%
export const DEFAULT_STOP_LOSS_PCT = 0.02;  // 2% stop — cut losers fast
export const RISK_PER_TRADE_PCT = 0.025;    // risk 2.5% of equity per trade
export const ATR_STOP_MULTIPLIER = 1.5;     // stop = entry - (1.5 × ATR)
export const MIN_CASH_PCT = 0.10;           // always keep 10% cash buffer
export const DAILY_PROFIT_TARGET = 500;     // $500/day target
export const MAX_SPREAD_PCT = 0.003;        // 0.3% max spread
export const MAX_POSITIONS = 6;             // HARD CAP: never hold more than 6 positions

// ── Scoring Thresholds ───────────────────────────────────────────────────────
export const MIN_SCORE = 35;                // Raised from 20 — filter out junk trades
export const LUNCH_MIN_SCORE = 45;          // Raised from 25 — higher bar during lunch lull
export const SPY_OVERRIDE_SCORE = 50;       // Raised from 35 — need conviction in bearish tape
export const MAX_PICKS = 4;                 // max simultaneous buy candidates per cycle (was 8)

// ── Profit-Taking (ATR-dynamic) ──────────────────────────────────────────────
export const SCALP_FLOOR_PCT = 0.006;           // 0.6% scalp floor
export const MOMENTUM_PARTIAL_FLOOR = 0.015;    // 1.5% partial exit
export const MOMENTUM_FULL_FLOOR = 0.03;        // 3% full exit
export const SCALP_ATR_MULT = 0.5;              // 0.5× ATR for scalp
export const MOMENTUM_PARTIAL_ATR_MULT = 1.2;   // 1.2× ATR for partial
export const MOMENTUM_FULL_ATR_MULT = 2.5;      // 2.5× ATR for full exit

// ── EOD Flatten ──────────────────────────────────────────────────────────────
export const FLATTEN_HOUR = 15;
export const FLATTEN_MINUTE = 50;
export const EARNINGS_HOLD_MIN_PROFIT_PCT = 0.005;

// ── Cooldowns ────────────────────────────────────────────────────────────────
export const LOSS_COOLDOWN_MS = 60 * 60 * 1000;    // 60 minutes after loss
export const PROFIT_COOLDOWN_MS = 15 * 60 * 1000;  // 15 minutes after profit

// ── Sector Concentration ─────────────────────────────────────────────────────
export const MAX_SECTOR_PCT = 0.60;  // max 60% of portfolio in one sector

// ── Leveraged ETF Limits ─────────────────────────────────────────────────────
export const MAX_LEVERAGED_BULL_POSITIONS = 2;
export const MAX_LEVERAGED_BEAR_POSITIONS = 1;
export const MAX_VOLATILITY_POSITIONS = 1;
export const MAX_TOTAL_LEVERAGED_POSITIONS = 3;

// ── API URLs ─────────────────────────────────────────────────────────────────
export const ALPACA_BASE_URL = "https://paper-api.alpaca.markets/v2";
export const ALPACA_DATA_URL = "https://data.alpaca.markets/v2";
export const GROK_BASE_URL = "https://api.x.ai/v1";
export const FINNHUB_BASE_URL = "https://finnhub.io/api/v1";

// ── Sector ETFs ──────────────────────────────────────────────────────────────
export const SECTOR_ETFS: Record<string, string> = {
  Technology: "XLK", Energy: "XLE", Healthcare: "XLV", Financials: "XLF",
  "Consumer Discretionary": "XLY", "Consumer Staples": "XLP", Industrials: "XLI",
  Materials: "XLB", "Real Estate": "XLRE", Utilities: "XLU",
  "Communication Services": "XLC", "Broad Market": "SPY",
};

// ── Stock Universe ───────────────────────────────────────────────────────────
export const FULL_UNIVERSE = [
  // Mega-caps & high-volume
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
  // Volatility plays
  "UVIX",
  // Small-cap momentum
  "PLUG", "FCEL", "SPCE", "OPEN", "CLOV",
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
  // 2x Single-Stock ETFs
  "NVDL", "NVDD", "TSLL", "TSLS", "AMDL", "AMZL", "MSFL", "GOOX", "CONL",
  // Volatility products
  "UVXY", "SVXY", "VXX", "VIXY", "SVOL",
];

export const BLACKLISTED_TICKERS = new Set<string>([]);

// ── Leveraged ETF Sets ───────────────────────────────────────────────────────
export const LEVERAGED_BULL_ETFS = new Set([
  "TQQQ", "UPRO", "SPXL", "TECL", "SOXL", "FNGU", "LABU", "TNA", "FAS", "CURE",
  "NAIL", "DPST", "DFEN", "DUSL", "MIDU", "WANT", "HIBL", "BULZ", "PILL", "RETL",
  "QLD", "SSO", "UWM", "UYG", "ROM", "UCC", "MVV",
  "NVDL", "TSLL", "AMDL", "AMZL", "MSFL", "GOOX", "CONL",
]);
export const LEVERAGED_BEAR_ETFS = new Set([
  "SQQQ", "SPXU", "SPXS", "TECS", "SOXS", "FNGD", "LABD", "TZA", "FAZ", "SDOW",
  "SRTY", "YANG", "ERY", "DRIP", "WEBS", "HIBS",
  "QID", "SDS", "SDD", "TWM", "SKF", "MZZ",
  "NVDD", "TSLS",
]);
export const VOLATILITY_ETFS = new Set(["UVXY", "SVXY", "VXX", "VIXY", "SVOL", "UVIX"]);
export const ALL_LEVERAGED_ETFS = new Set([...LEVERAGED_BULL_ETFS, ...LEVERAGED_BEAR_ETFS, ...VOLATILITY_ETFS]);

// ── Sector Mapping ───────────────────────────────────────────────────────────
const SECTOR_MAP: Record<string, string[]> = {
  Technology: ["AAPL", "MSFT", "GOOGL", "GOOG", "META", "AMZN", "NVDA", "AMD", "INTC", "CRM", "ORCL", "ADBE", "TSLA", "AVGO", "QCOM", "MU", "ANET", "NOW", "SHOP", "SQ", "PLTR", "SNOW", "UBER", "ABNB", "COIN", "AMAT", "LRCX", "KLAC", "MRVL", "ARM", "SMCI", "DELL", "HPE", "NET", "CRWD", "PANW", "ZS", "DDOG", "MDB", "IONQ", "SOXL", "SOXS", "TQQQ", "SQQQ", "QLD", "SMH", "SOXX", "ARKK", "TECL"],
  Healthcare: ["JNJ", "UNH", "PFE", "ABBV", "MRK", "LLY", "TMO", "ABT", "BMY", "AMGN", "GILD", "MRNA", "BNTX", "ISRG", "DXCM", "VEEV", "ZTS", "HCA", "CI", "ELV", "LABU", "XBI"],
  Financials: ["JPM", "BAC", "WFC", "GS", "MS", "C", "BLK", "SCHW", "AXP", "V", "MA", "PYPL", "MSTR", "HOOD", "SOFI", "FAS", "FAZ", "XLF"],
  Energy: ["XOM", "CVX", "COP", "EOG", "SLB", "OXY", "MPC", "PSX", "VLO", "HAL", "DVN", "FANG", "MRO", "USO", "UCO", "GUSH", "DRIP", "XLE", "XOP", "OIH"],
  "Consumer Discretionary": ["WMT", "COST", "TGT", "HD", "LOW", "NKE", "SBUX", "MCD", "DIS", "NFLX", "BABA", "JD", "PDD", "LULU", "ETSY", "DASH", "DKNG"],
  Industrials: ["CAT", "DE", "BA", "HON", "GE", "RTX", "LMT", "UPS", "FDX", "WM", "RSG", "EMR", "ITW", "SAIA"],
  Materials: ["MOS", "NEM", "FCX", "NUE", "STLD", "CLF", "AA", "X", "VALE", "RIO", "BHP", "GOLD", "GDX", "GDXJ", "SLV", "GLD", "XLB"],
  Crypto: ["MARA", "RIOT", "CLSK", "HUT", "BITF", "WULF", "CORZ", "BITO", "IBIT", "GBTC"],
  "EV/Auto": ["RIVN", "LCID", "NIO", "LI", "XPEV", "CHPT", "QS", "BLNK"],
  "Communication Services": ["T", "VZ", "TMUS", "CMCSA", "CHTR", "PARA", "WBD", "ROKU", "SPOT", "TTD", "XLC"],
};

// Build reverse lookup for O(1) sector resolution
const _sectorLookup = new Map<string, string>();
for (const [sector, symbols] of Object.entries(SECTOR_MAP)) {
  for (const sym of symbols) _sectorLookup.set(sym, sector);
}

export function guessSector(symbol: string): string {
  return _sectorLookup.get(symbol) ?? "Unknown";
}
