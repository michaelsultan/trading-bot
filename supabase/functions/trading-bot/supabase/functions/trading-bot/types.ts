// ── Type Definitions ─────────────────────────────────────────────────────────

export type TradingMode = "SCALP" | "MOMENTUM" | "HOLD_ONLY";

export type Bar = { o: number; h: number; l: number; c: number; v: number };

export type PatternSignal = {
  name: string;
  direction: "bullish" | "bearish" | "neutral";
  confidence: number;
  description: string;
};

export type VolumeProfile = {
  avg_volume_20: number | null;
  volume_ratio: number | null;
  accumulation_dist: number | null;
  obv_trend: "rising" | "falling" | "flat" | null;
  is_climax_volume: boolean;
  institutional_signal: string | null;
};

export type MultiTimeframeSignal = {
  tf_5min: "bullish" | "bearish" | "neutral" | null;
  tf_15min: "bullish" | "bearish" | "neutral" | null;
  tf_1hr: "bullish" | "bearish" | "neutral" | null;
  tf_daily: "bullish" | "bearish" | "neutral" | null;
  confluence: number;
  summary: string;
};

export type SectorData = {
  sector: string | null;
  sector_performance: number | null;
  relative_strength: number | null;
};

export type TechData = {
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
  patterns: PatternSignal[];
  volume_profile: VolumeProfile;
  mtf: MultiTimeframeSignal | null;
  sector: SectorData;
};

export type SnapshotData = {
  symbol: string;
  price: number;
  change_pct: number;
  volume: number;
  prev_close: number;
};

export type QuantScore = {
  symbol: string;
  score: number;
  momentum: number;
  volumeScore: number;
  rsiSignal: number;
  macdSignal: number;
  patternScore: number;
  socialBuzz: number;
  optionsFlow: number;
  reason: string;
  suggestedQty: number;
  suggestedStop: number;
};

export type ScanTrigger = {
  type: "volume_spike" | "big_move" | "position_alert" | "gapper" | "sector_rotation";
  symbol: string;
  detail: string;
  severity: "low" | "medium" | "high";
};

export interface FearGreedData {
  score: number;
  label: string;
  previous: number;
}

export interface VixData {
  value: number;
  label: string;
}

export interface ShortInterestData {
  symbol: string;
  shortInterest: number;
  daysTocover: number;
}

export interface CongressTrade {
  symbol: string;
  politician: string;
  type: string;
  amount: string;
  date: string;
}

export interface SocialStock {
  symbol: string;
  mentions: number;
  mentions_24h_ago: number;
  sentiment: string;
  source: string;
}

export interface EnrichmentData {
  fearGreed: FearGreedData;
  vix: VixData;
  earnings: Record<string, string>;
  socialSentiment: SocialStock[];
  shortInterest: ShortInterestData[];
  congressTrades: CongressTrade[];
  finnhubSentiment: Record<string, { sentiment: number; buzz: number; headlines: string[] }>;
  insiderTrades: Record<string, string[]>;
}

export type Decision = {
  action: string;
  symbol: string;
  quantity: number;
  reason: string;
};
