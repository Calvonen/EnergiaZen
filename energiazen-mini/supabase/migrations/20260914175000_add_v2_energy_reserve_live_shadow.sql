create table if not exists public.v2_energy_reserve_shadow_runs (
  id uuid primary key default gen_random_uuid(),
  run_at timestamptz not null default now(),
  source text not null,
  replay_start_at timestamptz not null,
  replay_end_at timestamptz not null,
  latest_tank_reading_at timestamptz,
  reading_count integer not null default 0,
  reliable_draw_count integer not null default 0,
  unresolved_draw_detected boolean not null default false,
  available boolean not null default false,
  unavailable_reason text,
  remaining_energy_kwh double precision,
  observed_energy_kwh double precision,
  sensor_gap_kwh double precision,
  balance_uncertainty_kwh double precision not null default 0,
  heater_delivery_uncertainty_kwh double precision not null default 0,
  heater_credit_guard_top_temp_c double precision,
  conservative_energy_kwh double precision,
  safety_energy_kwh double precision not null,
  target_energy_kwh double precision not null,
  v2_band text not null check (v2_band in ('below_safety', 'recovery', 'target_met', 'invalid')),
  v2_needs_energy_recovery boolean,
  v1_shadow_run_id uuid,
  v1_run_at timestamptz,
  v1_target_hours integer,
  v1_needs_energy_recovery boolean,
  comparison text not null check (
    comparison in ('agree', 'v2_more_conservative', 'v2_less_conservative', 'v1_unavailable', 'v2_unavailable')
  ),
  created_at timestamptz not null default now()
);

create index if not exists v2_energy_reserve_shadow_runs_recent_idx
  on public.v2_energy_reserve_shadow_runs (run_at desc);

alter table public.v2_energy_reserve_shadow_runs enable row level security;

grant select, insert on public.v2_energy_reserve_shadow_runs to service_role;

-- Run one minute after the V1 backend optimizer cadence. This keeps the
-- comparison independent: V1 still publishes/controls exactly as before,
-- while this job only reads the latest V1 shadow snapshot and persists V2.
do $$
declare
  existing_job record;
begin
  for existing_job in
    select jobid
    from cron.job
    where jobname = 'run-v2-energy-reserve-shadow'
  loop
    perform cron.unschedule(existing_job.jobid);
  end loop;
end
$$;

select cron.schedule(
  'run-v2-energy-reserve-shadow',
  '4,9,14,19,24,29,34,39,44,49,54,59 * * * *',
  $cron$
  select net.http_post(
    url := (
      select rtrim(decrypted_secret, '/')
      from vault.decrypted_secrets
      where name = 'project_url'
      limit 1
    ) || '/functions/v1/run-v2-energy-shadow',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'publishable_key'
        limit 1
      ),
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'publishable_key'
        limit 1
      ),
      'x-energyzen-cron-secret', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'heating_optimizer_cron_secret'
        limit 1
      )
    ),
    body := '{}'::jsonb
  );
  $cron$
);
