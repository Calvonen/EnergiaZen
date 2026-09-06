const assert = require("assert");
const fs = require("fs");
const path = require("path");
const {
  REQUIRED_CONTROL_PLANE_UNRELIABLE_CYCLES,
  REQUIRED_UNRELIABLE_CYCLES,
  applyControlPlaneDebounce,
  buildPlanFingerprint,
  createControllerState,
  createRequestError,
  decideHeating,
  isTrustedBackendHeartbeat,
  isValidDateKey,
  parsePostgresTimestampSeconds,
  resolveHelsinkiFromSysStatus,
  resolvePlanControl,
  resolveTrustedPlanControl,
} = require("./energyzen-controller");

const nowMs = Date.parse("2026-07-26T12:00:00.000Z");
const settings = {
  backupHours: [15],
  enabled: true,
};

// No local shower-count/fill-ratio math is left to derive a reading from -
// backend-primary now means Shelly trusts a planned hour as-is for its
// whole duration. top_temp/bottom_temp only need to be finite numbers
// (isValidReading); the actual values are otherwise irrelevant to the
// ON/OFF decision.
function freshReading(ageSeconds = 30) {
  return {
    bottom_temp: 55,
    created_at: new Date(nowMs - ageSeconds * 1000).toISOString(),
    top_temp: 55,
  };
}

function invalidTempReading(ageSeconds = 30) {
  return {
    bottom_temp: 55,
    created_at: new Date(nowMs - ageSeconds * 1000).toISOString(),
    top_temp: null,
  };
}

// planSource mirrors control.source (from resolvePlanControl/
// resolveTrustedPlanControl/applyControlPlaneDebounce), exactly what
// executeDecision passes in production. Only "energyzen" means "this IS
// the backend's own heartbeat-verified plan" - the default here, since
// most tests below exercise a genuinely trusted plan. Debounce-path tests
// override it to "backup" (or leave plannedHours not containing
// currentHour, which makes the distinction moot) to correctly model the
// backup_hours-adopted-as-plannedHours fallback, where the hour becomes
// "planned" too but is NOT actually on the backend's real plan.
function decide({
  currentHour = 15,
  failSafeReason = null,
  planSource = "energyzen",
  plannedHours = [15],
  reading = freshReading(),
  readingFetchError = false,
  relayCurrentlyOn = false,
  state = createControllerState(),
  testSettings = settings,
} = {}) {
  return decideHeating(
    {
      currentHour,
      failSafeReason,
      nowMs,
      planSource,
      plannedHours,
      reading,
      readingFetchError,
      relayCurrentlyOn,
      settings: testSettings,
    },
    state,
  );
}

assert.strictEqual(REQUIRED_UNRELIABLE_CYCLES, 3);
assert.strictEqual(REQUIRED_CONTROL_PLANE_UNRELIABLE_CYCLES, 3);

// The backend already decided WHICH hours to heat (heating_plans.planned_hours)
// - a planned hour with a valid, fresh reading heats unconditionally for its
// whole duration. There is no local shower-count/fill-ratio math left that
// could second-guess or cut this short mid-hour.
const plannedHeats = decide({ reading: freshReading() });
assert.strictEqual(plannedHeats.finalTargetOn, true);
assert.strictEqual(plannedHeats.reason, "planned-heating");
assert.strictEqual(plannedHeats.consecutiveUnreliableCycles, 0);

// Regression guard for the removed 92% fill-ratio gate: a reading that
// would previously have reported the tank as already full (and blocked/
// stopped heating after two such readings) must not affect the decision
// at all anymore - the exact same "hot" reading still heats because the
// hour is planned.
const hotReadingState = createControllerState();
for (let index = 0; index < 3; index += 1) {
  const hotDecision = decide({
    reading: { bottom_temp: 78, created_at: freshReading().created_at, top_temp: 78 },
    state: hotReadingState,
  });
  assert.strictEqual(hotDecision.finalTargetOn, true, "a 'tank full' reading must no longer block or stop planned heating");
  assert.strictEqual(hotDecision.reason, "planned-heating");
}

// relayCurrentlyOn no longer changes the outcome or the reason - there is
// no more "starting" vs "continuing" distinction now that there is no
// local threshold to have crossed.
const relayOnState = createControllerState();
const relayAlreadyOn = decide({
  reading: freshReading(),
  relayCurrentlyOn: true,
  state: relayOnState,
});
assert.strictEqual(relayAlreadyOn.finalTargetOn, true);
assert.strictEqual(relayAlreadyOn.reason, "planned-heating");

const unplanned = decide({ currentHour: 14 });
assert.strictEqual(unplanned.finalTargetOn, false);
assert.strictEqual(unplanned.reason, "hour-not-planned");

// Uusi consecutiveUnreliableCycles-laskuri ei muuta normaalia suunnitellun
// lammityksen kaytosta millaan tavoin - useampi perakkainen terve/normaali
// kierros pitaa laskurin nollassa koko ajan.
const normalPlanState = createControllerState();
for (let index = 0; index < REQUIRED_UNRELIABLE_CYCLES + 1; index += 1) {
  const normalPlanDecision = decide({
    reading: freshReading(),
    state: normalPlanState,
  });
  assert.strictEqual(normalPlanDecision.reason, "planned-heating");
  assert.strictEqual(normalPlanDecision.finalTargetOn, true);
  assert.strictEqual(normalPlanDecision.consecutiveUnreliableCycles, 0);
}

// ---------------------------------------------------------------------
// A trusted/control-plane-approved planned hour (planSource "energyzen")
// heats regardless of Shelly's own tank_readings visibility - missing,
// stale, or invalid readings no longer block it at all. Only the backup/
// fallback path below (an hour NOT actually on the backend's plan) still
// needs tank-reading freshness/validity.
// ---------------------------------------------------------------------

const plannedHourStaleReadingState = createControllerState();
const plannedHourStaleReading = decide({
  reading: freshReading(99999),
  state: plannedHourStaleReadingState,
});
assert.strictEqual(plannedHourStaleReading.finalTargetOn, true, "planned hour + stale reading -> ON");
assert.strictEqual(plannedHourStaleReading.reason, "planned-heating");
assert.strictEqual(plannedHourStaleReadingState.consecutiveUnreliableCycles, 0, "a trusted planned hour must not spuriously accumulate the tank-reading debounce counter");

