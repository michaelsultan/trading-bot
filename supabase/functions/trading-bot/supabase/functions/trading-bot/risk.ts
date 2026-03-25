// ── Risk Management: Sector Concentration, Correlation Guard, Position Sizing ─

import {
  RISK_PER_TRADE_PCT, ATR_STOP_MULTIPLIER, DEFAULT_STOP_LOSS_PCT,
  LEVERAGED_BULL_ETFS, LEVERAGED_BEAR_ETFS, VOLATILITY_ETFS, ALL_LEVERAGED_ETFS,
  MAX_LEVERAGED_BULL_POSITIONS, MAX_LEVERAGED_BEAR_POSITIONS,
  MAX_VOLATILITY_POSITIONS, MAX_TOTAL_LEVERAGED_POSITIONS,
  SECTOR_ETFS,
} from "./config.ts";
import { guessSector } from "./config.ts";
import { getCurrentTradingMode } from "./utils.ts";

// ── Sector Concentration Check ───────────────────────────────────────────────
export function checkSectorConcentration(
  positions: Record<string, unknown>[],
  newSymbol: string,
  maxSectorPct = 0.60
): { allowed: boolean; reason: string | null } {
  const sectorCounts: Record<string, number> = {};
  const total = positions.length + 1;

  for (const pos of positions) {
    const sec = guessSector(String(pos.symbol));
    sectorCounts[sec] = (sectorCounts[sec] ?? 0) + 1;
  }

  const newSector = guessSector(newSymbol);
  const currentCount = sectorCounts[newSector] ?? 0;
  const newPct = (currentCount + 1) / total;

  if (newPct > maxSectorPct && total > 2) {
    return {
      allowed: false,
      reason: `Adding ${newSymbol} would put ${(newPct * 100).toFixed(0)}% of positions in ${newSector} (max ${maxSectorPct * 100}%)`,
    };
  }
  return { allowed: true, reason: null };
}

// ── Correlation Guard ────────────────────────────────────────────────────────
export function checkCorrelationGuard(
  symbol: string,
  heldPositions: Record<string, unknown>[],
): { allowed: boolean; reason: string } {
  if (!ALL_LEVERAGED_ETFS.has(symbol)) return { allowed: true, reason: "" };

  const heldSymbols = heldPositions.map(p => p.symbol as string);
  const heldBull = heldSymbols.filter(s => LEVERAGED_BULL_ETFS.has(s)).length;
  const heldBear = heldSymbols.filter(s => LEVERAGED_BEAR_ETFS.has(s)).length;
  const heldVol = heldSymbols.filter(s => VOLATILITY_ETFS.has(s)).length;
  const heldLevTotal = heldSymbols.filter(s => ALL_LEVERAGED_ETFS.has(s)).length;

  if (heldLevTotal >= MAX_TOTAL_LEVERAGED_POSITIONS) {
    return { allowed: false, reason: `Max ${MAX_TOTAL_LEVERAGED_POSITIONS} total leveraged positions reached (holding ${heldLevTotal})` };
  }
  if (LEVERAGED_BULL_ETFS.has(symbol) && heldBull >= MAX_LEVERAGED_BULL_POSITIONS) {
    return { allowed: false, reason: `Max ${MAX_LEVERAGED_BULL_POSITIONS} leveraged bull positions reached (holding ${heldBull})` };
  }
  if (LEVERAGED_BEAR_ETFS.has(symbol) && heldBear >= MAX_LEVERAGED_BEAR_POSITIONS) {
    return { allowed: false, reason: `Max ${MAX_LEVERAGED_BEAR_POSITIONS} leveraged bear positions reached (holding ${heldBear})` };
  }
  if (VOLATILITY_ETFS.has(symbol) && heldVol >= MAX_VOLATILITY_POSITIONS) {
    return { allowed: false, reason: `Max ${MAX_VOLATILITY_POSITIONS} volatility positions reached (holding ${heldVol})` };
  }
  return { allowed: true, reason: "" };
}

