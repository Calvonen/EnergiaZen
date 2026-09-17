import type { EnergiaZenSettings } from "./settingsDefaults";
import { buildHeatingControlSettingsPayload } from "./heatingControlSettingsPayload";
import {
  getLoadedV2TargetReservePercent,
  persistEffectiveSettingsLocally,
  setLoadedV2TargetReservePercent,
} from "./v2RecommendationSaveBaseline";

type RecommendationRow = {
  v2_target_reserve_percent: number | null;
};

type RecommendationSelect = {
  eq: (column: "id", value: 1) => {
    maybeSingle: () => PromiseLike<{
      data: RecommendationRow | null;
      error: unknown | null;
    }>;
  };
};

type HeatingControlSettingsTable = {
  select?: (columns: "v2_target_reserve_percent") => RecommendationSelect;
  upsert: (
    payload: ReturnType<typeof buildHeatingControlSettingsPayload>,
    options: { onConflict: "id" },
  ) => PromiseLike<{ error: unknown | null }>;
};

type HeatingControlSettingsClient = {
  from: (table: "heating_control_settings") => HeatingControlSettingsTable;
};

function isPersistedReservePercent(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 5 &&
    value <= 95 &&
    value % 5 === 0
  );
}

export async function upsertHeatingControlSettings(
  client: HeatingControlSettingsClient,
  settings: EnergiaZenSettings,
) {
  const loadedRecommendation = getLoadedV2TargetReservePercent();
  const recommendationWasEdited =
    loadedRecommendation !== null &&
    settings.v2TargetReservePercent !== loadedRecommendation;

  let effectiveSettings = settings;
  const table = client.from("heating_control_settings");

  // Full settings saves must not let a fresh install's local default replace
  // an authoritative recommendation stored by another install. If this
  // recommendation has not changed since settings were loaded, re-read the
  // backend just before the upsert and preserve its current value. Production
  // clients have `select`; legacy unit-test fakes may omit it, in which case
  // no remote merge is possible and their historical behavior is preserved.
  if (!recommendationWasEdited && loadedRecommendation !== null && table.select) {
    const { data, error } = await table
      .select("v2_target_reserve_percent")
      .eq("id", 1)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (isPersistedReservePercent(data?.v2_target_reserve_percent)) {
      effectiveSettings = {
        ...settings,
        v2TargetReservePercent: data.v2_target_reserve_percent,
      };
    }
  }

  if (effectiveSettings !== settings) {
    // Reconcile the same effective value locally before the remote write.
    // If this local write fails, no remote mutation has happened yet. If the
    // following remote upsert fails, persistSettingsDraft's existing rollback
    // restores the previous local settings.
    const reconciledLocally = await persistEffectiveSettingsLocally(
      effectiveSettings,
    );

    if (reconciledLocally) {
      // persistSettingsDraft returns this same normalized draft object after a
      // successful remote save, so update it in place to keep the committed UI
      // state aligned with the effective local/backend value as well.
      settings.v2TargetReservePercent = effectiveSettings.v2TargetReservePercent;
    }
  }

  const payload = buildHeatingControlSettingsPayload(effectiveSettings);
  const { error } = await table.upsert(payload, { onConflict: "id" });

  if (error) {
    throw error;
  }

  setLoadedV2TargetReservePercent(effectiveSettings.v2TargetReservePercent);
  return payload;
}
