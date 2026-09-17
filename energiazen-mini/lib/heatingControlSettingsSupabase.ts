import {
  getLoadedV2TargetReservePercent,
  markV2TargetReservePercentSaved,
  type EnergiaZenSettings,
} from "./settings";
import { buildHeatingControlSettingsPayload } from "./heatingControlSettingsPayload";

type RecommendationRow = {
  v2_target_reserve_percent: number | null;
};

type HeatingControlSettingsClient = {
  from: (table: "heating_control_settings") => {
    select: (columns: "v2_target_reserve_percent") => {
      eq: (column: "id", value: 1) => {
        maybeSingle: () => PromiseLike<{
          data: RecommendationRow | null;
          error: unknown | null;
        }>;
      };
    };
    upsert: (
      payload: ReturnType<typeof buildHeatingControlSettingsPayload>,
      options: { onConflict: "id" },
    ) => PromiseLike<{ error: unknown | null }>;
  };
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

  // Full settings saves must not let a fresh install's local default replace
  // an authoritative recommendation stored by another install. If this
  // recommendation has not changed since settings were loaded, re-read the
  // backend just before the upsert and preserve its current value. Fail
  // closed on a read error rather than silently overwriting the remote value.
  if (!recommendationWasEdited && loadedRecommendation !== null) {
    const { data, error } = await client
      .from("heating_control_settings")
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

  const payload = buildHeatingControlSettingsPayload(effectiveSettings);
  const { error } = await client
    .from("heating_control_settings")
    .upsert(payload, { onConflict: "id" });

  if (error) {
    throw error;
  }

  if (recommendationWasEdited || loadedRecommendation === null) {
    markV2TargetReservePercentSaved(effectiveSettings.v2TargetReservePercent);
  }

  return payload;
}
