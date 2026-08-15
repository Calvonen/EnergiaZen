import type { WaterDrawDetectionKind, WaterDrawEnergyDiagnostic, WaterDrawEnergyQualityReason } from "./heatLossDiagnostics";
import { waterDrawLabelOptions, type WaterDrawLabel, type WaterDrawLabelKind } from "./waterDrawLabelDomain";

export type GroundTruthMatchEntry = {
  detectionKinds: WaterDrawDetectionKind[] | null;
  endTimeErrorMinutes: number | null;
  energyQualityReason: WaterDrawEnergyQualityReason | null;
  energyReliable: boolean | null;
  groundTruthEnd: string;
  groundTruthStart: string;
  label: WaterDrawLabelKind;
  matched: boolean;
  matchedEvent: { endedAt: string; startedAt: string } | null;
  netWaterDrawEnergyKwh: number | null;
  overlapMinutes: number | null;
  startTimeErrorMinutes: number | null;
};

export type GroundTruthLabelCounts = { matched: number; total: number };

export type GroundTruthValidationSummary = {
  countsByLabel: Record<WaterDrawLabelKind, GroundTruthLabelCounts>;
  labelCount: number;
  matchedCount: number;
  matchRatePercent: number | null;
  medianAbsoluteEndErrorMinutes: number | null;
  medianAbsoluteStartErrorMinutes: number | null;
  unmatchedEventCount: number;
  unmatchedGroundTruthCount: number;
};

export type GroundTruthValidationResult = {
  entries: GroundTruthMatchEntry[];
  falsePositiveCandidates: WaterDrawEnergyDiagnostic[];
  summary: GroundTruthValidationSummary;
};

function toTime(value: string): number | null {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function overlapMinutes(startA: number, endA: number, startB: number, endB: number): number {
  const overlapMs = Math.min(endA, endB) - Math.max(startA, startB);
  return overlapMs > 0 ? overlapMs / 60_000 : 0;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

type ParsedLabel = { end: number | null; index: number; label: WaterDrawLabel; start: number | null };
type ParsedEvent = { end: number | null; event: WaterDrawEnergyDiagnostic; index: number; start: number | null };
type Candidate = { eventIndex: number; labelIndex: number; overlap: number; startDiff: number };

/**
 * Matches user-recorded ground truth labels against EnergyModel V2's detected
 * water draw events by simple time overlap: the highest-overlap pairing wins,
 * ties break on the smallest start-time difference, and each side matches at
 * most once (greedy 1:1 assignment — no optimization search).
 */
export function validateGroundTruth(
  waterDrawEvents: readonly WaterDrawEnergyDiagnostic[],
  waterDrawLabels: readonly WaterDrawLabel[],
): GroundTruthValidationResult {
  const parsedLabels: ParsedLabel[] = waterDrawLabels.map((label, index) => ({
    end: toTime(label.event_ended_at),
    index,
    label,
    start: toTime(label.event_started_at),
  }));
  const parsedEvents: ParsedEvent[] = waterDrawEvents.map((event, index) => ({
    end: toTime(event.endedAt),
    event,
    index,
    start: toTime(event.startedAt),
  }));

  const candidates: Candidate[] = [];
  for (const parsedLabel of parsedLabels) {
    if (parsedLabel.start === null || parsedLabel.end === null || parsedLabel.start >= parsedLabel.end) continue;
    for (const parsedEvent of parsedEvents) {
      if (parsedEvent.start === null || parsedEvent.end === null || parsedEvent.start >= parsedEvent.end) continue;
      const overlap = overlapMinutes(parsedLabel.start, parsedLabel.end, parsedEvent.start, parsedEvent.end);
      if (overlap <= 0) continue;
      candidates.push({
        eventIndex: parsedEvent.index,
        labelIndex: parsedLabel.index,
        overlap,
        startDiff: Math.abs(parsedEvent.start - parsedLabel.start),
      });
    }
  }
  candidates.sort((a, b) =>
    b.overlap - a.overlap ||
    a.startDiff - b.startDiff ||
    a.labelIndex - b.labelIndex ||
    a.eventIndex - b.eventIndex
  );

  const matchByLabelIndex = new Map<number, Candidate>();
  const matchedEventIndexes = new Set<number>();
  for (const candidate of candidates) {
    if (matchByLabelIndex.has(candidate.labelIndex) || matchedEventIndexes.has(candidate.eventIndex)) continue;
    matchByLabelIndex.set(candidate.labelIndex, candidate);
    matchedEventIndexes.add(candidate.eventIndex);
  }

  const entries = [...parsedLabels]
    .sort((a, b) => {
      if (a.start === null && b.start === null) return a.index - b.index;
      if (a.start === null) return 1;
      if (b.start === null) return -1;
      return a.start - b.start;
    })
    .map((parsedLabel): GroundTruthMatchEntry => {
      const candidate = matchByLabelIndex.get(parsedLabel.index);
      const matchedEvent = candidate ? waterDrawEvents[candidate.eventIndex] : null;
      return {
        detectionKinds: matchedEvent?.detectionKinds ?? null,
        endTimeErrorMinutes: matchedEvent && parsedLabel.end !== null
          ? (Date.parse(matchedEvent.endedAt) - parsedLabel.end) / 60_000
          : null,
        energyQualityReason: matchedEvent?.energyQualityReason ?? null,
        energyReliable: matchedEvent?.energyReliable ?? null,
        groundTruthEnd: parsedLabel.label.event_ended_at,
        groundTruthStart: parsedLabel.label.event_started_at,
        label: parsedLabel.label.label,
        matched: matchedEvent !== null,
        matchedEvent: matchedEvent ? { endedAt: matchedEvent.endedAt, startedAt: matchedEvent.startedAt } : null,
        netWaterDrawEnergyKwh: matchedEvent?.estimatedWaterDrawNetEnergyKwh ?? null,
        overlapMinutes: candidate?.overlap ?? null,
        startTimeErrorMinutes: matchedEvent && parsedLabel.start !== null
          ? (Date.parse(matchedEvent.startedAt) - parsedLabel.start) / 60_000
          : null,
      };
    });

  const falsePositiveCandidates = waterDrawEvents.filter((_, index) => !matchedEventIndexes.has(index));

  const countsByLabel = Object.fromEntries(
    waterDrawLabelOptions.map(({ label }) => [label, { matched: 0, total: 0 }]),
  ) as Record<WaterDrawLabelKind, GroundTruthLabelCounts>;
  entries.forEach((entry) => {
    countsByLabel[entry.label].total += 1;
    if (entry.matched) countsByLabel[entry.label].matched += 1;
  });

  const matchedCount = entries.filter((entry) => entry.matched).length;
  const labelCount = entries.length;

  return {
    entries,
    falsePositiveCandidates,
    summary: {
      countsByLabel,
      labelCount,
      matchedCount,
      matchRatePercent: labelCount ? (matchedCount / labelCount) * 100 : null,
      medianAbsoluteEndErrorMinutes: median(
        entries.flatMap((entry) => entry.endTimeErrorMinutes === null ? [] : [Math.abs(entry.endTimeErrorMinutes)]),
      ),
      medianAbsoluteStartErrorMinutes: median(
        entries.flatMap((entry) => entry.startTimeErrorMinutes === null ? [] : [Math.abs(entry.startTimeErrorMinutes)]),
      ),
      unmatchedEventCount: falsePositiveCandidates.length,
      unmatchedGroundTruthCount: labelCount - matchedCount,
    },
  };
}
