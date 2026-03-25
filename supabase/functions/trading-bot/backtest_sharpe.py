#!/usr/bin/env python3
"""
Sharpe Ratio Optimizer — Tests multiple config variants to maximize Sharpe.
Fetches data once, then runs all configs against the same data.

Sharpe = (mean_daily_return - risk_free) / std(daily_returns) * sqrt(252)

To increase Sharpe: reduce daily return variance (smaller losses, consistent wins).
"""

import os, json, math, datetime, warnings
from collections import defaultdict
import numpy as np
import pandas as pd
warnings.filterwarnings('ignore')

# ── DATA FETCHING (Yahoo Finance) ────────────────────────────────────────────
import urllib.request, urllib.error, time as _time

def fetch_bars(symbol, start, end):
    start_ts = int(datetime.datetime.combine(datetime.date.fromisoformat(start), datetime.time()).timestamp())
    end_ts = int(datetime.datetime.combine(datetime.date.fromisoformat(end), datetime.time(23, 59, 59)).timestamp())
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?period1={start_ts}&period2={end_ts}&interval=1d"
    headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
            result = data.get("chart", {}).get("result", [])
            if not result:
                return pd.DataFrame()
            timestamps = result[0].get("timestamp", [])
            quote = result[0].get("indicators", {}).get("quote", [{}])[0]
            if not timestamps or not quote:
                return pd.DataFrame()
            df = pd.DataFrame({
                'date': pd.to_datetime(timestamps, unit='s'),
                'open': quote.get('open', []),
                'high': quote.get('high', []),
                'low': quote.get('low', []),
                'close': quote.get('close', []),
                'volume': quote.get('volume', []),
            })
            df = df.dropna(subset=['close'])
            df = df.set_index('date').sort_index()
            return df[['open', 'high', 'low', 'close', 'volume']]
    except Exception as e:
        return pd.DataFrame()

# ── TECHNICAL INDICATORS ─────────────────────────────────────────────────────
def compute_rsi(series, period=14):
    delta = series.diff()
    gain = delta.where(delta > 0, 0.0)
    loss = -delta.where(delta < 0, 0.0)
    avg_gain = gain.rolling(window=period, min_periods=period).mean()
    avg_loss = loss.rolling(window=period, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))

def compute_macd(series, fast=12, slow=26, signal=9):
    ema_fast = series.ewm(span=fast, adjust=False).mean()
    ema_slow = series.ewm(span=slow, adjust=False).mean()
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    return macd_line, signal_line, macd_line - signal_line

def compute_atr(high, low, close, period=14):
    tr1 = high - low
    tr2 = abs(high - close.shift(1))
    tr3 = abs(low - close.shift(1))
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    return tr.rolling(window=period, min_periods=period).mean()

def compute_sma(series, period):
    return series.rolling(window=period, min_periods=period).mean()

def compute_volume_ratio(volume, period=20):
    avg_vol = volume.rolling(window=period, min_periods=period).mean()
    return volume / avg_vol.replace(0, np.nan)

# ── QUANT SCORE ──────────────────────────────────────────────────────────────
def quant_score(row):
    score = 0
    change_pct = row.get('change_pct', 0)
    abs_change = abs(change_pct)
    if change_pct > 0:
        if 1 <= abs_change <= 5:
            score += min(25, abs_change * 5)
        elif abs_change > 5:
            score += 15
        else:
            score += abs_change * 8
    elif change_pct < -3 and row.get('rsi', 50) < 35:
        score += 15
    vol_ratio = row.get('volume_ratio', 1)
    if vol_ratio > 3: score += 20
    elif vol_ratio > 2: score += 15
    elif vol_ratio > 1.5: score += 10
    elif vol_ratio > 1: score += 5
    rsi = row.get('rsi', 50)
    if 40 <= rsi <= 65: score += 15
    elif rsi < 30: score += 12
    elif 30 <= rsi < 40: score += 8
    elif 65 < rsi <= 75: score += 5
    macd_hist = row.get('macd_hist', 0)
    macd_val = row.get('macd', 0)
    if macd_hist > 0 and macd_val > 0: score += 10
    elif macd_hist > 0: score += 5
    price = row.get('close', 0)
    sma20 = row.get('sma20', 0)
    sma50 = row.get('sma50', 0)
    if sma20 and sma50 and price > sma20 > sma50: score += 3
    if price < 5 or price > 500: score = 0
    return min(100, max(0, score))

