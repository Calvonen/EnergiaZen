import type { WaterDrawEnergyDiagnostic } from "./heatLossDiagnostics";
import { buildWaterDrawHistory, filterWaterDrawHistory, joinWaterDrawLabels, type WaterDrawLabel } from "./waterDrawLabelDomain";

function assert(condition: unknown, message: string) { if (!condition) throw new Error(message); }
const event = (startedAt: string, endedAt: string): WaterDrawEnergyDiagnostic => ({
  detectionKinds: ["rapid_drop"], diagnosticWindowMinutes: 20, durationMinutes: 5, endedAt,
  energyAfterStabilizationKwh: 4, energyBeforeKwh: 5, estimatedNaturalLossKwh: 0.1,
  estimatedWaterDrawNetEnergyKwh: 0.9, rawEnergyChangeKwh: -1, stabilizedAt: endedAt, startedAt,
});
const label = (overrides: Partial<WaterDrawLabel> = {}): WaterDrawLabel => ({
  created_at: "2026-08-09T10:10:00.000Z", event_ended_at: "2026-08-09T10:05:00.000Z",
  detection_kinds: ["rapid_drop"], duration_minutes: 5, estimated_water_draw_net_energy_kwh: 0.9,
  event_started_at: "2026-08-09T10:00:00.000Z", id: "label-1", label: "small_wash", note: "Kasvojen pesu",
  updated_at: "2026-08-09T10:10:00.000Z", user_id: "user-1", ...overrides,
});

export function runWaterDrawLabelUnitTests() {
  const first = event("2026-08-09T10:00:00Z", "2026-08-09T10:05:00Z");
  const second = event("2026-08-09T11:00:00Z", "2026-08-09T11:08:00Z");
  assert(joinWaterDrawLabels([first], [])[0].userLabel === null, "unlabeled events must remain available");
  const joined = joinWaterDrawLabels([first, second], [label()]);
  assert(joined[0].userLabel?.label === "small_wash", "label must join by both event timestamps");
  assert(joined[1].userLabel === null, "a label must not leak to another event");
  const changed = joinWaterDrawLabels([first], [label({ label: "normal_shower", note: "Muokattu" })]);
  assert(changed[0].userLabel?.label === "normal_shower" && changed[0].userLabel?.note === "Muokattu", "changed label and note must be shown");
  assert(joinWaterDrawLabels([first], [])[0].userLabel === null, "deleted label must disappear");
  assert(filterWaterDrawHistory(joined, "labeled").length === 1, "labeled history must exclude unlabeled events");
  assert(filterWaterDrawHistory(joined, "all").length === 2, "all history must include unlabeled events");

  const oldLabel = label({
    event_started_at: "2026-06-01T10:00:00.000Z",
    event_ended_at: "2026-06-01T10:12:00.000Z",
    duration_minutes: 12,
    note: "Yli 30 päivää vanha",
  });
  const oldHistory = buildWaterDrawHistory([], [oldLabel], "labeled");
  assert(oldHistory.length === 1 && oldHistory[0].userLabel?.note === "Yli 30 päivää vanha", "stored snapshot must show an old label without replay data");
  const editedOld = buildWaterDrawHistory([], [{ ...oldLabel, label: "long_hot_shower", note: "Muokattu vanha" }], "labeled");
  assert(editedOld[0].userLabel?.label === "long_hot_shower" && editedOld[0].userLabel?.note === "Muokattu vanha", "old snapshot label must remain editable");
  assert(buildWaterDrawHistory([], [], "labeled").length === 0, "deleted old snapshot label must disappear");
  const currentHistory = buildWaterDrawHistory([first, second], [label()], "labeled");
  assert(currentHistory.length === 1 && new Date(currentHistory[0].startedAt).getTime() === new Date(first.startedAt).getTime(), "current replay events and labels must still join");
  const allHistory = buildWaterDrawHistory([first, second], [oldLabel, label()], "all");
  assert(allHistory.length === 3 && allHistory.some((item) => item.userLabel === null), "all history must combine stored labels and unlabeled replay events without duplicates");
}
