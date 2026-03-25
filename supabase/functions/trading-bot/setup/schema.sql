-- ══════════════════════════════════════════════════════════════════════════════
-- Trading Bot Database Schema
-- Run this in the Supabase SQL Editor to set up all required tables.
-- ══════════════════════════════════════════════════════════════════════════════

-- 1. Trades (core trade log)
CREATE TABLE IF NOT EXISTS trades (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now() NOT NULL,
  symbol text,
  action text NOT NULL,
  quantity numeric,
  price_entry numeric,
  price_exit numeric,
  pnl numeric,
  reason text,
  alpaca_order_id text,
  status text DEFAULT 'open' NOT NULL
);

ALTER TABLE trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow service role full access on trades"
  ON trades FOR ALL USING (true) WITH CHECK (true);

-- 2. Portfolio Snapshots (equity tracking for dashboard)
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now() NOT NULL,
  cash numeric NOT NULL,
  equity numeric NOT NULL,
  positions jsonb
);

ALTER TABLE portfolio_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow service role full access on portfolio_snapshots"
  ON portfolio_snapshots FOR ALL USING (true) WITH CHECK (true);

-- 3. Performance Metrics (per-cycle stats)
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

ALTER TABLE performance_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow service role full access on performance_metrics"
  ON performance_metrics FOR ALL USING (true) WITH CHECK (true);

-- 4. Bot Analyses (Grok AI analysis log)
CREATE TABLE IF NOT EXISTS bot_analyses (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now() NOT NULL,
  trade_count integer NOT NULL,
  analysis text NOT NULL,
  trades_ref jsonb,
  type text DEFAULT 'analysis' NOT NULL CHECK (type = ANY (ARRAY['analysis', 'weekly_summary']))
);

ALTER TABLE bot_analyses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow service role full access on bot_analyses"
  ON bot_analyses FOR ALL USING (true) WITH CHECK (true);

-- 5. Bot Run Lock (prevents concurrent cycles)
CREATE TABLE IF NOT EXISTS bot_run_lock (
  id integer DEFAULT 1 PRIMARY KEY,
  is_running boolean DEFAULT false,
  locked_at timestamptz
);

INSERT INTO bot_run_lock (id, is_running) VALUES (1, false)
ON CONFLICT (id) DO NOTHING;

-- 6. Bot Runs (legacy lock table, kept for compatibility)
CREATE TABLE IF NOT EXISTS bot_runs (
  id integer DEFAULT 1 PRIMARY KEY CHECK (id = 1),
  is_running boolean DEFAULT false,
  started_at timestamptz
);

INSERT INTO bot_runs (id, is_running) VALUES (1, false)
ON CONFLICT (id) DO NOTHING;

-- 7. Massive Signals (Polygon.io / Massive Market Data pipeline)
CREATE TABLE IF NOT EXISTS massive_signals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  symbol text NOT NULL,
  signal_type text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  score numeric,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_massive_signals_symbol_type
  ON massive_signals (symbol, signal_type);
CREATE INDEX IF NOT EXISTS idx_massive_signals_created
  ON massive_signals (created_at DESC);

ALTER TABLE massive_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow service role full access on massive_signals"
  ON massive_signals FOR ALL USING (true) WITH CHECK (true);

-- Auto-cleanup: delete massive_signals older than 48 hours
CREATE OR REPLACE FUNCTION cleanup_old_massive_signals() RETURNS trigger AS $$
BEGIN
  DELETE FROM massive_signals WHERE created_at < NOW() - INTERVAL '48 hours';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_cleanup_massive ON massive_signals;
CREATE TRIGGER trigger_cleanup_massive
  AFTER INSERT ON massive_signals
  FOR EACH STATEMENT EXECUTE FUNCTION cleanup_old_massive_signals();

-- 8. BigData Signals (RavenPack pipeline: analysts, VIX, macro, etc.)
CREATE TABLE IF NOT EXISTS bigdata_signals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  symbol text NOT NULL,
  signal_type text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  score numeric,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bigdata_signals_symbol_type
  ON bigdata_signals (symbol, signal_type);
CREATE INDEX IF NOT EXISTS idx_bigdata_signals_created
  ON bigdata_signals (created_at DESC);

ALTER TABLE bigdata_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow service role full access on bigdata_signals"
  ON bigdata_signals FOR ALL USING (true) WITH CHECK (true);

-- Auto-cleanup: delete bigdata_signals older than 48 hours
CREATE OR REPLACE FUNCTION cleanup_old_bigdata_signals() RETURNS trigger AS $$
BEGIN
  DELETE FROM bigdata_signals WHERE created_at < NOW() - INTERVAL '48 hours';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_cleanup_bigdata ON bigdata_signals;
CREATE TRIGGER trigger_cleanup_bigdata
  AFTER INSERT ON bigdata_signals
  FOR EACH STATEMENT EXECUTE FUNCTION cleanup_old_bigdata_signals();

-- ══════════════════════════════════════════════════════════════════════════════
-- Enable pg_cron and pg_net extensions (needed for scheduled bot invocation)
-- ══════════════════════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ══════════════════════════════════════════════════════════════════════════════
-- Done! Your database is ready for the trading bot.
-- Next steps:
--   1. Set your secrets: npx supabase secrets set ALPACA_API_KEY=... etc.
--   2. Deploy: npx supabase functions deploy trading-bot --no-verify-jwt
--   3. Schedule: see README.md for the pg_cron setup command
-- ══════════════════════════════════════════════════════════════════════════════