# ── CONFIG VARIANTS ──────────────────────────────────────────────────────────
CONFIGS = {
    "BASELINE (current)": {
        "MAX_POSITION_PCT": 0.20,
        "MAX_POSITIONS": 6,
        "MIN_SCORE": 30,
        "STOP_LOSS_PCT": 0.025,
        "SCALP_TARGET_PCT": 0.008,
        "MIN_VOLUME_RATIO": 1.0,
        "MAX_GAP_PCT": 0.04,
        "MIN_RSI": 20,
        "MAX_RSI": 70,
        "MOMENTUM_DAYS": 2,
        "MOMENTUM_PARTIAL_PCT": 0.02,
        "MOMENTUM_FULL_PCT": 0.04,
        "TRAIL_TRIGGER_PCT": 0.008,
        "TRAIL_STOP_PCT": 0.012,
        "SCALP_ATR_MULT": 0.8,
        "PARTIAL_ATR_MULT": 1.5,
        "FULL_ATR_MULT": 3.0,
    },
    "A: Aggressive Size + More Slots": {
        # Bigger bets + more concurrent = more capital at work
        "MAX_POSITION_PCT": 0.25,     # 25% per position (was 20%) — bigger bets
        "MAX_POSITIONS": 8,           # 8 positions (was 6) — more capital deployed
        "MIN_SCORE": 25,              # looser entry — more trades
        "STOP_LOSS_PCT": 0.025,       # keep 2.5% stop
        "SCALP_TARGET_PCT": 0.008,    # keep 0.8% scalp
        "MIN_VOLUME_RATIO": 0.8,      # looser volume filter
        "MAX_GAP_PCT": 0.05,          # allow bigger gaps
        "MIN_RSI": 15,                # wider RSI
        "MAX_RSI": 75,                # wider RSI
        "MOMENTUM_DAYS": 2,
        "MOMENTUM_PARTIAL_PCT": 0.02,
        "MOMENTUM_FULL_PCT": 0.04,
        "TRAIL_TRIGGER_PCT": 0.008,
        "TRAIL_STOP_PCT": 0.012,
        "SCALP_ATR_MULT": 0.8,
        "PARTIAL_ATR_MULT": 1.5,
        "FULL_ATR_MULT": 3.0,
    },
    "B: Let Winners Run": {
        # Wider profit targets — capture full moves instead of scalping
        "MAX_POSITION_PCT": 0.22,
        "MAX_POSITIONS": 7,
        "MIN_SCORE": 30,
        "STOP_LOSS_PCT": 0.02,        # slightly tighter stop
        "SCALP_TARGET_PCT": 0.015,    # 1.5% scalp (was 0.8%) — don't exit too early
        "MIN_VOLUME_RATIO": 1.0,
        "MAX_GAP_PCT": 0.04,
        "MIN_RSI": 20,
        "MAX_RSI": 70,
        "MOMENTUM_DAYS": 2,
        "MOMENTUM_PARTIAL_PCT": 0.03,  # 3% partial (was 2%)
        "MOMENTUM_FULL_PCT": 0.06,    # 6% full (was 4%) — let big winners ride
        "TRAIL_TRIGGER_PCT": 0.012,   # trail later — give room to breathe
        "TRAIL_STOP_PCT": 0.015,      # wider trail
        "SCALP_ATR_MULT": 1.2,        # bigger ATR multipliers
        "PARTIAL_ATR_MULT": 2.0,
        "FULL_ATR_MULT": 4.0,
    },
    "C: Max Trades + Fast Compound": {
        # Maximum number of trades — compound small gains rapidly
        "MAX_POSITION_PCT": 0.18,
        "MAX_POSITIONS": 8,
        "MIN_SCORE": 20,              # very low bar — take everything
        "STOP_LOSS_PCT": 0.02,        # 2% stop — cut losers fast
        "SCALP_TARGET_PCT": 0.006,    # 0.6% scalp — quick wins
        "MIN_VOLUME_RATIO": 0.8,      # very loose
        "MAX_GAP_PCT": 0.05,
        "MIN_RSI": 15,
        "MAX_RSI": 80,                # almost no RSI filter
        "MOMENTUM_DAYS": 2,
        "MOMENTUM_PARTIAL_PCT": 0.015,
        "MOMENTUM_FULL_PCT": 0.03,
        "TRAIL_TRIGGER_PCT": 0.006,
        "TRAIL_STOP_PCT": 0.01,
        "SCALP_ATR_MULT": 0.5,
        "PARTIAL_ATR_MULT": 1.2,
        "FULL_ATR_MULT": 2.5,
    },
    "D: Hybrid (Big + Selective)": {
        # Big positions but only on the best setups — quality over quantity
        "MAX_POSITION_PCT": 0.30,     # 30% per position — big bets
        "MAX_POSITIONS": 5,           # fewer but larger
        "MIN_SCORE": 40,              # higher conviction only
        "STOP_LOSS_PCT": 0.02,        # 2% stop
        "SCALP_TARGET_PCT": 0.01,     # 1% scalp — let it breathe
        "MIN_VOLUME_RATIO": 1.2,      # require above-avg volume
        "MAX_GAP_PCT": 0.03,
        "MIN_RSI": 25,
        "MAX_RSI": 65,
        "MOMENTUM_DAYS": 2,
        "MOMENTUM_PARTIAL_PCT": 0.025,
        "MOMENTUM_FULL_PCT": 0.05,    # 5% full target
        "TRAIL_TRIGGER_PCT": 0.01,
        "TRAIL_STOP_PCT": 0.012,
        "SCALP_ATR_MULT": 1.0,
        "PARTIAL_ATR_MULT": 1.8,
        "FULL_ATR_MULT": 3.5,
    },
    "E: Kitchen Sink (Aggressive Everything)": {
        # Max aggression — big size, many slots, loose filters, wide targets
        "MAX_POSITION_PCT": 0.25,
        "MAX_POSITIONS": 8,
        "MIN_SCORE": 25,
        "STOP_LOSS_PCT": 0.02,
        "SCALP_TARGET_PCT": 0.01,     # 1% scalp — don't leave too early
        "MIN_VOLUME_RATIO": 0.8,
        "MAX_GAP_PCT": 0.05,
        "MIN_RSI": 15,
        "MAX_RSI": 75,
        "MOMENTUM_DAYS": 2,
        "MOMENTUM_PARTIAL_PCT": 0.025,
        "MOMENTUM_FULL_PCT": 0.05,
        "TRAIL_TRIGGER_PCT": 0.01,
        "TRAIL_STOP_PCT": 0.012,
        "SCALP_ATR_MULT": 1.0,
        "PARTIAL_ATR_MULT": 1.8,
        "FULL_ATR_MULT": 3.5,
    },
}

