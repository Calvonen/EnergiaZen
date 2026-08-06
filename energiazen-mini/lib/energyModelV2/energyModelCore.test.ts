import {
  advanceState,
  calculateTankStateFromObservation,
  calculateTwoNodeLayerMassesKg,
  createTankObservationFromReplayStep,
  runEnergyModelCoreReplay,
  defaultEnergyModelCoreConfig,
} from "./energyModelCore";
import { runTankReadingsReplay } from "./replayEngine";
import { createSensorGeometryEpochs, sensorGeometryV2 } from "./sensorGeometry";

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertClose(actual: number, expected: number, message: string) {
  if (Math.abs(actual - expected) > 0.000001) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function expectedLayerEnergyKwh(massKg: number, temperatureC: number, inletTempC: number) {
  return Math.round(
    Math.max(
      0,
      massKg *
        defaultEnergyModelCoreConfig.specificHeatKwhPerKgC *
        (temperatureC - inletTempC),
    ) * 1_000_000,
  ) / 1_000_000;
}

function calculateExpectedEnergies({
  bottomTempC,
  inletTempC,
  topTempC,
}: {
  bottomTempC: number;
  inletTempC: number;
  topTempC: number;
}) {
  const masses = calculateTwoNodeLayerMassesKg(sensorGeometryV2);
  const bottomEnergy = expectedLayerEnergyKwh(
    masses.bottomMassKg,
    bottomTempC,
    inletTempC,
  );
  const topEnergy = expectedLayerEnergyKwh(masses.topMassKg, topTempC, inletTempC);
  const storedEnergy = Math.round((bottomEnergy + topEnergy) * 1_000_000) / 1_000_000;
  const usableEnergy =
    (bottomTempC > defaultEnergyModelCoreConfig.targetUseTempC ? bottomEnergy : 0) +
    (topTempC > defaultEnergyModelCoreConfig.targetUseTempC ? topEnergy : 0);

  return {
    storedEnergy,
    usableEnergy: Math.round(usableEnergy * 1_000_000) / 1_000_000,
  };
}

export function runEnergyModelCoreUnitTests() {
  const fullTank = calculateTankStateFromObservation({
    geometry: sensorGeometryV2,
    observation: {
      bottomTempC: 65,
      heating: false,
      inletTempC: 12,
      timestamp: "2026-08-01T12:00:00.000Z",
      topTempC: 65,
    },
  });
  const fullTankExpected = calculateExpectedEnergies({
    bottomTempC: 65,
    inletTempC: 12,
    topTempC: 65,
  });

  assertClose(fullTank.storedEnergy.kwh, fullTankExpected.storedEnergy, "full tank stored energy");
  assertClose(fullTank.usableEnergy.kwh, fullTankExpected.usableEnergy, "full tank usable energy");
  assertClose(fullTank.reserveEnergy.kwh, 0, "full tank reserve energy");
  assertClose(fullTank.immediateEnergy.kwh, fullTank.usableEnergy.kwh, "full tank immediate energy");

  const stratifiedTank = calculateTankStateFromObservation({
    geometry: sensorGeometryV2,
    observation: {
      bottomTempC: 30,
      heating: false,
      inletTempC: 12,
      timestamp: "2026-08-01T12:01:00.000Z",
      topTempC: 65,
    },
  });
  const stratifiedExpected = calculateExpectedEnergies({
    bottomTempC: 30,
    inletTempC: 12,
    topTempC: 65,
  });

  assertClose(
    stratifiedTank.storedEnergy.kwh,
    stratifiedExpected.storedEnergy,
    "stratified tank stored energy includes bottom reserve energy",
  );
  assertClose(
    stratifiedTank.usableEnergy.kwh,
    stratifiedExpected.usableEnergy,
    "stratified tank usable energy includes only layers above target use temperature",
  );
  assertClose(
    stratifiedTank.reserveEnergy.kwh,
    stratifiedTank.storedEnergy.kwh - stratifiedTank.usableEnergy.kwh,
    "stratified tank reserve energy is stored minus usable",
  );

  const coldTank = calculateTankStateFromObservation({
    geometry: sensorGeometryV2,
    observation: {
      bottomTempC: 20,
      heating: false,
      inletTempC: 12,
      timestamp: "2026-08-01T12:02:00.000Z",
      topTempC: 25,
    },
  });

  assert(coldTank.storedEnergy.kwh > 0, "cold tank can still contain stored heat above inlet");
  assertClose(coldTank.usableEnergy.kwh, 0, "cold tank has no usable energy above 40C");
  assertClose(coldTank.immediateEnergy.kwh, 0, "cold tank has no immediate energy above 40C margin");

  const winterTank = calculateTankStateFromObservation({
    geometry: sensorGeometryV2,
    observation: {
      bottomTempC: 65,
      heating: false,
      inletTempC: 5,
      timestamp: "2026-08-01T12:03:00.000Z",
      topTempC: 65,
    },
  });
  const summerTank = calculateTankStateFromObservation({
    geometry: sensorGeometryV2,
    observation: {
      bottomTempC: 65,
      heating: false,
      inletTempC: 18,
      timestamp: "2026-08-01T12:04:00.000Z",
      topTempC: 65,
    },
  });

  assert(
    winterTank.usableEnergy.kwh > summerTank.usableEnergy.kwh,
    "lower winter inlet increases usable energy relative to inlet reference",
  );
  assert(
    winterTank.storedEnergy.kwh > summerTank.storedEnergy.kwh,
    "lower winter inlet increases stored energy relative to inlet reference",
  );

  const epochs = createSensorGeometryEpochs({
    topSensorMovedAt: "2026-08-01T12:03:30.000Z",
  });
  const replay = runTankReadingsReplay(
    [
      {
        bottom_temp: 65,
        created_at: "2026-08-01T12:04:00.000Z",
        heating: false,
        inlet_temp: 18,
        top_temp: 65,
      },
      {
        bottom_temp: 65,
        created_at: "2026-08-01T12:03:00.000Z",
        heating: false,
        inlet_temp: 5,
        top_temp: 65,
      },
    ],
    {
      initialState: [] as string[],
      modelVersion: "energy-model-core-v1",
      sensorGeometryEpochs: epochs,
      step: (state, context) => {
        const nextState = calculateTankStateFromObservation({
          geometry: context.geometry,
          observation: createTankObservationFromReplayStep(context),
        });

        return {
          state: [
            ...state,
            `${context.geometry.version}:${nextState.usableEnergy.kwh}`,
          ],
        };
      },
    },
  );

  assert(
    replay.finalState[0].startsWith("V1:"),
    "EnergyModelCore replay uses V1 geometry before the move",
  );
  assert(
    replay.finalState[1].startsWith("V2:"),
    "EnergyModelCore replay uses V2 geometry after the move",
  );


  const initialDynamicState = calculateTankStateFromObservation({
    geometry: sensorGeometryV2,
    observation: {
      bottomTempC: 65,
      heating: false,
      inletTempC: 12,
      timestamp: "2026-08-01T13:00:00.000Z",
      topTempC: 65,
    },
  });
  const restedSixHours = advanceState(
    initialDynamicState,
    {
      bottomTempC: null,
      heating: false,
      inletTempC: 12,
      timestamp: "2026-08-01T19:00:00.000Z",
      topTempC: null,
    },
    6 * 60,
  );

  assert(
    restedSixHours.storedEnergy.kwh < initialDynamicState.storedEnergy.kwh,
    "six hours of rest without heating lowers stored energy",
  );
  assert(
    (restedSixHours.topNodeTemperatureC ?? 0) < 65 &&
      (restedSixHours.bottomNodeTemperatureC ?? 0) < 65,
    "six hours of Newton cooling lowers both node temperatures",
  );

  const longGapState = advanceState(
    initialDynamicState,
    {
      bottomTempC: null,
      heating: false,
      inletTempC: 12,
      timestamp: "2026-08-02T13:00:00.000Z",
      topTempC: null,
    },
    24 * 60,
  );

  assert(
    longGapState.quality === "degraded",
    "long replay gaps degrade state quality deterministically",
  );
  assert(
    longGapState.uncertainty.reasons.includes("long-replay-gap"),
    "long replay gaps are recorded as uncertainty reasons",
  );
  assert(
    longGapState.uncertainty.energyKwh > restedSixHours.uncertainty.energyKwh,
    "long replay gaps increase energy uncertainty with gap length",
  );
  assert(
    (longGapState.topNodeTemperatureC ?? 0) <= defaultEnergyModelCoreConfig.maxNodeTemperatureC &&
      (longGapState.bottomNodeTemperatureC ?? 0) <= defaultEnergyModelCoreConfig.maxNodeTemperatureC,
    "long replay gaps keep node temperatures inside the deterministic model bounds",
  );

  const heatingStartState = calculateTankStateFromObservation({
    geometry: sensorGeometryV2,
    observation: {
      bottomTempC: 45,
      heating: false,
      inletTempC: 12,
      timestamp: "2026-08-01T20:00:00.000Z",
      topTempC: 50,
    },
  });
  const heatedOneHour = advanceState(
    heatingStartState,
    {
      bottomTempC: null,
      heating: true,
      inletTempC: 12,
      timestamp: "2026-08-01T21:00:00.000Z",
      topTempC: null,
    },
    60,
  );

  assert(
    heatedOneHour.storedEnergy.kwh > heatingStartState.storedEnergy.kwh,
    "continuous heating increases stored energy despite simultaneous heat loss",
  );
  assert(
    (heatedOneHour.topNodeTemperatureC ?? 0) > 50 &&
      (heatedOneHour.bottomNodeTemperatureC ?? 0) > 45,
    "continuous heating raises both deterministic nodes with fixed distribution",
  );

  const afterSingleDraw = advanceState(
    initialDynamicState,
    {
      bottomTempC: 35,
      heating: false,
      inletTempC: 12,
      timestamp: "2026-08-01T13:10:00.000Z",
      topTempC: 55,
    },
    10,
  );

  assert(
    afterSingleDraw.storedEnergy.kwh < initialDynamicState.storedEnergy.kwh,
    "single shower observation lowers stored energy",
  );
  assert(
    afterSingleDraw.uncertainty.reasons.includes(
      "water-draw-or-mixing-corrected-from-sensors",
    ),
    "single shower records deterministic sensor correction as water draw or mixing",
  );

  const afterSecondDraw = advanceState(
    afterSingleDraw,
    {
      bottomTempC: 25,
      heating: false,
      inletTempC: 12,
      timestamp: "2026-08-01T13:20:00.000Z",
      topTempC: 45,
    },
    10,
  );

  assert(
    afterSecondDraw.storedEnergy.kwh < afterSingleDraw.storedEnergy.kwh,
    "multiple consecutive water draws keep lowering stored energy",
  );
  assert(
    afterSecondDraw.usableEnergy.kwh < afterSingleDraw.usableEnergy.kwh,
    "multiple consecutive water draws lower usable energy",
  );

  const afterLongRest = advanceState(
    initialDynamicState,
    {
      bottomTempC: null,
      heating: false,
      inletTempC: 12,
      timestamp: "2026-08-02T01:00:00.000Z",
      topTempC: null,
    },
    12 * 60,
  );
  const afterLongRestThenHeating = advanceState(
    afterLongRest,
    {
      bottomTempC: null,
      heating: true,
      inletTempC: 12,
      timestamp: "2026-08-02T03:00:00.000Z",
      topTempC: null,
    },
    2 * 60,
  );

  assert(
    afterLongRest.storedEnergy.kwh < initialDynamicState.storedEnergy.kwh,
    "long rest lowers stored energy before heating resumes",
  );
  assert(
    afterLongRestThenHeating.storedEnergy.kwh > afterLongRest.storedEnergy.kwh,
    "heating after long rest raises stored energy",
  );

  const continuousReplay = runEnergyModelCoreReplay({
    readings: [
      {
        bottom_temp: 65,
        created_at: "2026-08-01T14:00:00.000Z",
        heating: false,
        inlet_temp: 12,
        top_temp: 65,
      },
      {
        created_at: "2026-08-01T20:00:00.000Z",
        heating: false,
        inlet_temp: 12,
      },
    ],
    sensorGeometryEpochs: createSensorGeometryEpochs({
      topSensorMovedAt: "2026-08-01T00:00:00.000Z",
    }),
  });

  assert(
    continuousReplay.finalState?.storedEnergy.kwh !== undefined &&
      continuousReplay.finalState.storedEnergy.kwh <
        (continuousReplay.steps[0].state?.storedEnergy.kwh ?? 0),
    "EnergyModelCore replay advances the previous state continuously across steps",
  );
}
