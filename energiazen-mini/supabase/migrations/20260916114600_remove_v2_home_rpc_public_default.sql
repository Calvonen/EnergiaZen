-- Explicitly retain least privilege if default function privileges change later.
revoke execute on function public.get_v2_energy_reserve_home() from public;
revoke execute on function public.get_v2_energy_reserve_home() from anon;
grant execute on function public.get_v2_energy_reserve_home() to authenticated;
