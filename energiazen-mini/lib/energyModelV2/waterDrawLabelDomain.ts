import type { WaterDrawDetectionKind, WaterDrawEnergyDiagnostic } from "./heatLossDiagnostics";

export const waterDrawLabelOptions = [
  { label: "normal_shower", title: "🚿 Tavallinen suihku" },
  { label: "long_hot_shower", title: "🔥 Pitkä / kuuma suihku" },
  { label: "small_wash", title: "🚰 Pieni käyttö / peseytyminen" },
  { label: "large_other_use", title: "🧹 Muu suuri vedenkäyttö" },
  { label: "multiple_showers", title: "👥 Useita suihkuja" },
  { label: "unknown", title: "❓ En tiedä" },
] as const;
export type WaterDrawLabelKind = typeof waterDrawLabelOptions[number]["label"];
export type WaterDrawLabel = { created_at: string; detection_kinds: WaterDrawDetectionKind[] | null; duration_minutes: number | null; energy_after_stabilization_kwh: number | null; energy_before_kwh: number | null; estimated_natural_loss_kwh: number | null; estimated_water_draw_net_energy_kwh: number | null; event_ended_at: string; event_started_at: string; feature_snapshot_version: 2 | null; id: string; label: WaterDrawLabelKind; note: string | null; raw_energy_change_kwh: number | null; updated_at: string; user_id: string };
export type LabeledWaterDrawEvent = WaterDrawEnergyDiagnostic & { userLabel: WaterDrawLabel | null };
export type WaterDrawEventSnapshot = Pick<WaterDrawEnergyDiagnostic, "detectionKinds" | "durationMinutes" | "endedAt" | "estimatedNaturalLossKwh" | "estimatedWaterDrawNetEnergyKwh" | "startedAt"> & {
  energyAfterStabilizationKwh: number | null;
  energyBeforeKwh: number | null;
  rawEnergyChangeKwh: number | null;
};
export type WaterDrawHistoryEvent = WaterDrawEventSnapshot & { userLabel: WaterDrawLabel | null };
export type WaterDrawLabelCounts = Record<WaterDrawLabelKind, number>;
export type WaterDrawLabelSummary = { counts: WaterDrawLabelCounts; total: number };

export function countWaterDrawLabels(labels: readonly Pick<WaterDrawLabel, "label">[]): WaterDrawLabelCounts {
  const counts = Object.fromEntries(waterDrawLabelOptions.map(({ label }) => [label, 0])) as WaterDrawLabelCounts;
  for (const savedLabel of labels) counts[savedLabel.label] += 1;
  return counts;
}

export function createWaterDrawLabelSummary(counts: WaterDrawLabelCounts): WaterDrawLabelSummary {
  return { counts, total: waterDrawLabelOptions.reduce((total, { label }) => total + counts[label], 0) };
}

export function waterDrawEventKey(startedAt: string, endedAt: string) { return `${new Date(startedAt).toISOString()}|${new Date(endedAt).toISOString()}`; }
export function joinWaterDrawLabels(events: WaterDrawEnergyDiagnostic[], labels: WaterDrawLabel[]): LabeledWaterDrawEvent[] {
  const byEvent = new Map(labels.map((label) => [waterDrawEventKey(label.event_started_at, label.event_ended_at), label]));
  return events.map((event) => ({ ...event, userLabel: byEvent.get(waterDrawEventKey(event.startedAt, event.endedAt)) ?? null }));
}
export function filterWaterDrawHistory(events: LabeledWaterDrawEvent[], filter: "labeled" | "all") { return filter === "labeled" ? events.filter((event) => event.userLabel) : events; }
export function getWaterDrawLabelTitle(label: WaterDrawLabelKind) { return waterDrawLabelOptions.find((option) => option.label === label)?.title ?? label; }

export function waterDrawEventSnapshotRow(event: WaterDrawEventSnapshot) {
  return {
    detection_kinds: event.detectionKinds,
    duration_minutes: event.durationMinutes,
    energy_after_stabilization_kwh: event.energyAfterStabilizationKwh,
    energy_before_kwh: event.energyBeforeKwh,
    estimated_natural_loss_kwh: event.estimatedNaturalLossKwh,
    estimated_water_draw_net_energy_kwh: event.estimatedWaterDrawNetEnergyKwh,
    event_ended_at: event.endedAt,
    event_started_at: event.startedAt,
    feature_snapshot_version: 2 as const,
    raw_energy_change_kwh: event.rawEnergyChangeKwh,
  };
}

function labelSnapshot(label: WaterDrawLabel): WaterDrawHistoryEvent | null {
  if (!label.detection_kinds || label.duration_minutes === null) return null;
  return { detectionKinds: label.detection_kinds, durationMinutes: label.duration_minutes, endedAt: label.event_ended_at,
    energyAfterStabilizationKwh: label.energy_after_stabilization_kwh,
    energyBeforeKwh: label.energy_before_kwh,
    estimatedNaturalLossKwh: label.estimated_natural_loss_kwh,
    estimatedWaterDrawNetEnergyKwh: label.estimated_water_draw_net_energy_kwh,
    rawEnergyChangeKwh: label.raw_energy_change_kwh,
    startedAt: label.event_started_at, userLabel: label };
}

export function buildWaterDrawHistory(events: WaterDrawEnergyDiagnostic[], labels: WaterDrawLabel[], filter: "labeled" | "all"): WaterDrawHistoryEvent[] {
  const replay = joinWaterDrawLabels(events, labels);
  const replayByKey = new Map(replay.map((event) => [waterDrawEventKey(event.startedAt, event.endedAt), event]));
  const labeled = labels.flatMap((label) => {
    const snapshot = labelSnapshot(label);
    const current = replayByKey.get(waterDrawEventKey(label.event_started_at, label.event_ended_at));
    return snapshot ? [snapshot] : current ? [current] : [];
  });
  if (filter === "labeled") return labeled.sort(newestFirst);
  const labeledKeys = new Set(labeled.map((event) => waterDrawEventKey(event.startedAt, event.endedAt)));
  return [...labeled, ...replay.filter((event) => !labeledKeys.has(waterDrawEventKey(event.startedAt, event.endedAt)))]
    .sort(newestFirst);
}

function newestFirst(a: WaterDrawEventSnapshot, b: WaterDrawEventSnapshot) {
  return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
}
