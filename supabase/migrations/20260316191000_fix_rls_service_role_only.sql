-- Fix: replace public read policies with service_role-only access.
-- The anon key is public by nature — anyone could read trades, positions and PnL.

drop policy if exists "public read" on trades;
drop policy if exists "public read" on portfolio_snapshots;
drop policy if exists "public read" on bot_analyses;

create policy "service_role read" on trades
  for select using (auth.role() = 'service_role');

create policy "service_role read" on portfolio_snapshots
  for select using (auth.role() = 'service_role');

create policy "service_role read" on bot_analyses
  for select using (auth.role() = 'service_role');
