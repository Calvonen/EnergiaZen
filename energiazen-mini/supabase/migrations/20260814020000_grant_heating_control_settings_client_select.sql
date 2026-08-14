-- heating_control_settings was created directly in Supabase Studio before
-- migration tracking (the same situation documented for its service_role
-- grant in 20260812010000_fix_heating_optimizer_shadow_permissions_and_schema.sql),
-- so its anon/authenticated grants and RLS policies are not in this repo's
-- migration history either. The app already successfully upserts this table
-- today (app/settings.tsx, app/heating-learning.tsx) - INSERT/UPDATE access
-- for anon/authenticated must already exist - but nothing in tracked
-- history explicitly grants SELECT, which the new settings-completeness
-- backfill check (lib/heatingControlSettingsBackfill.ts,
-- lib/settingsScenarioContext.tsx) needs in order to read the row before
-- deciding whether to backfill it.
--
-- Idempotent/forward-only: safe to re-run. A plain GRANT is a no-op if
-- already granted. For the policy, this deliberately does not try to
-- semantically prove that some other pre-existing SELECT/ALL policy
-- already covers the app: a policy can be PERMISSIVE and target
-- anon/authenticated and still exclude this singleton row (e.g. a USING
-- predicate scoped to a different id, or to some other condition entirely)
-- - inspecting arbitrary policies for that would be unreliable and is not
-- attempted here. Instead this only ever checks for its own specific,
-- named policy and (re)creates exactly that one if it is missing, with a
-- USING predicate that unconditionally guarantees id = 1 - this table's
-- only row - is readable by anon/authenticated regardless of whatever
-- other policies exist. Existing policies are never dropped or altered.
grant select on table public.heating_control_settings to anon, authenticated;

do $$
begin
  if exists (
    select 1
    from pg_class
    where oid = 'public.heating_control_settings'::regclass
      and relrowsecurity
  ) and not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'heating_control_settings'
      and policyname = 'heating_control_settings is readable by the app'
  ) then
    create policy "heating_control_settings is readable by the app"
      on public.heating_control_settings for select
      to anon, authenticated
      using (id = 1);
  end if;
end
$$;
