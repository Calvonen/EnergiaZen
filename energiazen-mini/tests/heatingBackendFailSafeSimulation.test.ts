import { runAllScenarios } from "../scripts/heatingBackendFailSafeScenarios";

// Regression test for the offline fail-safe simulator - see
// scripts/heatingBackendFailSafeScenarios.ts for the scenario
// definitions themselves. This turns "does fail-safe behaviour still
// hold" into something `npm test` fails on, not just something a console
// table (npm run simulate:heating-failsafe) shows if someone happens to
// look at it.
export function runHeatingBackendFailSafeSimulationTests() {
  const rows = runAllScenarios();

  for (const row of rows) {
    if (row.passFail !== "PASS") {
      throw new Error(
        `Fail-safe-simulaation skenaario ${row.scenario} epaonnistui:\n` +
          row.failures.map((failure) => `  - ${failure}`).join("\n"),
      );
    }
  }

  if (rows.length !== 9) {
    throw new Error(
      `Expected all 9 fail-safe scenarios to run, got ${rows.length}: ${rows
        .map((row) => row.scenario)
        .join(", ")}`,
    );
  }
}
