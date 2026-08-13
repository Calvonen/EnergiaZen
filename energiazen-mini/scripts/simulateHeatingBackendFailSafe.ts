import { runAllScenarios, type ScenarioReportRow } from "./heatingBackendFailSafeScenarios";

declare const process: {
  exitCode?: number;
};

function printReport(rows: ScenarioReportRow[]) {
  console.table(
    rows.map((row) => ({
      scenario: row.scenario,
      "PASS/FAIL": row.passFail,
      optimizer_status: row.optimizerStatus,
      plan_status: row.planStatus,
      fallback_expected: row.fallbackExpected,
      alert_expected: row.alertExpected,
      alert_reason: row.alertReason ?? "",
      last_validated_plan_age_min: row.lastValidatedPlanAgeMinutes,
      last_published_age_min: row.lastPublishedAgeMinutes,
    })),
  );

  for (const row of rows) {
    console.log(`\n=== ${row.scenario}: ${row.passFail} ===`);
    console.log(row.notes);
    if (row.failures.length > 0) {
      console.log("  Poikkeamat odotuksesta:");
      for (const failure of row.failures) {
        console.log(`    - ${failure}`);
      }
    }
  }
}

function main() {
  const rows = runAllScenarios();
  printReport(rows);

  const failedCount = rows.filter((row) => row.passFail === "FAIL").length;
  console.log(`\n${rows.length - failedCount}/${rows.length} skenaariota PASS.`);

  if (failedCount > 0) {
    process.exitCode = 1;
  }
}

main();
