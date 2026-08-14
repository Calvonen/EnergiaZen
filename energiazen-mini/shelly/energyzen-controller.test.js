const assert = require("assert");
const {
  REQUIRED_BLOCKING_READINGS,
  START_HEATING_FILL_RATIO,
  buildPlanFingerprint,
  calculateCurrentShowers,
  createControllerState,
  createRequestError,
  decideHeating,
  getHelsinkiParts,
  resolvePlanControl,
  resolveTrustedPlanControl,
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

// Ohjausdatan 120 sekunnin tuoreusraja on tarkoituksella paljon tiukempi
// kuin appin ja sahkopostihalytyksen 30 minuutin vikaraja. Shelly tarkistaa
// kerran minuutissa, joten 120 sekuntia vanha lukema kelpaa viela mutta heti
// sen jalkeen siirrytaan vain ennalta maaritettyjen varatuntien ohjaukseen.
const exactReadingAgeThreshold = decide({
  reading: readingForShowers(3, 120),
});
assert.strictEqual(exactReadingAgeThreshold.reason, "planned-heating-starts");
assert.strictEqual(exactReadingAgeThreshold.finalTargetOn, true);

// currentHour 15 on myos settings.backupHours - eli oletusparametrit
// osuvat varatunnille. Anturivika varatunnilla lammittaa nyt ehdoitta
// (varaajan oma termostaatti estaa ylikuumenemisen), toisin kuin
// tunnilla joka ei ole varatunti (ks. staleOutsideBackupHour alla).
const staleState = createControllerState();
decide({ reading: readingForShowers(6), state: staleState });
const stale = decide({
  reading: readingForShowers(3, 121),
  state: staleState,
});
assert.strictEqual(stale.reason, "backup-fault-override");
assert.strictEqual(stale.finalTargetOn, true);
assert.strictEqual(stale.consecutiveHighFillReadings, 0);

// Varatila ei saa jaada paalle: kun seuraavan tarkistuksen lukema on taas
// tuore, paatos tehdaan normaalisti suunnitelman ja tayttoasteen perusteella.
const recoveredAfterStale = decide({
  currentHour: 15,
  plannedHours: [10],
  reading: readingForShowers(3),
  state: staleState,
});
assert.strictEqual(recoveredAfterStale.reason, "hour-not-planned");
assert.strictEqual(recoveredAfterStale.finalTargetOn, false);

const staleOutsideBackupHour = decide({
  currentHour: 8,
  plannedHours: [8],
  reading: readingForShowers(3, 121),
});
assert.strictEqual(
  staleOutsideBackupHour.reason,
  "stale-reading",
  "vanha lukema tunnilla joka ei ole varatunti ei saa lammittaa",
);
assert.strictEqual(staleOutsideBackupHour.finalTargetOn, false);

// Regressiotesti Codexin P1-loydokselle: kelvollinen paivittainen
// optimointisuunnitelma EI sisalla nykyista varatuntia (talla paivalla
// valittiin joku muu, halvempi tunti) - tama on normaali tilanne, ei
// itsessaan vika. Jos anturidata on samaan aikaan vanhentunut, ohituksen
// pitaa silti laueta, koska "hour-not-planned" ei saa peittaa alleen
// oikeaa datavikaa varatunnilla.
const staleBackupHourNotInTodaysPlan = decide({
  currentHour: 15,
  plannedHours: [10],
  reading: readingForShowers(3, 121),
});
assert.strictEqual(
  staleBackupHourNotInTodaysPlan.reason,
  "backup-fault-override",
  "anturivika varatunnilla ohittaa vaikka tunti ei ole mukana taman paivan optimoidussa suunnitelmassa",
);
assert.strictEqual(staleBackupHourNotInTodaysPlan.finalTargetOn, true);

const missingReadingBackupHourNotInTodaysPlan = decide({
  currentHour: 15,
  plannedHours: [10],
  reading: null,
});
assert.strictEqual(
  missingReadingBackupHourNotInTodaysPlan.reason,
  "backup-fault-override",
  "puuttuva lukema varatunnilla ohittaa myos vaikka tunti ei ole mukana suunnitelmassa",
);
assert.strictEqual(missingReadingBackupHourNotInTodaysPlan.finalTargetOn, true);

// Sama tilanne mutta data ONKIN kelvollista - talloin "hour-not-planned"
// pitaa silti raportoitua lopulta oikein, eika varatuntistatus yksinaan
// saa laukaista lammitysta ilman oikeaa datavikaa.
const healthyBackupHourNotInTodaysPlan = decide({
  currentHour: 15,
  plannedHours: [10],
  reading: readingForShowers(3),
});
assert.strictEqual(
  healthyBackupHourNotInTodaysPlan.reason,
  "hour-not-planned",
  "terve data varatunnilla joka ei ole suunnitelmassa ei saa lammittaa pelkan varatuntistatuksen perusteella",
);
assert.strictEqual(healthyBackupHourNotInTodaysPlan.finalTargetOn, false);

const staleWithFallbackDisabled = decide({
  reading: readingForShowers(3, 121),
  testSettings: { ...settings, enabled: false },
});
assert.strictEqual(
  staleWithFallbackDisabled.reason,
  "stale-reading",
  "varakaytto pois paalta -asetus estaa myos anturivikaohituksen",
);
assert.strictEqual(staleWithFallbackDisabled.finalTargetOn, false);

assert.strictEqual(
  decide({ currentHour: 8, plannedHours: [8], reading: null }).reason,
  "missing-reading",
  "puuttuva lukema tunnilla joka ei ole varatunti ei saa ohittaa",
);
assert.strictEqual(
  decide({ currentHour: 8, plannedHours: [8], reading: null }).finalTargetOn,
  false,
  "puuttuva lukema tunnilla joka ei ole varatunti ei saa lammittaa",
);
assert.strictEqual(
  decide({ reading: null }).reason,
  "backup-fault-override",
  "puuttuva lukema varatunnilla lammittaa ehdoitta",
);
assert.strictEqual(decide({ reading: null }).finalTargetOn, true);

assert.strictEqual(
  decide({
    testSettings: { ...settings, fullTankShowers: null },
  }).reason,
  "invalid-calibration",
  "invalid calibration must fail safe OFF - kalibrointi puuttuu, varatuntejakaan ei voi luottaa",
);

const failSafeState = createControllerState();
decide({ reading: readingForShowers(6), state: failSafeState });
const failSafe = decide({
  failSafeReason: "plan-fetch-error",
  state: failSafeState,
});
assert.strictEqual(
  failSafe.finalTargetOn,
  false,
  "tuntematon failSafeReason ei kuulu DATA_FAULT_REASONS-listaan eika ohita",
);
assert.strictEqual(failSafe.consecutiveHighFillReadings, 0);

const readingFetchErrorOnBackupHour = decide({
  failSafeReason: "reading-fetch-error",
  reading: null,
});
assert.strictEqual(
  readingFetchErrorOnBackupHour.reason,
  "backup-fault-override",
  "lukeman hakuvirhe varatunnilla lammittaa ehdoitta",
);
assert.strictEqual(readingFetchErrorOnBackupHour.finalTargetOn, true);

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
  true,
  "Supabase error fallback on a backup hour now heats through a stale reading too - the tank's own thermostat is the real safety net",
);
assert.strictEqual(
  decide({
    currentHour: 8,
    plannedHours: fallbackControl.plannedHours,
    reading: readingForShowers(3, 121),
  }).finalTargetOn,
  false,
  "the stale-reading override only applies to hours actually listed in backupHours, not every hour once fallback mode is active",
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
  "backup",
  "a missing plan for today is treated the same as a connection error and falls back to backup hours",
);
assert.strictEqual(missingPlanControl.plannedHours, settings.backupHours);

