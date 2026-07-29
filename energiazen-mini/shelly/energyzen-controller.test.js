const assert = require("assert");
const {
  REQUIRED_BLOCKING_READINGS,
  START_HEATING_FILL_RATIO,
  calculateCurrentShowers,
  createControllerState,
  createRequestError,
  decideHeating,
  resolvePlanControl,
} = require("./energyzen-controller");

const nowMs = Date.parse("2026-07-26T12:00:00.000Z");
const settings = {
  backupHours: [15],
  enabled: true,
  fullTankAverageTemperature: 70,
  fullTankShowers: 6,
  maxTankTemperature: 80,
  minTankTemperature: 10,
  targetShowerReserve: 3,
};

function readingForShowers(showers, ageSeconds = 30) {
  let lower = 42;
  let upper = settings.fullTankAverageTemperature;

  for (let iteration = 0; iteration < 80; iteration += 1) {
    let temperature = (lower + upper) / 2;
    let estimate = calculateCurrentShowers(
      {
        bottom_temp: temperature,
        top_temp: temperature,
      },
      settings,
    );

    if (estimate < showers) {
      lower = temperature;
    } else {
      upper = temperature;
    }
  }

  return {
    bottom_temp: (lower + upper) / 2,
    created_at: new Date(nowMs - ageSeconds * 1000).toISOString(),
    heating: false,
    top_temp: (lower + upper) / 2,
  };
}

function decide({
  currentHour = 15,
  failSafeReason = null,
  plannedHours = [15],
  reading = readingForShowers(3),
  relayCurrentlyOn = false,
  state = createControllerState(),
  testSettings = settings,
} = {}) {
  return decideHeating(
    {
      currentHour,
      failSafeReason,
      nowMs,
      plannedHours,
      reading,
      relayCurrentlyOn,
      settings: testSettings,
    },
    state,
  );
}

assert.strictEqual(START_HEATING_FILL_RATIO, 0.92);
assert.strictEqual(REQUIRED_BLOCKING_READINGS, 2);

const highFillState = createControllerState();
const firstHighFill = decide({
  reading: readingForShowers(6),
  state: highFillState,
});
assert.strictEqual(firstHighFill.finalTargetOn, false);
assert.strictEqual(firstHighFill.startBlockedByFillRatio, false);
assert.strictEqual(firstHighFill.consecutiveHighFillReadings, 1);
assert.strictEqual(firstHighFill.reason, "start-fill-ratio-pending");

const secondHighFill = decide({
  reading: readingForShowers(6),
  state: highFillState,
});
assert.strictEqual(secondHighFill.finalTargetOn, false);
assert.strictEqual(secondHighFill.startBlockedByFillRatio, true);
assert.strictEqual(secondHighFill.consecutiveHighFillReadings, 2);
assert.strictEqual(secondHighFill.reason, "start-fill-ratio");

const exactThresholdState = createControllerState();
const exactThresholdShowers = settings.fullTankShowers * 0.92;
decide({
  reading: readingForShowers(exactThresholdShowers),
  state: exactThresholdState,
});
const exactThresholdDecision = decide({
  reading: readingForShowers(exactThresholdShowers),
  state: exactThresholdState,
});
assert.strictEqual(exactThresholdDecision.finalTargetOn, false);
assert.strictEqual(
  exactThresholdDecision.startThresholdShowers,
  exactThresholdShowers,
);

const resetBelowState = createControllerState();
decide({ reading: readingForShowers(6), state: resetBelowState });
const belowThreshold = decide({
  reading: readingForShowers(settings.fullTankShowers * 0.91),
  state: resetBelowState,
});
assert.strictEqual(belowThreshold.finalTargetOn, true);
assert.strictEqual(belowThreshold.consecutiveHighFillReadings, 0);
assert.strictEqual(belowThreshold.reason, "planned-heating-starts");

const lowFirst = decide({
  reading: readingForShowers(settings.fullTankShowers * 0.91),
});
assert.strictEqual(lowFirst.finalTargetOn, true);
assert.strictEqual(lowFirst.reason, "planned-heating-starts");

