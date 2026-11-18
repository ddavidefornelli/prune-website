-- Apply after 20261120000100_start_times_and_push.sql. A start time the owner
-- picks should be announced within minutes, not at the next full hour, so the
-- reminder job now runs every ten minutes. Idempotency lives in
-- planner_claim_reminders, so running more often never sends anything twice.
select cron.alter_job(
  (select jobid from cron.job where jobname = 'prune-email-reminders'),
  schedule := '*/10 * * * *'
);
