-- RPC to join cron run history with pg_net HTTP responses.
-- Both tables are in non-public schemas, inaccessible via REST API directly.
-- security definer lets the Edge Function (service_role) read them.

create or replace function get_bot_run_logs(limit_n int default 50)
returns table (
  run_id        bigint,
  started_at    timestamptz,
  cron_status   text,
  http_status   int,
  http_error    text
) as $$
  select
    jrd.runid,
    jrd.start_time,
    jrd.status,
    hr.status_code,
    hr.error_msg
  from cron.job_run_details jrd
  join cron.job j on j.jobid = jrd.jobid
  left join net._http_response hr on hr.id = jrd.runid
  where j.jobname = 'trading-bot-job'
  order by jrd.start_time desc
  limit limit_n;
$$ language sql security definer;
