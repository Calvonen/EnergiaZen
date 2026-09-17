alter table public.heating_control_settings
  add column if not exists v2_max_billed_price_cents_kwh double precision;

comment on column public.heating_control_settings.v2_max_billed_price_cents_kwh is
  'Optional V2 maximum billed electricity price in cents/kWh. NULL disables the ceiling. Advisory/telemetry only until explicitly wired into control.';
