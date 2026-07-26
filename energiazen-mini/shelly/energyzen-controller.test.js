const assert = require("assert");
const {
  START_HEATING_FILL_RATIO,
  calculateCurrentShowers,
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
  plannedHours = [15],
  reading = readingForShowers(3),
  relayCurrentlyOn = false,
  testSettings = settings,
} = {}) {
  return decideHeating({
    currentHour,
    failSafeReason: null,
    nowMs,
    plannedHours,
    reading,
    relayCurrentlyOn,
    settings: testSettings,
  });
}

assert.strictEqual(START_HEATING_FILL_RATIO, 0.9);

assert.strictEqual(
  decide({ reading: readingForShowers(6) }).finalTargetOn,
  false,
  "planned + full + relay OFF must stay OFF",
);
assert.strictEqual(
  decide({ reading: readingForShowers(5.4) }).finalTargetOn,
  false,
  "exactly 90 percent + relay OFF must stay OFF",
);
assert.strictEqual(
  decide({ reading: readingForShowers(6 * 0.89) }).finalTargetOn,
  true,
  "89 percent + relay OFF may start",
);
assert.strictEqual(
  decide({
    reading: readingForShowers(6),
    relayCurrentlyOn: true,
  }).finalTargetOn,
  true,
  "planned relay already ON may continue at 100 percent",
);
assert.strictEqual(
  decide({ currentHour: 14 }).finalTargetOn,
  false,
  "hour not planned must be OFF",
);
assert.strictEqual(
  decide({ reading: readingForShowers(3, 121) }).reason,
  "stale-reading",
  "stale reading must fail safe OFF",
);
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

const fallbackControl = resolvePlanControl(
  null,
  createRequestError("network down", true),
  settings,
  "2026-07-26",
);

assert.strictEqual(fallbackControl.source, "backup");
assert.strictEqual(
  decide({
    plannedHours: fallbackControl.plannedHours,
    reading: readingForShowers(6),
  }).finalTargetOn,
  false,
  "Supabase error fallback cannot bypass full-tank start block",
);
assert.strictEqual(
  decide({
    plannedHours: fallbackControl.plannedHours,
    reading: readingForShowers(3),
  }).finalTargetOn,
  true,
  "Supabase error fallback may start below 90 percent",
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
