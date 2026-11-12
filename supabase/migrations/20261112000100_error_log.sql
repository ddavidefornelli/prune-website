-- Reusable client error log. Rows hold what kind of error happened and coarse
-- context only: no IP address, user agent, email, account or device identifier.
-- Written by the website's /api/error-log relay, which runs on the website's own
-- domain so errors are counted even when a visitor cannot reach Supabase.
-- Apply after all prior migrations.
begin;
create table public.error_log (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  -- Add new event names here when you start logging them.
  event text not null check (event in ('signin_network')),
  context text not null check (context ~ '^[a-z_]{1,32}$'),
  detail text not null check (detail ~ '^[a-z_]{1,32}$'),
  country text check (country ~ '^[A-Z]{2}$'),
  browser text not null check (browser in ('chrome', 'edge', 'firefox', 'safari', 'samsung', 'opera', 'other')),
  device text not null check (device in ('mobile', 'desktop'))
);
create index error_log_created_at on public.error_log (created_at);
alter table public.error_log enable row level security;
revoke all on public.error_log from public, anon, authenticated;
grant all on public.error_log to service_role;

-- The only anon entry point. Invalid input is rejected by the table checks.
-- Caps writes per day so a flood cannot grow the table, and prunes rows older
-- than 90 days on each write so no scheduled job is needed.
create function public.log_client_error(p_event text, p_context text, p_detail text,
  p_country text, p_browser text, p_device text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.error_log where created_at >= date_trunc('day', now())) >= 5000 then
    return;
  end if;
  delete from public.error_log where created_at < now() - interval '90 days';
  insert into public.error_log (event, context, detail, country, browser, device)
    values (p_event, p_context, p_detail, nullif(p_country, ''), p_browser, p_device);
exception when check_violation or not_null_violation or string_data_right_truncation then
  raise exception using errcode = 'PT400', message = 'Invalid error report.';
end;
$$;
revoke all on function public.log_client_error(text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.log_client_error(text, text, text, text, text, text) to anon;
commit;
