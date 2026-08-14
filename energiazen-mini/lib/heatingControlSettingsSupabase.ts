import type { EnergiaZenSettings } from "./settings";
import { buildHeatingControlSettingsPayload } from "./heatingControlSettingsPayload";

type HeatingControlSettingsClient = {
  from: (table: "heating_control_settings") => {
    upsert: (
      payload: ReturnType<typeof buildHeatingControlSettingsPayload>,
      options: { onConflict: "id" },
    ) => PromiseLike<{ error: unknown | null }>;
  };
};

export async function upsertHeatingControlSettings(
  client: HeatingControlSettingsClient,
  settings: EnergiaZenSettings,
) {
  const payload = buildHeatingControlSettingsPayload(settings);
  const { error } = await client
    .from("heating_control_settings")
    .upsert(payload, { onConflict: "id" });

  if (error) {
    throw error;
  }

  return payload;
}
