// Helpers for the P2 reliability patches:
//   #7 EOD flatten — cancel-then-refetch so bracket-pledged shares get sold
//   #8 Trade reconciliation — backfill external SELL fills (bracket stops,
//      nuclear cron, manual closes) into our trades table so the dashboard
//      and pnl calc never silently miss a close.
//
// These are kept separate from _p0_helpers (fail-closed/fill-price) and
// _p1_helpers (regime/scoring) so each concern has its own surface area.
// If you change behavior here, update tests/p2_regressions.test.ts too.

import type { Fetcher } from "./_p0_helpers.ts";

// ── P2 #7: cancel-all-open-orders before EOD flatten ────────────────────────
// Alpaca holds shares pledged to a protective stop bracket as "unavailable".
// If we try to flatten without first cancelling, the SELL is rejected silently
// (Alpaca returns 200 with a partially-filled order, or the position is gone
// entirely because the stop just fired). Cancelling globally up front + a
// short pause + a fresh /positions read avoids the race.

export interface CancelAllResult {
  cancelled: number;
  ok: boolean;
  reason: string;
}

export async function cancelAllOpenOrders(
  alpacaBaseUrl: string,
  headers: Record<string, string>,
  fetcher: Fetcher,
): Promise<CancelAllResult> {
  try {
    const res = await fetcher(`${alpacaBaseUrl}/orders`, {
      method: "DELETE",
      headers,
    });
    if (res.status >= 200 && res.status < 300) {
      let cancelled = 0;
      try {
        const body = await res.json();
        if (Array.isArray(body)) cancelled = body.length;
      } catch { /* empty body is fine */ }
      return { cancelled, ok: true, reason: "" };
    }
    return { cancelled: 0, ok: false, reason: `HTTP ${res.status}` };
  } catch (err) {
    return { cancelled: 0, ok: false, reason: String(err).slice(0, 200) };
  }
}

// ── P2 #8: reconcile Alpaca fills back into trades table ────────────────────
// Find every SELL/sell-side fill that Alpaca has recorded today but that does
// NOT yet have a matching `alpaca_order_id` in our trades table. These are
// almost always bracket-stop fills that the bot did not orchestrate directly.
//
// Pure function so it can be unit-tested without hitting Alpaca or Supabase.

export interface AlpacaOrderLike {
  id: string;
  symbol: string;
  side: string;             // "buy" | "sell"
  status: string;           // expect "filled"
  filled_qty?: string | null;
  filled_avg_price?: string | null;
  filled_at?: string | null;
}

export interface TradeRowLike {
  alpaca_order_id?: string | null;
  symbol?: string | null;
  action?: string | null;
}

export interface ReconcileMatch {
  symbol: string;
  qty: number;
  fillPrice: number;
  alpacaOrderId: string;
  filledAt: string | null;
}

// Given a list of Alpaca orders and the SELL/PROFIT_TAKE rows already in
// public.trades for today, return the SELL-side orders that are missing.
//
// "Missing" = no row in the trades table whose alpaca_order_id matches the
// Alpaca order id. Symbol+timestamp matching is intentionally NOT used — we
// allow Alpaca's order id to be the single dedup key, because two different
// fills (e.g. partial fills 30s apart) can both be legitimate trade rows.
export function findUnreconciledFills(
  alpacaOrders: AlpacaOrderLike[],
  knownTradeRows: TradeRowLike[],
): ReconcileMatch[] {
  const knownIds = new Set<string>();
  for (const row of knownTradeRows) {
    if (row?.alpaca_order_id) knownIds.add(row.alpaca_order_id);
  }
  const out: ReconcileMatch[] = [];
  for (const order of alpacaOrders) {
    if (!order?.id || !order?.symbol) continue;
    if (order.side !== "sell") continue;
    if (order.status !== "filled") continue;
    if (knownIds.has(order.id)) continue;
    const qty = parseInt(String(order.filled_qty ?? "0"));
    const fillPrice = parseFloat(String(order.filled_avg_price ?? "0"));
    if (!Number.isFinite(qty) || qty <= 0) continue;
    if (!Number.isFinite(fillPrice) || fillPrice <= 0) continue;
    out.push({
      symbol: order.symbol,
      qty,
      fillPrice,
      alpacaOrderId: order.id,
      filledAt: order.filled_at ?? null,
    });
  }
  return out;
}

// Build the reason string the reconciliation pass will write into the trades
// table. The string makes it obvious in the UI that this row was synthesized
// from Alpaca's order history rather than directly orchestrated by the bot.
export function buildReconcileReason(filledAt: string | null): string {
  const tag = filledAt ? ` at ${filledAt}` : "";
  return `🔁 Reconciled from Alpaca order history${tag}: external close (likely bracket stop, nuclear cron, or manual)`;
}
