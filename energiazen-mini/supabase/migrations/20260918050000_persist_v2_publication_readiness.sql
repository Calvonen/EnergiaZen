alter table public.v2_energy_reserve_shadow_runs
  add column if not exists staged_publication_ready boolean,
  add column if not exists staged_publication_ready_reason text,
  add column if not exists staged_publication_result text,
  add column if not exists publication_cutover_enabled boolean,
  add column if not exists publication_ready boolean,
  add column if not exists publication_ready_reason text,
  add column if not exists publication_latest_publishable_tank_reading_at timestamptz;

comment on column public.v2_energy_reserve_shadow_runs.staged_publication_ready is
  'Whether the V2 staged publication guard passed for this shadow run. Telemetry only; does not enable production cutover.';

comment on column public.v2_energy_reserve_shadow_runs.publication_ready is
  'Whether the production publication guard would pass if cutover were enabled. With cutover disabled this remains false with reason cutover_disabled.';

comment on column public.v2_energy_reserve_shadow_runs.publication_cutover_enabled is
  'Runtime V2 production cutover flag captured for observability. This migration does not enable cutover.';
