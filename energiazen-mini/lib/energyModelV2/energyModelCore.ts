import { runTankReadingsReplay } from "./replayEngine";
import type { ReplayStepContext } from "./replayEngine";
import type { SensorGeometryEpoch } from "./sensorGeometry";

export type TankObservation = {
  bottomTempC: number | null;
  heating: boolean | null;
  inletTempC: number | null;
  timestamp: string;
  topTempC: number | null;
};

export type EnergyQuantity = {
  kwh: number;
};

export type TankStateQuality = "valid" | "degraded" | "invalid";

export type TankState = {
  bottomNodeTemperatureC: number | null;
  immediateEnergy: EnergyQuantity;
  inletTemperatureC: number | null;
  layerMassesKg: {
    bottom: number;
    top: number;
  };
  quality: TankStateQuality;
  reserveEnergy: EnergyQuantity;
  storedEnergy: EnergyQuantity;
  timestamp: string | null;
  topNodeTemperatureC: number | null;
  uncertainty: {
    bottomTemperatureC: number;
    energyKwh: number;
    reasons: string[];
    topTemperatureC: number;
  };
  usableEnergy: EnergyQuantity;
};

export type EnergyModelCoreConfig = {
  ambientTempC: number;
  bottomHeatLossTimeConstantHours: number;
  deliveryMarginC: number;
  fixedHeaterDistribution: {
    toBottom: number;
    toTop: number;
  };
  heatingPowerKwhPerHour: number;
  longGapThresholdMinutes: number;
  longGapUncertaintyKwhPerHour: number;
  maxNodeTemperatureC: number;
  specificHeatKwhPerKgC: number;
  targetUseTempC: number;
  topHeatLossTimeConstantHours: number;
};

export const defaultEnergyModelCoreConfig = {
  ambientTempC: 21,
  bottomHeatLossTimeConstantHours: 120,
  deliveryMarginC: 2,
  fixedHeaterDistribution: {
    toBottom: 0.55,
    toTop: 0.45,
  },
  heatingPowerKwhPerHour: 3,
  longGapThresholdMinutes: 180,
  longGapUncertaintyKwhPerHour: 0.15,
  maxNodeTemperatureC: 80,
  // Water heat capacity: 4.186 kJ/kgC = 0.00116278 kWh/kgC.
  specificHeatKwhPerKgC: 0.001163,
  targetUseTempC: 40,
  topHeatLossTimeConstantHours: 96,
} as const satisfies EnergyModelCoreConfig;

export function createTankObservationFromReplayStep(
  context: ReplayStepContext,
): TankObservation {
  return {
    bottomTempC:
      typeof context.reading.bottom_temp === "number"
        ? context.reading.bottom_temp
        : null,
    heating: context.reading.heating ?? null,
    inletTempC:
      typeof context.reading.inlet_temp === "number"
        ? context.reading.inlet_temp
        : null,
    timestamp: context.reading.created_at,
    topTempC:
      typeof context.reading.top_temp === "number"
        ? context.reading.top_temp
        : null,
  };
}

export function calculateTankStateFromObservation({
  config = defaultEnergyModelCoreConfig,
  geometry,
  observation,
}: {
  config?: EnergyModelCoreConfig;
  geometry: SensorGeometryEpoch;
  observation: TankObservation;
}): TankState {
  const qualityReasons = getObservationQualityReasons(observation);

  if (qualityReasons.length > 0) {
    return createInvalidTankState(qualityReasons);
  }

  const topTempC = observation.topTempC as number;
  const bottomTempC = observation.bottomTempC as number;
  const inletTempC = observation.inletTempC as number;
  const layerMasses = calculateTwoNodeLayerMassesKg(geometry);
  const bottomEnergyKwh = calculateLayerStoredEnergyKwh({
    config,
    inletTempC,
    massKg: layerMasses.bottomMassKg,
    temperatureC: bottomTempC,
  });
  const topEnergyKwh = calculateLayerStoredEnergyKwh({
    config,
    inletTempC,
    massKg: layerMasses.topMassKg,
    temperatureC: topTempC,
  });
  const storedEnergyKwh = bottomEnergyKwh + topEnergyKwh;
  const usableEnergyKwh =
    (bottomTempC > config.targetUseTempC ? bottomEnergyKwh : 0) +
    (topTempC > config.targetUseTempC ? topEnergyKwh : 0);
  const immediateEnergyKwh =
    bottomEnergyKwh * calculateImmediateUsabilityWeight(bottomTempC, config) +
    topEnergyKwh * calculateImmediateUsabilityWeight(topTempC, config);

  return {
    bottomNodeTemperatureC: bottomTempC,
    immediateEnergy: { kwh: roundEnergyKwh(immediateEnergyKwh) },
    inletTemperatureC: inletTempC,
    layerMassesKg: {
      bottom: layerMasses.bottomMassKg,
      top: layerMasses.topMassKg,
    },
    quality: "valid",
    reserveEnergy: { kwh: roundEnergyKwh(storedEnergyKwh - usableEnergyKwh) },
    storedEnergy: { kwh: roundEnergyKwh(storedEnergyKwh) },
    timestamp: observation.timestamp,
    topNodeTemperatureC: topTempC,
    uncertainty: {
      bottomTemperatureC: 0,
      energyKwh: 0,
      reasons: [],
      topTemperatureC: 0,
    },
    usableEnergy: { kwh: roundEnergyKwh(usableEnergyKwh) },
  };
}

