alter table public.heating_control_settings
  add column if not exists price_tolerance_cents double precision default 0;

comment on column public.heating_control_settings.price_tolerance_cents is
  'Price tolerance (c/kWh) for optimizeHeatingPlan''s internal hour ranking only - hours within this many cents of the cheapest hour in the optimization window are treated as equally cheap. Never changes stored electricity_prices values or values shown in the UI. 0 = disabled (default), matches prior behaviour.';
