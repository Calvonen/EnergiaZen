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

  const oneDayLater = new Date(new Date(afterCurrentEpoch).getTime() + 24 * 60 * 60 * 1000).toISOString();
  const stateWithWarmLatestSensor = calculateDashboardV2TankState([
    { ...completeReading, inlet_temp: 8 },
    { ...completeReading, created_at: oneDayLater, inlet_temp: 21 },
  ]);

  assert(
    stateWithWarmLatestSensor?.inletTemperatureC === 8,
    "dashboard replay uses the seven-day minimum inlet temperature instead of the latest raw value",
  );

  const eightDaysLater = new Date(new Date(afterCurrentEpoch).getTime() + 8 * 24 * 60 * 60 * 1000).toISOString();
  const stateAfterEstimateExpires = calculateDashboardV2TankState([
    { ...completeReading, inlet_temp: 8 },
    { ...completeReading, created_at: eightDaysLater, inlet_temp: 21 },
  ]);

  assert(
    stateAfterEstimateExpires?.inletTemperatureC === 21,
    "dashboard replay excludes inlet measurements older than seven days",
  );

  const stateWithoutCurrentCompleteReading = calculateDashboardV2TankState([
    { ...completeReading, created_at: beforeCurrentEpoch, inlet_temp: null },
    { ...completeReading, inlet_temp: null },
  ]);

  assert(
    stateWithoutCurrentCompleteReading === null,
    "dashboard replay does not initialize from a previous geometry epoch",
  );
}
