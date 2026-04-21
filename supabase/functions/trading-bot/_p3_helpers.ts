// Helpers for the P3 behavior patches. Kept separate from _p0/_p1 so the
// filter code that governs BUY timing stays isolated from fail closed logic
// and morning regime classification.
//
// If you change any of these, update tests/p3_regressions.test.ts too.

// ── P3 #1: Falling knife filter ─────────────────────────────────────────────
// Block BUYs when the quant engine is picking a low conviction "oversold
// bounce" setup AND the most recent 1 minute bar is still red. Rationale
// from Apr 20: RKLB printed a score of 38 with RSI 30 (quant engine picked
// it as an oversold bounce candidate) and we bought it twice, 4 minutes
// apart, while the last 1 minute bar was red both times. Both fills lost
// about 90 bps immediately. Waiting for a green confirmation bar would
// have blocked both entries.
//
// Design:
//   * score < SCORE_FLOOR (default 45) AND RSI < RSI_FLOOR (default 35)
//     are the entry criteria — low conviction oversold reads.
//   * The filter fires only if the last 1 minute bar is flat or down
//     (close <= open). A green bar is the confirmation signal we want.
//   * If minute bar data is unavailable (null, undefined, non finite,
//     before market open, etc.) we fail OPEN rather than closed — the bot
//     already has a crash filter for the truly bad case and we don't want
//     to block every premarket cycle.
//   * This check is NOT sticky. If a knife stops falling 5 minutes later
//     we want to reconsider the entry. See _p1_helpers.STICKY_PREFIXES
//     comment — we intentionally do not add "Falling knife" there.

const DEFAULT_SCORE_FLOOR = 45;
const DEFAULT_RSI_FLOOR = 35;
// P4 #2: require the "green confirmation" bar to actually move up by at least
// GREEN_MIN_PCT percent. Apr 21 LCID regression: the bot released two LCID
// entries (score 42, RSI 32.2) because the 1m bar printed a tick above open,
// but the move was too small to be a real recovery. Both fills lost ~1.5%.
const DEFAULT_GREEN_MIN_PCT = 0.3;

export interface FallingKnifeInputs {
  score: number | null | undefined;
  rsi14: number | null | undefined;
  minuteOpen: number | null | undefined;
  minuteClose: number | null | undefined;
}

export interface FallingKnifeOptions {
  scoreFloor?: number;   // score below which the filter is armed
  rsiFloor?: number;     // RSI14 below which the filter is armed
  greenMinPct?: number;  // minimum 1m green move (% of open) to count as confirmation
}

export interface FallingKnifeResult {
  blocked: boolean;
  reason?: string;
}

export function fallingKnifeBlocked(
  inputs: FallingKnifeInputs,
  opts: FallingKnifeOptions = {},
): FallingKnifeResult {
  const scoreFloor = opts.scoreFloor ?? DEFAULT_SCORE_FLOOR;
  const rsiFloor = opts.rsiFloor ?? DEFAULT_RSI_FLOOR;
  const greenMinPct = opts.greenMinPct ?? DEFAULT_GREEN_MIN_PCT;

  const score = finiteOrNull(inputs.score);
  const rsi = finiteOrNull(inputs.rsi14);

  // Both score and RSI must be present and below their floors. If either is
  // missing or above floor, this is not the low conviction oversold setup
  // the filter targets, so we let it through.
  if (score == null || rsi == null) return { blocked: false };
  if (score >= scoreFloor) return { blocked: false };
  if (rsi >= rsiFloor) return { blocked: false };

  const mo = finiteOrNull(inputs.minuteOpen);
  const mc = finiteOrNull(inputs.minuteClose);

  // Minute bar unavailable: fail OPEN. We don't want to block every
  // premarket cycle or every symbol that Alpaca hasn't printed a fresh
  // minute bar for yet.
  if (mo == null || mc == null) return { blocked: false };
  if (mo <= 0) return { blocked: false };

  // Meaningful green bar (close above open by at least greenMinPct of open)
  // is the confirmation we want. A tick green bar is not a real recovery.
  const movePct = ((mc - mo) / mo) * 100;
  if (movePct >= greenMinPct) return { blocked: false };

  let direction: string;
  if (mc < mo) direction = "red";
  else if (mc === mo) direction = "flat";
  else direction = `weak green +${movePct.toFixed(2)}% < ${greenMinPct}%`;

  const reason =
    `Falling knife: score ${score.toFixed(1)} < ${scoreFloor} + RSI ${rsi.toFixed(1)} < ${rsiFloor}, ` +
    `last 1m bar ${direction} (${mo.toFixed(2)} → ${mc.toFixed(2)})`;
  return { blocked: true, reason };
}

function finiteOrNull(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