// ── Directional Conflict Guard ────────────────────────────────────────────────
// Prevents conflicting bets: e.g. long energy (USO, XLE, SLB) + short energy (ERY)
// Maps bear ETFs to the sector they short, and checks if held positions conflict.
const BEAR_ETF_SECTOR: Record<string, string> = {
  ERY: "Energy", DRIP: "Energy",
  SOXS: "Technology", TECS: "Technology", SQQQ: "Technology",
  FNGD: "Technology",
  LABD: "Healthcare",
  FAZ: "Financials", SKF: "Financials",
  TZA: "Broad", SPXU: "Broad", SPXS: "Broad", SDOW: "Broad",
  SRTY: "Broad", YANG: "China",
  WEBS: "Broad", HIBS: "Broad",
  QID: "Technology", SDS: "Broad", SDD: "Broad", TWM: "Broad", MZZ: "Broad",
  NVDD: "Technology", TSLS: "EV/Auto",
};

// Sectors that should be treated as "long energy" for conflict purposes
const ENERGY_LONGS = new Set(["XOM", "CVX", "COP", "SLB", "OXY", "MPC", "PSX", "VLO", "HAL", "DVN", "FANG", "MRO", "USO", "UCO", "XLE", "XOP", "OIH", "GUSH"]);
const TECH_LONGS = new Set(["SOXL", "TQQQ", "TECL", "FNGU", "QLD", "NVDL"]);
const HEALTHCARE_LONGS = new Set(["LABU", "XBI"]);
const FINANCIALS_LONGS = new Set(["FAS", "XLF", "UYG"]);

function getDirectionalSector(symbol: string): { sector: string; direction: "bull" | "bear" } | null {
  // Check if it's a known bear ETF
  if (BEAR_ETF_SECTOR[symbol]) {
    return { sector: BEAR_ETF_SECTOR[symbol], direction: "bear" };
  }
  // Check if it's a known sector long
  if (ENERGY_LONGS.has(symbol)) return { sector: "Energy", direction: "bull" };
  if (TECH_LONGS.has(symbol)) return { sector: "Technology", direction: "bull" };
  if (HEALTHCARE_LONGS.has(symbol)) return { sector: "Healthcare", direction: "bull" };
  if (FINANCIALS_LONGS.has(symbol)) return { sector: "Financials", direction: "bull" };

  // For regular stocks, use guessSector
  const sector = guessSector(symbol);
  if (sector !== "Unknown") return { sector, direction: "bull" };

  return null;
}

export function checkDirectionalConflict(
  newSymbol: string,
  heldPositions: Record<string, unknown>[],
): { allowed: boolean; reason: string } {
  const newDir = getDirectionalSector(newSymbol);
  if (!newDir) return { allowed: true, reason: "" };

  for (const pos of heldPositions) {
    const heldDir = getDirectionalSector(String(pos.symbol));
    if (!heldDir) continue;

    // Same sector, opposite direction = conflict
    if (heldDir.sector === newDir.sector && heldDir.direction !== newDir.direction) {
      return {
        allowed: false,
        reason: `Conflicts with ${pos.symbol}: both target ${newDir.sector} but in opposite directions (${newSymbol}=${newDir.direction}, ${pos.symbol}=${heldDir.direction})`,
      };
    }
  }
  return { allowed: true, reason: "" };
}

// ── ATR-Based Position Sizing ────────────────────────────────────────────────
export function atrPositionSize(
  equity: number,
  entryPrice: number,
  atr: number | null,
): { qty: number; stopDistance: number; stopLossPct: number } {
  const { mode } = getCurrentTradingMode();

  const riskPct = mode === "SCALP" ? 0.035 : RISK_PER_TRADE_PCT;
  const atrMult = mode === "SCALP" ? 1.0 : ATR_STOP_MULTIPLIER;
  const defaultStop = mode === "SCALP" ? 0.02 : DEFAULT_STOP_LOSS_PCT;

  if (!atr || atr <= 0) {
    const stopDistance = entryPrice * defaultStop;
    const riskDollars = equity * riskPct;
    const qty = Math.max(1, Math.floor(riskDollars / stopDistance));
    return { qty, stopDistance, stopLossPct: defaultStop };
  }

  const stopDistance = atr * atrMult;
  const stopLossPct = stopDistance / entryPrice;
  const riskDollars = equity * riskPct;
  const qty = Math.max(1, Math.floor(riskDollars / stopDistance));
  return { qty, stopDistance, stopLossPct };
}
