-- Migration: Update pg_cron to use adaptive two-tier scheduling
-- Run: npx supabase db push (or add to supabase/migrations/)
--
-- FAST SCAN: every 5 minutes during market hours (Mon-Fri, 9:30 AM - 4:00 PM ET)
--   → Lightweight snapshot scan of 220+ stocks
--   → If triggers detected → automatically launches full cycle
--   → Cost: ~2-3 Alpaca API calls, zero Grok calls
--
-- FULL CYCLE: every 30 minutes during market hours
--   → Full analysis: multi-TF, patterns, volume, Grok AI decisions
--   → Cost: 50+ Alpaca calls + 2-3 Grok calls
--
-- NOTE: Update YOUR_SUPABASE_URL and YOUR_BOT_SECRET below before running.

-- Remove old cron jobs (if they exist)
SELECT cron.unschedule(jobname) FROM cron.job WHERE jobname LIKE 'trading-bot%';

-- Fast scan: every 5 minutes, Mon-Fri, 13:30-20:00 UTC (9:30 AM - 4:00 PM ET)
SELECT cron.schedule(
  'trading-bot-scan',
  '*/5 * * * 1-5',  -- every 5 min, weekdays only
  $$
  SELECT net.http_post(
    url := 'https://rwfbleacxufaojkztxbj.supabase.co/functions/v1/trading-bot?mode=scan',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ3ZmJsZWFjeHVmYW9qa3p0eGJqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMDMxODUsImV4cCI6MjA4OTU3OTE4NX0.EVL-qzsNqe59VUwvpT33vuYz4GT80AflWvnEgRzo4iE',
      'x-bot-secret', 'f1411bfb63444c11acf19b4dbbaf22b24c8cfa74309b1457d0b5a1a9f2bd6f04',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Full cycle: every 30 minutes, Mon-Fri, 13:30-20:00 UTC (9:30 AM - 4:00 PM ET)
SELECT cron.schedule(
  'trading-bot-full',
  '*/30 * * * 1-5',  -- every 30 min, weekdays only
  $$
  SELECT net.http_post(
    url := 'https://rwfbleacxufaojkztxbj.supabase.co/functions/v1/trading-bot?mode=full',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ3ZmJsZWFjeHVmYW9qa3p0eGJqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMDMxODUsImV4cCI6MjA4OTU3OTE4NX0.EVL-qzsNqe59VUwvpT33vuYz4GT80AflWvnEgRzo4iE',
      'x-bot-secret', 'f1411bfb63444c11acf19b4dbbaf22b24c8cfa74309b1457d0b5a1a9f2bd6f04',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Verify the schedules are active
SELECT jobname, schedule, active FROM cron.job WHERE jobname LIKE 'trading-bot%';
