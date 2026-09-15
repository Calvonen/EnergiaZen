import { runEnergyForecastUnitTests } from "../lib/energyModelV2/energyForecast.test";
import { runEnergyPlanOptimizerUnitTests } from "../lib/energyModelV2/energyPlanOptimizer.test";
import { runEnergyReservePercentUnitTests } from "../lib/energyModelV2/energyReservePercent.test";

runEnergyForecastUnitTests();
runEnergyPlanOptimizerUnitTests();
runEnergyReservePercentUnitTests();
console.log("energyForecast, energyPlanOptimizer and energyReservePercent tests passed");
