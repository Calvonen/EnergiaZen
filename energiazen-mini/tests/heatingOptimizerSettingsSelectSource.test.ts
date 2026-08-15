import { readFileSync } from "node:fs";
import { join } from "node:path";

function assertSource(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

// Regression guard for the class of bug that let price_tolerance_cents
// silently resolve to the optimizer's default (0) forever, even for users
// who had configured a tolerance in the app: resolveOptimizerSettings reads
// row.price_tolerance_cents, but the run-heating-optimizer .select() list
// never asked Postgres for that column, so the field was always undefined
// at runtime regardless of what was saved. Rather than hard-coding the
// expected column list (which the same mistake could silently drift out of
// sync with again), this derives the expected columns straight from
// RawHeatingControlSettingsRow, so any future field added to that type
// without a matching select() column fails this test.
export function runHeatingOptimizerSettingsSelectSourceTests() {
  const logicSource = readFileSync(
    join(process.cwd(), "supabase/functions/run-heating-optimizer/logic.ts"),
    "utf8",
  );
  const indexSource = readFileSync(
    join(process.cwd(), "supabase/functions/run-heating-optimizer/index.ts"),
    "utf8",
  );

  const typeStart = logicSource.indexOf(
    "export type RawHeatingControlSettingsRow = {",
  );
  const typeEnd = logicSource.indexOf("};", typeStart);
  assertSource(
    typeStart !== -1 && typeEnd > typeStart,
    "expected to find the RawHeatingControlSettingsRow type in logic.ts",
  );
  const typeBody = logicSource.slice(
    typeStart + "export type RawHeatingControlSettingsRow = {".length,
    typeEnd,
  );
  const expectedColumns = Array.from(
    typeBody.matchAll(/^\s*([a-z_]+)\??:/gm),
  ).map((match) => match[1]);
  assertSource(
    expectedColumns.length > 0,
    "expected to parse at least one column name from RawHeatingControlSettingsRow",
  );
  assertSource(
    expectedColumns.includes("price_tolerance_cents"),
    "sanity check: RawHeatingControlSettingsRow must still declare price_tolerance_cents",
  );

  const fromIndex = indexSource.indexOf('.from("heating_control_settings")');
  assertSource(
    fromIndex !== -1,
    "expected a heating_control_settings query in run-heating-optimizer/index.ts",
  );
  const selectStart = indexSource.indexOf(".select(", fromIndex);
  const selectEnd = indexSource.indexOf(")", selectStart);
  assertSource(
    selectStart !== -1 && selectEnd > selectStart,
    "expected to find the heating_control_settings .select() call",
  );
  const selectSource = indexSource.slice(selectStart, selectEnd);
  const selectedColumnsMatch = selectSource.match(/"([^"]+)"/);
  assertSource(
    selectedColumnsMatch !== null,
    "expected the heating_control_settings .select() call to select a quoted column list",
  );
  const selectedColumns = (selectedColumnsMatch?.[1] ?? "").split(",");

  for (const column of expectedColumns) {
    assertSource(
      selectedColumns.includes(column),
      `run-heating-optimizer must select "${column}" from heating_control_settings - resolveOptimizerSettings reads row.${column}, and a missing column silently falls back to the default forever, even when the user has saved a different value`,
    );
  }
  for (const column of selectedColumns) {
    assertSource(
      expectedColumns.includes(column),
      `run-heating-optimizer selects unexpected column "${column}" from heating_control_settings, which RawHeatingControlSettingsRow does not declare`,
    );
  }

  // The specific bug this test was written for: price_tolerance_cents must
  // be selected so the backend optimizer honours a user's saved price
  // tolerance, matching how the app's own local optimization already reads
  // it (see settingsScenarioContext.tsx / heatingOptimizer.ts).
  assertSource(
    selectedColumns.includes("price_tolerance_cents"),
    "price_tolerance_cents must be present in the run-heating-optimizer heating_control_settings select() list",
  );
}
