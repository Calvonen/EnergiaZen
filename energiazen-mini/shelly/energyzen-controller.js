// EnergyZen Shelly controller source.
// Keep this file readable. energyzen-controller.min.js is generated for Shelly.

let SWITCH_ID = 0;
let CHECK_INTERVAL_MS = 60000;
let MAX_READING_AGE_SECONDS = 120;
// Yksittainen epaluotettava kierros (esim. hetkellinen Wi-Fi-katko) ei enaa
// yksinaan riita kaynnistamaan varatuntilammitysta sokeasti - vasta kolmas
// PERAKKAINEN epaluotettava kierros sallii nykyisen
// backup-fault-override-kayttaytymisen (ks. DATA_FAULT_REASONS alla).
let REQUIRED_UNRELIABLE_CYCLES = 3;
// Sama suoja control-plane-puolelle: yksittainen transientti plan-/
// heartbeat-haun hairio (resolvePlanControl/resolveTrustedPlanControl
// paatyy source:"backup") ei enaa yksinaan saa ottaa backup_hours-listaa
// kayttoon ohjaukseen - vasta kolmas PERAKKAINEN tallainen kierros sallii
// sen. Katso applyControlPlaneDebounce.
let REQUIRED_CONTROL_PLANE_UNRELIABLE_CYCLES = 3;
// Hourly pg_cron cadence plus one half-hour operational grace period.
// This gates validation time, never heating_plans.updated_at.
let MAX_BACKEND_VALIDATION_AGE_SECONDS = 90 * 60;
// Keep disabled while the optimizer is shadow-only. Enable only in the same
// controlled deployment that provides an approved backend publication path.
let BACKEND_PLAN_TRUST_ENABLED = true;

let SUPABASE_URL = "https://amyvzelzbvjvrevikvrp.supabase.co";
let SUPABASE_KEY =
  "sb_publishable_XTchn_mNxZwYWw06_Iphxw_IGYT44WV";

let DEFAULT_BACKUP_HOURS = [2, 3, 4];
let DEFAULT_FALLBACK_ENABLED = true;
let requestRunning = false;

// Nama syyt kertovat etta emme voi luottaa mittausdataan (vanha/puuttuva/
// virheellinen lukema tai sen hakeminen epaonnistui) - emme siis tieda onko
// varaaja jo taysi. Silloin varaaja lammitetaan silti ehdoitta jos ollaan
// varatunnilla, koska varaajan oma termostaatti estaa ylikuumenemisen; muut
// vikasyyt (esim. "hour-not-planned") eivat kata mittausdataa eivatka
// siis laukaise tata ohitusta.
let DATA_FAULT_REASONS = {
  "invalid-reading": true,
  "missing-reading": true,
  "missing-reading-time": true,
  "reading-fetch-error": true,
  "stale-reading": true,
};

function createControllerState() {
  return {
    consecutiveControlPlaneUnreliableCycles: 0,
    consecutiveUnreliableCycles: 0,
  };
}

let controllerState = createControllerState();

function resetUnreliableCycles(state) {
  state.consecutiveUnreliableCycles = 0;
}

function resetControlPlaneUnreliableCycles(state) {
  state.consecutiveControlPlaneUnreliableCycles = 0;
}

function pad2(value) {
  return value < 10 ? "0" + value : "" + value;
}

// Shelly's mJS runtime does not implement Date's getUTC-prefixed accessors
// or the UTC-constructing static Date helper (confirmed in production by a
// "function not found" crash on one of them), so the current Helsinki
// date/hour is derived from the device's own Sys status
// instead of a self-computed DST table: sys.time is already local
// wall-clock time (device timezone is assumed to be Europe/Helsinki), and
// sys.unixtime (a UTC epoch) is only used, via plain integer arithmetic,
// to tell whether that local time has rolled past midnight into the next
// calendar day.
//
// Shelly's Sys.GetStatus documentation guarantees sys.time is fixed-width
// "HH:MM" with a leading zero, so the hour is read with a plain string
// slice + Number() conversion - both definitely supported by Shelly's
// mJS runtime.
function parseSysLocalHour(time) {
  if (typeof time !== "string" || time.length !== 5 || time.indexOf(":") !== 2) {
    return -1;
  }

  let hour = Number(time.slice(0, 2));

  if (!(hour >= 0 && hour <= 23)) {
    return -1;
  }

  return hour;
}

// Howard Hinnant's days_from_civil/civil_from_days algorithm
// (http://howardhinnant.github.io/date_algorithms.html), pure integer
// arithmetic only - no UTC-family Date methods involved.
function civilDateFromDays(days) {
  let z = days + 719468;
  let era = Math.floor(z / 146097);
  let dayOfEra = z - era * 146097;
  let yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365,
  );
  let year = yearOfEra + era * 400;
  let dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  let monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  let day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  let month = monthPrime < 10 ? monthPrime + 3 : monthPrime - 9;

  return {
    day: day,
    month: month,
    year: month <= 2 ? year + 1 : year,
  };
}

