import { calculateDashboardV2TankState, type DashboardReplayReading } from "./dashboardReplay";
import { topSensorMovedAt } from "./sensorGeometry";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

export function runDashboardReplayUnitTests() {
  const beforeCurrentEpoch = new Date(
    new Date(topSensorMovedAt).getTime() - 60_000,
  ).toISOString();
  const afterCurrentEpoch = new Date(
    new Date(topSensorMovedAt).getTime() + 60_000,
  ).toISOString();
  const completeReading: DashboardReplayReading = {
    bottom_temp: 45,
    created_at: afterCurrentEpoch,
    heating: false,
    inlet_temp: 12,
    top_temp: 60,
  };

  const state = calculateDashboardV2TankState([
    { ...completeReading, created_at: beforeCurrentEpoch },
    { ...completeReading, bottom_temp: null, created_at: topSensorMovedAt },
    completeReading,
  ]);

  assert(state?.quality === "valid", "dashboard replay starts at the first complete reading");
  assert(state?.timestamp === afterCurrentEpoch, "dashboard replay uses the current geometry epoch");

  const stateWithoutCurrentCompleteReading = calculateDashboardV2TankState([
    { ...completeReading, created_at: beforeCurrentEpoch },
    { ...completeReading, inlet_temp: null },
  ]);

  assert(
    stateWithoutCurrentCompleteReading === null,
    "dashboard replay does not initialize from a previous geometry epoch",
  );
}
