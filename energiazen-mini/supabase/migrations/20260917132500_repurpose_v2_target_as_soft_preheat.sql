-- v2_target_reserve_percent keeps its existing storage/API name for
-- compatibility, but from this migration onward new V2 consumers interpret
-- it as the soft economic preheat recommendation rather than a hard reserve
-- target.
--
-- Keep the database write contract compatible with already-deployed clients:
-- older app versions can still write any legacy 5-95% value in 5-point
-- increments. New consumers clamp that persisted value to the new visible
-- 70-95% recommendation range at the read/policy boundary. This avoids a
-- migration-first rollout breaking unrelated Settings saves on older apps.
alter table public.heating_control_settings
  alter column v2_target_reserve_percent set default 90,
  drop constraint if exists heating_control_settings_v2_target_reserve_percent_check,
  drop constraint if exists heating_control_settings_v2_reserve_percent_order_check;

-- 75% was the previous default. Move only that default to the new 90% soft
-- recommendation; preserve other legacy values so older installed clients
-- remain writable during the staggered rollout.
update public.heating_control_settings
set v2_target_reserve_percent = 90
where v2_target_reserve_percent = 75;

alter table public.heating_control_settings
  add constraint heating_control_settings_v2_target_reserve_percent_check
    check (
      v2_target_reserve_percent >= 5
      and v2_target_reserve_percent <= 95
      and mod(v2_target_reserve_percent::numeric, 5) = 0
    );
