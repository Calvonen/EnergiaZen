-- Codex P2 (PR #193): the Home screen's storedHeatingPlans never reflected
-- a backend publication while the screen stayed mounted, because nothing
-- local updated it between the periodic reload keyed on visible plan dates.
-- The app now subscribes to Postgres changes on heating_plans directly
-- (see app/(tabs)/index.tsx) - that only works once this table is part of
-- the Supabase Realtime publication, which it was not (no earlier
-- migration in this repo enables Realtime on any table).
--
-- Idempotent/forward-only: safe to re-run, and degrades to a warning
-- instead of failing if the supabase_realtime publication does not exist
-- in this environment.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'heating_plans'
    ) then
      alter publication supabase_realtime add table public.heating_plans;
    end if;
  else
    raise warning 'supabase_realtime publication not found; heating_plans Realtime postgres_changes will not be enabled by this migration';
  end if;
end
$$;
