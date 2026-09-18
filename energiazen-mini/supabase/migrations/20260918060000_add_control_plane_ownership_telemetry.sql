alter table public.v2_energy_reserve_shadow_runs
  add column if not exists control_plane_state jsonb;

comment on column public.v2_energy_reserve_shadow_runs.control_plane_state is
  'Snapshot of the heating control-plane owner and health at shadow-run time. Observability only; does not change publisher ownership.';

create or replace function public.get_heating_control_plane_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  configured_mode text;
  v2_active boolean;
  v1_active boolean;
  v2_producer_active boolean;
  owner text;
  healthy boolean;
begin
  select heating_need_mode
    into configured_mode
  from public.heating_control_settings
  where id = 1;

  v2_active := public.get_v2_publication_cutover_enabled();

  select exists (
    select 1
    from cron.job
    where jobname = 'run-heating-optimizer-shadow-hourly'
      and active
  ) into v1_active;

  select exists (
    select 1
    from cron.job
    where jobname = 'run-v2-energy-reserve-shadow'
      and active
  ) into v2_producer_active;

  if configured_mode = 'fixed' then
    owner := 'fixed';
    healthy := true;
  elsif configured_mode = 'automatic' then
    if v2_active and not v1_active then
      owner := 'v2';
      healthy := v2_producer_active;
    elsif v1_active and not v2_active then
      owner := 'v1';
      healthy := true;
    elsif v1_active and v2_active then
      owner := 'conflict';
      healthy := false;
    else
      owner := 'unowned';
      healthy := false;
    end if;
  else
    owner := 'unowned';
    healthy := false;
  end if;

  return jsonb_build_object(
    'heating_need_mode', configured_mode,
    'v2_mirror_trigger_active', v2_active,
    'v1_optimizer_cron_active', v1_active,
    'v2_producer_cron_active', v2_producer_active,
    'owner', owner,
    'healthy', healthy
  );
end;
$$;

revoke all on function public.get_heating_control_plane_state() from public, anon, authenticated;
grant execute on function public.get_heating_control_plane_state() to service_role;

comment on function public.get_heating_control_plane_state() is
  'Returns the effective heating control-plane owner and scheduler health: fixed, v2, v1, conflict, or unowned. Read-only readiness telemetry.';