function resolveHelsinkiFromSysStatus(sysStatus) {
  // 1577836800 = 2020-01-01T00:00:00Z, a sanity floor that rejects an
  // unsynced device clock (unixtime near 0) instead of trusting a bogus
  // 1970 date.
  if (!sysStatus || typeof sysStatus.unixtime !== "number" || sysStatus.unixtime < 1577836800) {
    return null;
  }

  let localHour = parseSysLocalHour(sysStatus.time);

  if (localHour < 0) {
    return null;
  }

  let unixtime = sysStatus.unixtime;
  let utcDays = Math.floor(unixtime / 86400);
  let utcHour = Math.floor((unixtime - utcDays * 86400) / 3600);
  // Helsinki is always ahead of UTC (winter +2h / summer +3h, never
  // behind), so the local calendar date only ever equals the UTC date or
  // is one day ahead of it - that rollover happens exactly when the local
  // hour has wrapped past midnight below the UTC hour.
  let localDays = localHour < utcHour ? utcDays + 1 : utcDays;
  let date = civilDateFromDays(localDays);

  return {
    dateKey: date.year + "-" + pad2(date.month) + "-" + pad2(date.day),
    hour: localHour,
  };
}

function resolveHelsinkiNow() {
  return resolveHelsinkiFromSysStatus(Shelly.getComponentStatus("sys"));
}

// "Now" for the heartbeat-trust age comparison, as whole UNIX SECONDS
// straight from the device's own Sys status - never derived from
// new Date().getTime() (epoch-milliseconds), matching
// parsePostgresTimestampSeconds above. Same unsynced-clock sanity floor as
// resolveHelsinkiFromSysStatus, kept independent of it so this file's two
// device-time reads (local Helsinki date/hour vs. heartbeat "now") stay
// simple to reason about separately.
function resolveSysUnixtimeSeconds() {
  let sysStatus = Shelly.getComponentStatus("sys");

  if (!sysStatus || typeof sysStatus.unixtime !== "number" || sysStatus.unixtime < 1577836800) {
    return NaN;
  }

  return sysStatus.unixtime;
}

// Inverse of civilDateFromDays above (Howard Hinnant's days_from_civil,
// same source), same pure-integer-arithmetic constraint - no unsupported
// UTC-family Date methods involved.
function daysFromCivil(year, month, day) {
  let y = month <= 2 ? year - 1 : year;
  let era = Math.floor((y >= 0 ? y : y - 399) / 400);
  let yearOfEra = y - era * 400;
  let dayOfYear =
    Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  let dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;

  return era * 146097 + dayOfEra - 719468;
}

