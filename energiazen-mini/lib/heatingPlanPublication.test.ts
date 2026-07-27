import {
  canPublishActiveHeatingPlan,
  getChangedHeatingPlans,
  getHeatingPlanPresentationSource,
  publishLatestHeatingPlan,
} from "./heatingPlanPublication";
import type { PublishedHeatingPlanState } from "./heatingPlanPublication";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertSame(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected the same object reference`);
  }
}

export function runHeatingPlanPublicationUnitTests() {
  assertEqual(
    canPublishActiveHeatingPlan({
      hasUnsavedChanges: true,
      isOptimizationCurrent: true,
    }),
    false,
    "skenaariosuunnitelmaa ei voi julkaista",
  );
  assertEqual(
    canPublishActiveHeatingPlan({
      hasUnsavedChanges: false,
      isOptimizationCurrent: true,
    }),
    true,
    "vain ajantasainen aktiivinen suunnitelma voidaan julkaista",
  );

  const oldPublication: PublishedHeatingPlanState<
    { plannedHours: number[] },
    number
  > = {
    hours: [6],
    inputKey: "old",
    result: { plannedHours: [6] },
    runId: 2,
  };
  assertEqual(
    publishLatestHeatingPlan(oldPublication, {
      hours: [],
      inputKey: "loading",
      result: null,
      runId: 3,
    }),
    oldPublication,
    "loading tai valiaikainen tyhja tulos ei tyhjenna julkaistua korttia",
  );
  const newPublication: PublishedHeatingPlanState<
    { plannedHours: number[] },
    number
  > = {
    hours: [13],
    inputKey: "new",
    result: { plannedHours: [13] },
    runId: 3,
  };
  assertEqual(
    publishLatestHeatingPlan(oldPublication, newPublication),
    newPublication,
    "uusi tulos ja sen tunnit julkaistaan yhdella atomisella paivityksella",
  );
  assertEqual(
    publishLatestHeatingPlan(newPublication, oldPublication),
    newPublication,
    "vanha asynkroninen tulos ei ylikirjoita uudempaa julkaisua",
  );
  assertSame(
    publishLatestHeatingPlan(newPublication, { ...newPublication }),
    newPublication,
    "sama run id ei paivita korttia eika vuorottele planned_hours-arvoa",
  );

  const storedPlan = {
    mode: "automatic",
    plan_date: "2026-07-26",
    planned_hours: [6, 13],
    reason: "old",
    target_hours: 2,
    updated_at: "2026-07-26T05:00:00.000Z",
  };

  assertEqual(
    getHeatingPlanPresentationSource({
      hasPublishedOptimization: false,
      hasStoredPlan: true,
    }),
    "stored",
    "tallennettu suunnitelma nakyy uuden laskennan valmistumiseen asti",
  );
  assertEqual(
    getHeatingPlanPresentationSource({
      hasPublishedOptimization: true,
      hasStoredPlan: true,
    }),
    "optimizer",
    "uusi optimointitulos vaihtuu esityslahteeksi atomisesti",
  );
  assertEqual(
    getHeatingPlanPresentationSource({
      hasPublishedOptimization: true,
      hasStoredPlan: false,
    }),
    "optimizer",
    "loading tai tallennetun haun tyhjeneminen ei poista julkaistua tulosta",
  );

  const identicalPlan = {
    ...storedPlan,
    planned_hours: [13, 6, 6],
    reason: "new diagnostics",
    updated_at: "2026-07-26T06:00:00.000Z",
  };
  assertEqual(
    getChangedHeatingPlans(
      { "2026-07-26": storedPlan },
      [identicalPlan],
    ),
    [],
    "identtinen operatiivinen suunnitelma ei aiheuta upsertia",
  );
  assertEqual(
    getChangedHeatingPlans(
      { "2026-07-26": storedPlan },
      [{ ...identicalPlan, planned_hours: [13] }],
    ).length,
    1,
    "muuttunut planned_hours julkaistaan",
  );

  const unchangedPollSources = Array.from({ length: 3 }, () =>
    getHeatingPlanPresentationSource({
      hasPublishedOptimization: true,
      hasStoredPlan: true,
    }),
  );
  assertEqual(
    unchangedPollSources,
    ["optimizer", "optimizer", "optimizer"],
    "muuttumaton 30 sekunnin pollaus ei vaihda kortin lahdetta",
  );
}
