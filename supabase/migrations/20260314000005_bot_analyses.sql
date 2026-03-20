-- Auto-analyses générées par Grok tous les 5 trades
create table if not exists bot_analyses (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  trade_count int not null,       -- numéro du trade qui a déclenché l'analyse
  analysis    text not null,      -- texte libre produit par Grok
  trades_ref  jsonb               -- snapshot des 5 trades analysés
);
