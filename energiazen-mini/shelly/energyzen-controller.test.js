const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  REQUIRED_BLOCKING_READINGS,
  REQUIRED_UNRELIABLE_CYCLES,
  START_HEATING_FILL_RATIO,
  buildPlanFingerprint,
  calculateCurrentShowers,
  createControllerState,
  createRequestError,
  decideHeating,
  resolveHelsinkiFromSysStatus,
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
assert.strictEqual(REQUIRED_UNRELIABLE_CYCLES, 3);

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
assert.strictEqual(lowFirst.consecutiveUnreliableCycles, 0);

// Uusi consecutiveUnreliableCycles-laskuri ei muuta normaalia suunnitellun
// lammityksen kaytosta millaan tavoin - useampi perakkainen terve/normaali
// kierros pitaa laskurin nollassa koko ajan.
const normalPlanState = createControllerState();
for (let index = 0; index < REQUIRED_UNRELIABLE_CYCLES + 1; index += 1) {
  const normalPlanDecision = decide({
    reading: readingForShowers(settings.fullTankShowers * 0.91),
    state: normalPlanState,
  });
  assert.strictEqual(normalPlanDecision.reason, "planned-heating-starts");
  assert.strictEqual(normalPlanDecision.finalTargetOn, true);
  assert.strictEqual(normalPlanDecision.consecutiveUnreliableCycles, 0);
}

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
// osuvat varatunnille. Anturivika varatunnilla lammittaa nyt vasta kolmannen
// PERAKKAISEN epaluotettavan kierroksen jalkeen (varaajan oma termostaatti
// estaa ylikuumenemisen), toisin kuin tunnilla joka ei ole varatunti (ks.
// staleOutsideBackupHour alla).
const staleState = createControllerState();
decide({ reading: readingForShowers(6), state: staleState });

// 1) ensimmainen epaluotettava varatuntikierros -> ei viela lammitysta.
const staleFirst = decide({
  reading: readingForShowers(3, 121),
  state: staleState,
});
assert.strictEqual(staleFirst.reason, "stale-reading");
assert.strictEqual(staleFirst.finalTargetOn, false);
assert.strictEqual(staleFirst.consecutiveUnreliableCycles, 1);

// 2) toinen epaluotettava varatuntikierros -> ei viela lammitysta.
const staleSecond = decide({
  reading: readingForShowers(3, 121),
  state: staleState,
});
assert.strictEqual(staleSecond.reason, "stale-reading");
assert.strictEqual(staleSecond.finalTargetOn, false);
assert.strictEqual(staleSecond.consecutiveUnreliableCycles, 2);

// 3) kolmas peräkkäinen epaluotettava varatuntikierros -> nykyinen
// backup-fault-override-kaytos sallitaan, lammitys paalle.
const stale = decide({
  reading: readingForShowers(3, 121),
  state: staleState,
});
assert.strictEqual(stale.reason, "backup-fault-override");
assert.strictEqual(stale.finalTargetOn, true);
assert.strictEqual(stale.consecutiveHighFillReadings, 0);
assert.strictEqual(stale.consecutiveUnreliableCycles, 3);
assert.strictEqual(stale.requiredUnreliableCycles, 3);

// Luotettava kierros valissa nollaa laskurin heti: neljas kierros olisi
// muuten ollut yli kynnyksen, mutta valiin osunut terve lukema katkaisee
// putken eika seuraava epaluotettava kierros yksinaan enaa lammita.
const reliableBetweenState = createControllerState();
decide({ reading: readingForShowers(3, 121), state: reliableBetweenState });
decide({ reading: readingForShowers(3, 121), state: reliableBetweenState });
const reliableBetween = decide({
  reading: readingForShowers(3),
  state: reliableBetweenState,
});
assert.strictEqual(reliableBetween.consecutiveUnreliableCycles, 0);
const afterReliableBetween = decide({
  reading: readingForShowers(3, 121),
  state: reliableBetweenState,
});
assert.strictEqual(afterReliableBetween.reason, "stale-reading");
assert.strictEqual(afterReliableBetween.finalTargetOn, false);
assert.strictEqual(afterReliableBetween.consecutiveUnreliableCycles, 1);

