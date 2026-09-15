alter table public.heating_control_settings
  add column if not exists v2_target_reserve_percent double precision not null default 75,
  add column if not exists v2_safety_reserve_percent double precision not null default 30;

alter table public.heating_control_settings
  drop constraint if exists heating_control_settings_v2_target_reserve_percent_check,
  add constraint heating_control_settings_v2_target_reserve_percent_check
    check (v2_target_reserve_percent >= 5 and v2_target_reserve_percent <= 100),
  drop constraint if exists heating_control_settings_v2_safety_reserve_percent_check,
  add constraint heating_control_settings_v2_safety_reserve_percent_check
    check (v2_safety_reserve_percent >= 0 and v2_safety_reserve_percent <= 95),
  drop constraint if exists heating_control_settings_v2_reserve_percent_order_check,
  add constraint heating_control_settings_v2_reserve_percent_order_check
    check (v2_safety_reserve_percent <= v2_target_reserve_percent);
