-- PR #189 review fix: planned_hours_match now stays null whenever the
-- app's stored today-plan wasn't published in automatic mode (the backend
-- only ever runs the automatic optimizer, so comparing against a "fixed"
-- mode plan is not a meaningful parity signal - see run-heating-optimizer
-- logic.ts's buildShadowRunRow). app_plan_mode records which mode the
-- compared app plan actually was in, so a null planned_hours_match can be
-- told apart later (fixed mode vs. missing app plan vs. missing backend
-- plan) without re-joining heating_plans by plan_date/run_at.
alter table public.heating_plan_shadow_runs
  add column app_plan_mode text;