const plannedHourMissingReadingState = createControllerState();
const plannedHourMissingReading = decide({
  reading: null,
  state: plannedHourMissingReadingState,
});
assert.strictEqual(plannedHourMissingReading.finalTargetOn, true, "planned hour + missing reading -> ON");
assert.strictEqual(plannedHourMissingReading.reason, "planned-heating");
assert.strictEqual(plannedHourMissingReadingState.consecutiveUnreliableCycles, 0);

const plannedHourInvalidReadingState = createControllerState();
const plannedHourInvalidReading = decide({
  reading: invalidTempReading(),
  state: plannedHourInvalidReadingState,
});
assert.strictEqual(plannedHourInvalidReading.finalTargetOn, true, "planned hour + invalid reading -> ON");
assert.strictEqual(plannedHourInvalidReading.reason, "planned-heating");
assert.strictEqual(plannedHourInvalidReadingState.consecutiveUnreliableCycles, 0);

// A REAL upstream fail-safe reason (relay/device-time/settings/plan-fetch/
// heartbeat problems, arriving via failSafeReason) must still block even an
// otherwise-planned hour - trusting the plan only exempts the tank-reading
// checks computed inside decideHeating itself, never an upstream
// infrastructure failure.
const plannedHourWithFailSafeReason = decide({
  failSafeReason: "device-time-unavailable",
  reading: null,
});
assert.strictEqual(
  plannedHourWithFailSafeReason.finalTargetOn,
  false,
  "an upstream fail-safe reason must not become permissive just because the hour happens to be planned",
);
assert.notStrictEqual(plannedHourWithFailSafeReason.reason, "planned-heating");

// A tank_readings REST fetch failure is deliberately NOT plumbed through as
// failSafeReason (see fetchLatestReading/executeDecision) - it must not by
// itself defeat an otherwise heartbeat-verified trusted plan. This is
// distinct from the missing/stale/invalid-reading cases above: here Shelly
// could not even ask Supabase for a reading, yet a genuinely trusted
// planned hour still heats.
const plannedHourReadingFetchErrorState = createControllerState();
const plannedHourReadingFetchError = decide({
  reading: null,
  readingFetchError: true,
  state: plannedHourReadingFetchErrorState,
});
assert.strictEqual(plannedHourReadingFetchError.finalTargetOn, true, "trusted energyzen planned hour + reading fetch error -> ON");
assert.strictEqual(plannedHourReadingFetchError.reason, "planned-heating");
assert.strictEqual(plannedHourReadingFetchErrorState.consecutiveUnreliableCycles, 0);

// ---------------------------------------------------------------------
// The pre-existing tank-reading 3-cycle debounce is preserved, but only
// for the backup/fallback path: an hour that is NOT actually on the
// backend's plan (planSource "backup", as applyControlPlaneDebounce would
// pass once it adopts backup_hours as plannedHours) but is a configured
// backup hour.
// ---------------------------------------------------------------------

// currentHour 15 on myos settings.backupHours - eli oletusparametrit
// osuvat varatunnille. planSource "backup" mallintaa control-plane-
// fallbackin adoptoiman backup_hours-listan (control.plannedHours ==
// settings.backupHours), jolloin tunti on teknisesti "planned" mutta EI
// todellisuudessa backendin oikea suunnitelma - anturivika lammittaa nyt
// vasta kolmannen PERAKKAISEN epaluotettavan kierroksen jalkeen (varaajan
// oma termostaatti estaa ylikuumenemisen).
const staleState = createControllerState();

// 1) ensimmainen epaluotettava varatuntikierros -> ei viela lammitysta.
const staleFirst = decide({
  planSource: "backup",
  reading: freshReading(121),
  state: staleState,
});
assert.strictEqual(staleFirst.reason, "stale-reading");
assert.strictEqual(staleFirst.finalTargetOn, false);
assert.strictEqual(staleFirst.consecutiveUnreliableCycles, 1);

// 2) toinen epaluotettava varatuntikierros -> ei viela lammitysta.
const staleSecond = decide({
  planSource: "backup",
  reading: freshReading(121),
  state: staleState,
});
assert.strictEqual(staleSecond.reason, "stale-reading");
assert.strictEqual(staleSecond.finalTargetOn, false);
assert.strictEqual(staleSecond.consecutiveUnreliableCycles, 2);

// 3) kolmas peräkkäinen epaluotettava varatuntikierros -> nykyinen
// backup-fault-override-kaytos sallitaan, lammitys paalle.
const stale = decide({
  planSource: "backup",
  reading: freshReading(121),
  state: staleState,
});
assert.strictEqual(stale.reason, "backup-fault-override");
assert.strictEqual(stale.finalTargetOn, true);
assert.strictEqual(stale.consecutiveUnreliableCycles, 3);
assert.strictEqual(stale.requiredUnreliableCycles, 3);

// Sama kolmen kierroksen debounssi puuttuvalle ja virheelliselle lukemalle.
const missingReadingBackupState = createControllerState();
let missingReadingBackupDecision;
for (let index = 0; index < REQUIRED_UNRELIABLE_CYCLES; index += 1) {
  missingReadingBackupDecision = decide({
    planSource: "backup",
    reading: null,
    state: missingReadingBackupState,
  });
}
assert.strictEqual(
  missingReadingBackupDecision.reason,
  "backup-fault-override",
  "puuttuva lukema varatunnilla (ei todellisessa suunnitelmassa) lammittaa ehdoitta kolmannen perakkaisen epaluotettavan kierroksen jalkeen",
);
assert.strictEqual(missingReadingBackupDecision.finalTargetOn, true);

const invalidReadingBackupState = createControllerState();
let invalidReadingBackupDecision;
for (let index = 0; index < REQUIRED_UNRELIABLE_CYCLES; index += 1) {
  invalidReadingBackupDecision = decide({
    planSource: "backup",
    reading: invalidTempReading(),
    state: invalidReadingBackupState,
  });
}
assert.strictEqual(
  invalidReadingBackupDecision.reason,
  "backup-fault-override",
  "virheellinen lukema varatunnilla (ei todellisessa suunnitelmassa) lammittaa ehdoitta kolmannen perakkaisen epaluotettavan kierroksen jalkeen",
);
assert.strictEqual(invalidReadingBackupDecision.finalTargetOn, true);

