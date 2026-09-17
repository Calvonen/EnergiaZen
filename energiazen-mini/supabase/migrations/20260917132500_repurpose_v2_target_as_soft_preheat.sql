-- v2_target_reserve_percent keeps its existing storage/API name for
-- compatibility, but from this migration onward it represents the V2 soft
-- economic preheat recommendation rather than a hard reserve target.

alter table public.heating_control_settings
  alter column v2_target_reserve_percent set default 90,
  drop constraint if exists heating_control_settings_v2_target_reserve_percent_check,
  drop constraint if exists heating_control_settings_v2_reserve_percent_order_check;

-- 75% was the previous default and becomes the new 90% soft-preheat default.
-- Older explicitly low values were valid under the previous 5-95% contract;
-- clamp those to the new visible 70% minimum before installing the new
-- constraint so the migration remains deployable on upgraded databases.
update public.heating_control_settings
set v2_target_reserve_percent = case
  when v2_target_reserve_percent = 75 then 90
  when v2_target_reserve_percent < 70 then 70
  else v2_target_reserve_percent
end;

alter table public.heating_control_settings
  add constraint heating_control_settings_v2_target_reserve_percent_check
    check (
      v2_target_reserve_percent >= 70
      and v2_target_reserve_percent <= 95
      and mod(v2_target_reserve_percent::numeric, 5) = 0
    );
