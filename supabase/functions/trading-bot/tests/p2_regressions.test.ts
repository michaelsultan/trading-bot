// Regression tests for the P2 reliability patches:
//   #7 EOD flatten cancel-then-refetch (cancelAllOpenOrders)
//   #8 Trade reconciliation (findUnreconciledFills, buildReconcileReason)
//
// Run with: deno test --allow-none supabase/functions/trading-bot/tests/
//
// These tests import the real helpers used by index.ts (not copies). If someone
// breaks the cancel-all-orders path or the reconciliation dedup logic, the
// corresponding test here will turn red.
//
// Historical context: the Apr 20 RKLB SELL (147 shares, $188.73 loss) was
// triggered by a bracket stop but never landed in public.trades, because our
// EOD flatten saw qty=0 after the stop fired and silently skipped logging.
// The tests below pin down the behaviors that prevent that class of bug.

import {
  assert,
  assertEquals,
  assertFalse,
} from "jsr:@std/assert@1";
import type { Fetcher } from "../_p0_helpers.ts";
import {
  buildReconcileReason,
  cancelAllOpenOrders,
  findUnreconciledFills,
  type AlpacaOrderLike,
  type TradeRowLike,
} from "../_p2_helpers.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── P2 #7: cancel-all-open-orders ────────────────────────────────────────────

Deno.test("P2-cancelAll: 200 with array body returns cancelled count", async () => {
  const fetcher: Fetcher = async (_url, init) => {
    assertEquals(init?.method, "DELETE", "must issue a DELETE");
    return jsonResponse([{ id: "o1" }, { id: "o2" }, { id: "o3" }]);
  };
  const result = await cancelAllOpenOrders("https://alpaca.example", {}, fetcher);
  assert(result.ok, "200 response should return ok=true");
  assertEquals(result.cancelled, 3, "should count every cancelled order");
  assertEquals(result.reason, "");
});

Deno.test("P2-cancelAll: 207 multi-status is still success with unknown count tolerated", async () => {
  // Alpaca sometimes returns 207 with a body like [{id, status: 200}, ...].
  // We treat any 2xx as ok and count however many entries are in the array.
  const fetcher: Fetcher = async () =>
    jsonResponse([{ id: "o1", status: 200 }, { id: "o2", status: 500 }], 207);
  const result = await cancelAllOpenOrders("https://alpaca.example", {}, fetcher);
  assert(result.ok);
  assertEquals(result.cancelled, 2);
});

Deno.test("P2-cancelAll: 200 with empty body is tolerated", async () => {
  const fetcher: Fetcher = async () => new Response("", { status: 200 });
  const result = await cancelAllOpenOrders("https://alpaca.example", {}, fetcher);
  assert(result.ok);
  assertEquals(result.cancelled, 0);
});

Deno.test("P2-cancelAll: HTTP 500 returns ok=false and quotes the status", async () => {
  const fetcher: Fetcher = async () => new Response("server error", { status: 500 });
  const result = await cancelAllOpenOrders("https://alpaca.example", {}, fetcher);
  assertFalse(result.ok);
  assertEquals(result.cancelled, 0);
  assert(result.reason.includes("500"), "reason should quote the HTTP status");
});

Deno.test("P2-cancelAll: network exception returns ok=false with reason", async () => {
  const fetcher: Fetcher = () => {
    throw new Error("connection reset");
  };
  const result = await cancelAllOpenOrders("https://alpaca.example", {}, fetcher);
  assertFalse(result.ok);
  assert(result.reason.includes("connection reset"));
});

Deno.test("P2-cancelAll: forwards the auth headers to Alpaca", async () => {
  let sawHeaders: Record<string, string> | undefined;
  const fetcher: Fetcher = async (_url, init) => {
    sawHeaders = init?.headers as Record<string, string>;
    return jsonResponse([]);
  };
  const hdr = { "APCA-API-KEY-ID": "k", "APCA-API-SECRET-KEY": "s" };
  await cancelAllOpenOrders("https://alpaca.example", hdr, fetcher);
  assertEquals(sawHeaders?.["APCA-API-KEY-ID"], "k");
  assertEquals(sawHeaders?.["APCA-API-SECRET-KEY"], "s");
});

// ── P2 #8: findUnreconciledFills ─────────────────────────────────────────────

const baseOrder: AlpacaOrderLike = {
  id: "alpaca-1",
  symbol: "RKLB",
  side: "sell",
  status: "filled",
  filled_qty: "147",
  filled_avg_price: "87.53",
  filled_at: "2026-04-20T20:56:12Z",
};

Deno.test("P2-reconcile: picks up a sell fill that is not yet in trades", () => {
  const missing = findUnreconciledFills([baseOrder], []);
  assertEquals(missing.length, 1);
  assertEquals(missing[0].symbol, "RKLB");
  assertEquals(missing[0].qty, 147);
  assertEquals(missing[0].fillPrice, 87.53);
  assertEquals(missing[0].alpacaOrderId, "alpaca-1");
  assertEquals(missing[0].filledAt, "2026-04-20T20:56:12Z");
});

