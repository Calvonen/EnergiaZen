-- Backend-primary publication for run-heating-optimizer.
--
-- The Edge Function computes changedPlans using the existing shared
-- orchestration logic, then calls this RPC to publish those changed rows and
-- advance the heartbeat in one PostgreSQL transaction. Any raised error rolls
-- back both heating_plans and backend_heating_optimizer_state changes.

do $$
declare
  constraint_name text;
begin
  select conname
    into constraint_name
  from pg_constraint
  where conrelid = 'public.backend_heating_optimizer_state'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) like '%last_outcome%'
  limit 1;

  if constraint_name is not null then
    execute format(
      'alter table public.backend_heating_optimizer_state drop constraint %I',
      constraint_name
    );
  end if;
end;
$$;

alter table public.backend_heating_optimizer_state
  add constraint backend_heating_optimizer_state_last_outcome_check
  check (
    last_outcome in (
      'running',
      'no_changes',
      'published',
      'publication_failed',
      'changes_not_published',
      'optimizer_invalid',
      'deferred',
      'run_error'
    )
  );

grant insert, update on table public.heating_plans to service_role;

create or replace function public.publish_backend_heating_optimizer_plans(
  p_run_id uuid,
  p_run_started_at timestamptz,
  p_changed_plans jsonb,
  p_published_at timestamptz,
  p_publish_reason text,
  p_validated_plan_date date,
  p_validated_planned_hours integer[],
  p_validated_plan_fingerprint text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  changed_plan_count integer;
  written_plan_count integer;
begin
  if jsonb_typeof(p_changed_plans) <> 'array' then
    raise exception 'p_changed_plans must be a JSON array';
  end if;

  changed_plan_count := jsonb_array_length(p_changed_plans);
  if changed_plan_count = 0 then
    raise exception 'publish_backend_heating_optimizer_plans requires at least one changed plan';
  end if;

  perform 1
  from public.backend_heating_optimizer_state
  where id = 1
    and current_run_id = p_run_id
    and current_run_started_at = p_run_started_at
  for update;

  if not found then
    return false;
  end if;

  insert into public.heating_plans (
    mode,
    plan_date,
    planned_hours,
    reason,
    target_hours,
    updated_at
  )
  select
    plan.mode,
    plan.plan_date,
    coalesce(
      array(
        select value::integer
        from jsonb_array_elements_text(plan.planned_hours) as value
        order by value::integer
      ),
      array[]::integer[]
    ),
    plan.reason,
    plan.target_hours,
    plan.updated_at
  from jsonb_to_recordset(p_changed_plans) as plan(
    mode text,
    plan_date date,
    planned_hours jsonb,
    reason text,
    target_hours integer,
    updated_at timestamptz
  )
  on conflict (plan_date) do update
  set mode = excluded.mode,
      planned_hours = excluded.planned_hours,
      reason = excluded.reason,
      target_hours = excluded.target_hours,
      updated_at = excluded.updated_at;

  get diagnostics written_plan_count = row_count;
  if written_plan_count <> changed_plan_count then
    raise exception 'published % changed heating plan rows, expected %',
      written_plan_count,
      changed_plan_count;
  end if;

  update public.backend_heating_optimizer_state
  set health_status = 'healthy',
      last_outcome = 'published',
      reason = p_publish_reason,
      last_published_at = p_published_at,
      last_validated_plan_at = p_published_at,
      validated_plan_date = p_validated_plan_date,
      validated_planned_hours = p_validated_planned_hours,
      validated_plan_fingerprint = p_validated_plan_fingerprint,
      updated_at = now()
  where id = 1
    and current_run_id = p_run_id
    and current_run_started_at = p_run_started_at;

  return found;
end;
$$;

revoke all on function public.publish_backend_heating_optimizer_plans(
  uuid,
  timestamptz,
  jsonb,
  timestamptz,
  text,
  date,
  integer[],
  text
) from public, anon, authenticated;
grant execute on function public.publish_backend_heating_optimizer_plans(
  uuid,
  timestamptz,
  jsonb,
  timestamptz,
  text,
  date,
  integer[],
  text
) to service_role;
