-- Task-start alerts need a run every minute (an alert is due 5 minutes
-- before). Calls the daily-reminders function with {"job": "starts"}, using
-- the same Vault secrets as prune-email-reminders
-- (20261112000300_email_reminders_cron.sql). The hourly job is unchanged.
--
-- Apply after deploying the daily-reminders function that understands it.
select cron.schedule('prune-start-alerts', '* * * * *', $job$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'reminders_function_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'reminders_cron_secret')
    ),
    body := '{"job": "starts"}'::jsonb,
    timeout_milliseconds := 50000
  );
$job$);
