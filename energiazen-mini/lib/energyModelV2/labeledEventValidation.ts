import type { WaterDrawDetectionKind, WaterDrawEnergyQualityReason } from "./heatLossDiagnostics";
import { waterDrawLabelOptions, type WaterDrawLabel, type WaterDrawLabelKind } from "./waterDrawLabelDomain";

export type LabeledEventEntry = {
  detectionKinds: WaterDrawDetectionKind[] | null;
  durationMinutes: number | null;
  endedAt: string;
  energyQualityReason: WaterDrawEnergyQualityReason | null;
  energyReliable: boolean | null;
  label: WaterDrawLabelKind;
  netWaterDrawEnergyKwh: number | null;
  startedAt: string;
};

export type WaterDrawEnergyQualityReasonBucket = WaterDrawEnergyQualityReason | "missing_reason";

export type LabeledEventAggregate = {
  averageNetWaterDrawEnergyKwh: number | null;
  count: number;
  detectionKindCounts: Record<WaterDrawDetectionKind, number>;
  maximumNetWaterDrawEnergyKwh: number | null;
  medianDurationMinutes: number | null;
  medianNetWaterDrawEnergyKwh: number | null;
  minimumNetWaterDrawEnergyKwh: number | null;
  qualityReasonCounts: Record<WaterDrawEnergyQualityReasonBucket, number>;
  reliableCount: number;
  unknownReliabilityCount: number;
  unreliableCount: number;
};

export type LabeledEventValidationResult = {
  aggregatesByLabel: Record<WaterDrawLabelKind, LabeledEventAggregate>;
  entries: LabeledEventEntry[];
};

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function emptyDetectionKindCounts(): Record<WaterDrawDetectionKind, number> {
  return { cold_inlet: 0, rapid_drop: 0 };
}

function emptyQualityReasonCounts(): Record<WaterDrawEnergyQualityReasonBucket, number> {
  return { missing_reason: 0, tank_energy_rising: 0 };
}

function toTime(value: string): number | null {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function aggregate(entries: LabeledEventEntry[]): LabeledEventAggregate {
  const netEnergyValues = entries.flatMap((entry) => entry.netWaterDrawEnergyKwh === null ? [] : [entry.netWaterDrawEnergyKwh]);
  const durationValues = entries.flatMap((entry) => entry.durationMinutes === null ? [] : [entry.durationMinutes]);
  const detectionKindCounts = entries.reduce((counts, entry) => {
    entry.detectionKinds?.forEach((kind) => { counts[kind] += 1; });
    return counts;
  }, emptyDetectionKindCounts());
  const qualityReasonCounts = entries.reduce((counts, entry) => {
    if (entry.energyReliable === false) counts[entry.energyQualityReason ?? "missing_reason"] += 1;
    return counts;
  }, emptyQualityReasonCounts());

  return {
    averageNetWaterDrawEnergyKwh: netEnergyValues.length
      ? netEnergyValues.reduce((sum, value) => sum + value, 0) / netEnergyValues.length
      : null,
    count: entries.length,
    detectionKindCounts,
    maximumNetWaterDrawEnergyKwh: netEnergyValues.length ? Math.max(...netEnergyValues) : null,
    medianDurationMinutes: median(durationValues),
    medianNetWaterDrawEnergyKwh: median(netEnergyValues),
    minimumNetWaterDrawEnergyKwh: netEnergyValues.length ? Math.min(...netEnergyValues) : null,
    qualityReasonCounts,
    reliableCount: entries.filter((entry) => entry.energyReliable === true).length,
    unknownReliabilityCount: entries.filter((entry) => entry.energyReliable === null).length,
    unreliableCount: entries.filter((entry) => entry.energyReliable === false).length,
  };
}

/**
 * Diagnostic-only summary of the user's own water_draw_labels rows, grouped
 * by the label they chose. Each label already carries the V2 event snapshot
 * (event_started_at/ended_at, detection_kinds, energy fields) it was created
 * from, so this reads those snapshot fields directly rather than re-matching
 * against live waterDrawEvents — that would only compare a V2 event against
 * itself, not measure detector recall or timing accuracy.
 */
export function analyzeLabeledEvents(waterDrawLabels: readonly WaterDrawLabel[]): LabeledEventValidationResult {
  const entries: LabeledEventEntry[] = waterDrawLabels
    .map((label): LabeledEventEntry => ({
      detectionKinds: label.detection_kinds,
      durationMinutes: label.duration_minutes,
      endedAt: label.event_ended_at,
      energyQualityReason: label.energy_quality_reason,
      energyReliable: label.energy_reliable,
      label: label.label,
      netWaterDrawEnergyKwh: label.estimated_water_draw_net_energy_kwh,
      startedAt: label.event_started_at,
    }))
    .sort((a, b) => {
      const aTime = toTime(a.startedAt);
      const bTime = toTime(b.startedAt);
      if (aTime === null && bTime === null) return 0;
      if (aTime === null) return 1;
      if (bTime === null) return -1;
      return aTime - bTime;
    });

  const aggregatesByLabel = Object.fromEntries(
    waterDrawLabelOptions.map(({ label: kind }) =>
      [kind, aggregate(entries.filter((entry) => entry.label === kind))],
    ),
  ) as Record<WaterDrawLabelKind, LabeledEventAggregate>;

  return { aggregatesByLabel, entries };
}
