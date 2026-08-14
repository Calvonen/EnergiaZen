import { readFileSync } from "node:fs";
import { join } from "node:path";

function assertSource(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

// Codex P2 follow-up: the original guard only checked whether *any*
// SELECT/ALL policy existed on heating_control_settings before skipping
// policy creation - a restrictive policy, or one scoped to an unrelated
// role (e.g. service_role-only), would satisfy that check while leaving
// anon/authenticated with no actual read access, and the migration would
// silently skip creating the one policy that would have granted it. The
// guard must instead require the existing policy to be PERMISSIVE and to
// cover anon/authenticated (directly, or via the `public` pseudo-role)
// before treating app-role SELECT coverage as already sufficient.
export function runHeatingControlSettingsClientSelectMigrationTests() {
  const migrationSource = readFileSync(
    join(
      process.cwd(),
      "supabase/migrations/20260814020000_grant_heating_control_settings_client_select.sql",
    ),
    "utf8",
  );

  // The table-level GRANT must be unchanged.
  assertSource(
    migrationSource.includes(
      "grant select on table public.heating_control_settings to anon, authenticated;",
    ),
    "the table-level SELECT grant to anon/authenticated must be preserved",
  );

  const guardStart = migrationSource.indexOf("not exists (");
  const guardEnd = migrationSource.indexOf(") then", guardStart);
  const guardSource =
    guardStart !== -1 && guardEnd !== -1
      ? migrationSource.slice(guardStart, guardEnd)
      : "";
  assertSource(
    guardStart !== -1 && guardEnd !== -1,
    "expected to find the 'not exists (...) then' guard around the policy creation",
  );

  // The guard must still restrict to the same table/cmd baseline...
  assertSource(
    guardSource.includes("schemaname = 'public'") &&
      guardSource.includes("tablename = 'heating_control_settings'") &&
      guardSource.includes("cmd in ('SELECT', 'ALL')"),
    "the guard must still scope to public.heating_control_settings SELECT/ALL policies",
  );

  // ...but an existing SELECT/ALL policy must not be treated as sufficient
  // unless it is PERMISSIVE and actually covers anon/authenticated (or
  // `public`, which includes them). A policy that exists but is
  // restrictive, or grants some unrelated role only, must not suppress
  // creation of the app-readable policy.
  assertSource(
    guardSource.includes("permissive = 'PERMISSIVE'"),
    "an existing policy must be required to be PERMISSIVE, not just present, to count as sufficient app-role coverage",
  );
  assertSource(
    guardSource.includes("roles = '{public}'::name[]") &&
      guardSource.includes(
        "roles && array['anon', 'authenticated']::name[]",
      ),
    "an existing policy must be required to actually cover anon/authenticated (directly or via the public pseudo-role) to count as sufficient",
  );

  const policyBlockStart = migrationSource.indexOf(
    'create policy "heating_control_settings is readable by the app"',
  );
  assertSource(
    policyBlockStart !== -1 &&
      migrationSource
        .slice(policyBlockStart)
        .includes("on public.heating_control_settings for select") &&
      migrationSource.slice(policyBlockStart).includes("to anon, authenticated") &&
      migrationSource.slice(policyBlockStart).includes("using (true);"),
    "the fallback app-readable SELECT policy itself must be unchanged",
  );

  // No DROP/REVOKE/ALTER ... DISABLE ROW LEVEL SECURITY - this migration
  // must only ever add read access, never remove or weaken anything else.
  assertSource(
    !/\b(drop|revoke|delete|truncate)\b/i.test(migrationSource) &&
      !/disable row level security/i.test(migrationSource),
    "the migration must only add SELECT access - it must not drop/revoke anything or disable RLS",
  );
}
