import { runTankTemperatureForecastUnitTests } from "../lib/tankTemperatureForecast.test";
import { runHeatingHistoryUnitTests } from "../lib/heatingHistory.test";
import { runHeatingOptimizerUnitTests } from "../lib/heatingOptimizer.test";
import { runHeatingOptimizationRunUnitTests } from "../lib/heatingOptimizationRun.test";
import { runHeatingGainUnitTests } from "../lib/heatingGain.test";
import { runTemperatureDropProfileUnitTests } from "../lib/temperatureDropProfile.test";
import { runShowerReserveSettingsUnitTests } from "../lib/showerReserveSettings.test";
import { runHeatingSettingsUnitTests } from "../lib/heatingSettings.test";
import { runSettingsSectionSummaryUnitTests } from "../lib/settingsSectionSummaries.test";
import { runHeatingPlanPresentationUnitTests } from "../lib/heatingPlanPresentation.test";
import { runHeatingPlanPublicationUnitTests } from "../lib/heatingPlanPublication.test";
import { runHeatingEnergyCostUnitTests } from "../lib/heatingEnergyCost.test";
import { runElectricityPricesUnitTests } from "../lib/electricityPrices.test";
import { runHistoryUiSourceTests } from "../tests/historyUiSource.test";
import { runHeatingGainHistorySourceTests } from "../tests/heatingGainHistorySource.test";
import { runHeatingPlanMarkerUnitTests } from "../lib/heatingPlanMarkers.test";
import { runElectricityPriceTrendUnitTests } from "../lib/electricityPriceTrend.test";
import { runElectricityPriceFunctionUnitTests } from "../supabase/functions/fetch-electricity-prices/normalize.test";
import { runTemperatureHistoryDayUnitTests } from "../lib/temperatureHistoryDay.test";
import { runTemperatureHistoryRpcMigrationTests } from "../tests/temperatureHistoryRpcMigration.test";
import { runSettingsDraftUnitTests } from "../lib/settingsDraft.test";
import { runSettingsScenarioUnitTests } from "../lib/settingsScenario.test";
import { runSettingsDraftUiSourceTests } from "../tests/settingsDraftUiSource.test";
import { runSettingsScenarioUiSourceTests } from "../tests/settingsScenarioUiSource.test";

async function runTests() {
  runTankTemperatureForecastUnitTests();
  await runHeatingHistoryUnitTests();
  runHeatingEnergyCostUnitTests();
  runElectricityPricesUnitTests();
  runHistoryUiSourceTests();
  runHeatingGainHistorySourceTests();
  runHeatingPlanMarkerUnitTests();
  runElectricityPriceTrendUnitTests();
  runElectricityPriceFunctionUnitTests();
  runTemperatureHistoryDayUnitTests();
  runTemperatureHistoryRpcMigrationTests();
  await runSettingsDraftUnitTests();
  runSettingsScenarioUnitTests();
  runSettingsDraftUiSourceTests();
  runSettingsScenarioUiSourceTests();
  runHeatingOptimizerUnitTests();
  runHeatingOptimizationRunUnitTests();
  await runHeatingGainUnitTests();
  runHeatingPlanPresentationUnitTests();
  runHeatingPlanPublicationUnitTests();
  runHeatingSettingsUnitTests();
  runShowerReserveSettingsUnitTests();
  runSettingsSectionSummaryUnitTests();
  runTemperatureDropProfileUnitTests();

  console.log(
    "tankTemperatureForecast, heatingHistory, heatingEnergyCost, electricityPrices, electricityPriceTrend, electricityPriceFunction, temperatureHistoryDay, temperatureHistoryRpcMigration, settingsDraft, settingsScenario, settingsDraftUiSource, settingsScenarioUiSource, historyUiSource, heatingGainHistorySource, heatingPlanMarkers, heatingOptimizer, heatingOptimizationRun, heatingGain, heatingPlanPresentation, heatingPlanPublication, heatingSettings, settingsSectionSummaries, showerReserveSettings and temperatureDropProfile tests passed",
  );
}

void runTests();
