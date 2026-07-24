grant select, insert, update
on table public.electricity_prices
to service_role;

grant select
on table public.electricity_prices
to authenticated;
