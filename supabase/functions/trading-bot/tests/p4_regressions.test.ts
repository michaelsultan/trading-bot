// Regression tests for the P4 behavior patches:
//   #1 Reentry guard (block same day rebuy within 30 minutes of a SELL or PROFIT_TAKE)
//   #3 Sentiment gate when RSI is oversold (zero social buzz below RSI 35)
//
// Patch #2 lives in _p3_helpers.ts and is exercised by tests/p3_regressions.test.ts.

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import {
  applySentimentGuard,
  buildRecentExitMap,
  reentryBlocked,
  type ExitRow,
} from "../_p4_helpers.ts";

// ── P4 #1: reentry guard ────────────────────────────────────────────────────

function isoMinutesAgo(nowMs: number, ago: number): string {
  return new Date(nowMs - ago * 60_000).toISOString();
}

Deno.test("P4-reentry: builds map of today's SELL/PROFIT_TAKE within window", () => {
  const now = Date.parse("2026-04-21T15:00:00Z");
  const rows: ExitRow[] = [
    { symbol: "BULL", action: "SELL",         created_at: isoMinutesAgo(now, 10), pnl: 19 },
    { symbol: "FCEL", action: "PROFIT_TAKE",  created_at: isoMinutesAgo(now, 25), pnl: 127 },
    { symbol: "XYZ",  action: "SELL",         created_at: isoMinutesAgo(now, 90), pnl: -50 },  // outside 30m window
    { symbol: "AAPL", action: "BUY",          created_at: isoMinutesAgo(now, 5),  pnl: null },  // not an exit
  ];
  const map = buildRecentExitMap(rows, { nowMs: now });
  assertEquals(map.size, 2);
  assert(map.has("BULL"));
  assert(map.has("FCEL"));
  assertFalse(map.has("XYZ"));
  assertFalse(map.has("AAPL"));
});

Deno.test("P4-reentry: blocks rebuy on BULL (Apr 21 scalp then lose regression)", () => {
  const now = Date.parse("2026-04-21T15:00:00Z");
  const rows: ExitRow[] = [
    { symbol: "BULL", action: "SELL", created_at: isoMinutesAgo(now, 18), pnl: 19 },
  ];
  const map = buildRecentExitMap(rows, { nowMs: now });
  const res = reentryBlocked("BULL", map, { nowMs: now });
  assert(res.blocked);
  assertStringIncludes(res.reason!, "Reentry guard");
  assertStringIncludes(res.reason!, "BULL");
  assertStringIncludes(res.reason!, "18m ago");
  assertStringIncludes(res.reason!, "sell");
  assertStringIncludes(res.reason!, "+19");
});

Deno.test("P4-reentry: labels PROFIT_TAKE correctly", () => {
  const now = Date.parse("2026-04-21T15:00:00Z");
  const rows: ExitRow[] = [
    { symbol: "FCEL", action: "PROFIT_TAKE", created_at: isoMinutesAgo(now, 10), pnl: 127 },
  ];
  const map = buildRecentExitMap(rows, { nowMs: now });
  const res = reentryBlocked("FCEL", map, { nowMs: now });
  assert(res.blocked);
  assertStringIncludes(res.reason!, "profit take");
});

Deno.test("P4-reentry: allows rebuy after the 30 minute window expires", () => {
  const now = Date.parse("2026-04-21T15:00:00Z");
  const rows: ExitRow[] = [
    // First build the map when the exit is within window, then advance time
    { symbol: "AAPL", action: "SELL", created_at: isoMinutesAgo(now, 10), pnl: 5 },
  ];
  const map = buildRecentExitMap(rows, { nowMs: now });
  // 35 minutes later — map still has the entry but reentryBlocked should let it through.
  const later = now + 35 * 60_000;
  const res = reentryBlocked("AAPL", map, { nowMs: later });
  assertFalse(res.blocked);
});