// Shelly's mJS Date.parse() misparses the "YYYY-MM-DD HH:MM:SS(.sss)?+00"
// timestamp format Supabase/PostgreSQL emits for
// backend_heating_optimizer_state.last_validated_plan_at - confirmed on a
// real device: Date.parse("2026-08-16 04:23:01.034+00") returned a value
// hours off from the correct epoch. Parsed here deterministically with
// plain string slicing + integer arithmetic instead (the same
// mJS-compatibility approach as parseSysLocalHour/civilDateFromDays
// above), so isTrustedBackendHeartbeat no longer depends on Date.parse
// for this format at all.
//
// Returns whole UNIX SECONDS, never epoch-milliseconds: a second on-device
// test confirmed Shelly's mJS also loses several milliseconds of precision
// doing arithmetic at epoch-millisecond magnitude (~1.7e12), even with
// this same deterministic integer parser. Heartbeat freshness only ever
// needs whole-second precision (MAX_BACKEND_VALIDATION_AGE_SECONDS), and
// epoch-SECONDS magnitude (~1.7e9) is the same range as sys.unixtime,
// already used elsewhere in this file without any precision issue - so
// the fractional-second part is read only far enough to validate it and
// find the following timezone offset, then deliberately dropped. Also
// accepts the ISO "T" separator and a "Z" or "+HH:MM"/"-HH:MM" offset,
// since existing tests and any future ISO-formatted source should keep
// working too.
function parsePostgresTimestampSeconds(value) {
  if (typeof value !== "string" || value.length < 19) {
    return NaN;
  }

  if (
    value.charAt(4) !== "-" ||
    value.charAt(7) !== "-" ||
    (value.charAt(10) !== " " && value.charAt(10) !== "T") ||
    value.charAt(13) !== ":" ||
    value.charAt(16) !== ":"
  ) {
    return NaN;
  }

  let year = Number(value.slice(0, 4));
  let month = Number(value.slice(5, 7));
  let day = Number(value.slice(8, 10));
  let hour = Number(value.slice(11, 13));
  let minute = Number(value.slice(14, 16));
  let second = Number(value.slice(17, 19));

  if (
    !isFiniteNumber(year) ||
    !isFiniteNumber(month) || month < 1 || month > 12 ||
    !isFiniteNumber(day) || day < 1 || day > 31 ||
    !isFiniteNumber(hour) || hour < 0 || hour > 23 ||
    !isFiniteNumber(minute) || minute < 0 || minute > 59 ||
    !isFiniteNumber(second) || second < 0 || second > 59
  ) {
    return NaN;
  }

  let rest = value.slice(19);

  if (rest.charAt(0) === ".") {
    let fractionEnd = 1;

    while (
      fractionEnd < rest.length &&
      rest.charAt(fractionEnd) >= "0" &&
      rest.charAt(fractionEnd) <= "9"
    ) {
      fractionEnd += 1;
    }

    if (fractionEnd === 1) {
      return NaN;
    }

    rest = rest.slice(fractionEnd);
  }

  let offsetMinutes = 0;

  if (rest.length > 0) {
    if (rest === "Z") {
      offsetMinutes = 0;
    } else {
      let sign = rest.charAt(0);

      if ((sign !== "+" && sign !== "-") || rest.length < 3) {
        return NaN;
      }

      let offsetHour = Number(rest.slice(1, 3));
      let offsetMinute = 0;
      let minutePart = rest.slice(3);

      if (minutePart.length > 0) {
        if (minutePart.charAt(0) === ":") {
          minutePart = minutePart.slice(1);
        }

        if (minutePart.length !== 2) {
          return NaN;
        }

        offsetMinute = Number(minutePart);
      }

      if (
        !isFiniteNumber(offsetHour) || offsetHour < 0 || offsetHour > 23 ||
        !isFiniteNumber(offsetMinute) || offsetMinute < 0 || offsetMinute > 59
      ) {
        return NaN;
      }

      offsetMinutes = (offsetHour * 60 + offsetMinute) * (sign === "-" ? -1 : 1);
    }
  }

  let localAsUtcSeconds =
    daysFromCivil(year, month, day) * 86400 +
    hour * 3600 +
    minute * 60 +
    second;

  return localAsUtcSeconds - offsetMinutes * 60;
}

function isFiniteNumber(value) {
  return typeof value === "number" && isFinite(value);
}

function isValidHour(value) {
  return (
    typeof value === "number" &&
    value >= 0 &&
    value <= 23 &&
    Math.floor(value) === value
  );
}

function normalizeHours(hours) {
  let result = [];
  let seen = {};

  if (!Array.isArray(hours)) {
    return result;
  }

  for (let index = 0; index < hours.length; index++) {
    if (isValidHour(hours[index])) {
      seen[hours[index]] = true;
    }
  }

  for (let hour = 0; hour <= 23; hour++) {
    if (seen[hour] === true) {
      result.push(hour);
    }
  }

  return result;
}

function containsHour(hours, hour) {
  for (let index = 0; index < hours.length; index++) {
    if (hours[index] === hour) {
      return true;
    }
  }

  return false;
}

function createDefaultSettings() {
  return {
    backupHours: DEFAULT_BACKUP_HOURS,
    enabled: DEFAULT_FALLBACK_ENABLED,
    // Deliberately never cached (see loadCachedSettings/saveCachedSettings) -
    // a stale cached mode could wrongly authorize the fixed-plan heartbeat
    // exemption below during a settings fetch failure. null here means
    // "authoritative mode unknown", which correctly denies that exemption.
    heatingNeedMode: null,
  };
}

function normalizeSettingsRow(row, fallbackSettings) {
  let backupHours = normalizeHours(row.backup_hours);

  return {
    backupHours:
      backupHours.length > 0
        ? backupHours
        : fallbackSettings.backupHours,
    enabled:
      typeof row.fallback_enabled === "boolean"
        ? row.fallback_enabled
        : fallbackSettings.enabled,
    // Freshly read every runController() cycle from the same authoritative
    // heating_control_settings row already fetched here - never taken from
    // fallbackSettings (loadCachedSettings' cache never stores it), so a
    // settings fetch failure that falls back to cache correctly yields null.
    heatingNeedMode:
      typeof row.heating_need_mode === "string"
        ? row.heating_need_mode
        : null,
  };
}

// hasStoredFallback tells runController() whether Script.storage actually
// held a previously-cached row (vs. these being untouched defaults) - a
// device that has never once synced successfully must fail closed on a
// transient settings-fetch error instead of trusting unconfigured
// DEFAULT_BACKUP_HOURS.
function loadCachedSettings() {
  let settings = createDefaultSettings();
  settings.hasStoredFallback = false;

  try {
    let stored = Script.storage.getItem("fallback");

    if (stored !== null) {
      let parsed = JSON.parse(stored);
      let backupHours = normalizeHours(parsed.backupHours);

      if (backupHours.length > 0) {
        settings.backupHours = backupHours;
      }

      if (typeof parsed.enabled === "boolean") {
        settings.enabled = parsed.enabled;
      }

      settings.hasStoredFallback = true;
    }
  } catch (error) {
    console.log("EnergyZen: cached settings error", error);
  }

  return settings;
}

