-- Ajout d'une colonne type pour distinguer analyses régulières et bilans hebdomadaires
alter table bot_analyses
  add column if not exists type text not null default 'analysis'
  check (type in ('analysis', 'weekly_summary'));

-- Migrer les bilans existants identifiés par le préfixe [BILAN SEMAINE]
update bot_analyses
  set type = 'weekly_summary'
  where analysis ilike '[BILAN SEMAINE]%';
