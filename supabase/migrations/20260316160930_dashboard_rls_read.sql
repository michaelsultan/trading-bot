-- Allow anon (dashboard) to read all three tables
alter table trades enable row level security;
alter table portfolio_snapshots enable row level security;
alter table bot_analyses enable row level security;

create policy "public read" on trades
  for select using (true);

create policy "public read" on portfolio_snapshots
  for select using (true);

create policy "public read" on bot_analyses
  for select using (true);
