-- Apply after email_reminders.sql. Calls the daily-reminders Edge Function every
-- hour; the function itself decides who is due (09:00-11:59 in each owner's zone).
--
-- Before this job can succeed, the operator must create two Vault secrets
-- (Dashboard > Project Settings > Vault, or vault.create_secret):
--   reminders_function_url  https://<project-ref>.supabase.co/functions/v1/daily-reminders
--   reminders_cron_secret   the same value as the function's REMINDER_CRON_SECRET
-- Until both exist the job fails harmlessly and sends nothing.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule('prune-email-reminders', '5 * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'reminders_function_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'reminders_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
$job$);
