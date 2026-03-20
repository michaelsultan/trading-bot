-- Fix: cron.job only contains active jobs. When a job is unscheduled and
-- recreated, its history stays in job_run_details under the old jobid.
-- Remove the join filter — just get all recent runs ordered by time.

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
  left join net._http_response hr on hr.id = jrd.runid
  order by jrd.start_time desc
  limit limit_n;
$$ language sql security definer;