function saveCachedSettings(settings) {
  try {
    Script.storage.setItem(
      "fallback",
      JSON.stringify({ backupHours: settings.backupHours, enabled: settings.enabled }),
    );
  } catch (error) {
    console.log("EnergyZen: settings cache write failed", error);
  }
}

function createRequestError(message, allowFallback) {
  return {
    allowFallback: allowFallback === true,
    message: message,
  };
}

function supabaseRequest(path, callback) {
  Shelly.call(
    "HTTP.Request",
    {
      method: "GET",
      url: SUPABASE_URL + "/rest/v1/" + path,
      headers: { apikey: SUPABASE_KEY },
      timeout: 10,
    },
    function (result, errorCode, errorMessage) {
      if (errorCode !== 0) {
        callback(
          null,
          createRequestError("HTTP error: " + errorMessage, true),
        );
        return;
      }

      if (!result || result.code < 200 || result.code >= 300) {
        let status = result ? result.code : 0;
        let transient =
          status === 0 || status === 408 || status === 429 || status >= 500;

        callback(
          null,
          createRequestError(
            "Supabase status: " + (result ? result.code : "unknown"),
            transient,
          ),
        );
        return;
      }

      try {
        callback(JSON.parse(result.body), null);
      } catch (error) {
        callback(null, createRequestError("Invalid JSON response", false));
      }
    },
  );
}

// Sensor sanity check only - no local shower-count/fill-ratio math anymore
// (the backend already accounts for tank calibration when it computes
// planned_hours; a valid EnergyZen plan is trusted as-is for the whole
// planned hour). A reading missing/garbled top_temp or bottom_temp is
// still real data-quality signal though, and feeds "invalid-reading" into
// DATA_FAULT_REASONS below exactly as before.
function isValidReading(reading) {
  return (
    isFiniteNumber(reading.top_temp) && isFiniteNumber(reading.bottom_temp)
  );
}

