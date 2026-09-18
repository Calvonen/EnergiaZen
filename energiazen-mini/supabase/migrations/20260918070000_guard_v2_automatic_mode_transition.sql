create or replace function public.is_v2_automatic_control_plane_ready()
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v2_mirror_active boolean;
  v1_optimizer_active boolean;
  v2_producer_active boolean;
begin
  v2_mirror_active := public.get_v2_publication_cutover_enabled();

  select exists (
    select 1
    from cron.job
    where jobname = 'run-heating-optimizer-shadow-hourly'
      and active
  ) into v1_optimizer_active;

  select exists (
    select 1
    from cron.job
    where jobname = 'run-v2-energy-reserve-shadow'
      and active
  ) into v2_producer_active;

  return (
    v2_mirror_active
    and not v1_optimizer_active
    and v2_producer_active
  ) or (
    not v2_mirror_active
    and v1_optimizer_active
  );
end;
$$;

revoke all on function public.is_v2_automatic_control_plane_ready()
  from public, anon, authenticated;
grant execute on function public.is_v2_automatic_control_plane_ready()
  to service_role;

comment on function public.is_v2_automatic_control_plane_ready() is
  'Returns whether automatic heating has exactly one viable production owner: healthy V2, or V1 after the documented rollback. Read-only.';

create or replace function public.guard_heating_control_mode_transition()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if new.heating_need_mode = 'automatic'
     and (
       tg_op = 'INSERT'
       or old.heating_need_mode is distinct from 'automatic'
     )
     and not public.is_v2_automatic_control_plane_ready() then
    raise exception
      using
        errcode = 'check_violation',
        message = 'Automatic heating control plane is not ready';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_heating_control_mode_transition()
  from public, anon, authenticated;
grant execute on function public.guard_heating_control_mode_transition()
  to service_role;

drop trigger if exists guard_heating_control_mode_transition
  on public.heating_control_settings;

create trigger guard_heating_control_mode_transition
before insert or update of heating_need_mode
on public.heating_control_settings
for each row
execute function public.guard_heating_control_mode_transition();

comment on trigger guard_heating_control_mode_transition
on public.heating_control_settings is
  'Fail-closed guard for inserts or transitions into automatic mode. Accepts healthy V2 ownership or the documented V1 rollback ownership, and rejects conflicts/unowned states.';
