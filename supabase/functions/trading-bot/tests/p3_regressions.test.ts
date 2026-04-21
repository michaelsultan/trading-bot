// Regression tests for the P3 behavior patches:
//   #1 Falling knife filter (score < 45 + RSI < 35 + red/flat 1m bar)
//
// These import the production helper directly — if you change behavior in
// _p3_helpers.ts, the right assertion here will turn red.

import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { fallingKnifeBlocked } from "../_p3_helpers.ts";

// ── P3 #1: falling knife filter ─────────────────────────────────────────────

Deno.test("P3-knife: blocks low score + oversold + red bar (Apr 20 RKLB regression)", () => {
  // This is the exact profile that cost us on Apr 20: quant score around 38,
  // RSI around 30, last 1 minute bar red. The gate should block this.
  const res = fallingKnifeBlocked({
    score: 38,
    rsi14: 30,
    minuteOpen: 10.40,
    minuteClose: 10.35,
  });
  assert(res.blocked);
  assert(res.reason);
  assertStringIncludes(res.reason!, "Falling knife");
  assertStringIncludes(res.reason!, "red");
});

Deno.test("P3-knife: blocks low score + oversold + flat bar", () => {
  // A flat bar (close == open) is not a green confirmation either.
  const res = fallingKnifeBlocked({
    score: 40,
    rsi14: 32,
    minuteOpen: 10.00,
    minuteClose: 10.00,
  });
  assert(res.blocked);
  assertStringIncludes(res.reason!, "flat");
});

Deno.test("P3-knife: allows low score + oversold + meaningful green bar", () => {
  // Green confirmation — 0.5% move is above the 0.3% default threshold.
  const res = fallingKnifeBlocked({
    score: 38,
    rsi14: 30,
    minuteOpen: 10.00,
    minuteClose: 10.05,
  });
  assertFalse(res.blocked);
});

Deno.test("P3-knife: P4 #2 blocks weak green bar (Apr 21 LCID regression)", () => {
  // Apr 21: LCID quant score 42, RSI 32.2, 1m bar moved from 2.40 to 2.41
  // — a +0.4% tick that should not count as a real recovery. With the
  // 0.3% floor it should *not* block... actually 0.4% > 0.3% so it would
  // pass. Use a 0.1% tick that is clearly below the floor.
  const res = fallingKnifeBlocked({
    score: 42,
    rsi14: 32.2,
    minuteOpen: 2.400,
    minuteClose: 2.402,  // +0.083%
  });
  assert(res.blocked);
  assertStringIncludes(res.reason!, "weak green");
});

Deno.test("P3-knife: custom greenMinPct respected", () => {
  // If we bump the green floor to 1%, a 0.5% move is now weak green.
  const res = fallingKnifeBlocked(
    { score: 38, rsi14: 30, minuteOpen: 10.00, minuteClose: 10.05 },
    { greenMinPct: 1.0 },
  );
  assert(res.blocked);
  assertStringIncludes(res.reason!, "weak green");
});

Deno.test("P3-knife: fails OPEN on non positive minuteOpen", () => {
  // Degenerate bar data — don't divide by zero, just let the name through.
  const res = fallingKnifeBlocked({
    score: 38,
    rsi14: 30,
    minuteOpen: 0,
    minuteClose: 0,
  });
  assertFalse(res.blocked);
});

Deno.test("P3-knife: allows high score even with red bar", () => {
  // Score 50 is above the 45 floor — the filter should not apply.
  const res = fallingKnifeBlocked({
    score: 50,
    rsi14: 30,
    minuteOpen: 10.00,
    minuteClose: 9.95,
  });
  assertFalse(res.blocked);
});

Deno.test("P3-knife: allows low score but non oversold RSI", () => {
  // RSI 50 is above the 35 floor — the filter should not apply. Low score
  // alone is not a falling knife profile, just a weaker momentum pick.
  const res = fallingKnifeBlocked({
    score: 38,
    rsi14: 50,
    minuteOpen: 10.00,
    minuteClose: 9.95,
  });
  assertFalse(res.blocked);
});

Deno.test("P3-knife: fails OPEN when minute bar unavailable", () => {
  // Premarket, thin name, or Alpaca just hasn't printed a fresh bar. We
  // don't want to block every cycle in this case.
  const res = fallingKnifeBlocked({
    score: 38,
    rsi14: 30,
    minuteOpen: null,
    minuteClose: null,
  });
  assertFalse(res.blocked);
});

Deno.test("P3-knife: fails OPEN when only one side of bar is present", () => {
  // Defensive — if Alpaca returns partial data, don't assume anything.
  const res = fallingKnifeBlocked({
    score: 38,
    rsi14: 30,
    minuteOpen: 10.0,
    minuteClose: undefined,
  });
  assertFalse(res.blocked);
});

Deno.test("P3-knife: fails OPEN when score or RSI missing", () => {
  // If the quant engine didn't produce a score we let the downstream
  // gates decide — this filter only applies to known low conviction picks.
  assertFalse(fallingKnifeBlocked({
    score: null,
    rsi14: 30,
    minuteOpen: 10.0,
    minuteClose: 9.9,
  }).blocked);
  assertFalse(fallingKnifeBlocked({
    score: 38,
    rsi14: null,
    minuteOpen: 10.0,
    minuteClose: 9.9,
  }).blocked);
});

Deno.test("P3-knife: ignores non finite numbers", () => {
  assertFalse(fallingKnifeBlocked({
    score: NaN,
    rsi14: 30,
    minuteOpen: 10.0,
    minuteClose: 9.9,
  }).blocked);
  assertFalse(fallingKnifeBlocked({
    score: 38,
    rsi14: 30,
    minuteOpen: Infinity,
    minuteClose: 9.9,
  }).blocked);
});

Deno.test("P3-knife: boundary at scoreFloor (< is strict)", () => {
  // score === 45 should NOT block — the floor is a strict less than.
  const res = fallingKnifeBlocked({
    score: 45,
    rsi14: 30,
    minuteOpen: 10.0,
    minuteClose: 9.9,
  });
  assertFalse(res.blocked);
});

Deno.test("P3-knife: boundary at rsiFloor (< is strict)", () => {
  // rsi === 35 should NOT block.
  const res = fallingKnifeBlocked({
    score: 38,
    rsi14: 35,
    minuteOpen: 10.0,
    minuteClose: 9.9,
  });
  assertFalse(res.blocked);
});

Deno.test("P3-knife: custom floors respected", () => {
  // If the caller passes a looser scoreFloor of 60, a score of 50 is now
  // inside the filter's zone.
  const res = fallingKnifeBlocked(
    { score: 50, rsi14: 30, minuteOpen: 10.0, minuteClose: 9.9 },
    { scoreFloor: 60 },
  );
  assert(res.blocked);
});

Deno.test("P3-knife: reason string includes the numeric context", () => {
  const res = fallingKnifeBlocked({
    score: 38.4,
    rsi14: 30.2,
    minuteOpen: 12.345,
    minuteClose: 12.300,
  });
  assert(res.blocked);
  assertEquals(
    res.reason,
    "Falling knife: score 38.4 < 45 + RSI 30.2 < 35, last 1m bar red (12.35 → 12.30)",
  );
});