// Tarkka 120 sekunnin raja pitaa yha paikkansa off-plan-varatuntipolulla
// (trusted-suunniteltu tunti ohittaisi taman tarkistuksen kokonaan).
// plannedHours=[10] varmistaa etta planned=false riippumatta planSourcesta,
// joten lukema todella arvioidaan eika ohiteta luottamuksen takia.
const exactReadingAgeThresholdOffPlan = decide({
  plannedHours: [10],
  reading: freshReading(120),
});
assert.strictEqual(exactReadingAgeThresholdOffPlan.reason, "hour-not-planned", "tarkalleen 120s vanha lukema ei ole viela stale off-plan-varatuntipolulla");
assert.strictEqual(exactReadingAgeThresholdOffPlan.finalTargetOn, false);

// Luotettava kierros valissa nollaa laskurin heti: neljas kierros olisi
// muuten ollut yli kynnyksen, mutta valiin osunut terve lukema katkaisee
// putken eika seuraava epaluotettava kierros yksinaan enaa lammita.
const reliableBetweenState = createControllerState();
decide({ planSource: "backup", reading: freshReading(121), state: reliableBetweenState });
decide({ planSource: "backup", reading: freshReading(121), state: reliableBetweenState });
const reliableBetween = decide({
  planSource: "backup",
  reading: freshReading(),
  state: reliableBetweenState,
});
assert.strictEqual(reliableBetween.consecutiveUnreliableCycles, 0);
const afterReliableBetween = decide({
  planSource: "backup",
  reading: freshReading(121),
  state: reliableBetweenState,
});
assert.strictEqual(afterReliableBetween.reason, "stale-reading");
assert.strictEqual(afterReliableBetween.finalTargetOn, false);
assert.strictEqual(afterReliableBetween.consecutiveUnreliableCycles, 1);

// settings.enabled=false estaa myos anturivikaohituksen off-plan-
// varatuntipolulla - ei muutu permissiiviseksi trusted-suunnittelun takia.
const staleWithFallbackDisabled = decide({
  planSource: "backup",
  reading: freshReading(121),
  testSettings: { ...settings, enabled: false },
});
assert.strictEqual(
  staleWithFallbackDisabled.reason,
  "stale-reading",
  "varakaytto pois paalta -asetus estaa myos anturivikaohituksen",
);
assert.strictEqual(staleWithFallbackDisabled.finalTargetOn, false);

// ---------------------------------------------------------------------
// unplanned non-backup hour + stale/missing/invalid reading -> OFF, aina.
// currentHour 8 ei ole plannedHoursissa eika settings.backupHoursissa.
// ---------------------------------------------------------------------

const nonBackupUnreliableState = createControllerState();
for (let index = 0; index < REQUIRED_UNRELIABLE_CYCLES + 1; index += 1) {
  const nonBackupUnreliable = decide({
    currentHour: 8,
    plannedHours: [9],
    reading: freshReading(121),
    state: nonBackupUnreliableState,
  });
  assert.strictEqual(nonBackupUnreliable.finalTargetOn, false);
  assert.strictEqual(nonBackupUnreliable.reason, "hour-not-planned");
  assert.strictEqual(nonBackupUnreliable.consecutiveUnreliableCycles, 0);
}

const staleOutsideBackupHour = decide({
  currentHour: 8,
  plannedHours: [9],
  reading: freshReading(121),
});
assert.strictEqual(
  staleOutsideBackupHour.reason,
  "hour-not-planned",
  "vanha lukema tunnilla joka ei ole varatunti eika suunnitelmassa ei saa lammittaa",
);
assert.strictEqual(staleOutsideBackupHour.finalTargetOn, false);

const missingReadingOutsideBackupHour = decide({
  currentHour: 8,
  plannedHours: [9],
  reading: null,
});
assert.strictEqual(
  missingReadingOutsideBackupHour.reason,
  "hour-not-planned",
  "puuttuva lukema tunnilla joka ei ole varatunti eika suunnitelmassa ei saa lammittaa",
);
assert.strictEqual(missingReadingOutsideBackupHour.finalTargetOn, false);

// Varatila ei saa jaada paalle: kun seuraavan tarkistuksen lukema on taas
// tuore, paatos tehdaan normaalisti suunnitelman perusteella. Tassa
// plannedHours EI sisalla nykyista varatuntia (backendin oikea suunnitelma
// valitsi tunnin 10 sen sijaan) - eri skenaario kuin planSource "backup".
const recoveredAfterStale = decide({
  currentHour: 15,
  plannedHours: [10],
  reading: freshReading(),
  state: staleState,
});
assert.strictEqual(recoveredAfterStale.reason, "hour-not-planned");
assert.strictEqual(recoveredAfterStale.finalTargetOn, false);

