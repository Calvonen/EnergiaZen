import { runTankTemperatureForecastUnitTests } from "../lib/tankTemperatureForecast.test";
import { runHeatingHistoryUnitTests } from "../lib/heatingHistory.test";
import { runHeatingOptimizerUnitTests } from "../lib/heatingOptimizer.test";
import { runTemperatureDropProfileUnitTests } from "../lib/temperatureDropProfile.test";
import { runShowerReserveSettingsUnitTests } from "../lib/showerReserveSettings.test";
import { runHeatingSettingsUnitTests } from "../lib/heatingSettings.test";
import { runSettingsSectionSummaryUnitTests } from "../lib/settingsSectionSummaries.test";
import { runHeatingPlanPresentationUnitTests } from "../lib/heatingPlanPresentation.test";
import { runHeatingEnergyCostUnitTests } from "../lib/heatingEnergyCost.test";
import { runElectricityPricesUnitTests } from "../lib/electricityPrices.test";
import { runHistoryUiSourceTests } from "../tests/historyUiSource.test";
import { runHeatingPlanMarkerUnitTests } from "../lib/heatingPlanMarkers.test";
import { runElectricityPriceTrendUnitTests } from "../lib/electricityPriceTrend.test";

async function runTests() {
  runTankTemperatureForecastUnitTests();
  await runHeatingHistoryUnitTests();
  runHeatingEnergyCostUnitTests();
  runElectricityPricesUnitTests();
  runHistoryUiSourceTests();
  runHeatingPlanMarkerUnitTests();
  runElectricityPriceTrendUnitTests();
  runHeatingOptimizerUnitTests();
  runHeatingPlanPresentationUnitTests();
  runHeatingSettingsUnitTests();
  runShowerReserveSettingsUnitTests();
  runSettingsSectionSummaryUnitTests();
  runTemperatureDropProfileUnitTests();

  console.log(
    "tankTemperatureForecast, heatingHistory, heatingEnergyCost, electricityPrices, electricityPriceTrend, historyUiSource, heatingPlanMarkers, heatingOptimizer, heatingPlanPresentation, heatingSettings, settingsSectionSummaries, showerReserveSettings and temperatureDropProfile tests passed",
  );
}

void runTests();