Deno.test("P4-reentry: allows rebuy on a symbol never exited today", () => {
  const now = Date.parse("2026-04-21T15:00:00Z");
  const map = buildRecentExitMap([], { nowMs: now });
  const res = reentryBlocked("TSLA", map, { nowMs: now });
  assertFalse(res.blocked);
});

Deno.test("P4-reentry: fails OPEN on malformed rows", () => {
  const now = Date.parse("2026-04-21T15:00:00Z");
  const rows: ExitRow[] = [
    { symbol: null,   action: "SELL", created_at: isoMinutesAgo(now, 5) },
    { symbol: "",     action: "SELL", created_at: isoMinutesAgo(now, 5) },
    { symbol: "OK",   action: null,   created_at: isoMinutesAgo(now, 5) },
    { symbol: "OK",   action: "SELL", created_at: null },
    { symbol: "OK",   action: "SELL", created_at: "not a date" },
  ];
  const map = buildRecentExitMap(rows, { nowMs: now });
  assertEquals(map.size, 0);
});

Deno.test("P4-reentry: multiple exits keep the most recent one", () => {
  const now = Date.parse("2026-04-21T15:00:00Z");
  const rows: ExitRow[] = [
    { symbol: "LCID", action: "SELL",        created_at: isoMinutesAgo(now, 28), pnl: -128 },
    { symbol: "LCID", action: "PROFIT_TAKE", created_at: isoMinutesAgo(now, 8),  pnl: 30 },
  ];
  const map = buildRecentExitMap(rows, { nowMs: now });
  const info = map.get("LCID");
  assert(info);
  assertEquals(info!.count, 2);
  assertEquals(info!.lastAction, "PROFIT_TAKE");
  assertEquals(info!.lastPnl, 30);
});

Deno.test("P4-reentry: custom windowMinutes respected", () => {
  const now = Date.parse("2026-04-21T15:00:00Z");
  const rows: ExitRow[] = [
    { symbol: "NVDA", action: "SELL", created_at: isoMinutesAgo(now, 45), pnl: 10 },
  ];
  // With default window (30m) this should be dropped. With window = 60m it stays.
  assertEquals(buildRecentExitMap(rows, { nowMs: now }).size, 0);
  const map60 = buildRecentExitMap(rows, { nowMs: now, windowMinutes: 60 });
  const res = reentryBlocked("NVDA", map60, { nowMs: now, windowMinutes: 60 });
  assert(res.blocked);
});

// ── P4 #3: sentiment guard ──────────────────────────────────────────────────

Deno.test("P4-sentiment: zeros buzz below RSI floor (Apr 21 ASTS regression)", () => {
  // ASTS: raw buzz +10, RSI 33.7 → gate should zero the buzz.
  assertEquals(applySentimentGuard(10, 33.7), 0);
});

Deno.test("P4-sentiment: preserves buzz above RSI floor", () => {
  assertEquals(applySentimentGuard(10, 50), 10);
  assertEquals(applySentimentGuard(3, 40), 3);
});

Deno.test("P4-sentiment: RSI at floor is NOT gated (strict less than)", () => {
  assertEquals(applySentimentGuard(10, 35), 10);
});

Deno.test("P4-sentiment: custom floor respected", () => {
  assertEquals(applySentimentGuard(10, 38, 40), 0);
  assertEquals(applySentimentGuard(10, 45, 40), 10);
});

Deno.test("P4-sentiment: returns raw buzz when RSI is null or non finite", () => {
  // If we don't have an RSI read, default to returning the raw buzz —
  // the other BUY gates will have their own checks.
  assertEquals(applySentimentGuard(5, null), 5);
  assertEquals(applySentimentGuard(5, undefined), 5);
  assertEquals(applySentimentGuard(5, NaN), 5);
});

Deno.test("P4-sentiment: normalizes non finite buzz to 0", () => {
  assertEquals(applySentimentGuard(NaN, 50), 0);
  assertEquals(applySentimentGuard(Infinity, 50), 0);
});