// Regressiotesti Codexin P1-loydokselle: kelvollinen paivittainen
// optimointisuunnitelma EI sisalla nykyista varatuntia (talla paivalla
// valittiin joku muu, halvempi tunti) - tama on normaali tilanne, ei
// itsessaan vika. Jos anturidata on samaan aikaan vanhentunut, ohituksen
// pitaa silti laueta, koska "hour-not-planned" ei saa peittaa alleen
// oikeaa datavikaa varatunnilla. plannedHours=[10] tarkoittaa etta
// backendin AITO suunnitelma ei valinnut tata varatuntia (planned=false
// planSourcesta riippumatta).
const staleBackupHourNotInTodaysPlanState = createControllerState();
let staleBackupHourNotInTodaysPlan;
for (let index = 0; index < REQUIRED_UNRELIABLE_CYCLES; index += 1) {
  staleBackupHourNotInTodaysPlan = decide({
    currentHour: 15,
    plannedHours: [10],
    reading: freshReading(121),
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
  reading: freshReading(),
});
assert.strictEqual(
  healthyBackupHourNotInTodaysPlan.reason,
  "hour-not-planned",
  "terve data varatunnilla joka ei ole suunnitelmassa ei saa lammittaa pelkan varatuntistatuksen perusteella",
);
assert.strictEqual(healthyBackupHourNotInTodaysPlan.finalTargetOn, false);

const failSafe = decide({
  failSafeReason: "plan-fetch-error",
  planSource: "fail-safe",
});
assert.strictEqual(
  failSafe.finalTargetOn,
  false,
  "tuntematon failSafeReason ei kuulu DATA_FAULT_REASONS-listaan eika ohita",
);

// backup hour + reading fetch error -> 1./2. kierros OFF, 3. kierros
// backup-fault-override ON. readingFetchError:true + planSource:"backup"
// mallintaa fetchLatestReading:n tank_readings-REST-haun epaonnistumisen
// off-plan-varatuntipolulla (ei "energyzen") - eri kuin
// plannedHourReadingFetchError yllä, joka on planSource:"energyzen".
const readingFetchErrorOnBackupHourState = createControllerState();
const readingFetchErrorFirst = decide({
  planSource: "backup",
  reading: null,
  readingFetchError: true,
  state: readingFetchErrorOnBackupHourState,
});
assert.strictEqual(readingFetchErrorFirst.reason, "reading-fetch-error");
assert.strictEqual(readingFetchErrorFirst.finalTargetOn, false, "1) lukeman hakuvirhe varatunnilla ei viela lammita");

const readingFetchErrorSecond = decide({
  planSource: "backup",
  reading: null,
  readingFetchError: true,
  state: readingFetchErrorOnBackupHourState,
});
assert.strictEqual(readingFetchErrorSecond.finalTargetOn, false, "2) lukeman hakuvirhe varatunnilla ei viela lammita");

const readingFetchErrorThird = decide({
  planSource: "backup",
  reading: null,
  readingFetchError: true,
  state: readingFetchErrorOnBackupHourState,
});
assert.strictEqual(
  readingFetchErrorThird.reason,
  "backup-fault-override",
  "3) lukeman hakuvirhe varatunnilla lammittaa ehdoitta kolmannen perakkaisen epaluotettavan kierroksen jalkeen",
);
assert.strictEqual(readingFetchErrorThird.finalTargetOn, true);

// ---------------------------------------------------------------------
// resolvePlanControl's "backup" resolution, fed through decideHeating
// exactly the way executeDecision would (planSource: control.source).
// ---------------------------------------------------------------------

const fallbackControl = resolvePlanControl(
  null,
  createRequestError("network down", true),
  settings,
  "2026-07-26",
);

assert.strictEqual(fallbackControl.source, "backup");
assert.strictEqual(
  decide({
    planSource: fallbackControl.source,
    plannedHours: fallbackControl.plannedHours,
    reading: freshReading(),
  }).finalTargetOn,
  true,
  "Supabase error fallback heats a backup hour with a valid reading",
);

const fallbackStaleState = createControllerState();
const fallbackStaleFirst = decide({
  planSource: fallbackControl.source,
  plannedHours: fallbackControl.plannedHours,
  reading: freshReading(121),
  state: fallbackStaleState,
});
assert.strictEqual(fallbackStaleFirst.finalTargetOn, false, "adopted backup_hours must still require the tank-reading debounce on the 1st stale cycle");
const fallbackStaleSecond = decide({
  planSource: fallbackControl.source,
  plannedHours: fallbackControl.plannedHours,
  reading: freshReading(121),
  state: fallbackStaleState,
});
assert.strictEqual(fallbackStaleSecond.finalTargetOn, false, "...nor on the 2nd");
const fallbackStaleThird = decide({
  planSource: fallbackControl.source,
  plannedHours: fallbackControl.plannedHours,
  reading: freshReading(121),
  state: fallbackStaleState,
});
assert.strictEqual(
  fallbackStaleThird.finalTargetOn,
  true,
  "Supabase error fallback on a backup hour now heats through a stale reading too (after three consecutive unreliable cycles) - the tank's own thermostat is the real safety net",
);
assert.strictEqual(fallbackStaleThird.reason, "backup-fault-override");

assert.strictEqual(
  decide({
    currentHour: 8,
    planSource: fallbackControl.source,
    plannedHours: fallbackControl.plannedHours,
    reading: freshReading(121),
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


// buildPlanFingerprint/isValidDateKey: regex literals are not supported by
// Shelly's mJS runtime on some device firmware (confirmed on real
// hardware - see the regex-literal guard at the bottom of this file), so
// the YYYY-MM-DD shape is validated with plain length/charAt/slice/Number
// + numeric range checks instead of /^\d{4}-\d{2}-\d{2}$/.
assert.strictEqual(buildPlanFingerprint("2026-08-16", [23]), "2026-08-16|23", "physical-device acceptance case");
assert.strictEqual(isValidDateKey("2026-08-16"), true);
assert.strictEqual(isValidDateKey("2026-01-01"), true);
assert.strictEqual(isValidDateKey("2026-12-31"), true);
assert.strictEqual(isValidDateKey("2026-13-01"), false, "month out of range");
assert.strictEqual(isValidDateKey("2026-00-01"), false, "month out of range (zero)");
assert.strictEqual(isValidDateKey("2026-08-32"), false, "day out of range");
assert.strictEqual(isValidDateKey("2026-08-00"), false, "day out of range (zero)");
assert.strictEqual(isValidDateKey("2026/08/16"), false, "wrong separators");
assert.strictEqual(isValidDateKey("2026-8-16"), false, "wrong width (unpadded month)");
assert.strictEqual(isValidDateKey("2026-08-1"), false, "wrong width (unpadded day)");
assert.strictEqual(isValidDateKey("2026-08-160"), false, "wrong length (too long)");
assert.strictEqual(isValidDateKey("not-a-date"), false);
assert.strictEqual(isValidDateKey(""), false);
assert.strictEqual(isValidDateKey(null), false, "non-string value");
assert.strictEqual(isValidDateKey(undefined), false, "non-string value");
assert.strictEqual(isValidDateKey(20260816), false, "non-string value (number)");
assert.strictEqual(buildPlanFingerprint("not-a-date", [15]), null, "an invalid plan_date must fail closed to null, not throw");
assert.strictEqual(buildPlanFingerprint(null, [15]), null);

// resolveTrustedPlanControl/isTrustedBackendHeartbeat now compare whole
// UNIX SECONDS (matching parsePostgresTimestampSeconds and Shelly's own
// sys.unixtime), never epoch-milliseconds - Date.parse() is only used
// here in the Node test harness to build the fixture, then truncated.
const heartbeatNow = Math.floor(Date.parse("2026-08-13T12:00:00.000Z") / 1000);
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

// Hotfix regression: optimizer_invalid means the latest candidate could not be
// published; it must not retroactively cancel the last validated matching plan
// while the backend cron is still demonstrably alive.
assert.strictEqual(
  trustedControl([{
    health_status: "unhealthy",
    last_outcome: "optimizer_invalid",
    last_run_attempt_at: "2026-08-13T11:56:00Z",
    last_validated_plan_at: "2026-08-13T10:30:00Z",
    validated_plan_fingerprint: "2026-08-13|15",
  }]).source,
  "energyzen",
  "optimizer_invalid + fresh backend run + matching previously validated plan remains trusted",
);
assert.strictEqual(
  trustedControl([{
    health_status: "unhealthy",
    last_outcome: "optimizer_invalid",
    last_run_attempt_at: "2026-08-13T11:56:00Z",
    last_validated_plan_at: "2026-08-13T10:29:59Z",
    validated_plan_fingerprint: "2026-08-13|15",
  }]).source,
  "backup",
  "fresh optimizer_invalid attempts cannot extend preserved-plan trust beyond validation age",
);
assert.strictEqual(
  trustedControl([{
    health_status: "unhealthy",
    last_outcome: "optimizer_invalid",
    last_run_attempt_at: "2026-08-13T11:44:59Z",
    last_validated_plan_at: "2026-08-13T10:00:00Z",
    validated_plan_fingerprint: "2026-08-13|15",
  }]).source,
  "backup",
  "optimizer_invalid does not preserve trust once backend run attempts are stale",
);
assert.strictEqual(
  trustedControl([{
    health_status: "unhealthy",
    last_outcome: "run_error",
    last_run_attempt_at: "2026-08-13T11:56:00Z",
    last_validated_plan_at: "2026-08-13T10:00:00Z",
    validated_plan_fingerprint: "2026-08-13|15",
  }]).source,
  "backup",
  "infrastructure/run errors still fail over even with a fresh run attempt",
);
assert.strictEqual(
  trustedControl([{
    health_status: "unhealthy",
    last_outcome: "optimizer_invalid",
    last_run_attempt_at: "2026-08-13T11:56:00Z",
    last_validated_plan_at: "2026-08-13T10:00:00Z",
    validated_plan_fingerprint: "2026-08-13|7,8",
  }]).source,
  "backup",
  "optimizer_invalid never preserves trust across a fingerprint mismatch",
);
assert.strictEqual(trustedControl([{ health_status: "healthy", last_validated_plan_at: "not-a-date", validated_plan_fingerprint: "2026-08-13|15" }]).source, "backup", "malformed validation timestamp falls back");
assert.strictEqual(trustedControl([{ health_status: "healthy", last_validated_plan_at: "2026-08-13T12:00:01Z", validated_plan_fingerprint: "2026-08-13|15" }]).source, "backup", "future validation timestamp falls back");
const disabledHeartbeatControl = trustedControl([], { ...settings, enabled: false });
assert.strictEqual(disabledHeartbeatControl.source, "fail-safe", "fallback disabled fails closed");
assert.deepStrictEqual(disabledHeartbeatControl.plannedHours, []);

// ---------------------------------------------------------------------
// parsePostgresTimestampSeconds: Shelly's mJS Date.parse() misparses the
// "YYYY-MM-DD HH:MM:SS(.sss)?+00" format Supabase/PostgreSQL actually
// emits for last_validated_plan_at (confirmed on a real device). A
// deterministic integer parser fixed that, but a SECOND on-device test
// found that Shelly's mJS also loses several milliseconds of precision
// doing arithmetic at epoch-MILLISECOND magnitude (~1.7e12) - even with
// that same deterministic parser. isTrustedBackendHeartbeat now compares
// whole UNIX SECONDS throughout (matching sys.unixtime's magnitude,
// ~1.7e9, already proven precision-safe elsewhere in this file) and never
// builds an epoch-millisecond value at all. These tests exercise the real
// production timestamp shape end to end, not just the ISO "T"/"Z"
// fixtures used above (which parsePostgresTimestampSeconds also still
// accepts, confirmed by every "backup"/"energyzen" assertion above still
// passing unchanged).
// ---------------------------------------------------------------------

// 2026-08-16 04:23:01.034+00 -> correct Unix SECONDS (hand-verified: 20681
// days since 1970-01-01 * 86400 + 04:23:01 of that day; the .034
// millisecond part is intentionally dropped - see parsePostgresTimestampSeconds).
assert.strictEqual(
  parsePostgresTimestampSeconds("2026-08-16 04:23:01.034+00"),
  1786854181,
  "PostgreSQL timestamp format must parse to the correct Unix seconds without relying on Date.parse or building an epoch-millisecond value",
);

// heartbeat fresh + matching fingerprint -> trusted, using the real
// Postgres timestamp shape (space separator, "+00" offset) rather than
// the ISO fixtures used elsewhere in this file. postgresFormatNow is
// whole Unix seconds, exactly what resolveSysUnixtimeSeconds() would pass
// in production (sys.unixtime), not epoch-milliseconds.
const postgresFormatNow = Math.floor(Date.parse("2026-08-13T12:00:00.000Z") / 1000);
const postgresFormatPlanRow = { plan_date: "2026-08-13", planned_hours: [15] };
assert.strictEqual(
  isTrustedBackendHeartbeat(
    [{
      health_status: "healthy",
      last_validated_plan_at: "2026-08-13 11:30:00.034+00",
      validated_plan_fingerprint: buildPlanFingerprint("2026-08-13", [15]),
    }],
    null,
    postgresFormatPlanRow,
    postgresFormatNow,
  ),
  true,
  "a fresh heartbeat in the real PostgreSQL timestamp format with a matching fingerprint must be trusted",
);

// stale heartbeat -> untrusted, same Postgres format, timestamp older
// than MAX_BACKEND_VALIDATION_AGE_SECONDS (90 min) before postgresFormatNow.
assert.strictEqual(
  isTrustedBackendHeartbeat(
    [{
      health_status: "healthy",
      last_validated_plan_at: "2026-08-13 10:29:59.000+00",
      validated_plan_fingerprint: buildPlanFingerprint("2026-08-13", [15]),
    }],
    null,
    postgresFormatPlanRow,
    postgresFormatNow,
  ),
  false,
  "a stale heartbeat in the real PostgreSQL timestamp format must be untrusted",
);

// malformed timestamp -> untrusted (parsePostgresTimestampSeconds returns
// NaN, isFinite(NaN) is false, so isTrustedBackendHeartbeat fails closed).
assert.strictEqual(
  parsePostgresTimestampSeconds("not-a-timestamp"),
  NaN,
);
assert.ok(Number.isNaN(parsePostgresTimestampSeconds("2026-08-16 04:23:01.034+00 extra junk")), "trailing garbage after a valid timestamp must be rejected");
assert.ok(Number.isNaN(parsePostgresTimestampSeconds("2026-08-16T04:23:01+")), "a truncated/incomplete offset must be rejected");
assert.ok(Number.isNaN(parsePostgresTimestampSeconds("2026/08/16 04:23:01+00")), "wrong date-part separators must be rejected");
assert.ok(Number.isNaN(parsePostgresTimestampSeconds(null)), "a non-string value must be rejected");
assert.strictEqual(
  isTrustedBackendHeartbeat(
    [{
      health_status: "healthy",
      last_validated_plan_at: "not-a-timestamp",
      validated_plan_fingerprint: buildPlanFingerprint("2026-08-13", [15]),
    }],
    null,
    postgresFormatPlanRow,
    postgresFormatNow,
  ),
  false,
  "a malformed last_validated_plan_at must be untrusted",
);

// Boundary/round-trip sanity checks against the existing civilDateFromDays
// inverse (daysFromCivil is not exported, so this is exercised indirectly
// via parsePostgresTimestampSeconds at both a UTC-offset and a
// non-zero-offset timestamp that should land on the exact same instant).
assert.strictEqual(
  parsePostgresTimestampSeconds("2026-08-16 06:23:01.034+02"),
  parsePostgresTimestampSeconds("2026-08-16 04:23:01.034+00"),
  "a +02 offset must be subtracted correctly, landing on the same UTC instant as +00",
);
assert.strictEqual(
  parsePostgresTimestampSeconds("2026-08-16T04:23:01.034Z"),
  parsePostgresTimestampSeconds("2026-08-16 04:23:01.034+00"),
  "the ISO Z suffix and the PostgreSQL +00 offset must parse to the same instant",
);

// applyControlPlaneDebounce: a transient plan-/heartbeat-fetch problem that
// resolvePlanControl/resolveTrustedPlanControl would resolve to
// source:"backup" must not immediately let backup_hours drive the relay -
// only the third CONSECUTIVE such cycle may. Every decide() call below
// passes planSource: <control>.source, exactly as executeDecision does in
// production, so this exercises the real end-to-end wiring rather than
// just the raw plannedHours array.
const transientPlanErrorControl = () =>
  resolvePlanControl(null, createRequestError("transient network blip", true), settings, "2026-07-26");
assert.strictEqual(transientPlanErrorControl().source, "backup", "sanity check: this raw resolution is exactly the 'backup' source being debounced");

const planDebounceState = createControllerState();

const planPending1 = applyControlPlaneDebounce(transientPlanErrorControl(), planDebounceState);
assert.strictEqual(planPending1.source, "backup-pending", "1st consecutive transient plan-fetch backup resolution is still pending");
assert.deepStrictEqual(planPending1.plannedHours, [], "pending cycle must not let backup_hours drive the relay yet");
assert.strictEqual(planDebounceState.consecutiveControlPlaneUnreliableCycles, 1);
const planPending1Decision = decide({
  currentHour: 15,
  planSource: planPending1.source,
  plannedHours: planPending1.plannedHours,
  failSafeReason: planPending1.failSafeReason,
  reading: freshReading(),
  state: planDebounceState,
});
assert.strictEqual(planPending1Decision.finalTargetOn, false, "1) transient plan-fetch error on a backup hour must not heat yet");
assert.strictEqual(planPending1Decision.reason, "hour-not-planned");

const planPending2 = applyControlPlaneDebounce(transientPlanErrorControl(), planDebounceState);
assert.strictEqual(planPending2.source, "backup-pending", "2nd consecutive transient plan-fetch backup resolution is still pending");
assert.strictEqual(planDebounceState.consecutiveControlPlaneUnreliableCycles, 2);
const planPending2Decision = decide({
  currentHour: 15,
  planSource: planPending2.source,
  plannedHours: planPending2.plannedHours,
  failSafeReason: planPending2.failSafeReason,
  reading: freshReading(),
  state: planDebounceState,
});
assert.strictEqual(planPending2Decision.finalTargetOn, false, "2) transient plan-fetch error on a backup hour must still not heat");

const planAdopted = applyControlPlaneDebounce(transientPlanErrorControl(), planDebounceState);
assert.strictEqual(planAdopted.source, "backup", "3rd consecutive transient plan-fetch backup resolution is finally adopted");
assert.deepStrictEqual(planAdopted.plannedHours, settings.backupHours);
assert.strictEqual(planDebounceState.consecutiveControlPlaneUnreliableCycles, REQUIRED_CONTROL_PLANE_UNRELIABLE_CYCLES);
const planAdoptedDecision = decide({
  currentHour: 15,
  planSource: planAdopted.source,
  plannedHours: planAdopted.plannedHours,
  failSafeReason: planAdopted.failSafeReason,
  reading: freshReading(),
  state: planDebounceState,
});
assert.strictEqual(planAdoptedDecision.finalTargetOn, true, "3) after three consecutive transient plan-fetch errors backup_hours may finally start heating (with a valid reading)");
assert.strictEqual(planAdoptedDecision.reason, "planned-heating");

// A transient heartbeat-fetch failure/untrusted heartbeat is debounced
// exactly the same way, since resolveTrustedPlanControl also resolves it to
// source:"backup".
const transientHeartbeatControl = () =>
  resolveTrustedPlanControl(todayPlan, null, null, createRequestError("heartbeat unavailable", true), settings, "2026-08-13", heartbeatNow);
assert.strictEqual(transientHeartbeatControl().source, "backup", "sanity check: heartbeat fetch failure resolves to the same 'backup' source being debounced");

const heartbeatDebounceState = createControllerState();
const heartbeatPending1 = applyControlPlaneDebounce(transientHeartbeatControl(), heartbeatDebounceState);
assert.strictEqual(heartbeatPending1.source, "backup-pending");
const heartbeatPending1Decision = decide({
  currentHour: 15,
  planSource: heartbeatPending1.source,
  plannedHours: heartbeatPending1.plannedHours,
  failSafeReason: heartbeatPending1.failSafeReason,
  reading: freshReading(),
  state: heartbeatDebounceState,
});
assert.strictEqual(heartbeatPending1Decision.finalTargetOn, false, "transient heartbeat-fetch failure on a backup hour must not heat on the 1st cycle");

const heartbeatPending2 = applyControlPlaneDebounce(transientHeartbeatControl(), heartbeatDebounceState);
assert.strictEqual(heartbeatPending2.source, "backup-pending");
const heartbeatPending2Decision = decide({
  currentHour: 15,
  planSource: heartbeatPending2.source,
  plannedHours: heartbeatPending2.plannedHours,
  failSafeReason: heartbeatPending2.failSafeReason,
  reading: freshReading(),
  state: heartbeatDebounceState,
});
assert.strictEqual(heartbeatPending2Decision.finalTargetOn, false, "transient heartbeat-fetch failure on a backup hour must not heat on the 2nd cycle either");

const heartbeatAdopted = applyControlPlaneDebounce(transientHeartbeatControl(), heartbeatDebounceState);
assert.strictEqual(heartbeatAdopted.source, "backup", "3rd consecutive transient heartbeat failure is finally adopted");
const heartbeatAdoptedDecision = decide({
  currentHour: 15,
  planSource: heartbeatAdopted.source,
  plannedHours: heartbeatAdopted.plannedHours,
  failSafeReason: heartbeatAdopted.failSafeReason,
  reading: freshReading(),
  state: heartbeatDebounceState,
});
assert.strictEqual(heartbeatAdoptedDecision.finalTargetOn, true, "after three consecutive transient heartbeat failures backup_hours may finally start heating (with a valid reading)");

// A single successful/trusted "energyzen" cycle in between resets the
// control-plane counter immediately, exactly like decideHeating's own
// tank-reading counter resets on a reliable cycle.
const resetState = createControllerState();
applyControlPlaneDebounce(transientPlanErrorControl(), resetState);
applyControlPlaneDebounce(transientPlanErrorControl(), resetState);
assert.strictEqual(resetState.consecutiveControlPlaneUnreliableCycles, 2);
const trustedInBetween = applyControlPlaneDebounce(
  resolvePlanControl([{ plan_date: "2026-07-26", planned_hours: [15] }], null, settings, "2026-07-26"),
  resetState,
);
assert.strictEqual(trustedInBetween.source, "energyzen");
assert.strictEqual(resetState.consecutiveControlPlaneUnreliableCycles, 0, "a trusted energyzen cycle in between resets the control-plane counter immediately");
const afterResetPending = applyControlPlaneDebounce(transientPlanErrorControl(), resetState);
assert.strictEqual(afterResetPending.source, "backup-pending", "the next transient cycle after a reset starts counting from zero again, not from where it left off");
assert.strictEqual(resetState.consecutiveControlPlaneUnreliableCycles, 1);

// A transient control-plane cycle on an hour that is not a backup hour must
// never start heating, even once backup_hours has been fully adopted (3rd
// consecutive cycle) - matches the existing rule that backup_hours only
// ever applies to hours actually listed in it.
const nonBackupHourDebounceState = createControllerState();
for (let index = 0; index < REQUIRED_CONTROL_PLANE_UNRELIABLE_CYCLES; index += 1) {
  applyControlPlaneDebounce(transientPlanErrorControl(), nonBackupHourDebounceState);
}
assert.strictEqual(nonBackupHourDebounceState.consecutiveControlPlaneUnreliableCycles, REQUIRED_CONTROL_PLANE_UNRELIABLE_CYCLES);
const adoptedButNotBackupHour = applyControlPlaneDebounce(transientPlanErrorControl(), nonBackupHourDebounceState);
assert.strictEqual(adoptedButNotBackupHour.source, "backup");
const nonBackupHourDecision = decide({
  currentHour: 8,
  planSource: adoptedButNotBackupHour.source,
  plannedHours: adoptedButNotBackupHour.plannedHours,
  failSafeReason: adoptedButNotBackupHour.failSafeReason,
  reading: freshReading(121),
  state: nonBackupHourDebounceState,
});
assert.strictEqual(nonBackupHourDecision.finalTargetOn, false, "backup_hours never drives the relay on an hour that is not itself a backup hour");

// The control-plane debounce and the pre-existing tank-reading debounce are
// fully independent: adopting backup_hours (3 consecutive control-plane
// cycles) must not itself grant the tank-reading backup-fault-override -
// that still separately needs its own 3 consecutive unreliable readings.
// planSource: combinedControl.source ("backup") is essential here - it is
// exactly what stops the adopted backup hour from being (wrongly) treated
// as a trusted planned hour that would bypass tank-reading checks entirely.
const combinedState = createControllerState();
let combinedControl;
for (let index = 0; index < REQUIRED_CONTROL_PLANE_UNRELIABLE_CYCLES; index += 1) {
  combinedControl = applyControlPlaneDebounce(transientPlanErrorControl(), combinedState);
}
assert.strictEqual(combinedControl.source, "backup", "control-plane debounce has fully adopted backup_hours");
const combinedFirstStale = decide({
  currentHour: 15,
  planSource: combinedControl.source,
  plannedHours: combinedControl.plannedHours,
  failSafeReason: combinedControl.failSafeReason,
  reading: freshReading(121),
  state: combinedState,
});
assert.strictEqual(combinedFirstStale.reason, "stale-reading", "even with backup_hours adopted, a single stale reading must not yet trigger backup-fault-override");
assert.strictEqual(combinedFirstStale.finalTargetOn, false);
assert.strictEqual(combinedFirstStale.consecutiveUnreliableCycles, 1);
const combinedSecondStale = decide({
  currentHour: 15,
  planSource: combinedControl.source,
  plannedHours: combinedControl.plannedHours,
  failSafeReason: combinedControl.failSafeReason,
  reading: freshReading(121),
  state: combinedState,
});
assert.strictEqual(combinedSecondStale.finalTargetOn, false);
assert.strictEqual(combinedSecondStale.consecutiveUnreliableCycles, 2);
const combinedThirdStale = decide({
  currentHour: 15,
  planSource: combinedControl.source,
  plannedHours: combinedControl.plannedHours,
  failSafeReason: combinedControl.failSafeReason,
  reading: freshReading(121),
  state: combinedState,
});
assert.strictEqual(combinedThirdStale.reason, "backup-fault-override", "the tank-reading 3-cycle debounce still fires on its own after being independently satisfied");
assert.strictEqual(combinedThirdStale.finalTargetOn, true);

// A normal, trusted EnergyZen plan cycle must never be delayed by this
// debounce - it applies immediately on the very first cycle, and heats
// even through a stale reading (planSource "energyzen").
const normalEnergyzenState = createControllerState();
const normalEnergyzenControl = applyControlPlaneDebounce(
  resolvePlanControl([{ plan_date: "2026-07-26", planned_hours: [15] }], null, settings, "2026-07-26"),
  normalEnergyzenState,
);
assert.strictEqual(normalEnergyzenControl.source, "energyzen");
assert.strictEqual(normalEnergyzenState.consecutiveControlPlaneUnreliableCycles, 0);
const normalEnergyzenDecision = decide({
  currentHour: 15,
  planSource: normalEnergyzenControl.source,
  plannedHours: normalEnergyzenControl.plannedHours,
  failSafeReason: normalEnergyzenControl.failSafeReason,
  reading: freshReading(9999),
  state: normalEnergyzenState,
});
assert.strictEqual(normalEnergyzenDecision.finalTargetOn, true, "a normal trusted EnergyZen plan heats immediately, on the very first cycle, even through a stale reading");
assert.strictEqual(normalEnergyzenDecision.reason, "planned-heating");

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

// Regression guard: Shelly's mJS runtime does not support regex literals on
// some device firmware (confirmed on real hardware: buildPlanFingerprint's
// old /^\d{4}-\d{2}-\d{2}$/.test(...) crashed with "Uncaught SyntaxError:
// RegEx are not supported in this version of Espruino") - fail the build if
// a regex literal or the RegExp constructor ever reappears in the
// controller source or its regenerated minified build. This is a small
// hand-written tokenizer (not a regex-based scan, since a naive
// "contains a /" search would false-positive on every division operator
// in this file, e.g. Math.floor(z / 146097)) that walks the source
// character by character, skipping strings/comments, and classifies each
// remaining "/" as division or a regex-literal start using the same rule
// real JS lexers use: division follows an identifier/number/string/")"/
// "]", a regex literal starts everywhere else (after operators, "(", ",",
// "return", etc.).
function findRegexLiteralOffsets(source) {
  let offsets = [];
  let i = 0;
  let n = source.length;
  let prevType = null;
  let prevText = null;
  let regexPrecedingKeywords = {
    case: true, delete: true, do: true, else: true, in: true, instanceof: true,
    new: true, of: true, return: true, throw: true, typeof: true, void: true,
    yield: true,
  };

  while (i < n) {
    let ch = source[i];

    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i += 1;
      continue;
    }

    if (ch === "/" && source[i + 1] === "/") {
      let end = source.indexOf("\n", i);
      i = end === -1 ? n : end;
      continue;
    }

    if (ch === "/" && source[i + 1] === "*") {
      let end = source.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      let quote = ch;
      let j = i + 1;
      while (j < n) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      i = j;
      prevType = "string";
      prevText = null;
      continue;
    }

    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(source[i + 1] || ""))) {
      let j = i;
      if (ch === "0" && (source[j + 1] === "x" || source[j + 1] === "X")) {
        j += 2;
        while (j < n && /[0-9a-fA-F]/.test(source[j])) j += 1;
      } else {
        while (j < n && /[0-9]/.test(source[j])) j += 1;
        if (source[j] === ".") {
          j += 1;
          while (j < n && /[0-9]/.test(source[j])) j += 1;
        }
        if (source[j] === "e" || source[j] === "E") {
          j += 1;
          if (source[j] === "+" || source[j] === "-") j += 1;
          while (j < n && /[0-9]/.test(source[j])) j += 1;
        }
      }
      i = j;
      prevType = "number";
      prevText = null;
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(source[j])) j += 1;
      prevText = source.slice(i, j);
      i = j;
      prevType = "ident";
      continue;
    }

    if (ch === "/") {
      let isDivision =
        prevType === "number" ||
        prevType === "string" ||
        (prevType === "ident" && regexPrecedingKeywords[prevText] !== true) ||
        (prevType === "punct" && (prevText === ")" || prevText === "]"));

      if (isDivision) {
        i += 1;
        prevType = "punct";
        prevText = "/";
        continue;
      }

      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        let c = source[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "\n") break;
        if (c === "[") {
          inClass = true;
          j += 1;
          continue;
        }
        if (c === "]") {
          inClass = false;
          j += 1;
          continue;
        }
        if (c === "/" && !inClass) {
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }

      if (closed) {
        while (j < n && /[a-zA-Z]/.test(source[j])) j += 1;
        offsets.push(i);
        i = j;
        prevType = "punct";
        prevText = "regex";
        continue;
      }

      i += 1;
      prevType = "punct";
      prevText = "/";
      continue;
    }

    prevType = "punct";
    prevText = ch;
    i += 1;
  }

  return offsets;
}

