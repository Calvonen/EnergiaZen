import { defaultSettings, type EnergiaZenSettings } from "./settings";
import {
  ensureHeatingControlSettingsBackfilled,
  isHeatingControlSettingsRowAuthoritative,
  isHeatingControlSettingsSyncOutcomeSynced,
  mergeHeatingControlSettingsBackfillPayload,
  type HeatingControlSettingsBackfillPayloadFields,
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
  backup_hours: [2, 3, 4],
  fallback_enabled: true,
  full_tank_average_temperature: 55,
  full_tank_showers: 6,
  heating_gain_source: "learned",
  heating_need_mode: "automatic",
  max_tank_temperature: 70,
  min_tank_temperature: 10,
  safety_shower_reserve: 1.5,
  target_shower_reserve: 3,
  updated_at: "2026-08-14T10:00:00.000Z",
};

// A row created before the authoritative optimizer columns existed -
// exactly the pre-migration shape described in the Codex P1 finding.
const legacyEmptyRow: HeatingControlSettingsCompletenessRow = {
  automatic_max_heating_hours: null,
  backup_hours: null,
  fallback_enabled: null,
  full_tank_average_temperature: null,
  full_tank_showers: null,
  heating_gain_source: null,
  heating_need_mode: null,
  max_tank_temperature: null,
  min_tank_temperature: null,
  safety_shower_reserve: null,
  target_shower_reserve: null,
  updated_at: null,
};

