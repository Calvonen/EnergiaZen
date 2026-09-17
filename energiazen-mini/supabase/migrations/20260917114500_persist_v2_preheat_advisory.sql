alter table public.v2_energy_reserve_shadow_runs
  add column if not exists preheat_advisory jsonb;

comment on column public.v2_energy_reserve_shadow_runs.preheat_advisory is
  'Full V2 preheat advisory snapshot for this shadow run, including strategy, reason, recommended hours, headroom, displacement pairs, and the soft preheat level.';
