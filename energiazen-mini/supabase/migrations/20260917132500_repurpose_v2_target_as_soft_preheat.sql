-- v2_target_reserve_percent keeps its existing storage/API name for
-- compatibility, but from this migration onward it represents the V2 soft
-- economic preheat recommendation rather than a hard reserve target.

alter table public.heating_control_settings
  alter column v2_target_reserve_percent set default 90;

alter table public.heating_control_settings
  drop constraint if exists heating_control_settings_v2_target_reserve_percent_check,
  add constraint heating_control_settings_v2_target_reserve_percent_check
    check (
      v2_target_reserve_percent >= 70
      and v2_target_reserve_percent <= 95
      and mod(v2_target_reserve_percent::numeric, 5) = 0
    ),
  drop constraint if exists heating_control_settings_v2_reserve_percent_order_check;

-- 75% was the previous hard-target default. Move rows that still carry that
-- default to the new 90% soft-preheat default. Other configured values are
-- preserved (and must satisfy the new 70-95% range).
update public.heating_control_settings
set v2_target_reserve_percent = 90
where v2_target_reserve_percent = 75;
