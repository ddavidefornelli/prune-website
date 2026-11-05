-- Survey funnel: one anonymous total per question screen reached, so the
-- totals show where visitors leave the questions. Same bounds as the other
-- metrics: each call adds at most one, and no answers are ever sent.
-- Apply after 20261102000100_onboarding_survey.sql.
begin;
alter table public.guest_usage_daily drop constraint guest_usage_daily_metric_check;
alter table public.guest_usage_daily add constraint guest_usage_daily_metric_check check (metric in (
  'new_guests', 'active_guests', 'returning_guests', 'tasks_created', 'tasks_started',
  'tasks_completed', 'focus_minutes', 'funnel_control_shown', 'funnel_control_signed_up',
  'funnel_survey_shown', 'funnel_survey_started', 'funnel_survey_finished',
  'funnel_survey_plan_shown', 'funnel_survey_google_clicked', 'funnel_survey_signed_up',
  'funnel_survey_skipped', 'funnel_survey_reached_goal', 'funnel_survey_reached_role',
  'funnel_survey_reached_window', 'funnel_survey_reached_length', 'funnel_survey_reached_fact',
  'funnel_survey_reached_derailer', 'funnel_survey_reached_target',
  'funnel_survey_reached_outcome'));

create or replace function public.guest_record_usage(p_metrics jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  item record;
  today date := (now() at time zone 'utc')::date;
begin
  if p_metrics is null or jsonb_typeof(p_metrics) <> 'object' then
    raise exception using errcode = 'PT400', message = 'Invalid guest usage.';
  end if;
  for item in select key, value from jsonb_each(p_metrics) loop
    if item.key not in ('new_guests', 'active_guests', 'returning_guests',
        'tasks_created', 'tasks_started', 'tasks_completed', 'focus_minutes',
        'funnel_control_shown', 'funnel_control_signed_up', 'funnel_survey_shown',
        'funnel_survey_started', 'funnel_survey_finished', 'funnel_survey_plan_shown',
        'funnel_survey_google_clicked', 'funnel_survey_signed_up', 'funnel_survey_skipped',
        'funnel_survey_reached_goal', 'funnel_survey_reached_role',
        'funnel_survey_reached_window', 'funnel_survey_reached_length',
        'funnel_survey_reached_fact', 'funnel_survey_reached_derailer',
        'funnel_survey_reached_target', 'funnel_survey_reached_outcome')
      or jsonb_typeof(item.value) <> 'number' or item.value::text !~ '^[0-9]{1,4}$' then
      raise exception using errcode = 'PT400', message = 'Invalid guest usage.';
    end if;
    -- Cast only after the format check above; OR does not short-circuit in SQL.
    if item.value::text::integer > (case when item.key = 'focus_minutes' then 1440 else 1 end) then
      raise exception using errcode = 'PT400', message = 'Invalid guest usage.';
    end if;
  end loop;
  insert into public.guest_usage_daily as u (day, metric, total)
    select today, key, value::text::bigint from jsonb_each(p_metrics) where value::text::bigint > 0
    on conflict (day, metric) do update set total = u.total + excluded.total;
end;
$$;
revoke all on function public.guest_record_usage(jsonb) from public, anon, authenticated;
grant execute on function public.guest_record_usage(jsonb) to anon;
commit;
