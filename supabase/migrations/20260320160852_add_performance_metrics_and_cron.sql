-- ═══════════════════════════════════════════════════════════════════
-- Migration: Add performance_metrics table + update cron schedule
-- ═══════════════════════════════════════════════════════════════════

-- 1. Performance metrics table
CREATE TABLE IF NOT EXISTS performance_metrics (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  cycle_count integer NOT NULL,
  equity numeric NOT NULL,
  cash numeric NOT NULL,
  total_pnl_realized numeric,
  total_pnl_unrealized numeric,
  total_trades integer DEFAULT 0,
  winning_trades integer DEFAULT 0,
  losing_trades integer DEFAULT 0,
  win_rate numeric,
  avg_win numeric,
  avg_loss numeric,
  profit_factor numeric,
  max_drawdown_pct numeric,
  current_drawdown_pct numeric,
  sharpe_ratio numeric,
  open_positions integer DEFAULT 0,
  avg_hold_duration_minutes integer,
  current_streak integer DEFAULT 0,
  longest_win_streak integer DEFAULT 0,
  longest_loss_streak integer DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_perf_metrics_cycle ON performance_metrics(cycle_count DESC);
CREATE INDEX IF NOT EXISTS idx_perf_metrics_created ON performance_metrics(created_at DESC);

-- 2. Enable RLS with read access for anon (dashboard)
ALTER TABLE performance_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon read performance_metrics"
  ON performance_metrics FOR SELECT
  TO anon
  USING (true);

CREATE POLICY "Allow service_role all on performance_metrics"
  ON performance_metrics FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- 3. Done — cron schedule is managed separately via Supabase dashboard
-- (The bot now supports ?mode=scan and ?mode=full URL parameters)
