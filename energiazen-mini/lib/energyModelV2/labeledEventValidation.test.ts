import { analyzeLabeledEvents } from "./labeledEventValidation";
import type { WaterDrawLabel, WaterDrawLabelKind } from "./waterDrawLabelDomain";

function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); }

let labelSequence = 0;
const label = (
  kind: WaterDrawLabelKind,
  overrides: Partial<WaterDrawLabel> = {},
): WaterDrawLabel => {
  labelSequence += 1;
  return {
    created_at: "2026-08-09T10:10:00.000Z", detection_kinds: ["rapid_drop"], duration_minutes: 5,
    energy_after_stabilization_kwh: 4, energy_before_kwh: 5, energy_quality_reason: null,
    energy_reliable: true, estimated_natural_loss_kwh: 0.1, estimated_water_draw_net_energy_kwh: 0.9,
    event_ended_at: "2026-08-09T10:05:00.000Z", event_started_at: "2026-08-09T10:00:00.000Z",
    feature_snapshot_version: 2, id: `label-${labelSequence}`, label: kind, note: null,
    raw_energy_change_kwh: -1, updated_at: "2026-08-09T10:10:00.000Z", user_id: "user-1", ...overrides,
  };
};

export function runLabeledEventValidationUnitTests() {
  // 1. Per-label aggregates: count, median/average/min/max net energy, median duration, detectionKinds distribution.
  {
    const labels = [
      label("normal_shower", { duration_minutes: 4, estimated_water_draw_net_energy_kwh: 0.8, detection_kinds: ["rapid_drop"] }),
      label("normal_shower", { duration_minutes: 6, estimated_water_draw_net_energy_kwh: 1.2, detection_kinds: ["cold_inlet"] }),
      label("normal_shower", { duration_minutes: 8, estimated_water_draw_net_energy_kwh: 1.6, detection_kinds: ["rapid_drop", "cold_inlet"] }),
    ];
    const result = analyzeLabeledEvents(labels);
    const aggregate = result.aggregatesByLabel.normal_shower;
    assert(aggregate.count === 3, "count must equal the number of labels for that kind");
    assert(aggregate.medianNetWaterDrawEnergyKwh === 1.2, "median net energy must be the middle value");
    assert(Math.abs(aggregate.averageNetWaterDrawEnergyKwh! - 1.2) < 1e-9, "average net energy must be the mean of all values");
    assert(aggregate.minimumNetWaterDrawEnergyKwh === 0.8 && aggregate.maximumNetWaterDrawEnergyKwh === 1.6, "min/max net energy must span all values");
    assert(aggregate.medianDurationMinutes === 6, "median duration must be the middle duration value");
    assert(aggregate.detectionKindCounts.rapid_drop === 2 && aggregate.detectionKindCounts.cold_inlet === 2,
      "detection kind counts must tally every kind across every entry, including multi-kind events");
  }

  // 2. Null energy/duration values are excluded from numeric stats but still counted.
  {
    const labels = [
      label("small_wash", { duration_minutes: null, estimated_water_draw_net_energy_kwh: null, detection_kinds: null }),
      label("small_wash", { duration_minutes: 3, estimated_water_draw_net_energy_kwh: 0.4 }),
    ];
    const result = analyzeLabeledEvents(labels);
    const aggregate = result.aggregatesByLabel.small_wash;
    assert(aggregate.count === 2, "an entry with null snapshot fields must still be counted");
    assert(aggregate.medianNetWaterDrawEnergyKwh === 0.4 && aggregate.averageNetWaterDrawEnergyKwh === 0.4,
      "null net energy values must not distort the median or average");
    assert(aggregate.minimumNetWaterDrawEnergyKwh === 0.4 && aggregate.maximumNetWaterDrawEnergyKwh === 0.4,
      "null net energy values must not distort min/max");
    assert(aggregate.medianDurationMinutes === 3, "null duration values must not distort the median duration");
  }

  // 3. Unreliable and unknown (null) reliability must not be counted as reliable, but both count toward total.
  {
    const labels = [
      label("long_hot_shower", { energy_reliable: true }),
      label("long_hot_shower", { energy_reliable: false }),
      label("long_hot_shower", { energy_reliable: null }),
    ];
    const result = analyzeLabeledEvents(labels);
    const aggregate = result.aggregatesByLabel.long_hot_shower;
    assert(aggregate.count === 3, "total must include reliable, unreliable and unknown-reliability entries");
    assert(aggregate.reliableCount === 1, "only entries explicitly marked reliable must be counted as reliable");
  }

  // 4. Label kinds with no entries remain present with zero/null aggregates.
  {
    const result = analyzeLabeledEvents([label("normal_shower")]);
    const untouched = result.aggregatesByLabel.multiple_showers;
    assert(untouched.count === 0, "an unused label kind must report a zero count");
    assert(
      untouched.medianNetWaterDrawEnergyKwh === null && untouched.averageNetWaterDrawEnergyKwh === null &&
        untouched.minimumNetWaterDrawEnergyKwh === null && untouched.maximumNetWaterDrawEnergyKwh === null &&
        untouched.medianDurationMinutes === null,
      "an unused label kind must report null numeric aggregates rather than zero or NaN",
    );
    assert(untouched.detectionKindCounts.rapid_drop === 0 && untouched.detectionKindCounts.cold_inlet === 0,
      "an unused label kind must report zero detection kind counts");
  }

  // 5. Entries are returned oldest-first and mirror the label's own snapshot fields.
  {
    const first = label("normal_shower", { event_started_at: "2026-08-09T09:00:00Z", event_ended_at: "2026-08-09T09:05:00Z" });
    const second = label("small_wash", { event_started_at: "2026-08-09T10:00:00Z", event_ended_at: "2026-08-09T10:03:00Z" });
    const result = analyzeLabeledEvents([second, first]);
    assert(result.entries.length === 2, "every label must produce one entry");
    assert(result.entries[0].startedAt === first.event_started_at && result.entries[1].startedAt === second.event_started_at,
      "entries must be sorted oldest-first regardless of input order");
    assert(result.entries[0].label === "normal_shower" && result.entries[0].netWaterDrawEnergyKwh === first.estimated_water_draw_net_energy_kwh,
      "an entry must carry the label's own snapshot values");
  }

  // 6. Empty input does not throw and reports zeroed aggregates for every label kind.
  {
    const result = analyzeLabeledEvents([]);
    assert(result.entries.length === 0, "empty input must produce no entries");
    assert(Object.values(result.aggregatesByLabel).every((aggregate) => aggregate.count === 0),
      "every label kind must be present with a zero count when there are no labels at all");
  }
}
