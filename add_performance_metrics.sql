-- Migration: Add performance_metrics table for P2 tracking
-- Run: npx supabase db push (or add to supabase/migrations/)

CREATE TABLE IF NOT EXISTS performance_metrics (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  cycle_count integer NOT NULL,

  -- Core performance
  equity numeric NOT NULL,
  cash numeric NOT NULL,
  total_pnl_realized numeric,           -- sum of all closed trade PnL
  total_pnl_unrealized numeric,         -- sum of open position PnL

  -- Win/loss stats
  total_trades integer DEFAULT 0,
  winning_trades integer DEFAULT 0,
  losing_trades integer DEFAULT 0,
  win_rate numeric,                     -- winning / total (0-1)
  avg_win numeric,                      -- average profit on winning trades
  avg_loss numeric,                     -- average loss on losing trades
  profit_factor numeric,               -- gross profit / gross loss

  -- Risk metrics
  max_drawdown_pct numeric,            -- worst peak-to-trough decline (0-1)
  current_drawdown_pct numeric,        -- current drawdown from peak
  sharpe_ratio numeric,                -- risk-adjusted return (annualized)

  -- Position stats
  open_positions integer DEFAULT 0,
  avg_hold_duration_minutes integer,   -- average time from BUY to SELL

  -- Streak tracking
  current_streak integer DEFAULT 0,    -- positive = win streak, negative = loss streak
  longest_win_streak integer DEFAULT 0,
  longest_loss_streak integer DEFAULT 0
);

-- Index for fast lookups by cycle
CREATE INDEX IF NOT EXISTS idx_perf_metrics_cycle ON performance_metrics(cycle_count DESC);
CREATE INDEX IF NOT EXISTS idx_perf_metrics_created ON performance_metrics(created_at DESC);
