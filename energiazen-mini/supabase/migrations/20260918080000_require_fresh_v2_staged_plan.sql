create or replace function public.has_fresh_v2_staged_plan()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.v2_heating_plan_publications
    where plan_date = (now() at time zone 'Europe/Helsinki')::date
      and published_at <= now()
      and published_at >= now() - interval '15 minutes'
  );
$$;

revoke all on function public.has_fresh_v2_staged_plan()
  from public, anon, authenticated;
grant execute on function public.has_fresh_v2_staged_plan()
  to service_role;

comment on function public.has_fresh_v2_staged_plan() is
  'Returns whether V2 has a current-day staged publication no older than 15 minutes. Read-only readiness helper.';

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
  v2_plan_fresh boolean;
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

  v2_plan_fresh := public.has_fresh_v2_staged_plan();

  return (
    v2_mirror_active
    and not v1_optimizer_active
    and v2_producer_active
    and v2_plan_fresh
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
  'Returns whether automatic heating has exactly one viable production owner. V2 additionally requires an active producer and a staged current-day plan no older than 15 minutes; documented V1 rollback remains accepted.';

create or replace function public.get_automatic_mode_readiness()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v2_mirror_active boolean;
  v1_optimizer_active boolean;
  v2_producer_active boolean;
  v2_plan_fresh boolean;
  latest_v2_plan_published_at timestamptz;
  ready boolean;
  owner text;
  reason text;
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

  select max(published_at)
    into latest_v2_plan_published_at
  from public.v2_heating_plan_publications
  where plan_date = (now() at time zone 'Europe/Helsinki')::date;

  v2_plan_fresh := latest_v2_plan_published_at is not null
    and latest_v2_plan_published_at <= now()
    and latest_v2_plan_published_at >= now() - interval '15 minutes';

  if v2_mirror_active and not v1_optimizer_active and v2_producer_active and v2_plan_fresh then
    ready := true;
    owner := 'v2';
    reason := 'ready_v2';
  elsif not v2_mirror_active and v1_optimizer_active then
    ready := true;
    owner := 'v1';
    reason := 'ready_v1_rollback';
  elsif v2_mirror_active and v1_optimizer_active then
    ready := false;
    owner := 'conflict';
    reason := 'dual_writer_conflict';
  elsif v2_mirror_active and not v2_producer_active then
    ready := false;
    owner := 'v2';
    reason := 'v2_producer_inactive';
  elsif v2_mirror_active and not v2_plan_fresh then
    ready := false;
    owner := 'v2';
    reason := 'v2_plan_stale_or_missing';
  else
    ready := false;
    owner := 'unowned';
    reason := 'no_automatic_owner';
  end if;

  return jsonb_build_object(
    'ready', ready,
    'owner', owner,
    'reason', reason,
    'v2_mirror_trigger_active', v2_mirror_active,
    'v1_optimizer_cron_active', v1_optimizer_active,
    'v2_producer_cron_active', v2_producer_active,
    'v2_plan_fresh', v2_plan_fresh,
    'v2_latest_current_plan_published_at', latest_v2_plan_published_at
  );
end;
$$;

revoke all on function public.get_automatic_mode_readiness()
  from public, anon;
grant execute on function public.get_automatic_mode_readiness()
  to authenticated, service_role;

comment on function public.get_automatic_mode_readiness() is
  'Returns read-only automatic-mode readiness including V2 current-day staged-plan freshness for authenticated app preflight and service diagnostics.';


create or replace function public.activate_v2_plan_on_automatic_transition()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v2_mirror_active boolean;
  v1_optimizer_active boolean;
  refreshed_count integer;
begin
  if new.heating_need_mode is distinct from 'automatic'
     or (
       tg_op = 'UPDATE'
       and old.heating_need_mode is not distinct from 'automatic'
     ) then
    return new;
  end if;

  v2_mirror_active := public.get_v2_publication_cutover_enabled();

  select exists (
    select 1
    from cron.job
    where jobname = 'run-heating-optimizer-shadow-hourly'
      and active
  ) into v1_optimizer_active;

  -- The documented V1 rollback owns automatic mode when the V2 mirror is
  -- disabled and V1 is active. Nothing needs to be replayed in that state.
  if not v2_mirror_active or v1_optimizer_active then
    return new;
  end if;

  -- The BEFORE readiness guard has already required a fresh current-day staged
  -- publication. Re-touch exactly that row now that the settings row is
  -- automatic. This fires mirror_v2_heating_plan_to_production() in the same
  -- transaction, so production plan + Shelly heartbeat become authoritative
  -- before the mode transition can commit.
  update public.v2_heating_plan_publications
  set updated_at = updated_at
  where plan_date = (now() at time zone 'Europe/Helsinki')::date
    and published_at <= now()
    and published_at >= now() - interval '15 minutes';

  get diagnostics refreshed_count = row_count;

  if refreshed_count <> 1 then
    raise exception
      using
        errcode = 'check_violation',
        message = 'Fresh V2 staged plan disappeared during automatic-mode transition';
  end if;

  return new;
end;
$$;

revoke all on function public.activate_v2_plan_on_automatic_transition()
  from public, anon, authenticated;
grant execute on function public.activate_v2_plan_on_automatic_transition()
  to service_role;

drop trigger if exists activate_v2_plan_on_automatic_transition
  on public.heating_control_settings;

create trigger activate_v2_plan_on_automatic_transition
after insert or update of heating_need_mode
on public.heating_control_settings
for each row
execute function public.activate_v2_plan_on_automatic_transition();

comment on trigger activate_v2_plan_on_automatic_transition
on public.heating_control_settings is
  'Atomically replays the fresh current-day V2 staged plan after entering automatic mode so heating_plans and Shelly trust are updated before commit.';
