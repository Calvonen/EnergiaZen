-- Persist the exact electricity-price snapshot used by each successfully
-- validated backend optimizer run. Client diagnostics can then prove that
-- their counterfactual optimizer used the same prices before attributing a
-- missing adjacent hour specifically to the cooldown rule.

alter table public.backend_heating_optimizer_state
  add column if not exists validated_price_snapshot jsonb;

do $$
begin
  if to_regprocedure(
    'public.publish_backend_heating_optimizer_plans(uuid,timestamp with time zone,jsonb,jsonb,jsonb,jsonb,jsonb,timestamp with time zone,text,date,integer[],text)'
  ) is not null and to_regprocedure(
    'public.publish_backend_heating_optimizer_plans_without_price_identity(uuid,timestamp with time zone,jsonb,jsonb,jsonb,jsonb,jsonb,timestamp with time zone,text,date,integer[],text)'
  ) is null then
    alter function public.publish_backend_heating_optimizer_plans(
      uuid, timestamptz, jsonb, jsonb, jsonb, jsonb, jsonb, timestamptz,
      text, date, integer[], text
    ) rename to publish_backend_heating_optimizer_plans_without_price_identity;
  end if;
end;
$$;

revoke all on function public.publish_backend_heating_optimizer_plans_without_price_identity(
  uuid, timestamptz, jsonb, jsonb, jsonb, jsonb, jsonb, timestamptz,
  text, date, integer[], text
) from public, anon, authenticated, service_role;

alter function public.publish_backend_heating_optimizer_plans_without_price_identity(
  uuid, timestamptz, jsonb, jsonb, jsonb, jsonb, jsonb, timestamptz,
  text, date, integer[], text
) security invoker;

create or replace function public.publish_backend_heating_optimizer_plans(
  p_run_id uuid,
  p_run_started_at timestamptz,
  p_changed_plans jsonb,
  p_expected_settings jsonb,
  p_expected_plan_versions jsonb,
  p_expected_tank_snapshot jsonb,
  p_expected_price_snapshot jsonb,
  p_published_at timestamptz,
  p_publish_reason text,
  p_validated_plan_date date,
  p_validated_planned_hours integer[],
  p_validated_plan_fingerprint text
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  result text;
begin
  if p_expected_price_snapshot is null
    or jsonb_typeof(p_expected_price_snapshot) <> 'array'
    or jsonb_array_length(p_expected_price_snapshot) = 0 then
    return 'price_snapshot_conflict';
  end if;

  result := public.publish_backend_heating_optimizer_plans_without_price_identity(
    p_run_id,
    p_run_started_at,
    p_changed_plans,
    p_expected_settings,
    p_expected_plan_versions,
    p_expected_tank_snapshot,
    p_expected_price_snapshot,
    p_published_at,
    p_publish_reason,
    p_validated_plan_date,
    p_validated_planned_hours,
    p_validated_plan_fingerprint
  );

  if result in ('published', 'no_changes') then
    update public.backend_heating_optimizer_state
    set validated_price_snapshot = p_expected_price_snapshot,
        updated_at = now()
    where id = 1
      and current_run_id = p_run_id
      and current_run_started_at = p_run_started_at;

    if not found then
      raise exception 'optimizer heartbeat ownership lost while persisting validated price identity';
    end if;
  end if;

  return result;
end;
$$;

revoke all on function public.publish_backend_heating_optimizer_plans(
  uuid, timestamptz, jsonb, jsonb, jsonb, jsonb, jsonb, timestamptz,
  text, date, integer[], text
) from public, anon, authenticated;

grant execute on function public.publish_backend_heating_optimizer_plans(
  uuid, timestamptz, jsonb, jsonb, jsonb, jsonb, jsonb, timestamptz,
  text, date, integer[], text
) to service_role;
