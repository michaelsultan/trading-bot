// ── Shared Utilities ─────────────────────────────────────────────────────────

import type { TradingMode } from "./types.ts";

// Fetch with timeout — every fetch gets an 8-second timeout to prevent hanging
export function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Retry with exponential backoff
export async function withRetry<T>(fn: () => Promise<T>, retries = 2, delayMs = 500): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (err) {
      if (i === retries - 1) throw err;
      console.warn(`Retry ${i + 1}/${retries} after error:`, String(err));
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw new Error("unreachable");
}

// Validation
export function isValidSymbol(s: unknown): s is string {
  return typeof s === "string" && /^[A-Z]{1,5}$/.test(s);
}

export function isValidQuantity(q: unknown): q is number {
  return typeof q === "number" && Number.isInteger(q) && q > 0 && q < 1_000_000;
}

// JSON extraction from LLM responses
export function extractJson(content: string): unknown {
  try { return JSON.parse(content); } catch { /* continue */ }
  const stripped = content.replace(/^```(?:json)?\s*/im, "").replace(/\s*```\s*$/im, "").trim();
  try { return JSON.parse(stripped); } catch { /* continue */ }
  const arr = content.match(/\[[\s\S]*\]/);
  if (arr) { try { return JSON.parse(arr[0]); } catch { /* continue */ } }
  const obj = content.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch { /* continue */ } }
  throw new Error("No valid JSON found in Grok response");
}

// Math helpers
export function sma(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function ema(prices: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    result.push(prices[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

// Trading mode based on market phase (ET timezone)
export function getCurrentTradingMode(): { mode: TradingMode; label: string } {
  const now = new Date();
  const etStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const et = new Date(etStr);
  const etHour = et.getHours();
  const etMin = et.getMinutes();
  const etTime = etHour + etMin / 60;

  if (etTime >= 9.5 && etTime < 10.25) {
    return { mode: "SCALP", label: "🔥 SCALP MODE — Open Rush (9:30-10:15 ET)" };
  }
  if (etTime >= 15.25 && etTime < 16) {
    return { mode: "SCALP", label: "🔥 SCALP MODE — Power Hour (3:15-4:00 ET)" };
  }
  return { mode: "MOMENTUM", label: "📈 MOMENTUM MODE — Ride trends" };
}

// Week deadline calculations
export function getCurrentWeekDeadline(): Date {
  const now = new Date();
  const etStr = now.toLocaleString("en-US", { timeZone: "America/New_York" });
  const etNow = new Date(etStr);
  const etDay = etNow.getDay();
  const daysUntilFriday = ((5 - etDay) + 7) % 7;
  const friday = new Date(now);
  friday.setTime(now.getTime() + daysUntilFriday * 24 * 60 * 60 * 1000);
  const fridayEtStr = friday.toLocaleString("en-US", { timeZone: "America/New_York" });
  const fridayEt = new Date(fridayEtStr);
  fridayEt.setHours(16, 0, 0, 0);
  const etOffset = friday.getTime() - new Date(fridayEtStr).getTime();
  const deadline = new Date(fridayEt.getTime() + etOffset);
  if (deadline <= now) deadline.setTime(deadline.getTime() + 7 * 24 * 60 * 60 * 1000);
  return deadline;
}

export function estimateRemainingCycles(now: Date, deadline: Date): number {
  let remaining = 0;
  const cursor = new Date(now);
  while (cursor < deadline) {
    const etStr = cursor.toLocaleString("en-US", { timeZone: "America/New_York" });
    const et = new Date(etStr);
    const day = et.getDay();
    if (day !== 0 && day !== 6) {
      const etMinutes = et.getHours() * 60 + et.getMinutes();
      if (etMinutes >= 570 && etMinutes < 960) remaining += 10;
    }
    cursor.setTime(cursor.getTime() + 10 * 60 * 1000);
  }
  return Math.floor(remaining / 10);
}

export function isLastCycleOfWeek(now: Date, deadline: Date): boolean {
  const etDay = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" })).getDay();
  return etDay === 5 && (deadline.getTime() - now.getTime()) < 60 * 60 * 1000;
}

// Get current ET time components
export function getETTime(): { etHour: number; etMin: number } {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return { etHour: et.getHours(), etMin: et.getMinutes() };
}
