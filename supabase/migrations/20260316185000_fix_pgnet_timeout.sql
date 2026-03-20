-- Fix: pg_net default timeout is 5s but the Edge Function takes ~8-10 min.
-- Recreate the cron job with timeout_milliseconds = 600000 (10 min).

select cron.unschedule('trading-bot-job');

select cron.schedule(
  'trading-bot-job',
  '*/30 * * * *',
  $$
    select net.http_post(
      url                  := current_setting('app.edge_function_url'),
      body                 := '{}',
      headers              := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || current_setting('app.service_role_key')
      ),
      timeout_milliseconds := 600000
    );
  $$
);
