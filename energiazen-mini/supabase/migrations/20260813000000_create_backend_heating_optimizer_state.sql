-- One singleton row is sufficient: Shelly needs the current trust decision,
-- not an unbounded event history (shadow diagnostics remain in
-- heating_plan_shadow_runs). Separate timestamps preserve PR #191's run,
-- validation, and actual-publication semantics.
create table public.backend_heating_optimizer_state (
  id smallint primary key default 1 check (id = 1),
  last_run_attempt_at timestamptz,
  last_validated_plan_at timestamptz,
  last_published_at timestamptz,
  health_status text not null check (health_status in ('healthy', 'unhealthy')),
  last_outcome text not null check (last_outcome in ('running', 'no_changes', 'changes_not_published', 'optimizer_invalid', 'deferred', 'run_error')),
  reason text,
  updated_at timestamptz not null default now()
);

alter table public.backend_heating_optimizer_state enable row level security;
grant select on table public.backend_heating_optimizer_state to anon, authenticated, service_role;
grant insert, update on table public.backend_heating_optimizer_state to service_role;
create policy "backend optimizer state is readable by devices"
  on public.backend_heating_optimizer_state for select to anon, authenticated using (true);

insert into public.backend_heating_optimizer_state
  (id, health_status, last_outcome, reason)
values (1, 'unhealthy', 'deferred', 'No optimizer run has been validated yet');
