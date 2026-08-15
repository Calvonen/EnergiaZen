import type { WaterDrawEnergyDiagnostic } from "./heatLossDiagnostics";
import { validateGroundTruth } from "./groundTruthValidation";
import type { WaterDrawLabel, WaterDrawLabelKind } from "./waterDrawLabelDomain";

function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); }

const event = (startedAt: string, endedAt: string, overrides: Partial<WaterDrawEnergyDiagnostic> = {}): WaterDrawEnergyDiagnostic => ({
  detectionKinds: ["rapid_drop"], diagnosticWindowMinutes: 20, durationMinutes: 5, endedAt,
  energyAfterStabilizationKwh: 4, energyBeforeKwh: 5, energyQualityReason: null, energyReliable: true,
  estimatedNaturalLossKwh: 0.1, estimatedWaterDrawNetEnergyKwh: 0.9, rawEnergyChangeKwh: -1,
  stabilizedAt: endedAt, startedAt, ...overrides,
});

let labelSequence = 0;
const label = (
  startedAt: string,
  endedAt: string,
  kind: WaterDrawLabelKind = "normal_shower",
  overrides: Partial<WaterDrawLabel> = {},
): WaterDrawLabel => {
  labelSequence += 1;
  return {
    created_at: startedAt, detection_kinds: null, duration_minutes: null,
    energy_after_stabilization_kwh: null, energy_before_kwh: null, energy_quality_reason: null,
    energy_reliable: null, estimated_natural_loss_kwh: null, estimated_water_draw_net_energy_kwh: null,
    event_ended_at: endedAt, event_started_at: startedAt, feature_snapshot_version: null,
    id: `label-${labelSequence}`, label: kind, note: null, raw_energy_change_kwh: null,
    updated_at: startedAt, user_id: "user-1", ...overrides,
  };
};