export function advanceState(
  previousState: TankState,
  observation: TankObservation,
  deltaTimeMinutes: number,
  config = defaultEnergyModelCoreConfig,
): TankState {
  if (
    previousState.quality === "invalid" ||
    previousState.topNodeTemperatureC === null ||
    previousState.bottomNodeTemperatureC === null ||
    previousState.inletTemperatureC === null
  ) {
    return previousState;
  }

  const safeDeltaTimeMinutes = Math.max(deltaTimeMinutes, 0);
  const deltaHours = safeDeltaTimeMinutes / 60;
  const inletTempC = isFiniteNumber(observation.inletTempC)
    ? observation.inletTempC
    : previousState.inletTemperatureC;
  const naturallyCooledTopTempC = applyNewtonCooling({
    ambientTempC: config.ambientTempC,
    deltaHours,
    temperatureC: previousState.topNodeTemperatureC,
    timeConstantHours: config.topHeatLossTimeConstantHours,
  });
  const naturallyCooledBottomTempC = applyNewtonCooling({
    ambientTempC: config.ambientTempC,
    deltaHours,
    temperatureC: previousState.bottomNodeTemperatureC,
    timeConstantHours: config.bottomHeatLossTimeConstantHours,
  });
  const heatedTemperatures = observation.heating === true
    ? applyFixedHeating({
        bottomTempC: naturallyCooledBottomTempC,
        config,
        deltaHours,
        layerMassesKg: previousState.layerMassesKg,
        topTempC: naturallyCooledTopTempC,
      })
    : {
        bottomTempC: naturallyCooledBottomTempC,
        topTempC: naturallyCooledTopTempC,
      };
  const correctedTopTempC = isFiniteNumber(observation.topTempC)
    ? observation.topTempC
    : heatedTemperatures.topTempC;
  const correctedBottomTempC = isFiniteNumber(observation.bottomTempC)
    ? observation.bottomTempC
    : heatedTemperatures.bottomTempC;
  const uncertaintyReasons = getAdvanceUncertaintyReasons({
    deltaTimeMinutes: safeDeltaTimeMinutes,
    observation,
    predictedBottomTempC: heatedTemperatures.bottomTempC,
    predictedTopTempC: heatedTemperatures.topTempC,
    config,
  });
  const longGapUncertainty = calculateLongGapUncertaintyKwh({
    config,
    deltaTimeMinutes: safeDeltaTimeMinutes,
  });

  return createTankStateFromNodeTemperatures({
    bottomTempC: correctedBottomTempC,
    inletTempC,
    layerMassesKg: previousState.layerMassesKg,
    quality: uncertaintyReasons.length > 0 ? "degraded" : "valid",
    timestamp: observation.timestamp,
    topTempC: correctedTopTempC,
    uncertaintyReasons,
    extraEnergyUncertaintyKwh: longGapUncertainty,
    config,
  });
}

export function runEnergyModelCoreReplay({
  readings,
  sensorGeometryEpochs,
}: {
  readings: Parameters<typeof runTankReadingsReplay<TankState | null>>[0];
  sensorGeometryEpochs: SensorGeometryEpoch[];
}) {
  return runTankReadingsReplay<TankState | null>(readings, {
    initialState: null,
    modelVersion: "energy-model-core-v1",
    sensorGeometryEpochs,
    step: (state, context) => {
      const observation = createTankObservationFromReplayStep(context);
      const nextState = state === null || context.segmentMinutes === null
        ? calculateTankStateFromObservation({
            geometry: context.geometry,
            observation,
          })
        : advanceState(state, observation, context.segmentMinutes);

      return { state: nextState };
    },
  });
}