const wrongDateControl = resolvePlanControl(
  [{ plan_date: "2026-07-25", planned_hours: [15] }],
  null,
  settings,
  "2026-07-26",
);
assert.strictEqual(
  wrongDateControl.source,
  "backup",
  "a stale/wrong-dated plan row also falls back to backup hours",
);

const missingPlanFallbackDisabledControl = resolvePlanControl(
  [],
  null,
  { ...settings, enabled: false },
  "2026-07-26",
);
assert.strictEqual(
  missingPlanFallbackDisabledControl.source,
  "fail-safe",
  "a missing plan must not activate fallback when fallbackEnabled is off",
);
assert.strictEqual(missingPlanFallbackDisabledControl.failSafeReason, "plan-missing");


const heartbeatNow = Date.parse("2026-08-13T12:00:00.000Z");
const todayPlan = [{ plan_date: "2026-08-13", planned_hours: [15], updated_at: "2026-08-10T00:00:00Z" }];
function trustedControl(heartbeatRows, testSettings = settings) {
  return resolveTrustedPlanControl(todayPlan, null, heartbeatRows, null, testSettings, "2026-08-13", heartbeatNow);
}
const freshHeartbeat = [{ health_status: "healthy", last_validated_plan_at: "2026-08-13T11:30:00.000Z", validated_plan_fingerprint: buildPlanFingerprint("2026-08-13", [15]) }];
const fixedPlan = [{ plan_date: "2026-08-13", planned_hours: [7, 8], mode: "fixed" }];
assert.strictEqual(resolveTrustedPlanControl(fixedPlan, null, [{ health_status: "unhealthy" }], null, settings, "2026-08-13", heartbeatNow).source, "energyzen", "fixed plan bypasses unhealthy automatic heartbeat");
assert.strictEqual(resolveTrustedPlanControl(fixedPlan, null, [{ health_status: "healthy", last_validated_plan_at: "2026-08-13T11:30:00Z", validated_plan_fingerprint: null }], null, settings, "2026-08-13", heartbeatNow).source, "energyzen", "fixed plan does not require an optimizer fingerprint");
assert.strictEqual(resolveTrustedPlanControl([{ ...fixedPlan[0], mode: "automatic" }], null, [{ health_status: "unhealthy" }], null, settings, "2026-08-13", heartbeatNow).source, "backup", "fixed to automatic transition activates heartbeat trust");
assert.strictEqual(resolveTrustedPlanControl([{ ...todayPlan[0], mode: "fixed" }], null, [], null, settings, "2026-08-13", heartbeatNow).source, "energyzen", "automatic to fixed transition drops old heartbeat dependency");
assert.strictEqual(trustedControl(freshHeartbeat).source, "energyzen", "fresh healthy heartbeat trusts today's plan even when heating_plans.updated_at is old (no_changes)");
assert.strictEqual(resolveTrustedPlanControl([{ plan_date: "2026-08-13", planned_hours: [7, 8] }], null, freshHeartbeat, null, settings, "2026-08-13", heartbeatNow).source, "backup", "later changed planned_hours must not inherit trust");
assert.strictEqual(resolveTrustedPlanControl([{ plan_date: "2026-08-14", planned_hours: [15] }], null, freshHeartbeat, null, settings, "2026-08-14", heartbeatNow).source, "backup", "a different plan_date must not inherit trust");
assert.strictEqual(resolveTrustedPlanControl(todayPlan, null, null, createRequestError("heartbeat unavailable", true), settings, "2026-08-13", heartbeatNow).source, "backup", "heartbeat fetch failure falls back");
assert.strictEqual(trustedControl([{ ...freshHeartbeat[0], validated_plan_fingerprint: "2026-08-13|7,8" }]).source, "backup", "fingerprint mismatch falls back");
assert.strictEqual(trustedControl([{ health_status: "healthy", last_validated_plan_at: "2026-08-13T10:29:59.000Z", validated_plan_fingerprint: "2026-08-13|15" }]).source, "backup", "stale validation falls back");
assert.strictEqual(trustedControl([]).source, "backup", "missing heartbeat falls back");
assert.strictEqual(trustedControl([{ health_status: "unhealthy", last_validated_plan_at: "2026-08-13T11:30:00Z", validated_plan_fingerprint: "2026-08-13|15" }]).source, "backup", "unhealthy status falls back");
assert.strictEqual(trustedControl([{ health_status: "healthy", last_validated_plan_at: "not-a-date", validated_plan_fingerprint: "2026-08-13|15" }]).source, "backup", "malformed validation timestamp falls back");
assert.strictEqual(trustedControl([{ health_status: "healthy", last_validated_plan_at: "2026-08-13T12:00:01Z", validated_plan_fingerprint: "2026-08-13|15" }]).source, "backup", "future validation timestamp falls back");
const disabledHeartbeatControl = trustedControl([], { ...settings, enabled: false });
assert.strictEqual(disabledHeartbeatControl.source, "fail-safe", "fallback disabled fails closed");
assert.deepStrictEqual(disabledHeartbeatControl.plannedHours, []);
assert.deepStrictEqual(getHelsinkiParts(new Date("2026-03-29T00:30:00Z")), { dateKey: "2026-03-29", hour: 2 });
assert.deepStrictEqual(getHelsinkiParts(new Date("2026-03-29T01:30:00Z")), { dateKey: "2026-03-29", hour: 4 });
assert.deepStrictEqual(getHelsinkiParts(new Date("2026-10-25T00:30:00Z")), { dateKey: "2026-10-25", hour: 3 });
assert.deepStrictEqual(getHelsinkiParts(new Date("2026-10-25T01:30:00Z")), { dateKey: "2026-10-25", hour: 3 }, "both repeated autumn instants retain existing local-hour semantics");

console.log("EnergyZen Shelly controller tests passed");