function decideHeating(input, state) {
  let decisionState = state || controllerState;
  let plannedHours = normalizeHours(input.plannedHours);
  let planned = containsHour(plannedHours, input.currentHour);
  let relayCurrentlyOn = input.relayCurrentlyOn === true;
  let settings = input.settings;
  let reading = input.reading;
  let readingAgeSeconds = null;
  let finalTargetOn = false;
  let backupHours = settings ? normalizeHours(settings.backupHours) : [];
  let isBackupHour = containsHour(backupHours, input.currentHour);
  let reason = input.failSafeReason || null;

  // Trusted/control-plane-approved planned hour: input.planSource is
  // control.source from resolveTrustedPlanControl/applyControlPlaneDebounce
  // (set by executeDecision below) - "energyzen" means this plannedHours
  // list IS the backend's own heartbeat-verified heating_plans.planned_hours,
  // not a backup_hours substitution. Only THAT case (plus no other upstream
  // fail-safe condition - relay/device-time/settings/plan-fetch/heartbeat/
  // reading-fetch problems all still block below, exactly as before) heats
  // unconditionally regardless of Shelly's own tank_readings visibility.
  // Once control-plane fallback adopts backup_hours as plannedHours
  // (source "backup", after its own 3-cycle debounce), every backup hour
  // trivially becomes "planned" too - but planSource stays "backup" there,
  // so this stays false and tank-reading freshness/validity below is still
  // required, preserving the separate tank-reading 3-cycle debounce for an
  // hour that is NOT actually on the backend's real plan.
  let trustedPlannedHour = !reason && planned && input.planSource === "energyzen";

  if (!trustedPlannedHour) {
    // Jos tunti on varatunti, mittausdatan kelvollisuus pitaa arvioida ennen
    // kuin annetaan periksi "hour-not-planned"-syyhyn - muuten anturivika
    // (vanha/puuttuva lukema) varatunnilla joka ei sattunut olemaan mukana
    // TAMAN PAIVAN optimoidussa suunnitelmassa nayttaisi virheellisesti
    // pelkalta "suunnittelematon tunti" -tilalta eika koskaan laukaisisi
    // alla olevaa backup-fault-overridea. Tama on juuri normaali ESP-/
    // anturikatkon polku, koska Supabase itse pysyy tavoitettavissa vaikka
    // tank_readings vanhenee.
    if (!reason && !planned && !isBackupHour) {
      reason = "hour-not-planned";
    }

    // input.readingFetchError (set by fetchLatestReading when the
    // tank_readings REST request itself failed, as opposed to succeeding
    // with an empty/stale/invalid row) is deliberately NOT passed as
    // failSafeReason - a failSafeReason would short-circuit reason before
    // trustedPlannedHour is even computed above, blocking a trusted
    // energyzen-planned hour purely because Shelly's own tank_readings
    // fetch hiccuped. Evaluating it here instead means a trusted planned
    // hour skips it entirely (like every other tank-reading check in this
    // block), while the backup/fallback path below still treats it as the
    // same "reading-fetch-error" DATA_FAULT_REASON it always has, subject
    // to the same 3-cycle debounce.
    if (!reason && input.readingFetchError === true) {
      reason = "reading-fetch-error";
    } else if (!reason && !reading) {
      reason = "missing-reading";
    }

    if (!reason) {
      let timestamp = reading.created_at || reading.measured_at || null;
      let readingTime = timestamp ? new Date(timestamp).getTime() : NaN;

      if (!isFinite(readingTime)) {
        reason = "missing-reading-time";
      } else {
        readingAgeSeconds = (input.nowMs - readingTime) / 1000;

        if (
          readingAgeSeconds < 0 ||
          readingAgeSeconds > MAX_READING_AGE_SECONDS
        ) {
          reason = "stale-reading";
        }
      }
    }

    if (!reason && !isValidReading(reading)) {
      reason = "invalid-reading";
    }

    // Mittausdata oli lopulta kelvollista, mutta tunti ei silti ollut
    // mukana taman paivan suunnitelmassa - pelkka varatuntistatus ei
    // yksinaan riita perusteeksi lammittaa (backup-fault-override alla
    // vaatii oikean datavian, ei pelkkaa poissaoloa suunnitelmasta).
    if (!reason && !planned) {
      reason = "hour-not-planned";
    }
  }

  // Mittausdata ei kelpaa, mutta ollaan silti varatunnilla eika
  // varakaytto ole kaytoston pois - tama kierros VOISI johtaa
  // backup-fault-overrideen. Katso DATA_FAULT_REASONS.
  let unreliableCycleEligible =
    reason !== null &&
    DATA_FAULT_REASONS[reason] === true &&
    settings !== null &&
    settings !== undefined &&
    settings.enabled === true &&
    isBackupHour;

  if (unreliableCycleEligible) {
    decisionState.consecutiveUnreliableCycles = Math.min(
      decisionState.consecutiveUnreliableCycles + 1,
      REQUIRED_UNRELIABLE_CYCLES,
    );
  } else {
    resetUnreliableCycles(decisionState);
  }

  // Yksi tai kaksi perakkaista epaluotettavaa kierrosta ei viela riita -
  // vasta kolmas peräkkäinen sallii sokean lammityksen, koska varaajan oma
  // termostaatti hoitaa turvallisuuden vasta silloin kun katko on aidosti
  // pitkittynyt eika vain hetkellinen.
  let backupFaultOverride =
    unreliableCycleEligible &&
    decisionState.consecutiveUnreliableCycles >= REQUIRED_UNRELIABLE_CYCLES;

  // reason on viela null tassa vaiheessa juuri silloin kun trustedPlannedHour
  // oli tosi (ohitettiin ylla) tai kun mittausdata paatyi lopulta kelvolliseksi
  // suunnitellulla tunnilla ilman muuta failSafeReasonia - molemmissa
  // tapauksissa lammitetaan. Backend on jo paattanyt MITKA tunnit
  // lammitetaan (heating_plans.planned_hours) - Shelly ei enaa laske
  // paikallisesti tayttoastetta paattaakseen KESKEN suunnitellun tunnin
  // pitaisiko lammitys jo lopettaa, vaan luottaa suunnitelmaan sellaisenaan
  // koko tunnin ajan.
  if (backupFaultOverride) {
    finalTargetOn = true;
    reason = "backup-fault-override";
  } else if (!reason) {
    finalTargetOn = true;
    reason = "planned-heating";
  }

  return {
    backupHours: backupHours,
    consecutiveUnreliableCycles:
      decisionState.consecutiveUnreliableCycles,
    currentHour: input.currentHour,
    finalTargetOn: finalTargetOn,
    isBackupHour: isBackupHour,
    planned: planned,
    plannedHours: plannedHours,
    readingAgeSeconds: readingAgeSeconds,
    reason: reason,
    relayCurrentlyOn: relayCurrentlyOn,
    requiredUnreliableCycles: REQUIRED_UNRELIABLE_CYCLES,
  };
}