Deno.test("P2-reconcile: dedups by alpaca_order_id", () => {
  const known: TradeRowLike[] = [
    { alpaca_order_id: "alpaca-1", symbol: "RKLB", action: "SELL" },
  ];
  const missing = findUnreconciledFills([baseOrder], known);
  assertEquals(missing.length, 0, "existing order id must suppress the fill");
});

Deno.test("P2-reconcile: skips buy-side orders", () => {
  const buy: AlpacaOrderLike = { ...baseOrder, id: "b1", side: "buy" };
  assertEquals(findUnreconciledFills([buy], []).length, 0);
});

Deno.test("P2-reconcile: skips non-filled orders", () => {
  const partial: AlpacaOrderLike = { ...baseOrder, id: "p1", status: "partially_filled" };
  const canceled: AlpacaOrderLike = { ...baseOrder, id: "c1", status: "canceled" };
  assertEquals(findUnreconciledFills([partial, canceled], []).length, 0);
});

Deno.test("P2-reconcile: drops rows with zero or invalid qty", () => {
  const zeroQty: AlpacaOrderLike = { ...baseOrder, id: "z1", filled_qty: "0" };
  const nanQty: AlpacaOrderLike = { ...baseOrder, id: "z2", filled_qty: "abc" };
  const nullQty: AlpacaOrderLike = { ...baseOrder, id: "z3", filled_qty: null };
  assertEquals(findUnreconciledFills([zeroQty, nanQty, nullQty], []).length, 0);
});

Deno.test("P2-reconcile: drops rows with zero or invalid fill price", () => {
  const zeroPx: AlpacaOrderLike = { ...baseOrder, id: "p1", filled_avg_price: "0" };
  const nanPx: AlpacaOrderLike = { ...baseOrder, id: "p2", filled_avg_price: "oops" };
  const nullPx: AlpacaOrderLike = { ...baseOrder, id: "p3", filled_avg_price: null };
  assertEquals(findUnreconciledFills([zeroPx, nanPx, nullPx], []).length, 0);
});

Deno.test("P2-reconcile: drops rows with missing id or symbol", () => {
  const noId = { ...baseOrder, id: "" } as AlpacaOrderLike;
  const noSym = { ...baseOrder, symbol: "" } as AlpacaOrderLike;
  assertEquals(findUnreconciledFills([noId, noSym], []).length, 0);
});

Deno.test("P2-reconcile: does NOT collapse two different fills for same symbol", () => {
  // Bracket partial fill at 87.53, then the rest at 87.49 — two distinct Alpaca
  // order ids, both legitimate trade rows. Symbol+timestamp is intentionally not
  // used as a dedup key so both are inserted.
  const o1: AlpacaOrderLike = { ...baseOrder, id: "alpaca-1", filled_qty: "100", filled_avg_price: "87.53" };
  const o2: AlpacaOrderLike = { ...baseOrder, id: "alpaca-2", filled_qty: "47", filled_avg_price: "87.49" };
  const missing = findUnreconciledFills([o1, o2], []);
  assertEquals(missing.length, 2);
  assertEquals(missing[0].qty, 100);
  assertEquals(missing[1].qty, 47);
});

Deno.test("P2-reconcile: mixed input — keeps only the unreconciled sell", () => {
  const orders: AlpacaOrderLike[] = [
    { ...baseOrder, id: "buy-1", side: "buy" },
    { ...baseOrder, id: "alpaca-known", symbol: "AAPL" },
    baseOrder,
    { ...baseOrder, id: "canceled-1", status: "canceled" },
  ];
  const known: TradeRowLike[] = [
    { alpaca_order_id: "alpaca-known", symbol: "AAPL", action: "SELL" },
  ];
  const missing = findUnreconciledFills(orders, known);
  assertEquals(missing.length, 1);
  assertEquals(missing[0].alpacaOrderId, "alpaca-1");
  assertEquals(missing[0].symbol, "RKLB");
});

Deno.test("P2-reconcile: ignores known trade rows without alpaca_order_id", () => {
  const known: TradeRowLike[] = [
    { alpaca_order_id: null, symbol: "RKLB", action: "SELL" },
    { symbol: "RKLB", action: "SELL" } as TradeRowLike,
  ];
  const missing = findUnreconciledFills([baseOrder], known);
  assertEquals(missing.length, 1, "null/absent order ids must not dedup anything");
});

// ── P2 #8: buildReconcileReason ──────────────────────────────────────────────

Deno.test("P2-reason: includes timestamp when provided", () => {
  const reason = buildReconcileReason("2026-04-20T20:56:12Z");
  assert(reason.includes("Reconciled"), "reason should flag origin");
  assert(reason.includes("2026-04-20T20:56:12Z"), "reason should include the fill timestamp");
  assert(reason.includes("bracket stop"), "reason should mention likely source");
});

Deno.test("P2-reason: omits timestamp when null", () => {
  const reason = buildReconcileReason(null);
  assert(reason.includes("Reconciled"));
  assertFalse(reason.includes("at null"), "must not splice literal null");
  assertFalse(reason.includes(" at "), "no timestamp tag when filledAt is null");
});
