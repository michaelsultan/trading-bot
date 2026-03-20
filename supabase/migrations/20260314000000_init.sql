-- Historique de toutes les décisions de Grok
create table if not exists trades (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  symbol        text,                        -- null si action = HOLD
  action        text not null,               -- BUY | SELL | HOLD
  quantity      numeric,                     -- null si HOLD
  price_entry   numeric,                     -- prix au moment de la décision
  price_exit    numeric,                     -- rempli à la clôture
  pnl           numeric,                     -- profit/loss réalisé
  reason        text,                        -- justification de Grok
  alpaca_order_id text,                      -- id de l'ordre Alpaca
  status        text not null default 'open' -- open | closed | cancelled
);

-- Snapshots du portfolio toutes les 30 min
create table if not exists portfolio_snapshots (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  cash          numeric not null,
  equity        numeric not null,            -- valeur totale (cash + positions)
  positions     jsonb                        -- liste des positions ouvertes
);

-- Active pg_net et pg_cron (extensions Supabase)
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Job cron toutes les 30 min : appelle l'Edge Function
select cron.schedule(
  'trading-bot-job',
  '*/30 * * * *',
  $$
    select net.http_post(
      url    := current_setting('app.edge_function_url'),
      body   := '{}',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || current_setting('app.service_role_key')
      )
    );
  $$
);