# ── UNIVERSE & PERIOD ────────────────────────────────────────────────────────
UNIVERSE = [
    "NVDA", "TSLA", "AMD", "AMZN", "META", "NFLX", "GOOGL", "AAPL", "MSFT",
    "COIN", "PLTR", "SOFI", "RIVN", "MARA", "SHOP", "ROKU", "SNAP",
    "SPY", "QQQ", "BA", "PYPL", "UBER", "ABNB", "CRWD", "PANW",
]
INITIAL_EQUITY = 100_000
MONTHS_BACK = 6
END_DATE = datetime.date.today()
START_DATE = END_DATE - datetime.timedelta(days=MONTHS_BACK * 30)

# ── POSITION & BACKTEST ENGINE ───────────────────────────────────────────────
class Position:
    def __init__(self, symbol, entry_price, quantity, entry_date):
        self.symbol = symbol
        self.entry_price = entry_price
        self.quantity = quantity
        self.entry_date = entry_date
        self.partial_sold = False
        self.high_water = entry_price

class Backtest:
    def __init__(self, initial_equity):
        self.cash = initial_equity
        self.initial_equity = initial_equity
        self.positions = {}
        self.trades = []
        self.equity_curve = []
        self.wins = 0
        self.losses = 0
        self.total_trades = 0

    def buy(self, symbol, price, date, score, cfg):
        if symbol in self.positions or len(self.positions) >= cfg["MAX_POSITIONS"]:
            return
        target_value = min(self.cash * 0.95, self.cash * cfg["MAX_POSITION_PCT"])
        if target_value < price:
            return
        quantity = max(1, int(target_value / price))
        cost = quantity * price
        if cost > self.cash:
            quantity = int(self.cash * 0.95 / price)
            cost = quantity * price
        if quantity <= 0 or cost > self.cash:
            return
        self.cash -= cost
        self.positions[symbol] = Position(symbol, price, quantity, date)

    def sell(self, symbol, price, date, reason, qty_pct=1.0):
        if symbol not in self.positions:
            return
        pos = self.positions[symbol]
        sell_qty = max(1, int(pos.quantity * qty_pct))
        if sell_qty >= pos.quantity:
            sell_qty = pos.quantity
            del self.positions[symbol]
        else:
            pos.quantity -= sell_qty
            pos.partial_sold = True
        proceeds = sell_qty * price
        self.cash += proceeds
        pnl = (price - pos.entry_price) * sell_qty
        pnl_pct = pnl / (pos.entry_price * sell_qty) if pos.entry_price > 0 else 0
        self.total_trades += 1
        if pnl > 0:
            self.wins += 1
        else:
            self.losses += 1
        self.trades.append({
            'date': date, 'symbol': symbol, 'reason': reason,
            'entry': pos.entry_price, 'exit': price, 'qty': sell_qty,
            'pnl': pnl, 'pnl_pct': pnl_pct,
        })

    def flatten_all(self, prices, date):
        for sym in list(self.positions.keys()):
            price = prices.get(sym, self.positions[sym].entry_price)
            self.sell(sym, price, date, "EOD flatten")

