// Helpers for the P4 behavior patches. Kept separate from _p0/_p1/_p3 so the
// reentry guard, the sentiment gate, and any future buy timing rules stay
// isolated from the earlier filter families.
//
// If you change any of these, update tests/p4_regressions.test.ts too.
//
// ── P4 #1: Reentry guard ────────────────────────────────────────────────────
// Apr 21 loss pattern: bot scalps +$19 on BULL at 09:41, then rebuys the same
// name 18 minutes later on a +6.9% gap and loses $272. FCEL: +$127 scalp at
// 10:11, rebuy at 10:27 at a higher price, loses $240. LCID: stops out at
// 09:42 for $128 and the bot rebuys at 10:42 for another $108 loss.
//
// Three bad reentries on Apr 21 alone cost about $620. The existing repeat
// loser filter only triggers after 3 consecutive losses across 7 days, and
// the churn filter needs 5 same day trades with near zero pnl. Neither
// catches the single day scalp then rebuy pattern.
//
// Design:
//   * Look at today's exit rows (SELL or PROFIT_TAKE) per symbol.
//   * If the most recent exit is within windowMinutes (default 30), block
//     further BUYs on that symbol.
//   * Fail OPEN on missing or malformed data — we do not want to block the
//     whole universe because one row has a bad timestamp.
//   * NOT added to the sticky block memo: the 30 minute window expires, at
//     which point the bot is allowed to reconsider.

export interface ExitRow {
  symbol: string | null | undefined;
  created_at: string | null | undefined;
  action: string | null | undefined;
  pnl?: number | null;
}

export interface RecentExitOptions {
  windowMinutes?: number;
  nowMs?: number;
}

export interface RecentExitInfo {
  lastExitMs: number;
  count: number;
  lastAction: string;
  lastPnl: number | null;
}

const DEFAULT_REENTRY_WINDOW_MIN = 30;
const EXIT_ACTIONS = new Set(["SELL", "PROFIT_TAKE"]);

export function buildRecentExitMap(
  rows: ExitRow[],
  opts: RecentExitOptions = {},
): Map<string, RecentExitInfo> {
  const out = new Map<string, RecentExitInfo>();
  if (!Array.isArray(rows) || rows.length === 0) return out;

  const windowMs = (opts.windowMinutes ?? DEFAULT_REENTRY_WINDOW_MIN) * 60_000;
  const now = opts.nowMs ?? Date.now();
  if (!Number.isFinite(now) || !Number.isFinite(windowMs) || windowMs <= 0) return out;

  for (const r of rows) {
    if (!r) continue;
    const sym = typeof r.symbol === "string" ? r.symbol.trim() : "";
    const action = typeof r.action === "string" ? r.action.trim().toUpperCase() : "";
    const createdAt = typeof r.created_at === "string" ? r.created_at : "";
    if (!sym || !action || !createdAt) continue;
    if (!EXIT_ACTIONS.has(action)) continue;

    const ts = Date.parse(createdAt);
    if (!Number.isFinite(ts)) continue;
    const ageMs = now - ts;
    if (ageMs < 0 || ageMs > windowMs) continue;

    const pnl = typeof r.pnl === "number" && Number.isFinite(r.pnl) ? r.pnl : null;
    const prev = out.get(sym);
    if (!prev) {
      out.set(sym, { lastExitMs: ts, count: 1, lastAction: action, lastPnl: pnl });
    } else {
      prev.count += 1;
      if (ts > prev.lastExitMs) {
        prev.lastExitMs = ts;
        prev.lastAction = action;
        prev.lastPnl = pnl;
      }
    }
  }

  return out;
}

export interface ReentryCheckResult {
  blocked: boolean;
  reason?: string;
}

export function reentryBlocked(
  symbol: string,
  map: Map<string, RecentExitInfo>,
  opts: { nowMs?: number; windowMinutes?: number } = {},
): ReentryCheckResult {
  if (!symbol) return { blocked: false };
  const info = map.get(symbol);
  if (!info) return { blocked: false };

  const now = opts.nowMs ?? Date.now();
  const window = opts.windowMinutes ?? DEFAULT_REENTRY_WINDOW_MIN;
  const ageMin = Math.max(0, Math.round((now - info.lastExitMs) / 60_000));
  if (ageMin > window) return { blocked: false };

  const exitKind = info.lastAction === "PROFIT_TAKE" ? "profit take" : "sell";
  const pnlFragment = info.lastPnl != null
    ? ` (pnl ${info.lastPnl >= 0 ? "+" : ""}${info.lastPnl.toFixed(2)})`
    : "";
  const reason =
    `Reentry guard: ${symbol} closed ${exitKind} ${ageMin}m ago${pnlFragment}, ` +
    `blocking rebuys within ${window}m to prevent scalp then lose pattern`;
  return { blocked: true, reason };
}

// ── P4 #3: Sentiment gate when RSI is oversold ──────────────────────────────
// Apr 21 ASTS loss: quant score 55.55 cleared the 45 floor largely because
// "150 Reddit mentions" added a +10 social buzz component. Underlying RSI was
// 33.7 (oversold). Price fell through the stop for a $332 loss.
//
// A Reddit pump on a stock that is already oversold is usually a short squeeze
// setup that unwinds against longs. The fix is to zero the sentiment boost
// whenever RSI14 is below the same 35 floor the P3 falling knife filter uses.

export function applySentimentGuard(
  rawBuzz: number,
  rsi14: number | null | undefined,
  rsiFloor = 35,
): number {
  if (typeof rawBuzz !== "number" || !Number.isFinite(rawBuzz)) return 0;
  if (typeof rsi14 !== "number" || !Number.isFinite(rsi14)) return rawBuzz;
  if (rsi14 < rsiFloor) return 0;
  return rawBuzz;
}
