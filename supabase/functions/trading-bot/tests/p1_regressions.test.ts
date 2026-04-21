// Regression tests for the three P1 behavior patches:
//   #4 Morning regime filter (SPY gap + VIX)
//   #5 ETF bias on choppy days
//   #6 BUY_BLOCKED memoization
//
// These import the production helpers directly — if you change behavior in
// _p1_helpers.ts, the right assertion here will turn red.

import {
  assert,
  assertEquals,
  assertFalse,
} from "jsr:@std/assert@1";
import {
  applyEtfBias,
  BlockMemo,
  classifyRegime,
  isStickyBlockReason,
} from "../_p1_helpers.ts";

// ── P1 #4: regime classifier ────────────────────────────────────────────────

Deno.test("P1-regime: calm day stays normal", () => {
  // VXX at 29 on a calm day is a normal reading, not stress. This was the
  // Apr 20 false-positive scenario that shut the bot out for a whole morning.
  const r = classifyRegime(
    { spyChangePct: 0.3, spyGapPct: 0.3, vixProxyValue: 29, vixProxyChangePct: 1.2 },
    6,
    28,
  );
  assertFalse(r.choppyDay);
  assertEquals(r.maxPicks, 6);
  assertEquals(r.minScore, 28);
  assertEquals(r.reasons.length, 0);
});

Deno.test("P1-regime: SPY gap down triggers choppy", () => {
  const r = classifyRegime(
    { spyChangePct: -1.4, spyGapPct: -1.4, vixProxyValue: 30 },
    6,
    28,
  );
  assert(r.choppyDay);
  assertEquals(r.maxPicks, 3);
  assertEquals(r.minScore, 35);
  assert(r.reasons[0].includes("SPY gap"));
});

Deno.test("P1-regime: SPY gap up also triggers choppy", () => {
  const r = classifyRegime(
    { spyChangePct: 1.5, spyGapPct: 1.5, vixProxyValue: 30 },
    6,
    28,
  );
  assert(r.choppyDay, "gap ups are also risky, not just gap downs");
  assertEquals(r.maxPicks, 3);
});

Deno.test("P1-regime: elevated VXX absolute level triggers choppy even with calm SPY", () => {
  const r = classifyRegime(
    { spyChangePct: 0.2, spyGapPct: 0.2, vixProxyValue: 45 },
    6,
    28,
  );
  assert(r.choppyDay);
  assert(r.reasons.some((s) => s.includes("VXX proxy") && s.includes("above")),
    "reason should cite VXX absolute level");
});

Deno.test("P1-regime: VXX intraday spike triggers choppy", () => {
  // VXX at a moderate level 32 but up 20% intraday is a real fear spike.
  const r = classifyRegime(
    { spyChangePct: 0.1, spyGapPct: 0.1, vixProxyValue: 32, vixProxyChangePct: 20 },
    6,
    28,
  );
  assert(r.choppyDay);
  assert(r.reasons.some((s) => s.includes("spiked")),
    "reason should cite VXX spike, not absolute level");
});

Deno.test("P1-regime: small positive VXX change does not trigger", () => {
  const r = classifyRegime(
    { spyChangePct: 0.2, spyGapPct: 0.2, vixProxyValue: 30, vixProxyChangePct: 5 },
    6,
    28,
  );
  assertFalse(r.choppyDay);
});

Deno.test("P1-regime: SPY gap + VXX spike stack reasons", () => {
  const r = classifyRegime(
    { spyChangePct: -1.2, spyGapPct: -1.2, vixProxyValue: 42, vixProxyChangePct: 18 },
    6,
    28,
  );
  assert(r.choppyDay);
  assertEquals(r.reasons.length, 3, "SPY gap + VXX absolute + VXX spike all trigger");
});

Deno.test("P1-regime: missing vol proxy does not trigger", () => {
  const r = classifyRegime(
    { spyChangePct: 0.5, spyGapPct: 0.5, vixProxyValue: null },
    6,
    28,
  );
  assertFalse(r.choppyDay);
});

Deno.test("P1-regime: respects custom normal caps", () => {
  const r = classifyRegime(
    { spyChangePct: -1.5, spyGapPct: -1.5, vixProxyValue: 30 },
    10,
    40,
  );
  assertEquals(r.maxPicks, 5, "10/2 = 5");
  assertEquals(r.minScore, 40, "normal 40 wins over 35 floor");
});

// ── P1 #5: ETF bias ─────────────────────────────────────────────────────────

Deno.test("P1-etfbias: ETFs get +5 on choppy days", () => {
  const etfs = new Set(["SPY", "QQQ"]);
  assertEquals(applyEtfBias(70, "SPY", true, etfs), 75);
  assertEquals(applyEtfBias(60, "QQQ", true, etfs), 65);
});

Deno.test("P1-etfbias: single names get -5 on choppy days", () => {
  const etfs = new Set(["SPY", "QQQ"]);
  assertEquals(applyEtfBias(70, "NVDA", true, etfs), 65);
});

Deno.test("P1-etfbias: no effect when regime is normal", () => {
  const etfs = new Set(["SPY"]);
  assertEquals(applyEtfBias(70, "SPY", false, etfs), 70);
  assertEquals(applyEtfBias(70, "NVDA", false, etfs), 70);
});

