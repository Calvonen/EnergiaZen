create or replace function public.get_v2_publication_cutover_enabled()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from pg_catalog.pg_trigger as trigger
    join pg_catalog.pg_class as relation
      on relation.oid = trigger.tgrelid
    join pg_catalog.pg_namespace as namespace
      on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname = 'v2_heating_plan_publications'
      and trigger.tgname = 'mirror_v2_heating_plan_to_production'
      and not trigger.tgisinternal
      and trigger.tgenabled in ('O', 'A')
  );
$$;

revoke all on function public.get_v2_publication_cutover_enabled() from public, anon, authenticated;
grant execute on function public.get_v2_publication_cutover_enabled() to service_role;

comment on function public.get_v2_publication_cutover_enabled() is
  'Returns whether the V2 staged-to-production mirror trigger is currently enabled. Used for audit/readiness telemetry; does not change cutover state.';
