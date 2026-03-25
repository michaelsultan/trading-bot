-- Remove any existing trading-bot cron jobs safely
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname LIKE 'trading-bot%';

-- Fast scan: every 5 minutes, weekdays
SELECT cron.schedule(
  'trading-bot-scan',
  '*/5 * * * 1-5',
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

-- Full cycle: every 30 minutes, weekdays
SELECT cron.schedule(
  'trading-bot-full',
  '*/30 * * * 1-5',
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