Deno.test("P1-etfbias: custom bias magnitude", () => {
  const etfs = new Set(["SPY"]);
  assertEquals(applyEtfBias(70, "SPY", true, etfs, 10), 80);
  assertEquals(applyEtfBias(70, "NVDA", true, etfs, 10), 60);
});

// ── P1 #6: block memo ──────────────────────────────────────────────────────

Deno.test("P1-memo: sticky reasons are memoized", () => {
  const memo = new BlockMemo();
  memo.remember("NVDA", "2026-04-18", "Repeat loser: 3+ consecutive losses in 7 days");
  assert(memo.has("NVDA", "2026-04-18"));
  assertEquals(memo.get("NVDA", "2026-04-18"), "Repeat loser: 3+ consecutive losses in 7 days");
});

Deno.test("P1-memo: transient reasons are dropped", () => {
  const memo = new BlockMemo();
  memo.remember("NVDA", "2026-04-18", "lunch lull (score 20 < 34 threshold)");
  assertFalse(memo.has("NVDA", "2026-04-18"), "lunch lull is transient — should not memoize");
  memo.remember("NVDA", "2026-04-18", "Earnings fail-closed: calendar unavailable");
  assertFalse(memo.has("NVDA", "2026-04-18"), "fail-closed is transient — retry when calendar recovers");
});

Deno.test("P1-memo: scoped by date", () => {
  const memo = new BlockMemo();
  memo.remember("NVDA", "2026-04-17", "Crash filter: NVDA down -12% today");
  assert(memo.has("NVDA", "2026-04-17"));
  assertFalse(memo.has("NVDA", "2026-04-18"), "yesterday's block should not carry over");
});

Deno.test("P1-memo: first reason wins on duplicate remember", () => {
  const memo = new BlockMemo();
  memo.remember("ABT", "2026-04-18", "Earnings blackout: ABT reports earnings today — price action unpredictable, spreads wide");
  memo.remember("ABT", "2026-04-18", "Correlation guard: max 3 leveraged positions");
  assertEquals(
    memo.get("ABT", "2026-04-18"),
    "Earnings blackout: ABT reports earnings today — price action unpredictable, spreads wide",
    "first sticky reason wins",
  );
});

Deno.test("P1-memo: hydrate from DB rows", () => {
  const memo = new BlockMemo();
  const rows = [
    { symbol: "NVDA", reason: "Repeat loser: 3+ consecutive losses in 7 days" },
    { symbol: "TSLA", reason: "Crash filter: TSLA down -11% today — falling knife blocked" },
    { symbol: "AAPL", reason: "lunch lull (score 20 < 34 threshold)" }, // transient, should drop
    { symbol: null as unknown as string, reason: "Churn limit: 5+ trades" }, // missing symbol
  ];
  const added = memo.hydrate(rows, "2026-04-18");
  assertEquals(added, 2, "only the two sticky rows should be kept");
  assert(memo.has("NVDA", "2026-04-18"));
  assert(memo.has("TSLA", "2026-04-18"));
  assertFalse(memo.has("AAPL", "2026-04-18"));
});

Deno.test("P1-memo: isStickyBlockReason catches all sticky families", () => {
  const sticky = [
    "Repeat loser: 3+ consecutive losses in 7 days",
    "Churn limit: 5+ trades with ~$0 P&L today",
    "Crash filter: FOO down -12% today",
    "Correlation guard: max 3 leveraged positions",
    "Sector exposure: Adding FOO would put 70% of positions in Technology (max 60%)",
    "Earnings blackout: FOO reports earnings today",
    "Order value $22845 exceeds 25% position cap",
    "Order value $40123 exceeds 25% position cap",
  ];
  for (const r of sticky) assert(isStickyBlockReason(r), `should be sticky: ${r}`);

  const transient = [
    "Earnings fail-closed: calendar unavailable",
    "lunch lull (score 20 < 34 threshold)",
    "past 3:00 PM ET buy cutoff",
    null,
    "",
  ];
  for (const r of transient) assertFalse(isStickyBlockReason(r), `should NOT be sticky: ${r}`);
});

Deno.test("P1-memo: position cap rejection memoizes for whole day (FNGU regression)", () => {
  // On 2026-04-21 FNGU was sized above the 25% position cap on every cycle
  // and wrote ~60 identical BUY_BLOCKED rows. After this fix, the second
  // cycle should hit the memo and skip re-sizing.
  const memo = new BlockMemo();
  const today = "2026-04-21";
  const reason = "Order value $22845 exceeds 25% position cap";
  memo.remember("FNGU", today, reason);
  assert(memo.has("FNGU", today), "first rejection should be remembered");
  assertEquals(memo.get("FNGU", today), reason);
  // Hydrating from a DB row with a different dollar amount should still
  // count as the same sticky family for the day.
  const added = memo.hydrate(
    [{ symbol: "FNGU", reason: "Order value $22910 exceeds 25% position cap" }],
    today,
  );
  // Already memoized so hydrate adds 0 net new rows but does not throw.
  assertEquals(added, 0);
});
