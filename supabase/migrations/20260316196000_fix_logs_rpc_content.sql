-- Add content (response body) and timed_out to the logs RPC.
-- Must drop first because return type changed.

drop function if exists get_bot_run_logs(int);

create or replace function get_bot_run_logs(limit_n int default 50)
returns table (
  run_id        bigint,
  started_at    timestamptz,
  cron_status   text,
  http_status   int,
  timed_out     boolean,
  http_error    text,
  http_content  text
) as $$
  select
    jrd.runid,
    jrd.start_time,
    jrd.status,
    hr.status_code,
    hr.timed_out,
    hr.error_msg,
    hr.content
  from cron.job_run_details jrd
  left join net._http_response hr on hr.id = jrd.runid
  order by jrd.start_time desc
  limit limit_n;
$$ language sql security definer;
