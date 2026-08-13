-- Forward-only hardening for the already-deployed singleton heartbeat.
-- current_run_id + current_run_started_at form a database-level compare-and-set
-- token: only the newest-started run owns the row and may complete it.
alter table public.backend_heating_optimizer_state
  add column if not exists current_run_id uuid,
  add column if not exists current_run_started_at timestamptz,
  add column if not exists validated_plan_date date,
  add column if not exists validated_planned_hours integer[],
  add column if not exists validated_plan_fingerprint text;

create or replace function public.begin_backend_heating_optimizer_run(
  p_run_id uuid,
  p_run_started_at timestamptz
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.backend_heating_optimizer_state
  set current_run_id = p_run_id,
      current_run_started_at = p_run_started_at,
      last_run_attempt_at = p_run_started_at,
      health_status = 'unhealthy',
      last_outcome = 'running',
      reason = 'Optimizer run started; no plan has been validated by this attempt yet',
      updated_at = now()
  where id = 1
    and (current_run_started_at is null or current_run_started_at < p_run_started_at);
  return found;
end;
$$;

create or replace function public.complete_backend_heating_optimizer_run(
  p_run_id uuid,
  p_run_started_at timestamptz,
  p_health_status text,
  p_last_outcome text,
  p_reason text,
  p_validated_plan_at timestamptz default null,
  p_validated_plan_date date default null,
  p_validated_planned_hours integer[] default null,
  p_validated_plan_fingerprint text default null
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.backend_heating_optimizer_state
  set health_status = p_health_status,
      last_outcome = p_last_outcome,
      reason = p_reason,
      last_validated_plan_at = coalesce(p_validated_plan_at, last_validated_plan_at),
      validated_plan_date = case when p_validated_plan_at is null then validated_plan_date else p_validated_plan_date end,
      validated_planned_hours = case when p_validated_plan_at is null then validated_planned_hours else p_validated_planned_hours end,
      validated_plan_fingerprint = case when p_validated_plan_at is null then validated_plan_fingerprint else p_validated_plan_fingerprint end,
      updated_at = now()
  where id = 1
    and current_run_id = p_run_id
    and current_run_started_at = p_run_started_at;
  return found;
end;
$$;

revoke all on function public.begin_backend_heating_optimizer_run(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.complete_backend_heating_optimizer_run(uuid, timestamptz, text, text, text, timestamptz, date, integer[], text) from public, anon, authenticated;
grant execute on function public.begin_backend_heating_optimizer_run(uuid, timestamptz) to service_role;
grant execute on function public.complete_backend_heating_optimizer_run(uuid, timestamptz, text, text, text, timestamptz, date, integer[], text) to service_role;
