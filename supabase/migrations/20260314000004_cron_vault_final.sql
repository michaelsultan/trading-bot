-- Cron job final : lit la service_role_key depuis Vault (aucune clé en clair)
select cron.unschedule('trading-bot-job');

select cron.schedule(
  'trading-bot-job',
  '*/30 * * * *',
  $$
    select net.http_post(
      url     := 'https://bhumjspdeveqybkilcxc.supabase.co/functions/v1/trading-bot',
      body    := '{}',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret
          from vault.decrypted_secrets
          where name = 'service_role_key'
          limit 1
        )
      )
    );
  $$
);
