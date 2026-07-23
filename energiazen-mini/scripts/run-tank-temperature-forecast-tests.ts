import { runTankTemperatureForecastUnitTests } from "../lib/tankTemperatureForecast.test";
import { runHeatingHistoryUnitTests } from "../lib/heatingHistory.test";
import { runHeatingOptimizerUnitTests } from "../lib/heatingOptimizer.test";
import { runTemperatureDropProfileUnitTests } from "../lib/temperatureDropProfile.test";
import { runShowerReserveSettingsUnitTests } from "../lib/showerReserveSettings.test";

async function runTests() {
  runTankTemperatureForecastUnitTests();
  await runHeatingHistoryUnitTests();
  runHeatingOptimizerUnitTests();
  runShowerReserveSettingsUnitTests();
  runTemperatureDropProfileUnitTests();

  console.log(
    "tankTemperatureForecast, heatingHistory, heatingOptimizer, showerReserveSettings and temperatureDropProfile tests passed",
  );
}

void runTests();
