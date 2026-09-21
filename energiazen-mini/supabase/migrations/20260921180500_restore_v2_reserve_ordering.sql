-- Restore the invariants required by hard-target V2 planning.
-- Legacy soft-preheat storage allowed target values below the current 70%
-- hard-target minimum. Bring those rows into the supported range first, then
-- repair any inverted safety/target pair before tightening the constraints.
update public.heating_control_settings
set v2_target_reserve_percent = greatest(v2_target_reserve_percent, 70);

update public.heating_control_settings
set v2_target_reserve_percent = v2_safety_reserve_percent
where v2_safety_reserve_percent > v2_target_reserve_percent;

alter table public.heating_control_settings
  drop constraint if exists heating_control_settings_v2_target_reserve_percent_check,
  drop constraint if exists heating_control_settings_v2_reserve_percent_order_check,
  add constraint heating_control_settings_v2_target_reserve_percent_check
    check (
      v2_target_reserve_percent >= 5
      and v2_target_reserve_percent <= 95
      and mod(v2_target_reserve_percent::numeric, 5) = 0
    ),
  add constraint heating_control_settings_v2_reserve_percent_order_check
    check (v2_safety_reserve_percent <= v2_target_reserve_percent);