# ── RUN ONE CONFIG ───────────────────────────────────────────────────────────
def run_config(name, cfg, all_data, trading_dates):
    bt = Backtest(INITIAL_EQUITY)
    daily_returns = []
    prev_equity = INITIAL_EQUITY

    for date in trading_dates:
        today_data = {}
        prev_scores = {}
        prev_vol_ratios = {}
        prev_rsi_values = {}
        prev_closes = {}
        multi_day_mom = {}

        for sym, df in all_data.items():
            mask = df.index.date == date
            if not mask.any():
                continue
            row = df[mask].iloc[-1]
            today_data[sym] = {
                'open': row['open'], 'high': row['high'],
                'low': row['low'], 'close': row['close'],
            }
            prev_mask = df.index.date < date
            if prev_mask.any():
                prev_row = df[prev_mask].iloc[-1]
                if not pd.isna(prev_row.get('rsi')) and not pd.isna(prev_row.get('macd_hist')):
                    prev_scores[sym] = quant_score(prev_row)
                    prev_vol_ratios[sym] = prev_row.get('volume_ratio', 1.0)
                    prev_rsi_values[sym] = prev_row.get('rsi', 50)
                    prev_closes[sym] = prev_row.get('close', 0)
                prev_rows = df[prev_mask].tail(cfg["MOMENTUM_DAYS"])
                if len(prev_rows) >= cfg["MOMENTUM_DAYS"]:
                    changes = prev_rows['close'].pct_change().dropna()
                    multi_day_mom[sym] = (changes > 0).sum() >= 1
                else:
                    multi_day_mom[sym] = False

        if not today_data:
            continue

        # BUY at open
        ranked = sorted(prev_scores.items(), key=lambda x: x[1], reverse=True)
        for sym, score in ranked:
            if len(bt.positions) >= cfg["MAX_POSITIONS"]:
                break
            if score < cfg["MIN_SCORE"] or sym not in today_data:
                continue
            if prev_vol_ratios.get(sym, 1.0) < cfg["MIN_VOLUME_RATIO"]:
                continue
            rsi = prev_rsi_values.get(sym, 50)
            if rsi < cfg["MIN_RSI"] or rsi > cfg["MAX_RSI"]:
                continue
            prev_close = prev_closes.get(sym, 0)
            if prev_close > 0:
                gap_pct = (today_data[sym]['open'] - prev_close) / prev_close
                if gap_pct > cfg["MAX_GAP_PCT"]:
                    continue
            if not multi_day_mom.get(sym, False):
                continue
            bt.buy(sym, today_data[sym]['open'], date, score, cfg)

        # INTRADAY management
        for sym in list(bt.positions.keys()):
            if sym not in today_data:
                continue
            pos = bt.positions[sym]
            td = today_data[sym]
            pos.high_water = max(pos.high_water, td['high'])

            atr_pct = 0.02
            sym_df = all_data.get(sym)
            if sym_df is not None:
                pm = sym_df.index.date <= date
                if pm.any():
                    atr_val = sym_df[pm].iloc[-1].get('atr')
                    if atr_val and pos.entry_price > 0:
                        atr_pct = atr_val / pos.entry_price

            scalp_target = max(cfg["SCALP_TARGET_PCT"], atr_pct * cfg["SCALP_ATR_MULT"])
            momentum_partial = max(cfg["MOMENTUM_PARTIAL_PCT"], atr_pct * cfg["PARTIAL_ATR_MULT"])
            momentum_full = max(cfg["MOMENTUM_FULL_PCT"], atr_pct * cfg["FULL_ATR_MULT"])

            # Trailing stop
            gain_from_entry = (pos.high_water - pos.entry_price) / pos.entry_price
            if gain_from_entry > cfg["TRAIL_TRIGGER_PCT"]:
                trail_stop = pos.high_water * (1 - cfg["TRAIL_STOP_PCT"])
                if td['low'] <= trail_stop:
                    bt.sell(sym, trail_stop, date, "Trail stop")
                    continue

            # Fixed stop-loss
            low_pnl = (td['low'] - pos.entry_price) / pos.entry_price
            if low_pnl <= -cfg["STOP_LOSS_PCT"]:
                stop_price = pos.entry_price * (1 - cfg["STOP_LOSS_PCT"])
                bt.sell(sym, stop_price, date, "Stop loss")
                continue

            # Profit targets
            high_pnl = (td['high'] - pos.entry_price) / pos.entry_price
            if high_pnl >= momentum_full:
                bt.sell(sym, pos.entry_price * (1 + momentum_full), date, "Full profit")
                continue
            if high_pnl >= momentum_partial and not pos.partial_sold:
                bt.sell(sym, pos.entry_price * (1 + momentum_partial), date, "Partial profit", qty_pct=0.5)
                continue
            if high_pnl >= scalp_target:
                bt.sell(sym, pos.entry_price * (1 + scalp_target), date, "Scalp exit")
                continue

        # EOD flatten
        close_prices = {sym: td['close'] for sym, td in today_data.items()}
        bt.flatten_all(close_prices, date)

        equity = bt.cash
        bt.equity_curve.append({'date': date, 'equity': equity})
        daily_return = (equity - prev_equity) / prev_equity if prev_equity > 0 else 0
        daily_returns.append(daily_return)
        prev_equity = equity

    # Compute metrics
    final_equity = bt.cash
    total_return = (final_equity - INITIAL_EQUITY) / INITIAL_EQUITY
    dr = np.array(daily_returns)
    trading_days = len(trading_dates)
    ann_return = (1 + total_return) ** (252 / max(trading_days, 1)) - 1

    if len(dr) > 1 and np.std(dr) > 0:
        sharpe = (np.mean(dr) - 0.05/252) / np.std(dr) * np.sqrt(252)
    else:
        sharpe = 0

    equity_series = [e['equity'] for e in bt.equity_curve]
    peak = equity_series[0] if equity_series else INITIAL_EQUITY
    max_dd = 0
    for eq in equity_series:
        peak = max(peak, eq)
        max_dd = max(max_dd, (peak - eq) / peak)

    win_rate = bt.wins / max(bt.total_trades, 1)
    winning = [t for t in bt.trades if t['pnl'] > 0]
    losing = [t for t in bt.trades if t['pnl'] <= 0]
    avg_win = np.mean([t['pnl_pct'] for t in winning]) * 100 if winning else 0
    avg_loss = np.mean([t['pnl_pct'] for t in losing]) * 100 if losing else 0
    gross_profit = sum(t['pnl'] for t in winning) if winning else 0
    gross_loss = abs(sum(t['pnl'] for t in losing)) if losing else 1
    profit_factor = gross_profit / max(gross_loss, 1)
    avg_daily = np.mean(dr) * INITIAL_EQUITY if dr.any() else 0
    daily_std = np.std(dr) * INITIAL_EQUITY if len(dr) > 1 else 0

    # Sortino ratio (downside deviation only)
    downside = dr[dr < 0]
    if len(downside) > 0:
        sortino = (np.mean(dr) - 0.05/252) / np.std(downside) * np.sqrt(252)
    else:
        sortino = float('inf')

    # Calmar ratio (annual return / max drawdown)
    calmar = ann_return / max_dd if max_dd > 0 else float('inf')

    return {
        'name': name,
        'total_return': total_return,
        'ann_return': ann_return,
        'sharpe': sharpe,
        'sortino': sortino,
        'calmar': calmar,
        'max_dd': max_dd,
        'profit_factor': profit_factor,
        'win_rate': win_rate,
        'total_trades': bt.total_trades,
        'avg_win': avg_win,
        'avg_loss': avg_loss,
        'avg_daily_pnl': avg_daily,
        'daily_std': daily_std,
        'final_equity': final_equity,
    }

