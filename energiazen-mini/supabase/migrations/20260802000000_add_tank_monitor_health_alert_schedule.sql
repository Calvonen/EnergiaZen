create table if not exists public.device_monitor_state (
  id smallint primary key,
  is_stale boolean not null default false,
  alert_sent_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint device_monitor_state_singleton check (id = 1)
);

comment on table public.device_monitor_state is
  'Single-row state tracking whether the latest tank_readings row is stale, used by the check-tank-monitor-health Edge Function to send the fault email only on the healthy->stale transition instead of on every cron run.';

insert into public.device_monitor_state (id, is_stale)
values (1, false)
on conflict (id) do nothing;

-- Vain palvelinpuolen Edge Function (service_role) lukee/päivittää tätä -
-- sovellus ei tarvitse pääsyä, koska virhebanneri lasketaan appissa
-- suoraan tank_readings-taulun tuoreimmasta rivistä (ks.
-- lib/tankMonitorAlert.ts), ei tästä taulusta.
grant select, update
on table public.device_monitor_state
to service_role;

-- project_url- ja publishable_key-secretit on jo luotu Vaultiin
-- fetch-electricity-prices-hourly-jobin migraatiossa
-- (20260724020000_schedule_electricity_price_fetch.sql) - samoja
-- käytetään tässä uudelleen.
do $$
declare
  existing_job record;
begin
  for existing_job in
    select jobid
    from cron.job
    where jobname = 'check-tank-monitor-health-every-5-minutes'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
end
$$;

select cron.schedule(
  'check-tank-monitor-health-every-5-minutes',
  '*/5 * * * *',
  $cron$
  select net.http_post(
    url := (
      select rtrim(decrypted_secret, '/')
      from vault.decrypted_secrets
      where name = 'project_url'
      limit 1
    ) || '/functions/v1/check-tank-monitor-health',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'publishable_key'
        limit 1
      )
    ),
    body := '{}'::jsonb
  );
  $cron$
);
