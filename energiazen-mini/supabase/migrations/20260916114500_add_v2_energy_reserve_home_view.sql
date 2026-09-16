-- Expose only the latest user-facing V2 reserve fields needed by the home card.
-- The full shadow table remains service-role only and RLS-protected.
create or replace function public.get_v2_energy_reserve_home()
returns table (
  run_at timestamptz,
  available boolean,
  conservative_energy_kwh double precision,
  energy_capacity_kwh double precision,
  safety_reserve_percent integer,
  target_reserve_percent integer
)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select
    shadow.run_at,
    shadow.available,
    shadow.conservative_energy_kwh,
    shadow.energy_capacity_kwh,
    shadow.safety_reserve_percent,
    shadow.target_reserve_percent
  from public.v2_energy_reserve_shadow_runs as shadow
  order by shadow.run_at desc
  limit 1;
$$;

revoke all on function public.get_v2_energy_reserve_home() from public, anon;
grant execute on function public.get_v2_energy_reserve_home() to authenticated;
