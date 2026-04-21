// Extracted helpers for P0 regression tests. These are the exact functions the
// bot uses at runtime — do NOT duplicate their logic elsewhere. If you change
// behavior here, update the tests in tests/p0_regressions.test.ts too.

export type Fetcher = (url: string, init?: RequestInit, timeoutMs?: number) => Promise<Response>;

export type EarningsCheckResult = {
  ok: boolean;
  symbols: Set<string>;
  reason: string;
};

// Fetch today's earnings calendar from Finnhub. Returns a fail-closed result:
// if the key is missing, the HTTP call fails, the response is malformed, or any
// retry path throws, `ok` is false and callers must block new BUYs this cycle.
export async function checkEarningsCalendar(
  finnhubKey: string | undefined,
  finnhubBaseUrl: string,
  todayIso: string,
  fetcher: Fetcher,
): Promise<EarningsCheckResult> {
  const symbols = new Set<string>();
  if (!finnhubKey) {
    return {
      ok: false,
      symbols,
      reason: "FINNHUB_API_KEY not set — cannot verify earnings blackout",
    };
  }

  let lastReason = "";
  for (const timeoutMs of [8000, 12000]) {
    try {
      const res = await fetcher(
        `${finnhubBaseUrl}/calendar/earnings?from=${todayIso}&to=${todayIso}&token=${finnhubKey}`,
        undefined,
        timeoutMs,
      );
      if (!res.ok) {
        lastReason = `HTTP ${res.status}`;
        continue;
      }
      const body = await res.json();
      if (!body || !Array.isArray(body.earningsCalendar)) {
        lastReason = "malformed response (missing earningsCalendar array)";
        continue;
      }
      for (const e of body.earningsCalendar) {
        if (e?.symbol) symbols.add(e.symbol);
      }
      return { ok: true, symbols, reason: "" };
    } catch (err) {
      lastReason = `fetch error: ${String(err).slice(0, 120)}`;
    }
  }
  return { ok: false, symbols, reason: lastReason || "unknown fetch failure" };
}

// Poll Alpaca for the actual fill price of an order. Returns null if the order
// is not filled within maxWaitMs, in which case callers fall back to a quoted
// price. Separate from checkEarningsCalendar so tests can inject a fake clock.
export async function fetchOrderFillPrice(
  orderId: string,
  alpacaBaseUrl: string,
  headers: Record<string, string>,
  fetcher: Fetcher,
  maxWaitMs = 3000,
  sleeper: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => number = () => Date.now(),
): Promise<number | null> {
  const deadline = now() + maxWaitMs;
  while (now() < deadline) {
    try {
      const res = await fetcher(
        `${alpacaBaseUrl}/orders/${orderId}`,
        { headers },
        2000,
      );
      const data = await res.json();
      if (data?.status === "filled" && data?.filled_avg_price) {
        return parseFloat(String(data.filled_avg_price));
      }
    } catch { /* retry */ }
    await sleeper(400);
  }
  return null;
}

// Compute realized pnl from an entry price, exit fill price, and quantity.
// Exported so the telemetry regression tests can verify the single arithmetic
// path used by every exit row (SELL, PROFIT_TAKE, EOD flatten, nuclear).
export function computeRealizedPnl(
  entryPrice: number | null | undefined,
  exitFillPrice: number | null | undefined,
  quantity: number,
): number | null {
  if (!entryPrice || entryPrice <= 0) return null;
  if (exitFillPrice == null || !Number.isFinite(exitFillPrice)) return null;
  if (!quantity || quantity <= 0) return null;
  return +((exitFillPrice - entryPrice) * quantity).toFixed(2);
}
