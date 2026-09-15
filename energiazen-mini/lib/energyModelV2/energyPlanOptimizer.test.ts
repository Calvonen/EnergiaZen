import { optimizeEnergyPlan, type EnergyPlanCandidateSegment } from "./energyPlanOptimizer";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

function segment(
  id: string,
  hour: number,
  priceCentsPerKwh: number,
  modeledHeatLossKwh = 0.2,
  segmentHours = 1,
): EnergyPlanCandidateSegment {
  return {
    id,
    modeledHeatLossKwh,
    priceCentsPerKwh,
    segmentHours,
    startDate: `2026-09-15T${String(hour).padStart(2, "0")}:00:00.000Z`,
  };
}

export function runEnergyPlanOptimizerUnitTests() {
  const alreadyHealthy = optimizeEnergyPlan({
    heaterPowerKw: 3,
    initialRemainingEnergyKwh: 8,
    initialUncertaintyKwh: 0.25,
    maxHeatingHours: 4,
    segments: [segment("a", 8, 10), segment("b", 9, 1)],
  });
  assert(alreadyHealthy.valid, "healthy horizon is valid without heating");
  assertEqual(alreadyHealthy.selectedHeatingHourIds.length, 0, "optimizer does not overheat an already healthy horizon");

  const cheapestEquivalent = optimizeEnergyPlan({
    heaterPowerKw: 3,
    initialRemainingEnergyKwh: 4.2,
    initialUncertaintyKwh: 0.25,
    maxHeatingHours: 2,
    segments: [segment("expensive", 8, 20, 0.1), segment("cheap", 9, 2, 0.1)],
  });
  assert(cheapestEquivalent.valid, "one heating hour can restore target");
  assertEqual(cheapestEquivalent.selectedHeatingHourIds.length, 1, "minimum heating energy wins before price");
  assertEqual(cheapestEquivalent.selectedHeatingHourIds[0], "cheap", "cheapest equivalent safe hour is selected");

  const safetyForcesEarlier = optimizeEnergyPlan({
    heaterPowerKw: 3,
    initialRemainingEnergyKwh: 3.25,
    initialUncertaintyKwh: 0.25,
    maxHeatingHours: 2,
    segments: [segment("early", 8, 20, 0.3), segment("late", 9, 1, 0.1)],
  });
  assert(safetyForcesEarlier.valid, "an early heating hour can protect safety reserve");
  assertEqual(safetyForcesEarlier.selectedHeatingHourIds[0], "early", "cheap late hour is rejected when safety would fail first");

  const requiredAndForbidden = optimizeEnergyPlan({
    forbiddenHeatingHourIds: ["cheap"],
    heaterPowerKw: 3,
    initialRemainingEnergyKwh: 4.2,
    initialUncertaintyKwh: 0.25,
    maxHeatingHours: 2,
    requiredHeatingHourIds: ["locked"],
    segments: [segment("locked", 8, 15, 0.1), segment("cheap", 9, 1, 0.1)],
  });
  assert(requiredAndForbidden.valid, "required hour remains a valid physical plan");
  assertEqual(requiredAndForbidden.selectedHeatingHourIds.join(","), "locked", "required/forbidden constraints are preserved");

  const overlap = optimizeEnergyPlan({
    forbiddenHeatingHourIds: ["same"],
    heaterPowerKw: 3,
    initialRemainingEnergyKwh: 5,
    initialUncertaintyKwh: 0.25,
    maxHeatingHours: 2,
    requiredHeatingHourIds: ["same"],
    segments: [segment("same", 8, 1)],
  });
  assert(!overlap.valid, "contradictory hard constraints fail closed");
  assertEqual(overlap.violationReason, "required_hour_is_forbidden", "constraint conflict has explicit reason");

  const insufficientCapacity = optimizeEnergyPlan({
    heaterPowerKw: 3,
    initialRemainingEnergyKwh: 1,
    initialUncertaintyKwh: 0.25,
    maxHeatingHours: 1,
    segments: [segment("only", 8, 1, 0.5), segment("later", 9, 2, 0.5)],
  });
  assert(!insufficientCapacity.valid, "insufficient heating capacity stays invalid");
  assert(insufficientCapacity.selectedHeatingHourIds.length <= 1, "fallback never exceeds max heating hours");

  const partialEnough = optimizeEnergyPlan({
    heaterPowerKw: 3,
    initialRemainingEnergyKwh: 5.6,
    initialUncertaintyKwh: 0.25,
    maxHeatingHours: 2,
    segments: [
      segment("partial", 8, 20, 0.05, 0.25),
      segment("full", 9, 1, 0.05, 1),
    ],
  });
  assert(partialEnough.valid, "partial current hour can satisfy target when physically enough");
  assertEqual(partialEnough.selectedHeatingHourIds[0], "partial", "optimizer minimizes delivered heating energy before cost");
}
