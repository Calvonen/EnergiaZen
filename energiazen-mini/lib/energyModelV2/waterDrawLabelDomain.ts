import type { WaterDrawEnergyDiagnostic } from "./heatLossDiagnostics";

export const waterDrawLabelOptions = [
  { label: "normal_shower", title: "🚿 Tavallinen suihku" },
  { label: "long_hot_shower", title: "🔥 Pitkä / kuuma suihku" },
  { label: "small_wash", title: "🚰 Pieni käyttö / peseytyminen" },
  { label: "large_other_use", title: "🧹 Muu suuri vedenkäyttö" },
  { label: "multiple_showers", title: "👥 Useita suihkuja" },
  { label: "unknown", title: "❓ En tiedä" },
] as const;
export type WaterDrawLabelKind = typeof waterDrawLabelOptions[number]["label"];
export type WaterDrawLabel = { created_at: string; event_ended_at: string; event_started_at: string; id: string; label: WaterDrawLabelKind; note: string | null; updated_at: string; user_id: string };
export type LabeledWaterDrawEvent = WaterDrawEnergyDiagnostic & { userLabel: WaterDrawLabel | null };

export function waterDrawEventKey(startedAt: string, endedAt: string) { return `${new Date(startedAt).toISOString()}|${new Date(endedAt).toISOString()}`; }
export function joinWaterDrawLabels(events: WaterDrawEnergyDiagnostic[], labels: WaterDrawLabel[]): LabeledWaterDrawEvent[] {
  const byEvent = new Map(labels.map((label) => [waterDrawEventKey(label.event_started_at, label.event_ended_at), label]));
  return events.map((event) => ({ ...event, userLabel: byEvent.get(waterDrawEventKey(event.startedAt, event.endedAt)) ?? null }));
}
export function filterWaterDrawHistory(events: LabeledWaterDrawEvent[], filter: "labeled" | "all") { return filter === "labeled" ? events.filter((event) => event.userLabel) : events; }
export function getWaterDrawLabelTitle(label: WaterDrawLabelKind) { return waterDrawLabelOptions.find((option) => option.label === label)?.title ?? label; }