function resolvePlanControl(rows, error, settings, today) {
  if (error !== null) {
    if (error.allowFallback === true && settings.enabled) {
      return {
        failSafeReason: null,
        plannedHours: settings.backupHours,
        source: "backup",
      };
    }

    return {
      failSafeReason:
        error.allowFallback === true
          ? "fallback-disabled"
          : "plan-response-invalid",
      plannedHours: [],
      source: "fail-safe",
    };
  }

  if (!Array.isArray(rows) || rows.length === 0 || rows[0].plan_date !== today) {
    // Yhteys Supabaseen toimii, mutta tamalle paivalle ei ole (viela)
    // suunnitelmaa - sama tilanne turvallisuusmielessa kuin yhteysvirhe
    // ylla, joten kaytetaan samaa varatunti-fallbackia sen sijaan etta
    // pysahdytaan kokonaan.
    if (settings.enabled) {
      return {
        failSafeReason: null,
        plannedHours: settings.backupHours,
        source: "backup",
      };
    }

    return {
      failSafeReason:
        !Array.isArray(rows) || rows.length === 0
          ? "plan-missing"
          : "wrong-plan-date",
      plannedHours: [],
      source: "fail-safe",
    };
  }

  return {
    failSafeReason: null,
    plannedHours: normalizeHours(rows[0].planned_hours),
    source: "energyzen",
  };
}


// No regex literals are supported by Shelly's mJS runtime on some device
// firmware (confirmed on real hardware: "Uncaught SyntaxError: RegEx are
// not supported in this version of Espruino") - validated here with plain
// length/charAt/slice/Number + numeric range checks instead, the same
// mJS-compatibility approach as parseSysLocalHour/parsePostgresTimestampSeconds
// above. No regex-based APIs are used anywhere else in this file either -
// see the banned-regex-literal guard in the test suite.
function isValidDateKey(value) {
  if (typeof value !== "string" || value.length !== 10) {
    return false;
  }

  if (value.charAt(4) !== "-" || value.charAt(7) !== "-") {
    return false;
  }

  let year = Number(value.slice(0, 4));
  let month = Number(value.slice(5, 7));
  let day = Number(value.slice(8, 10));

  return (
    isFiniteNumber(year) &&
    isFiniteNumber(month) && month >= 1 && month <= 12 &&
    isFiniteNumber(day) && day >= 1 && day <= 31
  );
}

function buildPlanFingerprint(planDate, plannedHours) {
  let hours = normalizeHours(plannedHours);
  return isValidDateKey(planDate)
    ? planDate + "|" + hours.join(",")
    : null;
}

// nowSeconds: whole UNIX SECONDS (e.g. Shelly's own sys.unixtime) - never
// epoch-milliseconds, see parsePostgresTimestampSeconds above.
function isTrustedBackendHeartbeat(rows, error, planRow, nowSeconds) {
  if (error !== null || !Array.isArray(rows) || rows.length !== 1 || !planRow) return false;
  let row = rows[0];
  let validatedAtSeconds = parsePostgresTimestampSeconds(row.last_validated_plan_at);
  let ageSeconds = nowSeconds - validatedAtSeconds;
  let planFingerprint = buildPlanFingerprint(planRow.plan_date, planRow.planned_hours);
  return row.health_status === "healthy" && isFinite(validatedAtSeconds) && ageSeconds >= 0 && ageSeconds <= MAX_BACKEND_VALIDATION_AGE_SECONDS && planFingerprint !== null && row.validated_plan_fingerprint === planFingerprint;
}

function resolveTrustedPlanControl(planRows, planError, heartbeatRows, heartbeatError, settings, today, nowSeconds) {
  let control = resolvePlanControl(planRows, planError, settings, today);
  // Fixed rows are authoritative user commands, not optimizer publications -
  // but only when heating_control_settings.heating_need_mode (fetched fresh
  // every cycle alongside the rest of settings, see runController) still
  // confirms "fixed" too. Without this, a stored fixed plan left over from
  // before another device switched the authoritative mode to "automatic"
  // would keep bypassing heartbeat trust indefinitely. Any other mode value
  // - "automatic", missing, or invalid (settings fetch failure fell back to
  // uncached-mode defaults) - denies the exemption and falls through to the
  // same heartbeat-trust check and backup/fail-safe path automatic rows
  // already use below.
  if (control.source !== "energyzen" || (planRows[0].mode === "fixed" && settings.heatingNeedMode === "fixed") || isTrustedBackendHeartbeat(heartbeatRows, heartbeatError, planRows[0], nowSeconds)) return control;
  return settings.enabled
    ? { failSafeReason: null, plannedHours: settings.backupHours, source: "backup" }
    : { failSafeReason: "backend-heartbeat-untrusted", plannedHours: [], source: "fail-safe" };
}