export function calculateTwoNodeLayerMassesKg(geometry: SensorGeometryEpoch) {
  const tankHeightCm = geometry.tank.heightCm;
  const topSensorHeightFromBottomCm =
    tankHeightCm - geometry.topSensorDistanceFromTopCm;
  const bottomSensorHeightFromBottomCm = geometry.bottomSensorHeightFromBottomCm;
  const boundaryHeightCm =
    (topSensorHeightFromBottomCm + bottomSensorHeightFromBottomCm) / 2;
  const bottomVolumeRatio = clamp(boundaryHeightCm / tankHeightCm, 0, 1);
  const totalMassKg = geometry.tank.nominalVolumeLiters;
  const bottomMassKg = totalMassKg * bottomVolumeRatio;

  return {
    bottomMassKg,
    topMassKg: totalMassKg - bottomMassKg,
  };
}

function createTankStateFromNodeTemperatures({
  bottomTempC,
  config,
  inletTempC,
  layerMassesKg,
  quality,
  timestamp,
  topTempC,
  uncertaintyReasons,
  extraEnergyUncertaintyKwh = 0,
}: {
  bottomTempC: number;
  config: EnergyModelCoreConfig;
  inletTempC: number;
  layerMassesKg: { bottom: number; top: number };
  quality: TankStateQuality;
  timestamp: string;
  topTempC: number;
  uncertaintyReasons: string[];
  extraEnergyUncertaintyKwh?: number;
}): TankState {
  const bottomEnergyKwh = calculateLayerStoredEnergyKwh({
    config,
    inletTempC,
    massKg: layerMassesKg.bottom,
    temperatureC: bottomTempC,
  });
  const topEnergyKwh = calculateLayerStoredEnergyKwh({
    config,
    inletTempC,
    massKg: layerMassesKg.top,
    temperatureC: topTempC,
  });
  const storedEnergyKwh = bottomEnergyKwh + topEnergyKwh;
  const usableEnergyKwh =
    (bottomTempC > config.targetUseTempC ? bottomEnergyKwh : 0) +
    (topTempC > config.targetUseTempC ? topEnergyKwh : 0);
  const immediateEnergyKwh =
    bottomEnergyKwh * calculateImmediateUsabilityWeight(bottomTempC, config) +
    topEnergyKwh * calculateImmediateUsabilityWeight(topTempC, config);

  return {
    bottomNodeTemperatureC: bottomTempC,
    immediateEnergy: { kwh: roundEnergyKwh(immediateEnergyKwh) },
    inletTemperatureC: inletTempC,
    layerMassesKg,
    quality,
    reserveEnergy: { kwh: roundEnergyKwh(storedEnergyKwh - usableEnergyKwh) },
    storedEnergy: { kwh: roundEnergyKwh(storedEnergyKwh) },
    timestamp,
    topNodeTemperatureC: topTempC,
    uncertainty: {
      bottomTemperatureC: uncertaintyReasons.length > 0 ? 0.5 : 0,
      energyKwh: roundEnergyKwh((uncertaintyReasons.length > 0 ? 0.1 : 0) + extraEnergyUncertaintyKwh),
      reasons: uncertaintyReasons,
      topTemperatureC: uncertaintyReasons.length > 0 ? 0.5 : 0,
    },
    usableEnergy: { kwh: roundEnergyKwh(usableEnergyKwh) },
  };
}

function calculateLayerStoredEnergyKwh({
  config,
  inletTempC,
  massKg,
  temperatureC,
}: {
  config: EnergyModelCoreConfig;
  inletTempC: number;
  massKg: number;
  temperatureC: number;
}) {
  return Math.max(
    0,
    massKg * config.specificHeatKwhPerKgC * (temperatureC - inletTempC),
  );
}

function applyNewtonCooling({
  ambientTempC,
  deltaHours,
  temperatureC,
  timeConstantHours,
}: {
  ambientTempC: number;
  deltaHours: number;
  temperatureC: number;
  timeConstantHours: number;
}) {
  if (deltaHours <= 0) {
    return temperatureC;
  }

  return (
    ambientTempC +
    (temperatureC - ambientTempC) * Math.exp(-deltaHours / timeConstantHours)
  );
}

