import { runEnergyForecastUnitTests } from "../lib/energyModelV2/energyForecast.test";
import { runEnergyPlanOptimizerUnitTests } from "../lib/energyModelV2/energyPlanOptimizer.test";

runEnergyForecastUnitTests();
runEnergyPlanOptimizerUnitTests();
console.log("energyForecast and energyPlanOptimizer tests passed");
