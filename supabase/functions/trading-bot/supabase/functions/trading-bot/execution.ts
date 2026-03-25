// ── Alpaca Trading Execution ─────────────────────────────────────────────────

import { ALPACA_BASE_URL, DEFAULT_STOP_LOSS_PCT } from "./config.ts";
import { fetchWithTimeout, withRetry } from "./utils.ts";

// Alpaca auth headers — initialized from env
export const alpacaHeaders = {
  "APCA-API-KEY-ID": Deno.env.get("ALPACA_API_KEY")!,
  "APCA-API-SECRET-KEY": Deno.env.get("ALPACA_SECRET_KEY")!,
  "Content-Type": "application/json",
};

export async function getAccount() {
  const res = await withRetry(() => fetchWithTimeout(`${ALPACA_BASE_URL}/account`, { headers: alpacaHeaders }));
  const data = await res.json();
  if (data?.code || data?.message) throw new Error(`Alpaca account error: ${JSON.stringify(data)}`);
  return data;
}

export async function getPositions() {
  const res = await withRetry(() => fetchWithTimeout(`${ALPACA_BASE_URL}/positions`, { headers: alpacaHeaders }));
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`Alpaca positions error: ${JSON.stringify(data)}`);
  return data;
}

export async function isClock() {
  try {
    const res = await fetchWithTimeout(`${ALPACA_BASE_URL}/clock`, { headers: alpacaHeaders });
    const clock = await res.json();
    return clock.is_open as boolean;
  } catch (err) {
    console.error("isClock() failed — assuming market closed:", err);
    return false;
  }
}

export async function cancelOrdersForSymbol(symbol: string) {
  try {
    const res = await fetchWithTimeout(`${ALPACA_BASE_URL}/orders?status=open&symbols=${symbol}`, {
      headers: alpacaHeaders,
    });
    const openOrders = await res.json();
    if (!Array.isArray(openOrders) || openOrders.length === 0) return;
    console.log(`Cancelling ${openOrders.length} open order(s) for ${symbol} before selling...`);
    for (const order of openOrders) {
      await fetchWithTimeout(`${ALPACA_BASE_URL}/orders/${order.id}`, {
        method: "DELETE",
        headers: alpacaHeaders,
      });
      console.log(`  Cancelled order ${order.id} (${order.type} ${order.side} ${order.qty})`);
    }
    await new Promise(r => setTimeout(r, 1000));
  } catch (err) {
    console.error(`Failed to cancel orders for ${symbol}:`, (err as Error).message);
  }
}

export async function placeOrder(symbol: string, qty: number, side: "buy" | "sell") {
  const res = await withRetry(() => fetchWithTimeout(`${ALPACA_BASE_URL}/orders`, {
    method: "POST",
    headers: alpacaHeaders,
    body: JSON.stringify({
      symbol,
      qty: String(qty),
      side,
      type: "market",
      time_in_force: "day",
    }),
  }));
  return res.json();
}

export async function placeOrderWithStopLoss(
  symbol: string,
  qty: number,
  entryPrice: number,
  stopLossPct = DEFAULT_STOP_LOSS_PCT
) {
  if (!entryPrice || entryPrice <= 0) {
    console.error(`BUY ${symbol} aborted — invalid entry price: $${entryPrice}`);
    return { code: 0, message: `Invalid entry price $${entryPrice}` };
  }

  const clampedPct = Math.max(0.02, Math.min(0.15, stopLossPct));
  const stopPrice = +(entryPrice * (1 - clampedPct)).toFixed(2);

  console.log(`Placing BUY ${qty} ${symbol} @ ~$${entryPrice} with stop-loss at $${stopPrice} (${(clampedPct * 100).toFixed(1)}%)`);

  const res = await withRetry(() => fetchWithTimeout(`${ALPACA_BASE_URL}/orders`, {
    method: "POST",
    headers: alpacaHeaders,
    body: JSON.stringify({
      symbol,
      qty: String(qty),
      side: "buy",
      type: "market",
      time_in_force: "gtc",
      order_class: "oto",
      stop_loss: {
        stop_price: String(stopPrice),
      },
    }),
  }));

  const data = await res.json();

  if (data?.code || data?.message?.includes?.("error")) {
    console.warn(`OTO order failed for ${symbol}: ${JSON.stringify(data).slice(0, 200)} — falling back to simple market buy`);
    const fallbackRes = await withRetry(() => fetchWithTimeout(`${ALPACA_BASE_URL}/orders`, {
      method: "POST",
      headers: alpacaHeaders,
      body: JSON.stringify({
        symbol,
        qty: String(qty),
        side: "buy",
        type: "market",
        time_in_force: "day",
      }),
    }));
    const fallbackData = await fallbackRes.json();
    if (fallbackData?.id) {
      console.log(`✅ Fallback market buy succeeded for ${symbol} (no stop-loss attached — profit-taking will manage exits)`);
    }
    return fallbackData;
  }

  return data;
}
