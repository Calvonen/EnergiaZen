alter table public.tank_readings
  add column if not exists inlet_temp double precision;

comment on column public.tank_readings.inlet_temp is
  'Optional cold-water inlet temperature from the ESP32 tank monitor, null when the inlet sensor is not installed or its reading is invalid.';