const relayOnState = createControllerState();
decide({ reading: readingForShowers(6), state: relayOnState });
const relayAlreadyOn = decide({
  reading: readingForShowers(6),
  relayCurrentlyOn: true,
  state: relayOnState,
});
assert.strictEqual(relayAlreadyOn.finalTargetOn, true);
assert.strictEqual(relayAlreadyOn.consecutiveHighFillReadings, 0);
assert.strictEqual(relayAlreadyOn.reason, "planned-heating-continues");

const unplannedState = createControllerState();
decide({ reading: readingForShowers(6), state: unplannedState });
const unplanned = decide({ currentHour: 14, state: unplannedState });
assert.strictEqual(unplanned.finalTargetOn, false);
assert.strictEqual(unplanned.consecutiveHighFillReadings, 0);

const staleState = createControllerState();
decide({ reading: readingForShowers(6), state: staleState });
const stale = decide({
  reading: readingForShowers(3, 121),
  state: staleState,
});
assert.strictEqual(stale.reason, "stale-reading");
assert.strictEqual(stale.finalTargetOn, false);
assert.strictEqual(stale.consecutiveHighFillReadings, 0);

assert.strictEqual(
  decide({ reading: null }).reason,
  "missing-reading",
  "missing reading must fail safe OFF",
);
assert.strictEqual(
  decide({
    testSettings: { ...settings, fullTankShowers: null },
  }).reason,
  "invalid-calibration",
  "invalid calibration must fail safe OFF",
);

const failSafeState = createControllerState();
decide({ reading: readingForShowers(6), state: failSafeState });
const failSafe = decide({
  failSafeReason: "plan-fetch-error",
  state: failSafeState,
});
assert.strictEqual(failSafe.finalTargetOn, false);
assert.strictEqual(failSafe.consecutiveHighFillReadings, 0);

const isolatedStateA = createControllerState();
const isolatedStateB = createControllerState();
decide({ reading: readingForShowers(6), state: isolatedStateA });
assert.strictEqual(isolatedStateA.consecutiveHighFillReadings, 1);
assert.strictEqual(isolatedStateB.consecutiveHighFillReadings, 0);

const fallbackControl = resolvePlanControl(
  null,
  createRequestError("network down", true),
  settings,
  "2026-07-26",
);

assert.strictEqual(fallbackControl.source, "backup");
assert.strictEqual(fallbackControl.resetHighFillReadings, true);
const fallbackHighState = createControllerState();
decide({
  plannedHours: fallbackControl.plannedHours,
  reading: readingForShowers(6),
  state: fallbackHighState,
});
assert.strictEqual(
  decide({
    plannedHours: fallbackControl.plannedHours,
    reading: readingForShowers(6),
    state: fallbackHighState,
  }).finalTargetOn,
  false,
  "fallback must use the same two-reading start block",
);
assert.strictEqual(
  decide({
    plannedHours: fallbackControl.plannedHours,
    reading: readingForShowers(3),
  }).finalTargetOn,
  true,
  "Supabase error fallback may start below 92 percent",
);
assert.strictEqual(
  decide({
    plannedHours: fallbackControl.plannedHours,
    reading: readingForShowers(3, 121),
  }).finalTargetOn,
  false,
  "Supabase error fallback cannot bypass a stale reading",
);

const invalidResponseControl = resolvePlanControl(
  null,
  createRequestError("invalid JSON", false),
  settings,
  "2026-07-26",
);
assert.strictEqual(
  invalidResponseControl.source,
  "fail-safe",
  "non-connection errors must not activate fallback",
);

const missingPlanControl = resolvePlanControl(
  [],
  null,
  settings,
  "2026-07-26",
);
assert.strictEqual(
  missingPlanControl.source,
  "fail-safe",
  "a missing plan must not activate fallback",
);

console.log("EnergyZen Shelly controller tests passed");
