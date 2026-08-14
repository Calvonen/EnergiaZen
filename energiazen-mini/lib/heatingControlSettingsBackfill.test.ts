import { defaultSettings, type EnergiaZenSettings } from "./settings";
import {
  ensureHeatingControlSettingsBackfilled,
  isHeatingControlSettingsRowAuthoritative,
  isHeatingControlSettingsSyncOutcomeSynced,
  type HeatingControlSettingsCompletenessRow,
} from "./heatingControlSettingsBackfill";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// A plain function parameter narrows cleanly; reading the field through
// this (rather than directly off a `let` reassigned inside the upsert
// closures above) avoids a TS control-flow narrowing quirk where a
// closure-captured `let` can get stuck narrowed to its initializer's type.
function readHeatingNeedMode(settings: EnergiaZenSettings | null) {
  return settings ? settings.heatingNeedMode : null;
}

const completeAutomaticRow: HeatingControlSettingsCompletenessRow = {
  automatic_max_heating_hours: 3,
  full_tank_average_temperature: 55,
  full_tank_showers: 6,
  heating_gain_source: "learned",
  heating_need_mode: "automatic",
  max_tank_temperature: 70,
  min_tank_temperature: 10,
  safety_shower_reserve: 1.5,
  target_shower_reserve: 3,
};

// A row created before the authoritative optimizer columns existed -
// exactly the pre-migration shape described in the Codex P1 finding.
const legacyEmptyRow: HeatingControlSettingsCompletenessRow = {
  automatic_max_heating_hours: null,
  full_tank_average_temperature: null,
  full_tank_showers: null,
  heating_gain_source: null,
  heating_need_mode: null,
  max_tank_temperature: null,
  min_tank_temperature: null,
  safety_shower_reserve: null,
  target_shower_reserve: null,
};

export async function runHeatingControlSettingsBackfillUnitTests() {
  assertEqual(
    isHeatingControlSettingsRowAuthoritative(null),
    false,
    "no row at all must not be authoritative",
  );
  assertEqual(
    isHeatingControlSettingsRowAuthoritative(legacyEmptyRow),
    false,
    "an old row with every new column NULL must not be authoritative",
  );
  assertEqual(
    isHeatingControlSettingsRowAuthoritative(completeAutomaticRow),
    true,
    "a fully populated automatic row must be authoritative",
  );
  assertEqual(
    isHeatingControlSettingsRowAuthoritative({
      ...completeAutomaticRow,
      heating_need_mode: "fixed",
    }),
    true,
    "a fully populated fixed row must also be authoritative - completeness does not depend on which mode is selected",
  );
  assertEqual(
    isHeatingControlSettingsRowAuthoritative({
      ...completeAutomaticRow,
      automatic_max_heating_hours: null,
    }),
    false,
    "any single missing authoritative field must fail completeness",
  );
  assertEqual(
    isHeatingControlSettingsRowAuthoritative({
      ...completeAutomaticRow,
      heating_gain_source: "invalid" as unknown as string,
    }),
    false,
    "an invalid heating_gain_source must fail completeness",
  );

  const localSettings: EnergiaZenSettings = {
    ...defaultSettings,
    automaticMaxHeatingHours: 4,
    heatingNeedMode: "automatic",
  };

  // "upgrade ilman että käyttäjä käy settings-näkymässä" + "authoritative
  // local settings -> Supabase backfill": an incomplete/missing remote row
  // must be backfilled from the app's own already-loaded local settings,
  // with no user interaction and no arbitrary backend default substituted.
  {
    let upsertedSettings: EnergiaZenSettings | null = null;
    const outcome = await ensureHeatingControlSettingsBackfilled({
      fetchRow: async () => ({ data: null, error: null }),
      localSettings,
      upsert: async (settings) => {
        upsertedSettings = settings;
      },
    });
    assertEqual(outcome, "backfilled", "a missing remote row must trigger a backfill");
    assertEqual(
      upsertedSettings,
      localSettings,
      "the backfill must upsert exactly the app's current local settings, not an arbitrary default",
    );
    assertEqual(
      isHeatingControlSettingsSyncOutcomeSynced(outcome),
      true,
      "a successful backfill must count as synced",
    );
  }

  // "jo täydellinen Supabase settings-rivi ei regressioidu": an already-
  // authoritative row must short-circuit without ever calling upsert.
  {
    let upsertCalled = false;
    const outcome = await ensureHeatingControlSettingsBackfilled({
      fetchRow: async () => ({ data: completeAutomaticRow, error: null }),
      localSettings,
      upsert: async () => {
        upsertCalled = true;
      },
    });
    assertEqual(outcome, "already_synced", "an already-complete row must not be rewritten");
    assertEqual(upsertCalled, false, "already_synced must never call upsert");
    assertEqual(
      isHeatingControlSettingsSyncOutcomeSynced(outcome),
      true,
      "already_synced must count as synced",
    );
  }

  // "epäonnistunut synkronointi ei poista legacy publisheria käytöstä": both
  // a failed read and a failed write must resolve to a non-synced outcome.
  {
    const checkFailedOutcome = await ensureHeatingControlSettingsBackfilled({
      fetchRow: async () => ({ data: null, error: new Error("network down") }),
      localSettings,
      upsert: async () => {
        throw new Error("must not be called when the read failed");
      },
    });
    assertEqual(checkFailedOutcome, "check_failed", "a failed read must resolve to check_failed");
    assertEqual(
      isHeatingControlSettingsSyncOutcomeSynced(checkFailedOutcome),
      false,
      "check_failed must never count as synced",
    );

    const backfillFailedOutcome = await ensureHeatingControlSettingsBackfilled({
      fetchRow: async () => ({ data: legacyEmptyRow, error: null }),
      localSettings,
      upsert: async () => {
        throw new Error("simulated remote write failure");
      },
    });
    assertEqual(
      backfillFailedOutcome,
      "backfill_failed",
      "a failed remote write must resolve to backfill_failed",
    );
    assertEqual(
      isHeatingControlSettingsSyncOutcomeSynced(backfillFailedOutcome),
      false,
      "backfill_failed must never count as synced",
    );
  }

  // "fixed mode ei muutu automaticiksi": backfilling a fixed-mode install
  // must write heating_need_mode back as "fixed", never force "automatic".
  {
    const fixedLocalSettings: EnergiaZenSettings = {
      ...defaultSettings,
      heatingNeedMode: "fixed",
    };
    let upsertedSettings: EnergiaZenSettings | null = null;
    const outcome = await ensureHeatingControlSettingsBackfilled({
      fetchRow: async () => ({ data: legacyEmptyRow, error: null }),
      localSettings: fixedLocalSettings,
      upsert: async (settings) => {
        upsertedSettings = settings;
      },
    });
    assertEqual(outcome, "backfilled", "a fixed-mode install must still be backfilled");
    assertEqual(
      upsertedSettings !== null,
      true,
      "backfilling a fixed-mode install must call upsert",
    );
    assertEqual(
      readHeatingNeedMode(upsertedSettings),
      "fixed",
      "backfilling a fixed-mode install must preserve heating_need_mode = fixed, not force automatic",
    );
  }
}
