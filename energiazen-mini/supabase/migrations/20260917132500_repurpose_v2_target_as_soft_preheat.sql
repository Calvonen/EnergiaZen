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

-- Preserve every existing stored value. In particular, 75% may have been an
-- intentional user selection rather than merely the previous default, and the
-- database has no provenance that can distinguish those cases safely. The new
-- 90% value applies only as the default for newly created rows/settings.
alter table public.heating_control_settings
  add constraint heating_control_settings_v2_target_reserve_percent_check
    check (
      v2_target_reserve_percent >= 5
      and v2_target_reserve_percent <= 95
      and mod(v2_target_reserve_percent::numeric, 5) = 0
    );
