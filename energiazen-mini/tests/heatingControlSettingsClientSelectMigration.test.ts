import { readFileSync } from "node:fs";
import { join } from "node:path";

function assertSource(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

const intendedPolicyName = "heating_control_settings is readable by the app";

// Codex P2 follow-up: checking whether some *other* existing SELECT/ALL
// policy is PERMISSIVE and covers anon/authenticated is not actually
// sufficient - such a policy can still exclude this singleton row via its
// own USING predicate (e.g. scoped to a different id, or some unrelated
// condition), and there is no reliable way to semantically prove an
// arbitrary policy's USING clause covers id = 1. The safest approach is to
// stop trying to evaluate other policies at all: only ever check for this
// migration's own specific, named policy, and (re)create exactly that one -
// with a USING predicate that unconditionally guarantees id = 1 is
// readable - whenever it is missing. Any other existing policy, no matter
// how permissive its role coverage looks, must never suppress that.
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

  // The guard must check specifically for this migration's own named
  // policy, scoped to the right schema/table...
  assertSource(
    guardSource.includes("schemaname = 'public'") &&
      guardSource.includes("tablename = 'heating_control_settings'") &&
      guardSource.includes(`policyname = '${intendedPolicyName}'`),
    "the guard must check specifically for the intended named app-read policy by policyname",
  );

  // ...and must NOT attempt to semantically prove some other arbitrary
  // policy is equivalent (permissive/role-coverage inspection) - that was
  // the exact gap being closed, since such a check can be satisfied by a
  // policy whose USING predicate still excludes id = 1. An unrelated
  // existing app-role policy - however permissive, however broad its role
  // list - must therefore never be treated as sufficient on its own; only
  // presence of this exact policy name may skip (re)creation.
  assertSource(
    !guardSource.includes("permissive") && !guardSource.includes("roles"),
    "the guard must not rely on inspecting arbitrary policies' permissive/role coverage - only the exact named policy's presence may skip creation",
  );

  const createPolicyOccurrences = migrationSource.split("create policy").length - 1;
  assertSource(
    createPolicyOccurrences === 1,
    "the migration must define exactly one policy - no unconditional duplicate creation outside the guard",
  );

  const policyBlockStart = migrationSource.indexOf(
    `create policy "${intendedPolicyName}"`,
  );
  assertSource(
    policyBlockStart !== -1 && policyBlockStart > guardEnd,
    "the create policy statement must be the one guarded by the not-exists(...) check above, proving re-running the migration is idempotent once the named policy exists",
  );
  const policyBlockSource = migrationSource.slice(policyBlockStart);
  assertSource(
    policyBlockSource.includes("on public.heating_control_settings for select") &&
      policyBlockSource.includes("to anon, authenticated") &&
      policyBlockSource.includes("using (id = 1);"),
    "the created policy must grant anon/authenticated SELECT access specifically to the singleton row id = 1",
  );

  // No DROP/REVOKE/ALTER ... DISABLE ROW LEVEL SECURITY - this migration
  // must only ever add read access, never remove or weaken anything else.
  assertSource(
    !/\b(drop|revoke|delete|truncate)\b/i.test(migrationSource) &&
      !/disable row level security/i.test(migrationSource),
    "the migration must only add SELECT access - it must not drop/revoke anything or disable RLS",
  );
}
