// EnergyZen Shelly controller source.
// Keep this file readable. energyzen-controller.min.js is generated for Shelly.

let SWITCH_ID = 0;
let CHECK_INTERVAL_MS = 60000;
let MAX_READING_AGE_SECONDS = 120;
let START_HEATING_FILL_RATIO = 0.92;
let REQUIRED_BLOCKING_READINGS = 2;
// Hourly pg_cron cadence plus one half-hour operational grace period.
// This gates validation time, never heating_plans.updated_at.
let MAX_BACKEND_VALIDATION_AGE_SECONDS = 90 * 60;
// Keep disabled while the optimizer is shadow-only. Enable only in the same
// controlled deployment that provides an approved backend publication path.
let BACKEND_PLAN_TRUST_ENABLED = false;

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
// vikasyyt (esim. "hour-not-planned", "invalid-calibration") eivat kata
// mittausdataa eivatka siis laukaise tata ohitusta.
let DATA_FAULT_REASONS = {
  "invalid-reading": true,
  "missing-reading": true,
  "missing-reading-time": true,
  "reading-fetch-error": true,
  "stale-reading": true,
};

function createControllerState() {
  return { consecutiveHighFillReadings: 0 };
}

let controllerState = createControllerState();

function resetHighFillReadings(state) {
  state.consecutiveHighFillReadings = 0;
}

function pad2(value) {
  return value < 10 ? "0" + value : "" + value;
}

function getHelsinkiParts(now) {
  let year = now.getUTCFullYear();
  let marchLast = new Date(Date.UTC(year, 2, 31));
  let octoberLast = new Date(Date.UTC(year, 9, 31));
  let dstStart = Date.UTC(year, 2, 31 - marchLast.getUTCDay(), 1);
  let dstEnd = Date.UTC(year, 9, 31 - octoberLast.getUTCDay(), 1);
  let offsetHours = now.getTime() >= dstStart && now.getTime() < dstEnd ? 3 : 2;
  let local = new Date(now.getTime() + offsetHours * 60 * 60 * 1000);

  return {
    dateKey: local.getUTCFullYear() + "-" + pad2(local.getUTCMonth() + 1) + "-" + pad2(local.getUTCDate()),
    hour: local.getUTCHours(),
  };
}

function getLocalDateKey() {
  return getHelsinkiParts(new Date()).dateKey;
}

function isFiniteNumber(value) {
  return typeof value === "number" && isFinite(value);
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
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
    fullTankAverageTemperature: null,
    fullTankShowers: null,
    maxTankTemperature: null,
    minTankTemperature: null,
    targetShowerReserve: null,
  };
}

function isValidCalibration(settings) {
  return (
    settings !== null &&
    isFiniteNumber(settings.fullTankShowers) &&
    settings.fullTankShowers > 0 &&
    isFiniteNumber(settings.fullTankAverageTemperature) &&
    isFiniteNumber(settings.minTankTemperature) &&
    isFiniteNumber(settings.maxTankTemperature) &&
    isFiniteNumber(settings.targetShowerReserve) &&
    settings.targetShowerReserve >= 0 &&
    settings.targetShowerReserve <= settings.fullTankShowers &&
    settings.fullTankAverageTemperature > settings.minTankTemperature &&
    settings.fullTankAverageTemperature > 42 &&
    settings.maxTankTemperature > settings.minTankTemperature &&
    settings.fullTankAverageTemperature <= settings.maxTankTemperature
  );
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
    fullTankAverageTemperature:
      row.full_tank_average_temperature,
    fullTankShowers: row.full_tank_showers,
    maxTankTemperature: row.max_tank_temperature,
    minTankTemperature: row.min_tank_temperature,
    targetShowerReserve: row.target_shower_reserve,
  };
}

function loadCachedSettings() {
  let settings = createDefaultSettings();

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

      settings.fullTankAverageTemperature =
        parsed.fullTankAverageTemperature;
      settings.fullTankShowers = parsed.fullTankShowers;
      settings.maxTankTemperature = parsed.maxTankTemperature;
      settings.minTankTemperature = parsed.minTankTemperature;
      settings.targetShowerReserve = parsed.targetShowerReserve;
    }
  } catch (error) {
    console.log("EnergyZen: cached settings error", error);
  }

  return settings;
}

