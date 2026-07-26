alter table public.heating_control_settings
  add column if not exists target_shower_reserve double precision,
  add column if not exists full_tank_showers double precision,
  add column if not exists full_tank_average_temperature double precision,
  add column if not exists min_tank_temperature double precision,
  add column if not exists max_tank_temperature double precision,
  add column if not exists updated_at timestamptz;

comment on column public.heating_control_settings.target_shower_reserve is
  'Minimum desired shower reserve used by the Shelly heating controller.';
comment on column public.heating_control_settings.full_tank_showers is
  'Calibrated shower count for a full tank.';
comment on column public.heating_control_settings.full_tank_average_temperature is
  'Calibrated 70/30 weighted temperature for a full tank.';
comment on column public.heating_control_settings.min_tank_temperature is
  'Minimum tank temperature used by the shared shower estimate.';
comment on column public.heating_control_settings.max_tank_temperature is
  'Maximum configured tank temperature used to validate calibration.';
