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

  if v2_mirror_active and not v1_optimizer_active and v2_producer_active then
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
    'v2_producer_cron_active', v2_producer_active
  );
end;
$$;

revoke all on function public.get_automatic_mode_readiness()
  from public, anon;
grant execute on function public.get_automatic_mode_readiness()
  to authenticated, service_role;

comment on function public.get_automatic_mode_readiness() is
  'Returns read-only automatic-mode readiness for authenticated app preflight and service diagnostics.';
