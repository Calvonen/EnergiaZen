-- Expose only the latest user-facing V2 reserve fields needed by the home card.
-- Keep the full shadow diagnostics service-role only.
create or replace view public.v2_energy_reserve_home
with (security_invoker = true)
as
select
  run_at,
  available,
  conservative_energy_kwh,
  energy_capacity_kwh,
  safety_reserve_percent,
  target_reserve_percent
from public.v2_energy_reserve_shadow_runs;

revoke all on public.v2_energy_reserve_home from public, anon;
grant select on public.v2_energy_reserve_home to authenticated;

-- security_invoker means the caller also needs narrowly-scoped column access
-- on the source relation; do not expose the rest of the shadow diagnostics.
grant select (
  run_at,
  available,
  conservative_energy_kwh,
  energy_capacity_kwh,
  safety_reserve_percent,
  target_reserve_percent
) on public.v2_energy_reserve_shadow_runs to authenticated;
