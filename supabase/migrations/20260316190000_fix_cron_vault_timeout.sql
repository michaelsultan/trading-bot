-- Fix: previous timeout migration broke the cron by switching from vault back to
-- current_setting (which is not configured). This restores the vault approach
-- while adding timeout_milliseconds = 600000.

select cron.unschedule('trading-bot-job');

select cron.schedule(
  'trading-bot-job',
  '*/30 * * * *',
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