function saveCachedSettings(settings) {
  if (!isValidCalibration(settings)) {
    return;
  }

  try {
    Script.storage.setItem("fallback", JSON.stringify(settings));
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

function calculateCurrentShowers(reading, settings) {
  let topTemperature = reading ? reading.top_temp : null;
  let bottomTemperature = reading ? reading.bottom_temp : null;

  if (
    !isFiniteNumber(topTemperature) ||
    !isFiniteNumber(bottomTemperature) ||
    !isValidCalibration(settings)
  ) {
    return null;
  }

  let weightedTemperature =
    0.7 * topTemperature + 0.3 * bottomTemperature;
  let energyRatio = clamp(
    (weightedTemperature - settings.minTankTemperature) /
      (settings.fullTankAverageTemperature -
        settings.minTankTemperature),
    0,
    1,
  );
  let topUsability = clamp(
    (topTemperature - 42) /
      (settings.fullTankAverageTemperature - 42),
    0,
    1,
  );

  return energyRatio * topUsability * settings.fullTankShowers;
}

function decideHeating(input, state) {
  let decisionState = state || controllerState;
  let plannedHours = normalizeHours(input.plannedHours);
  let planned = containsHour(plannedHours, input.currentHour);
  let relayCurrentlyOn = input.relayCurrentlyOn === true;
  let settings = input.settings;
  let reading = input.reading;
  let readingAgeSeconds = null;
  let currentShowers = null;
  let startThresholdShowers = null;
  let startBlockedByFillRatio = false;
  let finalTargetOn = false;
  let backupHours = settings ? normalizeHours(settings.backupHours) : [];
  let isBackupHour = containsHour(backupHours, input.currentHour);
  let reason = input.failSafeReason || null;

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

  if (!reason && !isValidCalibration(settings)) {
    reason = "invalid-calibration";
  }

  if (!reason && !reading) {
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

  if (!reason) {
    currentShowers = calculateCurrentShowers(reading, settings);

    if (!isFiniteNumber(currentShowers)) {
      reason = "invalid-reading";
    }
  }

  // Mittausdata oli lopulta kelvollista, mutta tunti ei silti ollut
  // mukana taman paivan suunnitelmassa - pelkka varatuntistatus ei
  // yksinaan riita perusteeksi lammittaa (backup-fault-override alla
  // vaatii oikean datavian, ei pelkkaa poissaoloa suunnitelmasta).
  if (!reason && !planned) {
    reason = "hour-not-planned";
  }

  if (isValidCalibration(settings)) {
    startThresholdShowers =
      settings.fullTankShowers * START_HEATING_FILL_RATIO;
  }

  // Mittausdata ei kelpaa, mutta ollaan silti varatunnilla eika
  // varakaytto ole kaytoston pois - lammitetaan sokeana, koska varaajan
  // oma termostaatti hoitaa turvallisuuden. Katso DATA_FAULT_REASONS.
  let backupFaultOverride =
    reason !== null &&
    DATA_FAULT_REASONS[reason] === true &&
    settings !== null &&
    settings !== undefined &&
    settings.enabled === true &&
    isBackupHour;

  if (backupFaultOverride) {
    resetHighFillReadings(decisionState);
    finalTargetOn = true;
    reason = "backup-fault-override";
  } else if (reason) {
    resetHighFillReadings(decisionState);
  } else if (relayCurrentlyOn) {
    resetHighFillReadings(decisionState);
    finalTargetOn = true;
    reason = "planned-heating-continues";
  } else if (currentShowers < startThresholdShowers) {
    resetHighFillReadings(decisionState);
    finalTargetOn = true;
    reason = "planned-heating-starts";
  } else {
    decisionState.consecutiveHighFillReadings = Math.min(
      decisionState.consecutiveHighFillReadings + 1,
      REQUIRED_BLOCKING_READINGS,
    );

    if (
      decisionState.consecutiveHighFillReadings >=
      REQUIRED_BLOCKING_READINGS
    ) {
      startBlockedByFillRatio = true;
      reason = "start-fill-ratio";
    } else {
      reason = "start-fill-ratio-pending";
    }
  }

  return {
    backupHours: backupHours,
    consecutiveHighFillReadings:
      decisionState.consecutiveHighFillReadings,
    currentHour: input.currentHour,
    currentShowers: currentShowers,
    finalTargetOn: finalTargetOn,
    isBackupHour: isBackupHour,
    planned: planned,
    plannedHours: plannedHours,
    readingAgeSeconds: readingAgeSeconds,
    reason: reason,
    relayCurrentlyOn: relayCurrentlyOn,
    requiredBlockingReadings: REQUIRED_BLOCKING_READINGS,
    startBlockedByFillRatio: startBlockedByFillRatio,
    startHeatingFillRatio: START_HEATING_FILL_RATIO,
    startThresholdShowers: startThresholdShowers,
  };
}

function resolvePlanControl(rows, error, settings, today) {
  if (error !== null) {
    if (error.allowFallback === true && settings.enabled) {
      return {
        failSafeReason: null,
        plannedHours: settings.backupHours,
        resetHighFillReadings: true,
        source: "backup",
      };
    }

    return {
      failSafeReason:
        error.allowFallback === true
          ? "fallback-disabled"
          : "plan-response-invalid",
      plannedHours: [],
      resetHighFillReadings: true,
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
        resetHighFillReadings: true,
        source: "backup",
      };
    }

    return {
      failSafeReason:
        !Array.isArray(rows) || rows.length === 0
          ? "plan-missing"
          : "wrong-plan-date",
      plannedHours: [],
      resetHighFillReadings: true,
      source: "fail-safe",
    };
  }

  return {
    failSafeReason: null,
    plannedHours: normalizeHours(rows[0].planned_hours),
    source: "energyzen",
  };
}


function buildPlanFingerprint(planDate, plannedHours) {
  let hours = normalizeHours(plannedHours);
  return typeof planDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(planDate)
    ? planDate + "|" + hours.join(",")
    : null;
}

function isTrustedBackendHeartbeat(rows, error, planRow, nowMs) {
  if (error !== null || !Array.isArray(rows) || rows.length !== 1 || !planRow) return false;
  let row = rows[0];
  let validatedAt = typeof row.last_validated_plan_at === "string" ? Date.parse(row.last_validated_plan_at) : NaN;
  let ageSeconds = (nowMs - validatedAt) / 1000;
  let planFingerprint = buildPlanFingerprint(planRow.plan_date, planRow.planned_hours);
  return row.health_status === "healthy" && isFinite(validatedAt) && ageSeconds >= 0 && ageSeconds <= MAX_BACKEND_VALIDATION_AGE_SECONDS && planFingerprint !== null && row.validated_plan_fingerprint === planFingerprint;
}

function resolveTrustedPlanControl(planRows, planError, heartbeatRows, heartbeatError, settings, today, nowMs) {
  let control = resolvePlanControl(planRows, planError, settings, today);
  // Fixed rows are authoritative user commands, not optimizer publications.
  // Only automatic rows participate in backend heartbeat/fingerprint trust.
  if (control.source !== "energyzen" || planRows[0].mode === "fixed" || isTrustedBackendHeartbeat(heartbeatRows, heartbeatError, planRows[0], nowMs)) return control;
  return settings.enabled
    ? { failSafeReason: null, plannedHours: settings.backupHours, resetHighFillReadings: true, source: "backup" }
    : { failSafeReason: "backend-heartbeat-untrusted", plannedHours: [], resetHighFillReadings: true, source: "fail-safe" };
}

function logDecision(decision, source) {
  console.log(
    "EnergyZen decision:",
    JSON.stringify({
      backupHours: decision.backupHours,
      consecutiveHighFillReadings:
        decision.consecutiveHighFillReadings,
      currentHour: decision.currentHour,
      currentShowers: decision.currentShowers,
      finalTargetOn: decision.finalTargetOn,
      isBackupHour: decision.isBackupHour,
      planned: decision.planned,
      readingAgeSeconds: decision.readingAgeSeconds,
      reason: decision.reason,
      relayCurrentlyOn: decision.relayCurrentlyOn,
      requiredBlockingReadings:
        decision.requiredBlockingReadings,
      source: source,
      startBlockedByFillRatio:
        decision.startBlockedByFillRatio,
      startHeatingFillRatio: decision.startHeatingFillRatio,
      startThresholdShowers: decision.startThresholdShowers,
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
  if (control.resetHighFillReadings === true) {
    resetHighFillReadings(controllerState);
  }

  Shelly.call(
    "Switch.GetStatus",
    { id: SWITCH_ID },
    function (status, errorCode, errorMessage) {
      if (errorCode !== 0 || !status) {
        let failedDecision = decideHeating(
          {
            currentHour: getHelsinkiParts(new Date()).hour,
            failSafeReason: "relay-status-error",
            nowMs: new Date().getTime(),
            plannedHours: control.plannedHours,
            reading: reading,
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

      let decision = decideHeating(
        {
          currentHour: getHelsinkiParts(new Date()).hour,
          failSafeReason: control.failSafeReason,
          nowMs: new Date().getTime(),
          plannedHours: control.plannedHours,
          reading: reading,
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
      executeDecision(
        {
          failSafeReason: "reading-fetch-error",
          plannedHours: control.plannedHours,
          source: "fail-safe",
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
  let today = getLocalDateKey();
  let planPath =
    "heating_plans" +
    "?select=plan_date,planned_hours,updated_at,mode" +
    "&plan_date=eq." +
    today +
    "&limit=1";

  supabaseRequest(planPath, function (rows, error) {
    if (!BACKEND_PLAN_TRUST_ENABLED) {
      let shadowControl = resolvePlanControl(rows, error, settings, today);
      if (shadowControl.failSafeReason !== null) executeDecision(shadowControl, settings, null);
      else fetchLatestReading(shadowControl, settings);
      return;
    }
    let heartbeatPath = "backend_heating_optimizer_state?select=health_status,last_validated_plan_at,validated_plan_fingerprint&id=eq.1&limit=1";
    supabaseRequest(heartbeatPath, function (heartbeatRows, heartbeatError) {
      let control = resolveTrustedPlanControl(rows, error, heartbeatRows, heartbeatError, settings, today, new Date().getTime());
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
    "?select=backup_hours,fallback_enabled," +
    "full_tank_showers,full_tank_average_temperature," +
    "min_tank_temperature,max_tank_temperature," +
    "target_shower_reserve" +
    "&id=eq.1" +
    "&limit=1";

  supabaseRequest(settingsPath, function (rows, error) {
    let settings = null;

    if (error !== null) {
      resetHighFillReadings(controllerState);
    }

    if (
      error === null &&
      Array.isArray(rows) &&
      rows.length > 0
    ) {
      settings = normalizeSettingsRow(rows[0], cachedSettings);

      if (isValidCalibration(settings)) {
        saveCachedSettings(settings);
      }
    } else if (
      error !== null &&
      error.allowFallback === true &&
      isValidCalibration(cachedSettings)
    ) {
      settings = cachedSettings;
      console.log(
        "EnergyZen: settings connection failed, using valid cache",
        error.message,
      );
    }

    if (!isValidCalibration(settings)) {
      executeDecision(
        {
          failSafeReason: "invalid-calibration",
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
    REQUIRED_BLOCKING_READINGS: REQUIRED_BLOCKING_READINGS,
    START_HEATING_FILL_RATIO: START_HEATING_FILL_RATIO,
    buildPlanFingerprint: buildPlanFingerprint,
    calculateCurrentShowers: calculateCurrentShowers,
    createControllerState: createControllerState,
    createRequestError: createRequestError,
    decideHeating: decideHeating,
    getHelsinkiParts: getHelsinkiParts,
    isTrustedBackendHeartbeat: isTrustedBackendHeartbeat,
    isValidCalibration: isValidCalibration,
    resolvePlanControl: resolvePlanControl,
    resolveTrustedPlanControl: resolveTrustedPlanControl,
  };
}

if (typeof Shelly !== "undefined" && typeof Timer !== "undefined") {
  startController();
}
