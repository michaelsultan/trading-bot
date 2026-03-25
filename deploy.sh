#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════
# Trading Bot — One-Shot Deployment Script
# ═══════════════════════════════════════════════════════════════════════
# Run this from your trading-bot repo root:
#   chmod +x deploy.sh && ./deploy.sh
#
# Prerequisites:
#   - Supabase CLI installed (npx supabase)
#   - Repo cloned: git clone https://github.com/edprojet/trading-bot
#   - Project linked: npx supabase link --project-ref YOUR_PROJECT_REF
# ═══════════════════════════════════════════════════════════════════════

set -e  # Exit on any error

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  Trading Bot — Deployment${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
echo ""

# ── Check we're in the right directory ──────────────────────────────
if [ ! -d "supabase/functions/trading-bot" ]; then
  echo -e "${RED}ERROR: Run this from your trading-bot repo root.${NC}"
  echo "  Expected: supabase/functions/trading-bot/ to exist"
  echo "  Current dir: $(pwd)"
  exit 1
fi

echo -e "${GREEN}✓${NC} Repo structure detected"

# ── Check Supabase CLI ──────────────────────────────────────────────
if ! command -v npx &> /dev/null; then
  echo -e "${RED}ERROR: npx not found. Install Node.js first.${NC}"
  exit 1
fi

echo -e "${GREEN}✓${NC} npx available"

# ── Step 1: Copy updated bot code ──────────────────────────────────
echo ""
echo -e "${YELLOW}Step 1/4: Updating bot code...${NC}"

# Check if the new index.ts is in the same directory as this script
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/index.ts" ]; then
  cp "$SCRIPT_DIR/index.ts" supabase/functions/trading-bot/index.ts
  echo -e "${GREEN}✓${NC} Copied updated index.ts from deploy folder"
else
  echo -e "${RED}ERROR: index.ts not found next to deploy.sh${NC}"
  echo "  Expected: $SCRIPT_DIR/index.ts"
  echo "  Make sure index.ts and deploy.sh are in the same folder."
  exit 1
fi

# ── Step 2: Copy dashboard ─────────────────────────────────────────
echo ""
echo -e "${YELLOW}Step 2/4: Updating dashboard...${NC}"

mkdir -p dashboard
if [ -f "$SCRIPT_DIR/dashboard.html" ]; then
  cp "$SCRIPT_DIR/dashboard.html" dashboard/index.html
  echo -e "${GREEN}✓${NC} Copied updated dashboard.html → dashboard/index.html"
else
  echo -e "${YELLOW}⚠${NC}  dashboard.html not found, skipping dashboard update"
fi

# ── Step 3: Create new migration ───────────────────────────────────
echo ""
echo -e "${YELLOW}Step 3/4: Creating database migration...${NC}"

TIMESTAMP=$(date -u +"%Y%m%d%H%M%S")
MIGRATION_FILE="supabase/migrations/${TIMESTAMP}_add_performance_metrics_and_cron.sql"

cat > "$MIGRATION_FILE" << 'MIGRATION_SQL'
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
MIGRATION_SQL

echo -e "${GREEN}✓${NC} Created migration: $MIGRATION_FILE"

# ── Step 4: Deploy ─────────────────────────────────────────────────
echo ""
echo -e "${YELLOW}Step 4/4: Deploying to Supabase...${NC}"
echo ""

# Push database migration
echo -e "  ${CYAN}→ Pushing database migration...${NC}"
npx supabase db push
echo -e "  ${GREEN}✓${NC} Database updated"

# Deploy edge function
echo -e "  ${CYAN}→ Deploying trading-bot function...${NC}"
npx supabase functions deploy trading-bot --no-verify-jwt
echo -e "  ${GREEN}✓${NC} trading-bot deployed"

# ── Done ───────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  DEPLOYED SUCCESSFULLY!${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${CYAN}Next steps:${NC}"
echo ""
echo -e "  1. Set your BOT_SECRET env var (if not already set):"
echo -e "     ${YELLOW}npx supabase secrets set BOT_SECRET=your-secret-here${NC}"
echo ""
echo -e "  2. Update the cron schedule in Supabase Dashboard → SQL Editor:"
echo -e "     • Go to your Supabase project → SQL Editor"
echo -e "     • Remove old cron job:  SELECT cron.unschedule('trading-bot-cycle');"
echo -e "     • Add fast scan (every 5 min):"
echo -e "       ${YELLOW}SELECT cron.schedule('trading-bot-scan', '*/5 * * * 1-5',"
echo -e "         \$\$SELECT net.http_post("
echo -e "           url := 'https://YOUR_PROJECT.supabase.co/functions/v1/trading-bot?mode=scan',"
echo -e "           headers := jsonb_build_object('Authorization','Bearer YOUR_BOT_SECRET','Content-Type','application/json'),"
echo -e "           body := '{}'::jsonb);\$\$);${NC}"
echo -e "     • Add full cycle (every 30 min):"
echo -e "       ${YELLOW}SELECT cron.schedule('trading-bot-full', '*/30 * * * 1-5',"
echo -e "         \$\$SELECT net.http_post("
echo -e "           url := 'https://YOUR_PROJECT.supabase.co/functions/v1/trading-bot?mode=full',"
echo -e "           headers := jsonb_build_object('Authorization','Bearer YOUR_BOT_SECRET','Content-Type','application/json'),"
echo -e "           body := '{}'::jsonb);\$\$);${NC}"
echo ""
echo -e "  3. Test the bot manually:"
echo -e "     ${YELLOW}curl -X POST 'https://YOUR_PROJECT.supabase.co/functions/v1/trading-bot?mode=full' \\"
echo -e "       -H 'Authorization: Bearer YOUR_BOT_SECRET'${NC}"
echo ""
echo -e "  4. Open the dashboard and connect both Supabase + Alpaca"
echo ""
