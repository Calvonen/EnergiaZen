import { supabase } from "@/lib/supabase";
import type { WaterDrawEnergyDiagnostic } from "./heatLossDiagnostics";
import { waterDrawEventSnapshotRow, type WaterDrawEventSnapshot, type WaterDrawLabel, type WaterDrawLabelKind } from "./waterDrawLabelDomain";
export * from "./waterDrawLabelDomain";

async function currentUserId() {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw error;
  if (!data.user) throw new Error("Kirjaudu sisään tallentaaksesi merkinnän.");
  return data.user.id;
}

export async function fetchWaterDrawLabels(): Promise<WaterDrawLabel[]> {
  const userId = await currentUserId();
  const { data, error } = await supabase.from("water_draw_labels").select("*")
    .eq("user_id", userId).order("event_started_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as WaterDrawLabel[];
}

export async function saveWaterDrawLabel(event: WaterDrawEventSnapshot, label: WaterDrawLabelKind, note: string) {
  const userId = await currentUserId();
  const { data, error } = await supabase.from("water_draw_labels").upsert({
    ...waterDrawEventSnapshotRow(event),
    label,
    note: note.trim() || null,
    user_id: userId,
  }, { onConflict: "user_id,event_started_at,event_ended_at" }).select("*").single();
  if (error) throw error;
  return data as WaterDrawLabel;
}

export async function deleteWaterDrawLabel(event: Pick<WaterDrawEnergyDiagnostic, "endedAt" | "startedAt">) {
  const userId = await currentUserId();
  const { error } = await supabase.from("water_draw_labels").delete().eq("user_id", userId)
    .eq("event_started_at", event.startedAt).eq("event_ended_at", event.endedAt);
  if (error) throw error;
}
