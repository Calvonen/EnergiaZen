import { runTankTemperatureForecastUnitTests } from "../lib/tankTemperatureForecast.test";
import { runHeatingHistoryUnitTests } from "../lib/heatingHistory.test";
import { runHeatingOptimizerUnitTests } from "../lib/heatingOptimizer.test";
import { runTemperatureDropProfileUnitTests } from "../lib/temperatureDropProfile.test";
import { runShowerReserveSettingsUnitTests } from "../lib/showerReserveSettings.test";
import { runHeatingSettingsUnitTests } from "../lib/heatingSettings.test";
import { runSettingsSectionSummaryUnitTests } from "../lib/settingsSectionSummaries.test";
import { runHeatingPlanPresentationUnitTests } from "../lib/heatingPlanPresentation.test";

async function runTests() {
  runTankTemperatureForecastUnitTests();
  await runHeatingHistoryUnitTests();
  runHeatingOptimizerUnitTests();
  runHeatingPlanPresentationUnitTests();
  runHeatingSettingsUnitTests();
  runShowerReserveSettingsUnitTests();
  runSettingsSectionSummaryUnitTests();
  runTemperatureDropProfileUnitTests();

  console.log(
    "tankTemperatureForecast, heatingHistory, heatingOptimizer, heatingPlanPresentation, heatingSettings, settingsSectionSummaries, showerReserveSettings and temperatureDropProfile tests passed",
  );
}

void runTests();
