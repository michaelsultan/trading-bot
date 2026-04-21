// Helpers for the P1 behavior patches. Kept separate from _p0_helpers so the
// P0 fail-closed/fill-price logic stays isolated from scoring heuristics.
//
// If you change any of these, update tests/p1_regressions.test.ts too.

// ── P1 #4: regime classifier ────────────────────────────────────────────────
// A "choppy day" is any morning where the broad market is either gapping hard
// or the vol proxy is showing stress. On choppy days the caller should cut the
// pick count in half and raise the minimum score threshold.
//
// IMPORTANT: `vixProxyValue` is the VXX ETN share price, NOT the CBOE VIX
// index. Alpaca does not expose the VIX index directly, so the bot uses VXX
// as a proxy. This matters because VXX trades at a very different absolute
// level than VIX (VXX is around 25-35 on calm days, 50+ in real stress) due
// to contango decay and periodic reverse splits. The thresholds below are
// calibrated against the VXX scale, not the VIX scale.
//
// Two triggers on the vol proxy:
//   1. Absolute level: VXX above ABS_LEVEL_THRESHOLD (stress regime)
//   2. Intraday spike: VXX up more than SPIKE_PCT_THRESHOLD vs prior close
//      (fast unwind, even at a moderate absolute level)

const VXX_ABS_LEVEL_THRESHOLD = 40;   // rough VXX price that signals real stress
const VXX_SPIKE_PCT_THRESHOLD = 15;   // one-day VXX jump that signals fast unwind

export interface RegimeInputs {
  spyChangePct: number | null | undefined;       // intraday SPY % move from prior close
  spyGapPct: number | null | undefined;          // overnight SPY gap % (open vs prior close)
  vixProxyValue: number | null | undefined;      // VXX share price (NOT VIX level)
  vixProxyChangePct?: number | null | undefined; // VXX intraday % change from prior close
}

export interface RegimeClassification {
  choppyDay: boolean;
  reasons: string[];
  maxPicks: number;
  minScore: number;
}

export function classifyRegime(
  inputs: RegimeInputs,
  normalMaxPicks = 6,
  normalMinScore = 28,
): RegimeClassification {
  const reasons: string[] = [];

  const gap = pickNumber(inputs.spyGapPct, inputs.spyChangePct);
  if (gap != null && Math.abs(gap) > 1.0) {
    reasons.push(`SPY gap ${gap >= 0 ? "+" : ""}${gap.toFixed(2)}% exceeds 1%`);
  }

  const vxx = inputs.vixProxyValue;
  if (typeof vxx === "number" && Number.isFinite(vxx) && vxx > VXX_ABS_LEVEL_THRESHOLD) {
    reasons.push(`VXX proxy ${vxx.toFixed(1)} above ${VXX_ABS_LEVEL_THRESHOLD}`);
  }

  const vxxChg = inputs.vixProxyChangePct;
  if (typeof vxxChg === "number" && Number.isFinite(vxxChg) && vxxChg > VXX_SPIKE_PCT_THRESHOLD) {
    reasons.push(`VXX proxy spiked +${vxxChg.toFixed(1)}% today (above ${VXX_SPIKE_PCT_THRESHOLD}% threshold)`);
  }

  const choppyDay = reasons.length > 0;
  return {
    choppyDay,
    reasons,
    maxPicks: choppyDay ? Math.max(1, Math.floor(normalMaxPicks / 2)) : normalMaxPicks,
    // Choppy day: floor at 35 (7 point premium over normal 28). Apr 20 deploy
    // tried a 50 floor and the bot produced zero trades on what turned out to
    // be a false positive vol read, so we pulled the floor back to 35.
    minScore: choppyDay ? Math.max(normalMinScore, 35) : normalMinScore,
  };
}

function pickNumber(
  primary: number | null | undefined,
  fallback: number | null | undefined,
): number | null {
  if (typeof primary === "number" && Number.isFinite(primary)) return primary;
  if (typeof fallback === "number" && Number.isFinite(fallback)) return fallback;
  return null;
}

// ── P1 #5: ETF bias on choppy days ──────────────────────────────────────────
// When the regime is choppy, tilt the quant score in favor of liquid diversified
// ETFs and against single-name equities. +5 to ETFs, -5 to single names, 0 to
// anything else. Rationale: the Apr 17 basket was ETF heavy and green; Apr 14
// was single-name heavy and red.

export function applyEtfBias(
  rawScore: number,
  symbol: string,
  choppyDay: boolean,
  etfSet: Set<string>,
  bias = 5,
): number {
  if (!choppyDay) return rawScore;
  if (etfSet.has(symbol)) return rawScore + bias;
  return rawScore - bias;
}

// ── P1 #6: BUY_BLOCKED memoization ──────────────────────────────────────────
// Avoid re-running expensive checks (and re-writing identical BUY_BLOCKED rows)
// for symbols that are already known to be blocked today.
//
// Only "sticky" reasons are memoized. Transient reasons (earnings fail-closed,
// lunch lull, past 3pm cutoff) are intentionally skipped so they can recover.

const STICKY_PREFIXES = [
  "Repeat loser",
  "Churn",
  "Crash filter",
  "Correlation guard",
  "Sector exposure",
  "Earnings blackout",
  // Position cap rejection. Reason text is
  //   "Order value $X exceeds 25% position cap"
  // The cap is equity * 25% and the order value is qty * price. Both move
  // intraday but never enough to flip a rejection inside one session unless
  // equity grows by double digit percent, so it is safe to memo for the day.
  // Without this, a leveraged ETF that overshoots the cap (e.g. FNGU) gets
  // re-evaluated on every cycle and re-writes an identical BUY_BLOCKED row.
  "Order value $",
] as const;

export function isStickyBlockReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return STICKY_PREFIXES.some((p) => reason.startsWith(p));
}

export class BlockMemo {
  private readonly cache = new Map<string, string>();

  private key(symbol: string, dateIso: string): string {
    return `${symbol}:${dateIso}`;
  }

  has(symbol: string, dateIso: string): boolean {
    return this.cache.has(this.key(symbol, dateIso));
  }

  get(symbol: string, dateIso: string): string | null {
    return this.cache.get(this.key(symbol, dateIso)) ?? null;
  }

  remember(symbol: string, dateIso: string, reason: string): void {
    if (!isStickyBlockReason(reason)) return;
    const k = this.key(symbol, dateIso);
    if (!this.cache.has(k)) this.cache.set(k, reason);
  }

  // Hydrate from a DB query result of today's BUY_BLOCKED rows. Only rows
  // whose reason is sticky are kept. Rows are expected to have `symbol` and
  // `reason` fields; anything else is ignored.
  hydrate(rows: Array<{ symbol?: string; reason?: string | null }>, dateIso: string): number {
    let added = 0;
    for (const row of rows) {
      if (!row?.symbol || !row?.reason) continue;
      if (!isStickyBlockReason(row.reason)) continue;
      const k = this.key(row.symbol, dateIso);
      if (!this.cache.has(k)) {
        this.cache.set(k, row.reason);
        added++;
      }
    }
    return added;
  }

  size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}
