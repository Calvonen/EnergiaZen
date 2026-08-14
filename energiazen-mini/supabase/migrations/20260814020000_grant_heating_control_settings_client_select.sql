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
-- already granted; the policy is only created if RLS is enabled on the
-- table and no SELECT/ALL policy already covers it.
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
      and cmd in ('SELECT', 'ALL')
  ) then
    create policy "heating_control_settings is readable by the app"
      on public.heating_control_settings for select
      to anon, authenticated
      using (true);
  end if;
end
$$;
