// EnergyZen Shelly-ohjain
// SWITCH_ID 0 on lämminvesivaraajan oikea relekanava.

let SWITCH_ID = 0;
let CHECK_INTERVAL_MS = 60000;

let SUPABASE_URL = "https://amyvzelzbvjvrevikvrp.supabase.co";

// Käytä samaa publishable/anon-avainta kuin EnergyZen-sovelluksessa.
// Älä käytä service_role- tai secret-avainta Shelly-scriptissä.
let SUPABASE_KEY =
  "sb_publishable_XTchn_mNxZwYWw06_Iphxw_IGYT44WV";

let DEFAULT_BACKUP_HOURS = [2, 3, 4];
let DEFAULT_FALLBACK_ENABLED = true;

let requestRunning = false;

function pad2(value) {
  return value < 10 ? "0" + value : "" + value;
}

function getLocalDateKey() {
  let now = new Date();

  return (
    now.getFullYear() +
    "-" +
    pad2(now.getMonth() + 1) +
    "-" +
    pad2(now.getDate())
  );
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
    let hour = hours[index];

    if (isValidHour(hour) && seen[hour] !== true) {
      seen[hour] = true;
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

function loadCachedSettings() {
  let fallbackEnabled = DEFAULT_FALLBACK_ENABLED;
  let backupHours = DEFAULT_BACKUP_HOURS;

  try {
    let stored = Script.storage.getItem("fallback");

    if (stored !== null) {
      let parsed = JSON.parse(stored);
      let normalizedHours = normalizeHours(parsed.backupHours);

      if (typeof parsed.enabled === "boolean") {
        fallbackEnabled = parsed.enabled;
      }

      if (normalizedHours.length > 0) {
        backupHours = normalizedHours;
      }
    }
  } catch (error) {
    console.log("EnergyZen: cached settings error", error);
  }

  return {
    enabled: fallbackEnabled,
    backupHours: backupHours,
  };
}

function saveCachedSettings(enabled, backupHours) {
  try {
    Script.storage.setItem(
      "fallback",
      JSON.stringify({
        enabled: enabled,
        backupHours: backupHours,
      }),
    );
  } catch (error) {
    console.log(
      "EnergyZen: settings cache write failed",
      error,
    );
  }
}

function supabaseRequest(path, callback) {
  Shelly.call(
    "HTTP.Request",
    {
      method: "GET",
      url: SUPABASE_URL + "/rest/v1/" + path,
      headers: {
        apikey: SUPABASE_KEY,
      },
      timeout: 10,
    },
    function (result, errorCode, errorMessage) {
      if (errorCode !== 0) {
        callback(null, "HTTP error: " + errorMessage);
        return;
      }

      if (
        !result ||
        result.code < 200 ||
        result.code >= 300
      ) {
        callback(
          null,
          "Supabase status: " +
            (result ? result.code : "unknown"),
        );
        return;
      }

      try {
        callback(JSON.parse(result.body), null);
      } catch (error) {
        callback(null, "Invalid JSON response");
      }
    },
  );
}

function setOutput(targetOn, source, hours) {
  Shelly.call(
    "Switch.GetStatus",
    { id: SWITCH_ID },
    function (status, errorCode, errorMessage) {
      if (errorCode !== 0 || !status) {
        console.log(
          "EnergyZen: switch status failed",
          errorMessage,
        );
        requestRunning = false;
        return;
      }

      let currentOn = status.output === true;

      console.log(
        "EnergyZen:",
        "source=" + source,
        "hour=" + new Date().getHours(),
        "hours=" + JSON.stringify(hours),
        "current=" + currentOn,
        "target=" + targetOn,
      );

      if (currentOn === targetOn) {
        requestRunning = false;
        return;
      }

      Shelly.call(
        "Switch.Set",
        {
          id: SWITCH_ID,
          on: targetOn,
        },
        function (
          _result,
          setErrorCode,
          setErrorMessage
        ) {
          if (setErrorCode !== 0) {
            console.log(
              "EnergyZen: Switch.Set failed",
              setErrorMessage,
            );
          } else {
            console.log(
              "EnergyZen: water-heater relay set to",
              targetOn ? "ON" : "OFF",
            );
          }

          requestRunning = false;
        },
      );
    },
  );
}

function useFallback(settings, reason) {
  let currentHour = new Date().getHours();

  if (!settings.enabled) {
    console.log(
      "EnergyZen: fallback disabled:",
      reason,
    );
    setOutput(false, "fallback-disabled", []);
    return;
  }

  let targetOn = containsHour(
    settings.backupHours,
    currentHour,
  );

  console.log("EnergyZen: using fallback:", reason);

  setOutput(
    targetOn,
    "backup",
    settings.backupHours,
  );
}

function fetchTodayPlan(settings) {
  let today = getLocalDateKey();

  let path =
    "heating_plans" +
    "?select=plan_date,planned_hours,updated_at" +
    "&plan_date=eq." +
    today +
    "&limit=1";

  supabaseRequest(path, function (rows, error) {
    if (error !== null) {
      useFallback(settings, error);
      return;
    }

    if (
      !Array.isArray(rows) ||
      rows.length === 0
    ) {
      useFallback(settings, "today plan missing");
      return;
    }

    let plan = rows[0];

    if (plan.plan_date !== today) {
      useFallback(settings, "wrong plan date");
      return;
    }

    let plannedHours = normalizeHours(
      plan.planned_hours,
    );

    // Tyhjä planned_hours on kelvollinen suunnitelma:
    // se tarkoittaa, ettei tänään lämmitetä.
    let currentHour = new Date().getHours();

    let targetOn = containsHour(
      plannedHours,
      currentHour,
    );

    setOutput(
      targetOn,
      "energyzen",
      plannedHours,
    );
  });
}

function runController() {
  if (requestRunning) {
    console.log(
      "EnergyZen: previous request still running",
    );
    return;
  }

  requestRunning = true;

  let cachedSettings = loadCachedSettings();

  let settingsPath =
    "heating_control_settings" +
    "?select=backup_hours,fallback_enabled" +
    "&id=eq.1" +
    "&limit=1";

  supabaseRequest(
    settingsPath,
    function (rows, error) {
      if (
        error === null &&
        Array.isArray(rows) &&
        rows.length > 0
      ) {
        let row = rows[0];

        let normalizedHours = normalizeHours(
          row.backup_hours,
        );

        if (normalizedHours.length > 0) {
          cachedSettings.backupHours =
            normalizedHours;
        }

        if (
          typeof row.fallback_enabled ===
          "boolean"
        ) {
          cachedSettings.enabled =
            row.fallback_enabled;
        }

        saveCachedSettings(
          cachedSettings.enabled,
          cachedSettings.backupHours,
        );
      } else {
        console.log(
          "EnergyZen: settings fetch failed, using cached settings",
          error,
        );
      }

      fetchTodayPlan(cachedSettings);
    },
  );
}

console.log("EnergyZen controller started");
console.log(
  "EnergyZen water-heater switch id:",
  SWITCH_ID,
);

runController();

Timer.set(
  CHECK_INTERVAL_MS,
  true,
  function () {
    runController();
  },
);