# ── MAIN ─────────────────────────────────────────────────────────────────────
def main():
    print("=" * 80)
    print("💰 PROFIT MAXIMIZER — Testing configs for maximum returns")
    active_configs = {k: v for k, v in CONFIGS.items() if not v.get("SKIP")}
    print(f"   Testing {len(active_configs)} configurations over {MONTHS_BACK} months")
    print(f"   Universe: {len(UNIVERSE)} stocks | Starting equity: ${INITIAL_EQUITY:,}")
    print("=" * 80)

    # Fetch data once
    print("\n📥 Fetching data (one time for all configs)...")
    all_data = {}
    for i, sym in enumerate(UNIVERSE):
        print(f"  [{i+1}/{len(UNIVERSE)}] {sym}...", end=" ", flush=True)
        df = fetch_bars(sym, str(START_DATE), str(END_DATE))
        if len(df) > 30:
            df['rsi'] = compute_rsi(df['close'])
            df['macd'], df['macd_signal'], df['macd_hist'] = compute_macd(df['close'])
            df['atr'] = compute_atr(df['high'], df['low'], df['close'])
            df['sma20'] = compute_sma(df['close'], 20)
            df['sma50'] = compute_sma(df['close'], 50)
            df['volume_ratio'] = compute_volume_ratio(df['volume'])
            df['change_pct'] = df['close'].pct_change() * 100
            all_data[sym] = df
            print(f"✓ ({len(df)} bars)")
        else:
            print("✗")

    all_dates = sorted(set().union(*[set(df.index.date) for df in all_data.values()]))
    trading_dates = all_dates[50:]
    print(f"\n📊 {len(trading_dates)} trading days | {len(all_data)} symbols loaded\n")

    # Run all configs
    results = []
    for name, cfg in CONFIGS.items():
        if cfg.get("SKIP"):
            continue
        print(f"▶ Running: {name}...")
        r = run_config(name, cfg, all_data, trading_dates)
        results.append(r)
        print(f"  → Return: {r['total_return']*100:+.2f}% | Sharpe: {r['sharpe']:.2f} | "
              f"Win: {r['win_rate']*100:.1f}% | Trades: {r['total_trades']} | "
              f"MaxDD: {r['max_dd']*100:.2f}% | $/day: ${r['avg_daily_pnl']:.0f}")

    # Sort by total return (PROFIT MAXIMIZER)
    results.sort(key=lambda x: x['total_return'], reverse=True)

    # Print comparison table
    print("\n" + "=" * 80)
    print("💰 RESULTS RANKED BY TOTAL PROFIT")
    print("=" * 80)
    print(f"{'Config':<28} {'Return':>8} {'Sharpe':>7} {'Sortino':>8} {'Calmar':>7} {'WinRate':>8} {'Trades':>7} {'MaxDD':>7} {'AvgDly$':>8} {'DlyStd$':>8} {'PF':>5}")
    print("-" * 115)
    for r in results:
        sortino_str = f"{r['sortino']:.2f}" if r['sortino'] < 100 else "∞"
        calmar_str = f"{r['calmar']:.2f}" if r['calmar'] < 100 else "∞"
        print(f"{r['name']:<28} {r['total_return']*100:>+7.2f}% {r['sharpe']:>7.2f} {sortino_str:>8} {calmar_str:>7} {r['win_rate']*100:>7.1f}% {r['total_trades']:>7} {r['max_dd']*100:>6.2f}% ${r['avg_daily_pnl']:>7.0f} ${r['daily_std']:>7.0f} {r['profit_factor']:>5.2f}")

    print("\n" + "-" * 115)
    best = results[0]
    print(f"\n🏆 WINNER: {best['name']}")
    print(f"   Sharpe {best['sharpe']:.2f} | Sortino {best['sortino']:.2f} | "
          f"Return {best['total_return']*100:+.2f}% | Win Rate {best['win_rate']*100:.1f}% | "
          f"Max Drawdown {best['max_dd']*100:.2f}%")
    print(f"   Avg daily P&L: ${best['avg_daily_pnl']:.0f} | Daily std: ${best['daily_std']:.0f}")
    print(f"   Profit Factor: {best['profit_factor']:.2f} | Avg Win: {best['avg_win']:.2f}% | Avg Loss: {best['avg_loss']:.2f}%")

    # Print the winning config values
    winner_name = best['name']
    if winner_name in CONFIGS:
        print(f"\n📋 Winning config values:")
        for k, v in CONFIGS[winner_name].items():
            print(f"   {k}: {v}")

if __name__ == "__main__":
    main()