// Epaluotettava kierros joka EI ole varatunnilla ei koskaan saa lammittaa,
// eika se myoskaan kartuta varatunti-override-laskuria (ks.
// unreliableCycleEligible: vaatii isBackupHour).
const nonBackupUnreliableState = createControllerState();
for (let index = 0; index < REQUIRED_UNRELIABLE_CYCLES + 1; index += 1) {
  const nonBackupUnreliable = decide({
    currentHour: 8,
    plannedHours: [8],
    reading: readingForShowers(3, 121),
    state: nonBackupUnreliableState,
  });
  assert.strictEqual(nonBackupUnreliable.finalTargetOn, false);
  assert.strictEqual(nonBackupUnreliable.consecutiveUnreliableCycles, 0);
}

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
const staleBackupHourNotInTodaysPlanState = createControllerState();
let staleBackupHourNotInTodaysPlan;
for (let index = 0; index < REQUIRED_UNRELIABLE_CYCLES; index += 1) {
  staleBackupHourNotInTodaysPlan = decide({
    currentHour: 15,
    plannedHours: [10],
    reading: readingForShowers(3, 121),
    state: staleBackupHourNotInTodaysPlanState,
  });
}
assert.strictEqual(
  staleBackupHourNotInTodaysPlan.reason,
  "backup-fault-override",
  "anturivika varatunnilla ohittaa vaikka tunti ei ole mukana taman paivan optimoidussa suunnitelmassa, kolmannen perakkaisen epaluotettavan kierroksen jalkeen",
);
assert.strictEqual(staleBackupHourNotInTodaysPlan.finalTargetOn, true);