const localPayload: HeatingControlSettingsBackfillPayloadFields = {
  automatic_max_heating_hours: 4,
  backup_hours: [1, 2],
  fallback_enabled: false,
  full_tank_average_temperature: 50,
  full_tank_showers: 5,
  heating_gain_source: "fixed",
  heating_need_mode: "fixed",
  max_tank_temperature: 65,
  min_tank_temperature: 12,
  safety_shower_reserve: 1,
  target_shower_reserve: 2,
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

  // --- mergeHeatingControlSettingsBackfillPayload ---------------------

  assertEqual(
    mergeHeatingControlSettingsBackfillPayload(localPayload, null),
    localPayload,
    "merging with no observed row at all must return the local payload unchanged",
  );

  // Codex P2 (startup backfill follow-up): a partially-authoritative remote
  // row must keep every field it already has, and only genuinely missing
  // fields may fall back to the local payload.
  {
    const partiallyAuthoritativeRow: HeatingControlSettingsCompletenessRow = {
      ...legacyEmptyRow,
      heating_need_mode: "automatic",
      automatic_max_heating_hours: 6,
      heating_gain_source: "learned",
      updated_at: "2026-08-14T09:00:00.000Z",
    };
    const merged = mergeHeatingControlSettingsBackfillPayload(
      localPayload,
      partiallyAuthoritativeRow,
    );
    assertEqual(
      merged.heating_need_mode,
      "automatic",
      "an already-authoritative remote heating_need_mode must be preserved, not overwritten by a stale local value",
    );
    assertEqual(
      merged.automatic_max_heating_hours,
      6,
      "an already-authoritative remote numeric field must be preserved",
    );
    assertEqual(
      merged.heating_gain_source,
      "learned",
      "an already-authoritative remote heating_gain_source must be preserved",
    );
    assertEqual(
      merged.full_tank_average_temperature,
      localPayload.full_tank_average_temperature,
      "a genuinely missing remote field must fall back to the local value",
    );
    assertEqual(
      merged.full_tank_showers,
      localPayload.full_tank_showers,
      "a genuinely missing remote field must fall back to the local value",
    );
    assertEqual(
      merged.max_tank_temperature,
      localPayload.max_tank_temperature,
      "a genuinely missing remote field must fall back to the local value",
    );
    assertEqual(
      merged.min_tank_temperature,
      localPayload.min_tank_temperature,
      "a genuinely missing remote field must fall back to the local value",
    );
    assertEqual(
      merged.safety_shower_reserve,
      localPayload.safety_shower_reserve,
      "a genuinely missing remote field must fall back to the local value",
    );
    assertEqual(
      merged.target_shower_reserve,
      localPayload.target_shower_reserve,
      "a genuinely missing remote field must fall back to the local value",
    );
    assertEqual(
      merged.backup_hours,
      localPayload.backup_hours,
      "a genuinely missing remote backup_hours must fall back to the local value",
    );
    assertEqual(
      merged.fallback_enabled,
      localPayload.fallback_enabled,
      "a genuinely missing remote fallback_enabled must fall back to the local value",
    );
  }

  // backup_hours/fallback_enabled must be part of the same merge policy as
  // every other field - including preserving an explicit `false`, not just
  // truthy values.
  {
    const rowWithBackupHoursAndFallback: HeatingControlSettingsCompletenessRow = {
      ...completeAutomaticRow,
      backup_hours: [5, 6, 7],
      fallback_enabled: false,
    };
    const merged = mergeHeatingControlSettingsBackfillPayload(
      localPayload,
      rowWithBackupHoursAndFallback,
    );
    assertEqual(
      merged.backup_hours,
      [5, 6, 7],
      "an already-set remote backup_hours must be preserved by the merge",
    );
    assertEqual(
      merged.fallback_enabled,
      false,
      "an already-set remote fallback_enabled (including false) must be preserved",
    );
  }

  // A fully authoritative remote row must win on every field - the merge
  // result must never carry any value from the local payload in that case.
  {
    const fullyAuthoritativeRow: HeatingControlSettingsCompletenessRow = {
      ...completeAutomaticRow,
      backup_hours: [7, 8],
      fallback_enabled: true,
    };
    const merged = mergeHeatingControlSettingsBackfillPayload(
      localPayload,
      fullyAuthoritativeRow,
    );
    assertEqual(
      merged,
      {
        automatic_max_heating_hours: fullyAuthoritativeRow.automatic_max_heating_hours,
        backup_hours: fullyAuthoritativeRow.backup_hours,
        fallback_enabled: fullyAuthoritativeRow.fallback_enabled,
        full_tank_average_temperature:
          fullyAuthoritativeRow.full_tank_average_temperature,
        full_tank_showers: fullyAuthoritativeRow.full_tank_showers,
        heating_gain_source: fullyAuthoritativeRow.heating_gain_source,
        heating_need_mode: fullyAuthoritativeRow.heating_need_mode,
        max_tank_temperature: fullyAuthoritativeRow.max_tank_temperature,
        min_tank_temperature: fullyAuthoritativeRow.min_tank_temperature,
        safety_shower_reserve: fullyAuthoritativeRow.safety_shower_reserve,
        target_shower_reserve: fullyAuthoritativeRow.target_shower_reserve,
      },
      "merging with a fully authoritative remote row must yield exactly the remote's own values for every field, never the local payload's",
    );
  }

  // --- ensureHeatingControlSettingsBackfilled --------------------------

  const localSettings: EnergiaZenSettings = {
    ...defaultSettings,
    automaticMaxHeatingHours: 4,
    heatingNeedMode: "automatic",
  };

  // "upgrade ilman että käyttäjä käy settings-näkymässä" + "authoritative
  // local settings -> Supabase backfill": a missing remote row must be
  // backfilled from the app's own already-loaded local settings, with no
  // user interaction and no arbitrary backend default substituted. Also
  // verifies the observed row (null here) is threaded through to
  // upsertIfUnchanged unchanged, so the caller can build its own
  // compare-and-swap and merge on it.
  {
    let upsertedSettings: EnergiaZenSettings | null = null;
    let observedRowSeen: HeatingControlSettingsCompletenessRow | null | undefined;
    const outcome = await ensureHeatingControlSettingsBackfilled({
      fetchRow: async () => ({ data: null, error: null }),
      localSettings,
      upsertIfUnchanged: async (settings, observedRow) => {
        upsertedSettings = settings;
        observedRowSeen = observedRow;
        return true;
      },
    });
    assertEqual(outcome, "backfilled", "a missing remote row must trigger a backfill");
    assertEqual(
      upsertedSettings,
      localSettings,
      "the backfill must upsert exactly the app's current local settings, not an arbitrary default",
    );
    assertEqual(
      observedRowSeen,
      null,
      "a missing row must pass observedRow = null through to upsertIfUnchanged",
    );
    assertEqual(
      isHeatingControlSettingsSyncOutcomeSynced(outcome),
      true,
      "a successful backfill must count as synced",
    );
  }

  // The same, but for an existing incomplete row - the exact row read must
  // be passed through to upsertIfUnchanged, so the caller can build a
  // compare-and-swap and a merge on it.
  {
    let observedRowSeen: HeatingControlSettingsCompletenessRow | null | undefined;
    const outcome = await ensureHeatingControlSettingsBackfilled({
      fetchRow: async () => ({ data: legacyEmptyRow, error: null }),
      localSettings,
      upsertIfUnchanged: async (_settings, observedRow) => {
        observedRowSeen = observedRow;
        return true;
      },
    });
    assertEqual(outcome, "backfilled", "an existing incomplete row must trigger a backfill");
    assertEqual(
      observedRowSeen,
      legacyEmptyRow,
      "the observed row must be passed through to upsertIfUnchanged unchanged",
    );
  }

  // "jo täydellinen Supabase settings-rivi ei regressioidu": an already-
  // authoritative row must short-circuit without ever calling
  // upsertIfUnchanged - i.e. a fully authoritative remote row must never be
  // written to at all.
  {
    let upsertCalled = false;
    const outcome = await ensureHeatingControlSettingsBackfilled({
      fetchRow: async () => ({ data: completeAutomaticRow, error: null }),
      localSettings,
      upsertIfUnchanged: async () => {
        upsertCalled = true;
        return true;
      },
    });
    assertEqual(outcome, "already_synced", "an already-complete row must not be rewritten");
    assertEqual(upsertCalled, false, "already_synced must never call upsertIfUnchanged");
    assertEqual(
      isHeatingControlSettingsSyncOutcomeSynced(outcome),
      true,
      "already_synced must count as synced",
    );
  }

  // Codex P2 (startup backfill race): fetchRow() can observe an incomplete
  // row, then another device/Settings save can make it authoritative
  // before the write lands. upsertIfUnchanged reports that loss by
  // returning false (its compare-and-swap matched nothing) - the backfill
  // must re-read once and, finding the row now authoritative, defer to it
  // as already_synced instead of a second blind write with the stale
  // localSettings snapshot. This is the CAS-conflict case: the newer row
  // wins and is re-read.
  {
    let fetchCount = 0;
    let upsertAttempted = false;
    const outcome = await ensureHeatingControlSettingsBackfilled({
      fetchRow: async () => {
        fetchCount += 1;
        return {
          data: fetchCount === 1 ? legacyEmptyRow : completeAutomaticRow,
          error: null,
        };
      },
      localSettings,
      upsertIfUnchanged: async () => {
        upsertAttempted = true;
        // Lost the race: another writer already changed the row, so the
        // compare-and-swap condition matched zero rows.
        return false;
      },
    });
    assertEqual(fetchCount, 2, "a lost race must trigger exactly one re-read");
    assertEqual(upsertAttempted, true, "the conditional write must still have been attempted");
    assertEqual(
      outcome,
      "already_synced",
      "losing the race to a newer authoritative write must resolve to already_synced, not backfilled",
    );
    assertEqual(
      isHeatingControlSettingsSyncOutcomeSynced(outcome),
      true,
      "already_synced via a lost-race re-read must count as synced",
    );
  }

  // Same race, but the row that raced ahead is itself still incomplete
  // (e.g. another install's own backfill for a different partial state) -
  // must not be reported as synced, and must not retry within this same
  // call (the existing 5-minute retry loop in the caller handles that).
  {
    let fetchCount = 0;
    const outcome = await ensureHeatingControlSettingsBackfilled({
      fetchRow: async () => {
        fetchCount += 1;
        return { data: legacyEmptyRow, error: null };
      },
      localSettings,
      upsertIfUnchanged: async () => false,
    });
    assertEqual(fetchCount, 2, "a lost race must still trigger exactly one re-read");
    assertEqual(
      outcome,
      "backfill_failed",
      "losing the race to a still-incomplete row must resolve to backfill_failed, not synced",
    );
    assertEqual(
      isHeatingControlSettingsSyncOutcomeSynced(outcome),
      false,
      "backfill_failed after a lost race must never count as synced",
    );
  }

  // A lost race whose re-read itself fails must not crash or report synced.
  {
    let fetchCount = 0;
    const outcome = await ensureHeatingControlSettingsBackfilled({
      fetchRow: async () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          return { data: legacyEmptyRow, error: null };
        }
        throw new Error("network down during re-read");
      },
      localSettings,
      upsertIfUnchanged: async () => false,
    });
    assertEqual(
      outcome,
      "backfill_failed",
      "a failed re-read after a lost race must resolve to backfill_failed",
    );
  }

  // "epäonnistunut synkronointi ei poista legacy publisheria käytöstä": both
  // a failed read and a failed write must resolve to a non-synced outcome.
  {
    const checkFailedOutcome = await ensureHeatingControlSettingsBackfilled({
      fetchRow: async () => ({ data: null, error: new Error("network down") }),
      localSettings,
      upsertIfUnchanged: async () => {
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
      upsertIfUnchanged: async () => {
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
      upsertIfUnchanged: async (settings) => {
        upsertedSettings = settings;
        return true;
      },
    });
    assertEqual(outcome, "backfilled", "a fixed-mode install must still be backfilled");
    assertEqual(
      upsertedSettings !== null,
      true,
      "backfilling a fixed-mode install must call upsertIfUnchanged",
    );
    assertEqual(
      readHeatingNeedMode(upsertedSettings),
      "fixed",
      "backfilling a fixed-mode install must preserve heating_need_mode = fixed, not force automatic",
    );
  }
}
