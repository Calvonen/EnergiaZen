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
import { runSettingsDraftUiSourceTests } from "../tests/settingsDraftUiSource.test";

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
  runSettingsDraftUiSourceTests();
  runHeatingOptimizerUnitTests();
  runHeatingOptimizationRunUnitTests();
  await runHeatingGainUnitTests();
  runHeatingPlanPresentationUnitTests();
  runHeatingSettingsUnitTests();
  runShowerReserveSettingsUnitTests();
  runSettingsSectionSummaryUnitTests();
  runTemperatureDropProfileUnitTests();

  console.log(
    "tankTemperatureForecast, heatingHistory, heatingEnergyCost, electricityPrices, electricityPriceTrend, electricityPriceFunction, temperatureHistoryDay, temperatureHistoryRpcMigration, settingsDraft, settingsDraftUiSource, historyUiSource, heatingGainHistorySource, heatingPlanMarkers, heatingOptimizer, heatingOptimizationRun, heatingGain, heatingPlanPresentation, heatingSettings, settingsSectionSummaries, showerReserveSettings and temperatureDropProfile tests passed",
  );
}

void runTests();