const missingReadingBackupHourNotInTodaysPlanState = createControllerState();
let missingReadingBackupHourNotInTodaysPlan;
for (let index = 0; index < REQUIRED_UNRELIABLE_CYCLES; index += 1) {
  missingReadingBackupHourNotInTodaysPlan = decide({
    currentHour: 15,
    plannedHours: [10],
    reading: null,
    state: missingReadingBackupHourNotInTodaysPlanState,
  });
}
assert.strictEqual(
  missingReadingBackupHourNotInTodaysPlan.reason,
  "backup-fault-override",
  "puuttuva lukema varatunnilla ohittaa myos vaikka tunti ei ole mukana suunnitelmassa, kolmannen perakkaisen epaluotettavan kierroksen jalkeen",
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
const missingReadingBackupHourState = createControllerState();
let missingReadingBackupHour;
for (let index = 0; index < REQUIRED_UNRELIABLE_CYCLES; index += 1) {
  missingReadingBackupHour = decide({
    reading: null,
    state: missingReadingBackupHourState,
  });
}
assert.strictEqual(
  missingReadingBackupHour.reason,
  "backup-fault-override",
  "puuttuva lukema varatunnilla lammittaa ehdoitta kolmannen perakkaisen epaluotettavan kierroksen jalkeen",
);
assert.strictEqual(missingReadingBackupHour.finalTargetOn, true);

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

const readingFetchErrorOnBackupHourState = createControllerState();
let readingFetchErrorOnBackupHour;
for (let index = 0; index < REQUIRED_UNRELIABLE_CYCLES; index += 1) {
  readingFetchErrorOnBackupHour = decide({
    failSafeReason: "reading-fetch-error",
    reading: null,
    state: readingFetchErrorOnBackupHourState,
  });
}
assert.strictEqual(
  readingFetchErrorOnBackupHour.reason,
  "backup-fault-override",
  "lukeman hakuvirhe varatunnilla lammittaa ehdoitta kolmannen perakkaisen epaluotettavan kierroksen jalkeen",
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
const fallbackStaleState = createControllerState();
let fallbackStaleDecision;
for (let index = 0; index < REQUIRED_UNRELIABLE_CYCLES; index += 1) {
  fallbackStaleDecision = decide({
    plannedHours: fallbackControl.plannedHours,
    reading: readingForShowers(3, 121),
    state: fallbackStaleState,
  });
}
assert.strictEqual(
  fallbackStaleDecision.finalTargetOn,
  true,
  "Supabase error fallback on a backup hour now heats through a stale reading too (after three consecutive unreliable cycles) - the tank's own thermostat is the real safety net",
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
const authoritativeFixedSettings = { ...settings, heatingNeedMode: "fixed" };
assert.strictEqual(resolveTrustedPlanControl(fixedPlan, null, [{ health_status: "unhealthy" }], null, authoritativeFixedSettings, "2026-08-13", heartbeatNow).source, "energyzen", "fixed plan bypasses unhealthy automatic heartbeat when authoritative mode confirms fixed");
assert.strictEqual(resolveTrustedPlanControl(fixedPlan, null, [{ health_status: "healthy", last_validated_plan_at: "2026-08-13T11:30:00Z", validated_plan_fingerprint: null }], null, authoritativeFixedSettings, "2026-08-13", heartbeatNow).source, "energyzen", "fixed plan does not require an optimizer fingerprint when authoritative mode confirms fixed");
assert.strictEqual(resolveTrustedPlanControl([{ ...fixedPlan[0], mode: "automatic" }], null, [{ health_status: "unhealthy" }], null, authoritativeFixedSettings, "2026-08-13", heartbeatNow).source, "backup", "fixed to automatic transition activates heartbeat trust");
assert.strictEqual(resolveTrustedPlanControl([{ ...todayPlan[0], mode: "fixed" }], null, [], null, authoritativeFixedSettings, "2026-08-13", heartbeatNow).source, "energyzen", "automatic to fixed transition drops old heartbeat dependency when authoritative mode confirms fixed");

// Codex P1 (PR #193 Shelly follow-up): the fixed-plan heartbeat exemption
// must also require heating_control_settings.heating_need_mode (fetched
// fresh every runController() cycle alongside the rest of settings) to
// confirm "fixed" - otherwise a stored fixed plan left over from before
// another device switched the authoritative mode to "automatic" would keep
// bypassing heartbeat trust indefinitely.
assert.strictEqual(
  resolveTrustedPlanControl(fixedPlan, null, [{ health_status: "unhealthy" }], null, { ...settings, heatingNeedMode: "fixed" }, "2026-08-13", heartbeatNow).source,
  "energyzen",
  "1) plan fixed + authoritative mode fixed: exemption allowed",
);
assert.strictEqual(
  resolveTrustedPlanControl(fixedPlan, null, [{ health_status: "unhealthy" }], null, { ...settings, heatingNeedMode: "automatic" }, "2026-08-13", heartbeatNow).source,
  "backup",
  "2) plan fixed + authoritative mode automatic: exemption denied, falls through to heartbeat trust and then backup",
);
assert.strictEqual(
  resolveTrustedPlanControl(fixedPlan, null, [{ health_status: "unhealthy" }], null, { ...settings, heatingNeedMode: null }, "2026-08-13", heartbeatNow).source,
  "backup",
  "3a) plan fixed + authoritative mode missing/null: exemption denied, existing backup fallback path used",
);
assert.strictEqual(
  resolveTrustedPlanControl(fixedPlan, null, [{ health_status: "unhealthy" }], null, { ...settings, heatingNeedMode: "not-a-real-mode" }, "2026-08-13", heartbeatNow).source,
  "backup",
  "3b) plan fixed + authoritative mode invalid value: exemption denied",
);
assert.strictEqual(
  resolveTrustedPlanControl(fixedPlan, null, [{ health_status: "unhealthy" }], null, settings, "2026-08-13", heartbeatNow).source,
  "backup",
  "3c) plan fixed + settings fetch failure fell back to cache (heatingNeedMode never cached, so absent): exemption denied, existing fallback path used",
);
assert.strictEqual(
  resolveTrustedPlanControl(fixedPlan, null, [{ health_status: "unhealthy" }], null, { ...settings, heatingNeedMode: "automatic", enabled: false }, "2026-08-13", heartbeatNow).source,
  "fail-safe",
  "3d) exemption denied + fallback disabled: existing fail-safe path used, not a new one",
);
assert.strictEqual(
  resolveTrustedPlanControl([{ ...fixedPlan[0], mode: "automatic" }], null, [{ health_status: "unhealthy" }], null, { ...settings, heatingNeedMode: "fixed" }, "2026-08-13", heartbeatNow).source,
  "backup",
  "4a) automatic-plan behavior is unaffected by heatingNeedMode either way",
);
assert.strictEqual(
  trustedControl(freshHeartbeat, { ...settings, heatingNeedMode: "automatic" }).source,
  "energyzen",
  "4b) automatic plan with a fresh trusted heartbeat is still trusted regardless of heatingNeedMode",
);
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
// resolveHelsinkiFromSysStatus trusts the device's own Sys status (sys.time
// for local wall-clock hour, sys.unixtime as a UTC epoch used only to
// detect a local midnight rollover) instead of computing DST itself - the
// production bug this replaced was a "getUTCFullYear not found" mJS crash.
function sysStatus(isoUtc, localTime) {
  return { time: localTime, unixtime: Math.floor(Date.parse(isoUtc) / 1000) };
}

// Same instants/expectations as the DST table this function replaced -
// only now the local time comes from the (simulated) device clock, not a
// self-computed DST rule, matching what a correctly NTP/tz-configured
// device reports on each side of the spring/autumn transitions.
assert.deepStrictEqual(resolveHelsinkiFromSysStatus(sysStatus("2026-03-29T00:30:00Z", "02:30")), { dateKey: "2026-03-29", hour: 2 });
assert.deepStrictEqual(resolveHelsinkiFromSysStatus(sysStatus("2026-03-29T01:30:00Z", "04:30")), { dateKey: "2026-03-29", hour: 4 });
assert.deepStrictEqual(resolveHelsinkiFromSysStatus(sysStatus("2026-10-25T00:30:00Z", "03:30")), { dateKey: "2026-10-25", hour: 3 });
assert.deepStrictEqual(resolveHelsinkiFromSysStatus(sysStatus("2026-10-25T01:30:00Z", "03:30")), { dateKey: "2026-10-25", hour: 3 }, "both repeated autumn instants retain existing local-hour semantics");

// Local date must roll forward across a UTC midnight boundary...
assert.deepStrictEqual(resolveHelsinkiFromSysStatus(sysStatus("2026-06-15T22:30:00Z", "01:30")), { dateKey: "2026-06-16", hour: 1 }, "summer offset (+3h) rolls the local date forward past UTC midnight");
assert.deepStrictEqual(resolveHelsinkiFromSysStatus(sysStatus("2026-01-10T22:30:00Z", "00:30")), { dateKey: "2026-01-11", hour: 0 }, "winter offset (+2h) rolls the local date forward past UTC midnight");
// ...but not when local time has not yet crossed midnight...
assert.deepStrictEqual(resolveHelsinkiFromSysStatus(sysStatus("2026-01-10T10:00:00Z", "12:00")), { dateKey: "2026-01-10", hour: 12 }, "no rollover when the local hour has not wrapped past UTC midnight");
// ...and the rollover must also cross month/year boundaries correctly,
// which is what civilDateFromDays (not Date.UTC) is responsible for.
assert.deepStrictEqual(resolveHelsinkiFromSysStatus(sysStatus("2025-12-31T23:30:00Z", "01:30")), { dateKey: "2026-01-01", hour: 1 }, "local date rollover crosses a year boundary correctly");

// Fail safely (return null) whenever the device's own time cannot be
// trusted, instead of falling back to any self-computed guess.
assert.strictEqual(resolveHelsinkiFromSysStatus(null), null, "missing sys status fails safe");
assert.strictEqual(resolveHelsinkiFromSysStatus({}), null, "sys status without unixtime fails safe");
assert.strictEqual(resolveHelsinkiFromSysStatus({ time: "12:00", unixtime: 0 }), null, "an unsynced device clock (unixtime near epoch) fails safe");
assert.strictEqual(resolveHelsinkiFromSysStatus(sysStatus("2026-06-15T12:00:00Z", null)), null, "missing sys.time fails safe");
assert.strictEqual(resolveHelsinkiFromSysStatus(sysStatus("2026-06-15T12:00:00Z", "bogus")), null, "unparseable sys.time fails safe");
assert.strictEqual(resolveHelsinkiFromSysStatus(sysStatus("2026-06-15T12:00:00Z", "24:00")), null, "out-of-range sys.time hour fails safe");
// Sys.GetStatus documents sys.time as fixed-width "HH:MM" with a leading
// zero, so parsing only reads/validates the two-character hour - a
// malformed minute is not a documented sys.time shape.
assert.strictEqual(resolveHelsinkiFromSysStatus(sysStatus("2026-06-15T12:00:00Z", "bogus")), null, "wrong-length/no-colon sys.time fails safe");

// Boundary hours read directly via slice(0, 2) + Number(), the documented
// fixed-width "HH:MM" shape.
assert.strictEqual(resolveHelsinkiFromSysStatus(sysStatus("2026-06-15T12:05:00Z", "00:05")).hour, 0, "leading-zero midnight hour parses correctly");
assert.strictEqual(resolveHelsinkiFromSysStatus(sysStatus("2026-06-15T12:05:00Z", "09:05")).hour, 9, "leading-zero single-digit hour parses correctly");
assert.strictEqual(resolveHelsinkiFromSysStatus(sysStatus("2026-06-15T12:59:00Z", "23:59")).hour, 23, "last hour of the day parses correctly");

// Assumes sys.time is always zero-padded two-digit "HH:MM" (matches every
// documented Shelly Sys.GetStatus example, e.g. "09:05") - verify this
// against real device output if it is ever observed otherwise.
assert.strictEqual(resolveHelsinkiFromSysStatus(sysStatus("2026-06-15T12:00:00Z", "9:05")), null, "a non-zero-padded hour is not a format sys.time is documented to produce");

// Regression guard: the getUTC*/Date.UTC family is not implemented by
// Shelly's mJS runtime (this is exactly what crashed getHelsinkiParts in
// production) - fail the build if it ever reappears in the controller
// source or its regenerated minified build.
let controllerFiles = ["energyzen-controller.js", "energyzen-controller.min.js"];
let bannedDateApis = [
  "getUTCFullYear",
  "getUTCMonth",
  "getUTCDate",
  "getUTCDay",
  "getUTCHours",
  "getUTCMinutes",
  "getUTCSeconds",
  "getUTCMilliseconds",
  "Date.UTC",
];

for (let fileIndex = 0; fileIndex < controllerFiles.length; fileIndex++) {
  let filePath = path.join(__dirname, controllerFiles[fileIndex]);
  let source = fs.readFileSync(filePath, "utf8");

  for (let apiIndex = 0; apiIndex < bannedDateApis.length; apiIndex++) {
    assert.ok(
      source.indexOf(bannedDateApis[apiIndex]) === -1,
      controllerFiles[fileIndex] + " must not use unsupported mJS Date API " + bannedDateApis[apiIndex],
    );
  }
}

console.log("EnergyZen Shelly controller tests passed");
