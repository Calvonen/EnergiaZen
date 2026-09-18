create or replace function public.get_confirmed_cold_inlet_baseline(
  p_since timestamptz default now() - interval '7 days',
  p_until timestamptz default now()
)
returns double precision
language sql
stable
security definer
set search_path = public
as $$
  with candidates as materialized (
    select created_at, inlet_temp
    from public.tank_readings
    where created_at >= p_since
      and created_at <= p_until
      and inlet_temp between 1 and 30
  ),
  confirmed as (
    select candidate.inlet_temp
    from candidates candidate
    where exists (
      select 1
      from candidates neighbor
      where neighbor.created_at <> candidate.created_at
        and neighbor.created_at between
          candidate.created_at - interval '3 minutes'
          and candidate.created_at + interval '3 minutes'
        and neighbor.inlet_temp >= candidate.inlet_temp
        and neighbor.inlet_temp <= candidate.inlet_temp + 2
    )
  )
  select min(inlet_temp)::double precision
  from confirmed;
$$;

revoke all on function public.get_confirmed_cold_inlet_baseline(timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_confirmed_cold_inlet_baseline(timestamptz, timestamptz)
  to service_role;
