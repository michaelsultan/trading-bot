// Regression tests for the three P0 bugs found in the 04/13–04/17 analysis.
// Run with: deno test --allow-none supabase/functions/trading-bot/tests/
//
// These tests import the real helpers used by index.ts (not copies). If someone
// breaks the fail-closed earnings logic, the unprotected-position fallback, or
// the fill-price polling, the corresponding test here will turn red.

import {
  assert,
  assertEquals,
  assertFalse,
} from "jsr:@std/assert@1";
import {
  checkEarningsCalendar,
  computeRealizedPnl,
  fetchOrderFillPrice,
  type Fetcher,
} from "../_p0_helpers.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function recordingFetcher(handler: (url: string) => Response | Promise<Response>): {
  fetcher: Fetcher;
  calls: string[];
} {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    return await handler(url);
  };
  return { fetcher, calls };
}

// ── P0 #2: earnings blackout fail-closed ─────────────────────────────────────

Deno.test("P0-earnings: missing FINNHUB_API_KEY fails closed", async () => {
  const { fetcher, calls } = recordingFetcher(() => jsonResponse({}));
  const result = await checkEarningsCalendar(undefined, "https://finnhub.example", "2026-04-18", fetcher);
  assertFalse(result.ok, "must fail closed when key is missing");
  assertEquals(result.symbols.size, 0);
  assert(result.reason.includes("FINNHUB_API_KEY"), "reason should name the missing key");
  assertEquals(calls.length, 0, "no HTTP call should happen without a key");
});

Deno.test("P0-earnings: HTTP 500 fails closed", async () => {
  const { fetcher, calls } = recordingFetcher(() =>
    new Response("server error", { status: 500 })
  );
  const result = await checkEarningsCalendar("k", "https://finnhub.example", "2026-04-18", fetcher);
  assertFalse(result.ok);
  assertEquals(result.symbols.size, 0);
  assert(result.reason.startsWith("HTTP 500"), "reason should quote the status");
  assertEquals(calls.length, 2, "should retry once on HTTP failure");
});

Deno.test("P0-earnings: network exception fails closed", async () => {
  let calls = 0;
  const fetcher: Fetcher = () => {
    calls++;
    throw new Error("boom");
  };
  const result = await checkEarningsCalendar("k", "https://finnhub.example", "2026-04-18", fetcher);
  assertFalse(result.ok);
  assert(result.reason.includes("boom"), "reason should mention the underlying error");
  assertEquals(calls, 2, "should attempt both timeouts before giving up");
});

Deno.test("P0-earnings: malformed response fails closed", async () => {
  const { fetcher } = recordingFetcher(() => jsonResponse({ oops: true }));
  const result = await checkEarningsCalendar("k", "https://finnhub.example", "2026-04-18", fetcher);
  assertFalse(result.ok);
  assert(result.reason.includes("malformed"));
});

Deno.test("P0-earnings: success populates symbols set", async () => {
  const { fetcher } = recordingFetcher(() =>
    jsonResponse({
      earningsCalendar: [
        { symbol: "ABT", hour: "bmo" },
        { symbol: "PG" },
        { symbol: null }, // ignored
      ],
    })
  );
  const result = await checkEarningsCalendar("k", "https://finnhub.example", "2026-04-18", fetcher);
  assert(result.ok);
  assertEquals(result.symbols.size, 2);
  assert(result.symbols.has("ABT"), "ABT should be blocked — this is the 04/17 bug symbol");
  assert(result.symbols.has("PG"));
});

// ── P0 #3: fill price polling + pnl arithmetic ───────────────────────────────

Deno.test("P0-fill: returns filled_avg_price when order is filled", async () => {
  const fetcher: Fetcher = async () =>
    jsonResponse({ status: "filled", filled_avg_price: "123.45" });
  const sleeper = (_ms: number) => Promise.resolve();
  const nowStub = (() => {
    let t = 0;
    return () => (t += 10);
  })();
  const price = await fetchOrderFillPrice(
    "abc",
    "https://alpaca.example",
    { Authorization: "x" },
    fetcher,
    1000,
    sleeper,
    nowStub,
  );
  assertEquals(price, 123.45);
});

Deno.test("P0-fill: returns null when order never fills", async () => {
  const fetcher: Fetcher = async () =>
    jsonResponse({ status: "new" });
  const sleeper = (_ms: number) => Promise.resolve();
  let t = 0;
  const now = () => {
    t += 600;
    return t;
  };
  const price = await fetchOrderFillPrice(
    "abc",
    "https://alpaca.example",
    {},
    fetcher,
    1000,
    sleeper,
    now,
  );
  assertEquals(price, null, "must not invent a fill price when Alpaca has not reported one");
});

Deno.test("P0-fill: survives transient fetch errors until deadline", async () => {
  let attempt = 0;
  const fetcher: Fetcher = async () => {
    attempt++;
    if (attempt < 3) throw new Error("transient");
    return jsonResponse({ status: "filled", filled_avg_price: "99.99" });
  };
  const sleeper = (_ms: number) => Promise.resolve();
  let t = 0;
  const now = () => (t += 10);
  const price = await fetchOrderFillPrice(
    "abc",
    "https://alpaca.example",
    {},
    fetcher,
    5000,
    sleeper,
    now,
  );
  assertEquals(price, 99.99);
  assertEquals(attempt, 3);
});

Deno.test("P0-pnl: computes realized pnl from fill minus entry", () => {
  assertEquals(computeRealizedPnl(100, 102.5, 10), 25);
  assertEquals(computeRealizedPnl(50, 45, 4), -20);
});

Deno.test("P0-pnl: returns null on invalid inputs (no phantom pnl)", () => {
  assertEquals(computeRealizedPnl(0, 100, 10), null, "zero entry must not produce pnl");
  assertEquals(computeRealizedPnl(null, 100, 10), null);
  assertEquals(computeRealizedPnl(100, null, 10), null);
  assertEquals(computeRealizedPnl(100, NaN, 10), null);
  assertEquals(computeRealizedPnl(100, 105, 0), null, "zero qty must not produce pnl");
});