for (let fileIndex = 0; fileIndex < controllerFiles.length; fileIndex++) {
  let filePath = path.join(__dirname, controllerFiles[fileIndex]);
  let source = fs.readFileSync(filePath, "utf8");

  assert.ok(
    source.indexOf("RegExp") === -1,
    controllerFiles[fileIndex] + " must not use the RegExp constructor - not supported by Shelly's mJS runtime on some device firmware",
  );

  let regexOffsets = findRegexLiteralOffsets(source);
  assert.deepStrictEqual(
    regexOffsets.map((offset) => source.slice(offset, offset + 40)),
    [],
    controllerFiles[fileIndex] + " must not contain any regex literal - not supported by Shelly's mJS runtime on some device firmware",
  );
}

// Self-test for the tokenizer above: confirm it actually distinguishes
// division from a real regex literal, so a future refactor of it can't
// silently turn this guard into a no-op.
assert.strictEqual(findRegexLiteralOffsets("let x = z / 146097;").length, 0, "division after an identifier must not be flagged as a regex literal");
assert.strictEqual(findRegexLiteralOffsets("let x = 10 / 2;").length, 0, "division after a number must not be flagged as a regex literal");
assert.strictEqual(findRegexLiteralOffsets('let u = "https://example.com";').length, 0, "a URL inside a string must not be flagged as a regex literal");
assert.strictEqual(findRegexLiteralOffsets("return /^\\d{4}$/.test(x);").length, 1, "the tokenizer must still detect an actual regex literal");

console.log("EnergyZen Shelly controller tests passed");
