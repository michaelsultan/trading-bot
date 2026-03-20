-- Restrict cron to market hours: Mon–Fri 13:00–20:30 UTC (covers 09:30–16:00 ET).
-- Eliminates ~70% of useless runs (nights + weekends).
-- isClock() in the function handles the exact open/close boundary.

select cron.unschedule('trading-bot-job');

select cron.schedule(
  'trading-bot-job',
  '*/30 13-20 * * 1-5',
  $$
    select net.http_post(
      url                  := 'https://bhumjspdeveqybkilcxc.supabase.co/functions/v1/trading-bot',
      body                 := '{}',
      headers              := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'service_role_key'
          limit 1
        )
      ),
      timeout_milliseconds := 600000
    );
  $$
);