// Debounces the transition into control.source === "backup" (a transient
// plan-fetch/heartbeat problem, resolved by resolvePlanControl/
// resolveTrustedPlanControl above) the same way decideHeating debounces the
// tank-reading backup-fault-override: a single or second consecutive
// "backup" resolution must not yet let backup_hours drive the relay -
// only the third consecutive one does. Any other source ("energyzen" -
// the normal, trusted plan - or the already-safe "fail-safe" path) resets
// the counter immediately and passes control through untouched, so normal
// EnergyZen-planned heating is never delayed by this.
function applyControlPlaneDebounce(control, state) {
  let decisionState = state || controllerState;

  if (control.source !== "backup") {
    resetControlPlaneUnreliableCycles(decisionState);
    return control;
  }

  decisionState.consecutiveControlPlaneUnreliableCycles = Math.min(
    decisionState.consecutiveControlPlaneUnreliableCycles + 1,
    REQUIRED_CONTROL_PLANE_UNRELIABLE_CYCLES,
  );

  if (
    decisionState.consecutiveControlPlaneUnreliableCycles >=
    REQUIRED_CONTROL_PLANE_UNRELIABLE_CYCLES
  ) {
    return control;
  }

  // Pending: not yet debounced through, so backup_hours must not influence
  // the relay this cycle. failSafeReason stays null (not a fail-safe short
  // circuit) so the tank reading is still fetched and decideHeating's own
  // independent stale/missing-reading debounce keeps running exactly as it
  // would on a normal cycle - only the plan-derived planned-hours list is
  // withheld.
  return {
    failSafeReason: null,
    plannedHours: [],
    source: "backup-pending",
  };
}

function logDecision(decision, source) {
  console.log(
    "EnergyZen decision:",
    JSON.stringify({
      backupHours: decision.backupHours,
      // Kaksi ERI laskuria tarkoituksella: consecutive*ControlPlane*
      // koskee plan-/heartbeat-haun luotettavuutta (applyControlPlaneDebounce
      // yllä), consecutiveUnreliableCycles (ilman ControlPlane-etuliitetta)
      // koskee tank_readings-lukeman luotettavuutta (decideHeating) - nayta
      // molemmat erikseen, jotta lokista nakee kumpi kynnys kasvaa.
      consecutiveControlPlaneUnreliableCycles:
        controllerState.consecutiveControlPlaneUnreliableCycles,
      consecutiveUnreliableCycles:
        decision.consecutiveUnreliableCycles,
      currentHour: decision.currentHour,
      finalTargetOn: decision.finalTargetOn,
      isBackupHour: decision.isBackupHour,
      planned: decision.planned,
      readingAgeSeconds: decision.readingAgeSeconds,
      reason: decision.reason,
      relayCurrentlyOn: decision.relayCurrentlyOn,
      requiredControlPlaneUnreliableCycles:
        REQUIRED_CONTROL_PLANE_UNRELIABLE_CYCLES,
      requiredUnreliableCycles:
        decision.requiredUnreliableCycles,
      source: source,
    }),
  );
}

function setOutput(targetOn, currentOn) {
  if (currentOn === targetOn) {
    requestRunning = false;
    return;
  }

  Shelly.call(
    "Switch.Set",
    { id: SWITCH_ID, on: targetOn },
    function (_result, errorCode, errorMessage) {
      if (errorCode !== 0) {
        console.log("EnergyZen: Switch.Set failed", errorMessage);
      }

      requestRunning = false;
    },
  );
}

function executeDecision(control, settings, reading) {
  Shelly.call(
    "Switch.GetStatus",
    { id: SWITCH_ID },
    function (status, errorCode, errorMessage) {
      if (errorCode !== 0 || !status) {
        let helsinkiNow = resolveHelsinkiNow();
        let failedDecision = decideHeating(
          {
            currentHour: helsinkiNow ? helsinkiNow.hour : -1,
            failSafeReason: "relay-status-error",
            nowMs: new Date().getTime(),
            planSource: control.source,
            plannedHours: control.plannedHours,
            reading: reading,
            readingFetchError: control.readingFetchError === true,
            relayCurrentlyOn: false,
            settings: settings,
          },
          controllerState,
        );

        console.log("EnergyZen: switch status failed", errorMessage);
        logDecision(failedDecision, control.source);
        setOutput(false, null);
        return;
      }

      let helsinkiNow = resolveHelsinkiNow();
      let decision = decideHeating(
        {
          currentHour: helsinkiNow ? helsinkiNow.hour : -1,
          failSafeReason: control.failSafeReason || (helsinkiNow ? null : "device-time-unavailable"),
          nowMs: new Date().getTime(),
          planSource: control.source,
          plannedHours: control.plannedHours,
          reading: reading,
          readingFetchError: control.readingFetchError === true,
          relayCurrentlyOn: status.output === true,
          settings: settings,
        },
        controllerState,
      );

      logDecision(decision, control.source);
      setOutput(decision.finalTargetOn, decision.relayCurrentlyOn);
    },
  );
}

