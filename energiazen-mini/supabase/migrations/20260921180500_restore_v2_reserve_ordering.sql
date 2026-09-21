-- Restore the invariant required by hard-target V2 planning.
-- Existing inverted rows are repaired conservatively by raising the target to
-- the configured safety floor before the constraint is installed.
update public.heating_control_settings
set v2_target_reserve_percent = v2_safety_reserve_percent
where v2_safety_reserve_percent > v2_target_reserve_percent;

alter table public.heating_control_settings
  drop constraint if exists heating_control_settings_v2_reserve_percent_order_check,
  add constraint heating_control_settings_v2_reserve_percent_order_check
    check (v2_safety_reserve_percent <= v2_target_reserve_percent);