function applyFixedHeating({
  bottomTempC,
  config,
  deltaHours,
  layerMassesKg,
  topTempC,
}: {
  bottomTempC: number;
  config: EnergyModelCoreConfig;
  deltaHours: number;
  layerMassesKg: { bottom: number; top: number };
  topTempC: number;
}) {
  const energyAddedKwh = config.heatingPowerKwhPerHour * deltaHours;
  const topTempGainC =
    (energyAddedKwh * config.fixedHeaterDistribution.toTop) /
    (layerMassesKg.top * config.specificHeatKwhPerKgC);
  const bottomTempGainC =
    (energyAddedKwh * config.fixedHeaterDistribution.toBottom) /
    (layerMassesKg.bottom * config.specificHeatKwhPerKgC);

  return {
    bottomTempC: Math.min(
      bottomTempC + bottomTempGainC,
      config.maxNodeTemperatureC,
    ),
    topTempC: Math.min(topTempC + topTempGainC, config.maxNodeTemperatureC),
  };
}

function calculateImmediateUsabilityWeight(
  temperatureC: number,
  config: EnergyModelCoreConfig,
) {
  return clamp(
    (temperatureC - config.targetUseTempC) / config.deliveryMarginC,
    0,
    1,
  );
}

function getAdvanceUncertaintyReasons({
  config,
  deltaTimeMinutes,
  observation,
  predictedBottomTempC,
  predictedTopTempC,
}: {
  config: EnergyModelCoreConfig;
  deltaTimeMinutes: number;
  observation: TankObservation;
  predictedBottomTempC: number;
  predictedTopTempC: number;
}) {
  const reasons: string[] = [];

  if (deltaTimeMinutes > config.longGapThresholdMinutes) {
    reasons.push("long-replay-gap");
  }
  if (!isFiniteNumber(observation.topTempC)) {
    reasons.push("missing-top-temperature-corrected-by-model");
  }
  if (!isFiniteNumber(observation.bottomTempC)) {
    reasons.push("missing-bottom-temperature-corrected-by-model");
  }
  if (!isFiniteNumber(observation.inletTempC)) {
    reasons.push("missing-inlet-temperature-reused-previous");
  }
  if (
    isFiniteNumber(observation.topTempC) &&
    isFiniteNumber(observation.bottomTempC) &&
    (observation.topTempC < predictedTopTempC - 0.25 ||
      observation.bottomTempC < predictedBottomTempC - 0.25)
  ) {
    reasons.push("water-draw-or-mixing-corrected-from-sensors");
  }

  return reasons;
}

function calculateLongGapUncertaintyKwh({
  config,
  deltaTimeMinutes,
}: {
  config: EnergyModelCoreConfig;
  deltaTimeMinutes: number;
}) {
  const excessGapMinutes = Math.max(
    deltaTimeMinutes - config.longGapThresholdMinutes,
    0,
  );

  return (excessGapMinutes / 60) * config.longGapUncertaintyKwhPerHour;
}

function getObservationQualityReasons(observation: TankObservation) {
  const reasons: string[] = [];

  if (!isFiniteNumber(observation.topTempC)) {
    reasons.push("missing-top-temperature");
  }
  if (!isFiniteNumber(observation.bottomTempC)) {
    reasons.push("missing-bottom-temperature");
  }
  if (!isFiniteNumber(observation.inletTempC)) {
    reasons.push("missing-inlet-temperature");
  }
  if (!Number.isFinite(new Date(observation.timestamp).getTime())) {
    reasons.push("invalid-timestamp");
  }

  return reasons;
}

function createInvalidTankState(reasons: string[]): TankState {
  return {
    bottomNodeTemperatureC: null,
    immediateEnergy: { kwh: 0 },
    inletTemperatureC: null,
    layerMassesKg: {
      bottom: 0,
      top: 0,
    },
    quality: "invalid",
    reserveEnergy: { kwh: 0 },
    storedEnergy: { kwh: 0 },
    timestamp: null,
    topNodeTemperatureC: null,
    uncertainty: {
      bottomTemperatureC: Number.POSITIVE_INFINITY,
      energyKwh: Number.POSITIVE_INFINITY,
      reasons,
      topTemperatureC: Number.POSITIVE_INFINITY,
    },
    usableEnergy: { kwh: 0 },
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function roundEnergyKwh(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
