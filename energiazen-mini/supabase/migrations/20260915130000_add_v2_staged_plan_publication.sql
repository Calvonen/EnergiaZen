-- Isolated V2 publication staging. This table is deliberately not heating_plans:
-- Shelly/V1 cannot consume these rows before the explicit control cutover.
create table if not exists public.v2_heating_plan_publications (
  plan_date date primary key,
  planned_hours integer[] not null default '{}',
  source text not null default 'v2_energy_plan',
  published_at timestamptz not null,
  anchor_tank_reading_at timestamptz not null,
  forecast_horizon_end_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint v2_heating_plan_publications_hours_check check (planned_hours <@ array[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23]::integer[])
);
alter table public.v2_heating_plan_publications enable row level security;
revoke all on table public.v2_heating_plan_publications from public, anon, authenticated, service_role;
grant select on table public.v2_heating_plan_publications to service_role;

create or replace function public.publish_v2_heating_plans_staged(
  p_plans jsonb, p_expected_plan_versions jsonb, p_expected_tank_snapshot jsonb,
  p_expected_tank_replay jsonb, p_expected_water_draw_snapshot jsonb,
  p_expected_settings_snapshot jsonb, p_constraint_plan_dates jsonb,
  p_expected_constraint_plans jsonb, p_expected_price_snapshot jsonb,
  p_price_fetch_end_at timestamptz,
  p_replay_start_at timestamptz, p_replay_end_at timestamptz,
  p_published_at timestamptz, p_forecast_horizon_end_at timestamptz
) returns text language plpgsql security definer set search_path = public as $$
declare
  expected_created_at timestamptz; expected_top_temp double precision; expected_bottom_temp double precision;
  expected_inlet_temp double precision; expected_heating boolean; plan_count integer; written_count integer;
  conflict_count integer; expected_price_count integer; price_window_start timestamptz; price_window_end timestamptz;