export function runGroundTruthValidationUnitTests() {
  // 1. Exact 1:1 overlap matches with zero error.
  {
    const gt = label("2026-08-09T10:00:00Z", "2026-08-09T10:05:00Z");
    const result = validateGroundTruth([event("2026-08-09T10:00:00Z", "2026-08-09T10:05:00Z")], [gt]);
    assert(result.entries.length === 1, "one ground truth entry must be returned");
    const entry = result.entries[0];
    assert(entry.matched, "identical windows must match");
    assert(entry.startTimeErrorMinutes === 0 && entry.endTimeErrorMinutes === 0, "identical windows must have zero timing error");
    assert(entry.overlapMinutes === 5, "full overlap must equal the event duration");
    assert(result.falsePositiveCandidates.length === 0, "the matched event must not be a false positive candidate");
  }

  // 2. Slightly different start/end still match, with correct error minutes.
  {
    const gt = label("2026-08-09T10:00:00Z", "2026-08-09T10:10:00Z");
    const detected = event("2026-08-09T10:02:00Z", "2026-08-09T10:07:00Z");
    const result = validateGroundTruth([detected], [gt]);
    const entry = result.entries[0];
    assert(entry.matched, "overlapping but shifted windows must still match");
    assert(entry.startTimeErrorMinutes === 2, "start error must reflect the detected event starting 2 minutes later");
    assert(entry.endTimeErrorMinutes === -3, "end error must reflect the detected event ending 3 minutes earlier");
    assert(entry.overlapMinutes === 5, "overlap must equal the intersection of the two windows");
  }

  // 3. Two nearby V2 events: the larger overlap wins.
  {
    const gt = label("2026-08-09T10:00:00Z", "2026-08-09T10:10:00Z");
    const smallOverlap = event("2026-08-09T09:57:00Z", "2026-08-09T10:02:00Z");
    const bigOverlap = event("2026-08-09T10:01:00Z", "2026-08-09T10:09:00Z");
    const result = validateGroundTruth([smallOverlap, bigOverlap], [gt]);
    const entry = result.entries[0];
    assert(entry.matched && entry.matchedEvent?.startedAt === bigOverlap.startedAt, "the event with the larger overlap must win the match");
    assert(result.falsePositiveCandidates.length === 1 && result.falsePositiveCandidates[0].startedAt === smallOverlap.startedAt,
      "the losing event must be reported as a false positive candidate");
  }

  // 4. One V2 event cannot match two ground truth labels — the better match wins.
  {
    const detected = event("2026-08-09T10:05:00Z", "2026-08-09T10:10:00Z");
    const closeLabel = label("2026-08-09T10:04:00Z", "2026-08-09T10:11:00Z", "normal_shower", { id: "close" });
    const farLabel = label("2026-08-09T10:20:00Z", "2026-08-09T10:25:00Z", "small_wash", { id: "far", event_ended_at: "2026-08-09T10:06:00Z", event_started_at: "2026-08-09T10:03:00Z" });
    const result = validateGroundTruth([detected], [closeLabel, farLabel]);
    const matchedEntries = result.entries.filter((entry) => entry.matched);
    assert(matchedEntries.length === 1, "only one ground truth label may claim the single event");
    assert(result.entries.find((entry) => entry.groundTruthStart === closeLabel.event_started_at)?.matched, "the label with the larger overlap must be the one that matches");
  }

  // 5. Ground truth without any overlapping V2 event stays unmatched.
  {
    const gt = label("2026-08-09T10:00:00Z", "2026-08-09T10:05:00Z");
    const distantEvent = event("2026-08-09T14:00:00Z", "2026-08-09T14:05:00Z");
    const result = validateGroundTruth([distantEvent], [gt]);
    const entry = result.entries[0];
    assert(!entry.matched && entry.matchedEvent === null, "a label with no overlapping event must remain unmatched");
    assert(entry.startTimeErrorMinutes === null && entry.overlapMinutes === null, "an unmatched label must not report timing metrics");
    assert(result.falsePositiveCandidates.length === 1, "the unmatched event must be a false positive candidate");
  }

  // 6. A V2 event without any ground truth label is a false positive candidate.
  {
    const detected = event("2026-08-09T10:00:00Z", "2026-08-09T10:05:00Z");
    const result = validateGroundTruth([detected], []);
    assert(result.entries.length === 0, "no ground truth entries means no result rows");
    assert(result.falsePositiveCandidates.length === 1 && result.falsePositiveCandidates[0] === detected,
      "an unlabeled event must be surfaced as a false positive candidate");
  }

  // 7. Label-specific summary counts are correct.
  {
    const events = [
      event("2026-08-09T10:00:00Z", "2026-08-09T10:05:00Z"),
      event("2026-08-09T12:00:00Z", "2026-08-09T12:05:00Z"),
    ];
    const labels = [
      label("2026-08-09T10:00:00Z", "2026-08-09T10:05:00Z", "normal_shower"),
      label("2026-08-09T12:00:00Z", "2026-08-09T12:05:00Z", "long_hot_shower"),
      label("2026-08-09T16:00:00Z", "2026-08-09T16:05:00Z", "normal_shower"),
    ];
    const result = validateGroundTruth(events, labels);
    assert(result.summary.labelCount === 3, "label count must equal the number of ground truth entries");
    assert(result.summary.matchedCount === 2, "matched count must equal the number of matched entries");
    assert(result.summary.unmatchedGroundTruthCount === 1, "unmatched ground truth count must be labelCount minus matchedCount");
    assert(result.summary.unmatchedEventCount === 0, "both events were claimed, so there are no false positive candidates");
    assert(result.summary.countsByLabel.normal_shower.total === 2 && result.summary.countsByLabel.normal_shower.matched === 1,
      "normal_shower must count both its entries and only its matched entry");
    assert(result.summary.countsByLabel.long_hot_shower.total === 1 && result.summary.countsByLabel.long_hot_shower.matched === 1,
      "long_hot_shower must count its single matched entry");
    assert(result.summary.countsByLabel.small_wash.total === 0 && result.summary.countsByLabel.small_wash.matched === 0,
      "label kinds with no entries must remain present with zero counts");
    assert(result.summary.matchRatePercent === (2 / 3) * 100, "match rate percent must be matchedCount / labelCount");
    assert(result.summary.medianAbsoluteStartErrorMinutes === 0 && result.summary.medianAbsoluteEndErrorMinutes === 0,
      "exact-overlap matches must contribute zero timing error to the median");
  }

  // 8. Empty inputs do not throw and report empty results.
  {
    const result = validateGroundTruth([], []);
    assert(result.entries.length === 0 && result.falsePositiveCandidates.length === 0, "empty inputs must produce empty results");
    assert(result.summary.labelCount === 0 && result.summary.matchedCount === 0, "empty inputs must report zero counts");
    assert(result.summary.matchRatePercent === null, "match rate must be null when there are no ground truth labels");
    assert(result.summary.medianAbsoluteStartErrorMinutes === null && result.summary.medianAbsoluteEndErrorMinutes === null,
      "median timing error must be null when nothing matched");
  }

  // Invalid/missing timestamps are safely excluded from matching, not thrown.
  {
    const gt = label("not-a-date", "2026-08-09T10:05:00Z");
    const detected = event("2026-08-09T10:00:00Z", "2026-08-09T10:05:00Z");
    const result = validateGroundTruth([detected], [gt]);
    assert(result.entries.length === 1 && !result.entries[0].matched, "a label with an invalid timestamp must be excluded from matching, not crash");
    assert(result.falsePositiveCandidates.length === 1, "the event must remain an unclaimed false positive candidate");
  }
}
