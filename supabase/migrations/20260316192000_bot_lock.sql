-- Distributed lock to prevent concurrent bot executions.
-- The UPDATE is atomic (row-level lock), safe against simultaneous cron fires.

create table if not exists bot_runs (
  id         int primary key default 1,
  is_running boolean not null default false,
  started_at timestamptz,
  constraint single_row check (id = 1)
);

insert into bot_runs (id) values (1) on conflict do nothing;

-- Returns true and claims the lock, or false if already running.
-- A stale lock (> 25 min) is automatically reclaimed to handle crashes.
create or replace function try_claim_bot_run() returns boolean as $$
declare
  claimed boolean;
begin
  update bot_runs
  set    is_running = true,
         started_at = now()
  where  id = 1
    and  (is_running = false or started_at < now() - interval '25 minutes')
  returning true into claimed;
  return coalesce(claimed, false);
end;
$$ language plpgsql;

create or replace function release_bot_run() returns void as $$
  update bot_runs set is_running = false where id = 1;
$$ language sql;