begin
  if p_plans is null or jsonb_typeof(p_plans) <> 'array' or jsonb_array_length(p_plans)=0 then return 'plan_payload_invalid'; end if;
  if p_expected_plan_versions is null or jsonb_typeof(p_expected_plan_versions)<>'array' then return 'plan_snapshot_conflict'; end if;
  if p_expected_tank_snapshot is null or jsonb_typeof(p_expected_tank_snapshot)<>'object' then return 'tank_snapshot_conflict'; end if;
  if p_expected_tank_replay is null or jsonb_typeof(p_expected_tank_replay)<>'array' then return 'tank_snapshot_conflict'; end if;
  if p_expected_water_draw_snapshot is null or jsonb_typeof(p_expected_water_draw_snapshot)<>'array' then return 'water_draw_snapshot_conflict'; end if;
  if p_expected_settings_snapshot is null or jsonb_typeof(p_expected_settings_snapshot)<>'object' then return 'settings_conflict'; end if;
  if p_constraint_plan_dates is null or jsonb_typeof(p_constraint_plan_dates)<>'array' or jsonb_array_length(p_constraint_plan_dates)=0 then return 'constraint_plan_conflict'; end if;
  if p_expected_constraint_plans is null or jsonb_typeof(p_expected_constraint_plans)<>'array' then return 'constraint_plan_conflict'; end if;
  if p_expected_price_snapshot is null or jsonb_typeof(p_expected_price_snapshot)<>'array' or jsonb_array_length(p_expected_price_snapshot)=0 then return 'price_snapshot_conflict'; end if;
  if p_price_fetch_end_at is null then return 'price_snapshot_conflict'; end if;
  if p_replay_start_at is null or p_replay_end_at is null or p_replay_start_at>p_replay_end_at then return 'tank_snapshot_conflict'; end if;
  if p_published_at is null or p_forecast_horizon_end_at is null then return 'plan_payload_invalid'; end if;

  with plans as (select * from jsonb_to_recordset(p_plans) as p(plan_date date, planned_hours jsonb))
  select count(*) into conflict_count from (
    select plan_date from plans where plan_date is null or planned_hours is null or jsonb_typeof(planned_hours)<>'array'
    union all select plan_date from plans group by plan_date having count(*)<>1
  ) x;
  if conflict_count>0 then return 'plan_payload_invalid'; end if;

  with plans as (select plan_date from jsonb_to_recordset(p_plans) as p(plan_date date,planned_hours jsonb)), versions as (select * from jsonb_to_recordset(p_expected_plan_versions) as v(plan_date date,updated_at timestamptz))
  select count(*) into conflict_count from (select plan_date from versions where plan_date is null union all select plan_date from versions group by plan_date having count(*)<>1 union all select p.plan_date from plans p left join versions v using(plan_date) where v.plan_date is null union all select v.plan_date from versions v left join plans p using(plan_date) where p.plan_date is null) x;
  if conflict_count>0 then return 'plan_snapshot_conflict'; end if;

  if exists (select 1 from jsonb_array_elements(p_constraint_plan_dates) e where jsonb_typeof(e.value)<>'string' or nullif(e.value #>> '{}','') is null) then return 'constraint_plan_conflict'; end if;
  begin
    with dates as (select value::date plan_date from jsonb_array_elements_text(p_constraint_plan_dates))
    select count(*) into conflict_count from (select plan_date from dates where plan_date is null union all select plan_date from dates group by plan_date having count(*)<>1) x;
  exception when others then return 'constraint_plan_conflict'; end;
  if conflict_count>0 then return 'constraint_plan_conflict'; end if;

  select s.created_at,s.top_temp,s.bottom_temp,s.inlet_temp,s.heating into expected_created_at,expected_top_temp,expected_bottom_temp,expected_inlet_temp,expected_heating
  from jsonb_to_record(p_expected_tank_snapshot) as s(created_at timestamptz,top_temp double precision,bottom_temp double precision,inlet_temp double precision,heating boolean);
  if expected_created_at is null or expected_top_temp is null or expected_bottom_temp is null or expected_inlet_temp is null or expected_heating is null then return 'tank_snapshot_conflict'; end if;

  with expected as (select * from jsonb_to_recordset(p_expected_price_snapshot) as p(starts_at timestamptz,ends_at timestamptz,spot_price_cents_kwh numeric,resolution_minutes integer))
  select min(starts_at),max(ends_at),count(*) into price_window_start,price_window_end,expected_price_count from expected;
  if price_window_start is null or price_window_end is null then return 'price_snapshot_conflict'; end if;
  with expected as (select * from jsonb_to_recordset(p_expected_price_snapshot) as p(starts_at timestamptz,ends_at timestamptz,spot_price_cents_kwh numeric,resolution_minutes integer))
  select count(*) into conflict_count from (select starts_at from expected where starts_at is null or ends_at is null or spot_price_cents_kwh is null or resolution_minutes<>60 or ends_at<>starts_at+interval '60 minutes' or starts_at<>date_trunc('hour',starts_at) union all select starts_at from expected group by starts_at,resolution_minutes having count(*)<>1) x;
  if conflict_count>0 or price_window_end<>price_window_start+expected_price_count*interval '60 minutes' then return 'price_snapshot_conflict'; end if;
  with expected as (select starts_at,ends_at,lag(ends_at) over(order by starts_at) previous_end from jsonb_to_recordset(p_expected_price_snapshot) as p(starts_at timestamptz,ends_at timestamptz,spot_price_cents_kwh numeric,resolution_minutes integer)) select count(*) into conflict_count from expected where previous_end is not null and starts_at<>previous_end;
  if conflict_count>0 then return 'price_snapshot_conflict'; end if;

  lock table public.tank_readings in share mode; lock table public.water_draw_labels in share mode;
  lock table public.heating_control_settings in share mode; lock table public.heating_plans in share mode;
  lock table public.electricity_prices in share mode; lock table public.v2_heating_plan_publications in share row exclusive mode;

  with expected as (select created_at,top_temp,bottom_temp,inlet_temp,heating from jsonb_to_recordset(p_expected_tank_replay) as r(created_at timestamptz,top_temp double precision,bottom_temp double precision,inlet_temp double precision,heating boolean)), current_rows as (select created_at,top_temp::double precision,bottom_temp::double precision,inlet_temp::double precision,heating from public.tank_readings where created_at>=p_replay_start_at and created_at<=p_replay_end_at), delta as ((select * from expected except all select * from current_rows) union all (select * from current_rows except all select * from expected)) select count(*) into conflict_count from delta;
  if conflict_count>0 then return 'tank_snapshot_conflict'; end if;
  if not exists(select 1 from public.tank_readings r where r.created_at=expected_created_at and r.top_temp is not distinct from expected_top_temp and r.bottom_temp is not distinct from expected_bottom_temp and r.inlet_temp is not distinct from expected_inlet_temp and r.heating is not distinct from expected_heating) then return 'tank_snapshot_conflict'; end if;
  if exists(select 1 from public.tank_readings r where r.created_at>p_replay_end_at) then return 'tank_snapshot_conflict'; end if;

  with expected as (select event_started_at,event_ended_at,estimated_water_draw_net_energy_kwh,energy_reliable,energy_quality_reason from jsonb_to_recordset(p_expected_water_draw_snapshot) as d(event_started_at timestamptz,event_ended_at timestamptz,estimated_water_draw_net_energy_kwh double precision,energy_reliable boolean,energy_quality_reason text)), current_rows as (select event_started_at,event_ended_at,estimated_water_draw_net_energy_kwh::double precision,energy_reliable,energy_quality_reason from public.water_draw_labels where event_ended_at>=p_replay_start_at and event_started_at<=p_replay_end_at), delta as ((select * from expected except all select * from current_rows) union all (select * from current_rows except all select * from expected)) select count(*) into conflict_count from delta;
  if conflict_count>0 then return 'water_draw_snapshot_conflict'; end if;

  if not exists(select 1 from public.heating_control_settings s cross join jsonb_to_record(p_expected_settings_snapshot) as e(id integer,max_tank_temperature double precision,automatic_max_heating_hours double precision,v2_target_reserve_percent double precision,v2_safety_reserve_percent double precision) where s.id=1 and e.id=1 and s.max_tank_temperature is not distinct from e.max_tank_temperature and s.automatic_max_heating_hours is not distinct from e.automatic_max_heating_hours and s.v2_target_reserve_percent is not distinct from e.v2_target_reserve_percent and s.v2_safety_reserve_percent is not distinct from e.v2_safety_reserve_percent) then return 'settings_conflict'; end if;

  with dates as (select value::date plan_date from jsonb_array_elements_text(p_constraint_plan_dates)), expected as (select plan_date,planned_hours,mode from jsonb_to_recordset(p_expected_constraint_plans) as p(plan_date date,planned_hours integer[],mode text)), current_rows as (select h.plan_date,h.planned_hours,h.mode from public.heating_plans h join dates d using(plan_date)), delta as ((select * from expected except all select * from current_rows) union all (select * from current_rows except all select * from expected)) select count(*) into conflict_count from delta;
  if conflict_count>0 then return 'constraint_plan_conflict'; end if;

  -- Recheck the complete original Edge price-query scope, not merely the contiguous
  -- snapshot span. The Edge query was: FI/60m, ends_at > captured now
  -- (p_replay_end_at), starts_at <= p_price_fetch_end_at. Any insertion, deletion,
  -- duplicate or value change anywhere in that scope invalidates publication.
  with expected as (
    select starts_at,ends_at,spot_price_cents_kwh,resolution_minutes
    from jsonb_to_recordset(p_expected_price_snapshot) as p(starts_at timestamptz,ends_at timestamptz,spot_price_cents_kwh numeric,resolution_minutes integer)
  ), current_rows as (
    select starts_at,ends_at,spot_price_cents_kwh,resolution_minutes
    from public.electricity_prices
    where region='FI' and resolution_minutes=60
      and ends_at>p_replay_end_at and starts_at<=p_price_fetch_end_at
  ), delta as (
    (select * from expected except all select * from current_rows)
    union all
    (select * from current_rows except all select * from expected)
  ) select count(*) into conflict_count from delta;
  if conflict_count>0 then return 'price_snapshot_conflict'; end if;

  with expected as (select * from jsonb_to_recordset(p_expected_plan_versions) as v(plan_date date,updated_at timestamptz)) select count(*) into conflict_count from expected e left join public.v2_heating_plan_publications c on c.plan_date=e.plan_date where (e.updated_at is null and c.plan_date is not null) or (e.updated_at is not null and (c.plan_date is null or c.updated_at is distinct from e.updated_at));
  if conflict_count>0 then return 'plan_snapshot_conflict'; end if;

  plan_count:=jsonb_array_length(p_plans);
  insert into public.v2_heating_plan_publications(plan_date,planned_hours,source,published_at,anchor_tank_reading_at,forecast_horizon_end_at,updated_at)
  select p.plan_date,coalesce(array(select distinct value::integer from jsonb_array_elements_text(p.planned_hours) value order by value::integer),'{}'),'v2_energy_plan',p_published_at,expected_created_at,p_forecast_horizon_end_at,p_published_at from jsonb_to_recordset(p_plans) as p(plan_date date,planned_hours jsonb)
  on conflict(plan_date) do update set planned_hours=excluded.planned_hours,source=excluded.source,published_at=excluded.published_at,anchor_tank_reading_at=excluded.anchor_tank_reading_at,forecast_horizon_end_at=excluded.forecast_horizon_end_at,updated_at=excluded.updated_at;
  get diagnostics written_count=row_count;
  if written_count<>plan_count then raise exception 'V2 staged publication row-count mismatch'; end if;
  return 'published';
end; $$;

revoke all on function public.publish_v2_heating_plans_staged(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz) from public,anon,authenticated;
grant execute on function public.publish_v2_heating_plans_staged(jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,jsonb,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz) to service_role;