function fetchLatestReading(control, settings) {
  let readingPath =
    "tank_readings" +
    "?select=top_temp,bottom_temp,created_at,heating" +
    "&order=created_at.desc" +
    "&limit=1";

  supabaseRequest(readingPath, function (rows, error) {
    if (error !== null) {
      // Preserve the ORIGINAL control (source/plannedHours) instead of
      // forcing source:"fail-safe" here - a tank_readings fetch hiccup
      // must not by itself defeat an otherwise heartbeat-verified
      // energyzen plan. readingFetchError (not failSafeReason) lets
      // decideHeating exempt a trusted planned hour from it while still
      // treating it as the usual "reading-fetch-error" DATA_FAULT_REASON
      // - and thus still subject to the 3-cycle debounce - on the
      // backup/fallback path.
      executeDecision(
        {
          failSafeReason: null,
          plannedHours: control.plannedHours,
          readingFetchError: true,
          source: control.source,
        },
        settings,
        null,
      );
      return;
    }

    let reading =
      Array.isArray(rows) && rows.length > 0
        ? rows[0]
        : null;

    executeDecision(control, settings, reading);
  });
}

function fetchTodayPlan(settings) {
  let helsinkiNow = resolveHelsinkiNow();

  if (helsinkiNow === null) {
    executeDecision(
      {
        failSafeReason: "device-time-unavailable",
        plannedHours: [],
        source: "fail-safe",
      },
      settings,
      null,
    );
    return;
  }

  let today = helsinkiNow.dateKey;
  let planPath =
    "heating_plans" +
    "?select=plan_date,planned_hours,updated_at,mode" +
    "&plan_date=eq." +
    today +
    "&limit=1";

  supabaseRequest(planPath, function (rows, error) {
    if (!BACKEND_PLAN_TRUST_ENABLED) {
      let shadowControl = applyControlPlaneDebounce(
        resolvePlanControl(rows, error, settings, today),
        controllerState,
      );
      if (shadowControl.failSafeReason !== null) executeDecision(shadowControl, settings, null);
      else fetchLatestReading(shadowControl, settings);
      return;
    }
    let heartbeatPath = "backend_heating_optimizer_state?select=health_status,last_validated_plan_at,validated_plan_fingerprint&id=eq.1&limit=1";
    supabaseRequest(heartbeatPath, function (heartbeatRows, heartbeatError) {
      let control = applyControlPlaneDebounce(
        resolveTrustedPlanControl(rows, error, heartbeatRows, heartbeatError, settings, today, resolveSysUnixtimeSeconds()),
        controllerState,
      );
      if (control.failSafeReason !== null) executeDecision(control, settings, null);
      else fetchLatestReading(control, settings);
    });
  });
}

function runController() {
  if (requestRunning) {
    console.log("EnergyZen: previous request still running");
    return;
  }

  requestRunning = true;

  let cachedSettings = loadCachedSettings();
  let settingsPath =
    "heating_control_settings" +
    "?select=backup_hours,fallback_enabled,heating_need_mode" +
    "&id=eq.1" +
    "&limit=1";

  supabaseRequest(settingsPath, function (rows, error) {
    let settings = null;

    if (
      error === null &&
      Array.isArray(rows) &&
      rows.length > 0
    ) {
      settings = normalizeSettingsRow(rows[0], cachedSettings);
      saveCachedSettings(settings);
    } else if (
      error !== null &&
      error.allowFallback === true &&
      cachedSettings.hasStoredFallback === true
    ) {
      settings = cachedSettings;
      console.log(
        "EnergyZen: settings connection failed, using stored cache",
        error.message,
      );
    }

    if (settings === null) {
      executeDecision(
        {
          failSafeReason: "settings-unavailable",
          plannedHours: [],
          source: "fail-safe",
        },
        settings,
        null,
      );
      return;
    }

    fetchTodayPlan(settings);
  });
}

function startController() {
  runController();

  Timer.set(CHECK_INTERVAL_MS, true, function () {
    runController();
  });
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    REQUIRED_CONTROL_PLANE_UNRELIABLE_CYCLES:
      REQUIRED_CONTROL_PLANE_UNRELIABLE_CYCLES,
    REQUIRED_UNRELIABLE_CYCLES: REQUIRED_UNRELIABLE_CYCLES,
    applyControlPlaneDebounce: applyControlPlaneDebounce,
    buildPlanFingerprint: buildPlanFingerprint,
    createControllerState: createControllerState,
    createRequestError: createRequestError,
    decideHeating: decideHeating,
    isTrustedBackendHeartbeat: isTrustedBackendHeartbeat,
    isValidDateKey: isValidDateKey,
    parsePostgresTimestampSeconds: parsePostgresTimestampSeconds,
    resolveHelsinkiFromSysStatus: resolveHelsinkiFromSysStatus,
    resolvePlanControl: resolvePlanControl,
    resolveTrustedPlanControl: resolveTrustedPlanControl,
  };
}

if (typeof Shelly !== "undefined" && typeof Timer !== "undefined") {
  startController();
}
