import {
  fallbackHourlyTemperatureDrop,
  HourlyTemperatureDropProfile,
  TankTemperatureReading,
} from "./tankTemperatureForecast";
import { estimateHeatingGainPerHour } from "./heatingGain";
import type { HeatingGainEstimate } from "./heatingGain";

export { estimateHeatingGainPerHour } from "./heatingGain";
export type { HeatingGainEstimate } from "./heatingGain";

export type HeatingOptimizationHour = {
  date: Date;
  endDate: Date;
  id: string;
  price: number;
  segmentHours: number;
  startDate: string;
};

export type HeatingOptimizationSettings = {
  absoluteMinimumTemperature: number;
  fallbackHeatingGainPerHour: number;
  fullTankAverageTemperature: number;
  fullTankShowers: number;
  maxHeatingHours: number;
  maxTankTemperature: number;
  safetyShowerReserve: number;
  targetShowerReserve: number;
};

export type HeatingOptimizationSettingsSource = {
  fullTankAverageTemperature: number;
  fullTankShowers: number;
  automaticMaxHeatingHours: number;
  maxTankTemperature?: number;
  minTankTemperature: number;
  safetyShowerReserve: number;
  targetShowerReserve: number;
};

export type StratifiedShowersEstimate = {
  energyRatio: number;
  fillRatio: number;
  showersLeft: number;
  topUsability: number;
  weightedTemperature: number;
};

export type ConsumptionSpike = {
  drop: number;
  hour: number;
  requiredShowersBefore: number;
};

export type HourlyHeatingForecast = {
  bottomTemperatureAfter: number;
  bottomTemperatureBeforeHeating: number;
  appliedDrop: number;
  heatingGain: number;
  helsinkiHour: number;
  hourlyDrop: number;
  isHeatingSelected: boolean;
  showersLeftAfter: number;
  showersLeftBefore: number;
  segmentHours: number;
  startDate: string;
  temperatureAfter: number;
  temperatureBefore: number;
  temperatureBeforeHeating: number;
  topTemperatureAfter: number;
  topTemperatureBeforeHeating: number;
  violatedAbsoluteSafety: boolean;
  violatedReserve: boolean;
  violatedSpikeReserve: boolean;
};

export type HeatingSimulationResult = {
  forecast: HourlyHeatingForecast[];
  largestSpike:
    | {
        drop: number;
        hour: number;
        requiredShowersBefore: number;
        startDate: string;
        temperatureBefore: number;
        showersLeftBefore: number;
      }
    | null;
  minimumPredictedShowersLeft: number;
  minimumPredictedTemperature: number;
  selectedHeatingHourIds: string[];
  totalCost: number;
  valid: boolean;
  violations: string[];
};

export type RejectedShift = {
  minimumShowersLeftBeforeNextHeating: number;
  reason: string;
  selectedHeatingHourIds: string[];
};

export type HeatingOptimizationResult = HeatingSimulationResult & {
  diagnostics: {
    firstValidSelectionCount: number | null;
    forecast: HourlyHeatingForecast[];
    heatingGainEstimate: Pick<
      HeatingGainEstimate,
      "fallbackUsed" | "gainPerHour"
    >;
    largestSpike: HeatingSimulationResult["largestSpike"];
    minimumPredictedShowersLeft: number;
    minimumPredictedTemperature: number;
    rejectedShifts: RejectedShift[];
    selectedPlanCost: number;
    selectedHeatingHourIds: string[];
    validCombinationCountsBySelectionCount: Record<number, number>;
  };
  heatingGainEstimate: HeatingGainEstimate;
  spikes: ConsumptionSpike[];
};

const millisecondsPerHour = 60 * 60 * 1000;

export function getHeatingOptimizationSegmentHours({
  endDate,
  forecastStart,
  startDate,
}: {
  endDate: Date;
  forecastStart: Date;
  startDate: Date;
}) {
  const segmentStart = Math.max(startDate.getTime(), forecastStart.getTime());
  const durationHours =
    (endDate.getTime() - segmentStart) / millisecondsPerHour;

  return clamp(durationHours, 0, 1);
}

const helsinkiHourFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  hour12: false,
  timeZone: "Europe/Helsinki",
});

function getHelsinkiHourNumber(date: Date) {
  const hour = Number(helsinkiHourFormatter.format(date));

  return hour === 24 ? 0 : hour;
}

function getWeightedTemperatureFromSensors(
  topTemperature: number,
  bottomTemperature: number,
) {
  return topTemperature * 0.7 + bottomTemperature * 0.3;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getStratifiedTemperaturesFromWeightedTemperature({
  temperatureDifference,
  weightedTemperature,
}: {
  temperatureDifference: number;
  weightedTemperature: number;
}) {
  const safeTemperatureDifference = Math.max(temperatureDifference, 0);
  const bottomTemperature =
    weightedTemperature - 0.7 * safeTemperatureDifference;
  const topTemperature = bottomTemperature + safeTemperatureDifference;

  return {
    bottomTemperature,
    topTemperature: Math.max(topTemperature, bottomTemperature),
  };
}

function getMedian(values: number[]) {
  if (values.length === 0) {
    return null;
  }

  const sortedValues = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sortedValues.length / 2);

  if (sortedValues.length % 2 === 1) {
    return sortedValues[middle];
  }

  return (sortedValues[middle - 1] + sortedValues[middle]) / 2;
}

function getQuantile(sortedValues: number[], ratio: number) {
  if (sortedValues.length === 0) {
    return null;
  }

  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.floor((sortedValues.length - 1) * ratio)),
  );

  return sortedValues[index];
}

function getCombinationCost(
  hours: HeatingOptimizationHour[],
  selectedIndexes: number[],
) {
  return selectedIndexes.reduce((sum, index) => sum + hours[index].price, 0);
}

function createCombinations(
  itemCount: number,
  selectionCount: number,
  onCombination: (indexes: number[]) => void,
) {
  const indexes: number[] = [];

  function walk(startIndex: number) {
    if (indexes.length === selectionCount) {
      onCombination([...indexes]);
      return;
    }

    const remainingSlots = selectionCount - indexes.length;

    for (
      let index = startIndex;
      index <= itemCount - remainingSlots;
      index += 1
    ) {
      indexes.push(index);
      walk(index + 1);
      indexes.pop();
    }
  }

  walk(0);
}

export function estimateShowersLeftFromWeightedTemperature({
  absoluteMinimumTemperature,
  fullTankAverageTemperature,
  fullTankShowers,
  weightedTemperature,
}: {
  absoluteMinimumTemperature: number;
  fullTankAverageTemperature: number;
  fullTankShowers: number;
  weightedTemperature: number;
}) {
  const temperatureRange = Math.max(
    fullTankAverageTemperature - absoluteMinimumTemperature,
    1,
  );
  const fillRatio = Math.min(
    Math.max(
      (weightedTemperature - absoluteMinimumTemperature) / temperatureRange,
      0,
    ),
    1,
  );

  return fillRatio * fullTankShowers;
}

export function calculateStratifiedShowersLeft({
  bottomTemperature,
  fullTankAverageTemperature,
  fullTankShowers,
  maxTankTemperature,
  minTankTemperature,
  topTemperature,
}: {
  bottomTemperature: number;
  fullTankAverageTemperature?: number | null;
  fullTankShowers: number;
  maxTankTemperature: number;
  minTankTemperature: number;
  topTemperature: number;
}): StratifiedShowersEstimate {
  const weightedTemperature = getWeightedTemperatureFromSensors(
    topTemperature,
    bottomTemperature,
  );
  const fullTankTemp = fullTankAverageTemperature ?? maxTankTemperature;
  const energyTemperatureRange = Math.max(
    fullTankTemp - minTankTemperature,
    1,
  );
  const energyRatio = clamp(
    (weightedTemperature - minTankTemperature) / energyTemperatureRange,
    0,
    1,
  );
  const minimumUsableTopTemperature = 42;
  const topUsabilityTemperatureRange = Math.max(
    fullTankTemp - minimumUsableTopTemperature,
    1,
  );
  const topUsability = clamp(
    (topTemperature - minimumUsableTopTemperature) /
      topUsabilityTemperatureRange,
    0,
    1,
  );
  const fillRatio = energyRatio * topUsability;
  const showersLeft = fillRatio * fullTankShowers;

  return {
    energyRatio,
    fillRatio,
    showersLeft,
    topUsability,
    weightedTemperature,
  };
}

export function createHeatingOptimizationSettings(
  settings: HeatingOptimizationSettingsSource,
  fallbackHeatingGainPerHour: number,
): HeatingOptimizationSettings {
  return {
    absoluteMinimumTemperature: settings.minTankTemperature,
    fallbackHeatingGainPerHour,
    fullTankAverageTemperature: settings.fullTankAverageTemperature,
    fullTankShowers: settings.fullTankShowers,
    maxHeatingHours: settings.automaticMaxHeatingHours,
    maxTankTemperature:
      settings.maxTankTemperature ?? settings.fullTankAverageTemperature,
    safetyShowerReserve: settings.safetyShowerReserve,
    targetShowerReserve: settings.targetShowerReserve,
  };
}

export function detectConsumptionSpikes(
  hourlyDrops: HourlyTemperatureDropProfile,
  settings: Pick<HeatingOptimizationSettings, "safetyShowerReserve">,
) {
  const drops = Array.from({ length: 24 }, (_, hour) => hourlyDrops[hour] ?? 0);
  const sortedDrops = [...drops].sort((a, b) => a - b);
  const medianDrop = getMedian(sortedDrops) ?? 0;
  const upperQuartile = getQuantile(sortedDrops, 0.75) ?? medianDrop;
  const lowerQuartile = getQuantile(sortedDrops, 0.25) ?? medianDrop;
  const threshold = Math.max(
    medianDrop * 1.5,
    upperQuartile + Math.max(upperQuartile - lowerQuartile, 0.1),
  );
  return drops
    .map((drop, hour): ConsumptionSpike | null =>
      drop > threshold
        ? {
            drop,
            hour,
            requiredShowersBefore: settings.safetyShowerReserve,
          }
        : null,
    )
    .filter((item): item is ConsumptionSpike => item !== null)
    .sort((first, second) => second.drop - first.drop);
}

export function simulateHeatingPlan({
  currentBottomTemperature,
  currentTopTemperature,
  currentWeightedTemperature,
  heatingGainPerHour,
  hourlyDrops,
  hours,
  selectedHeatingHourIds,
  settings,
  spikes = detectConsumptionSpikes(hourlyDrops, settings),
}: {
  currentBottomTemperature: number;
  currentTopTemperature: number;
  currentWeightedTemperature?: number;
  heatingGainPerHour: number;
  hourlyDrops: HourlyTemperatureDropProfile;
  hours: HeatingOptimizationHour[];
  selectedHeatingHourIds: string[];
  settings: HeatingOptimizationSettings;
  spikes?: ConsumptionSpike[];
}): HeatingSimulationResult {
  const selectedHourIds = new Set(selectedHeatingHourIds);
  const spikesByHour = new Map(spikes.map((spike) => [spike.hour, spike]));
  const forecast: HourlyHeatingForecast[] = [];
  const violations = new Set<string>();
  const temperatureDifference = currentTopTemperature - currentBottomTemperature;
  let temperature =
    currentWeightedTemperature ??
    getWeightedTemperatureFromSensors(currentTopTemperature, currentBottomTemperature);
  let minimumPredictedTemperature = temperature;
  const currentShowers = calculateStratifiedShowersLeft({
    bottomTemperature: currentBottomTemperature,
    fullTankAverageTemperature: settings.fullTankAverageTemperature,
    fullTankShowers: settings.fullTankShowers,
    maxTankTemperature: settings.maxTankTemperature,
    minTankTemperature: settings.absoluteMinimumTemperature,
    topTemperature: currentTopTemperature,
  }).showersLeft;
  let minimumPredictedShowersLeft = currentShowers;
  let largestSpike: HeatingSimulationResult["largestSpike"] = null;
  let totalCost = 0;

  for (const hour of hours) {
    const helsinkiHour = getHelsinkiHourNumber(hour.date);
    const hourlyDrop =
      hourlyDrops[helsinkiHour] ?? fallbackHourlyTemperatureDrop;
    const segmentHours = Number.isFinite(hour.segmentHours)
      ? clamp(hour.segmentHours, 0, 1)
      : 1;
    const appliedDrop = hourlyDrop * segmentHours;
    const isHeatingSelected = selectedHourIds.has(hour.id);
    const heatingGain = isHeatingSelected
      ? heatingGainPerHour * segmentHours
      : 0;
    const temperatureBefore = temperature;
    const temperatureBeforeHeating = temperatureBefore - appliedDrop;
    const {
      bottomTemperature: bottomTemperatureBeforeHeating,
      topTemperature: topTemperatureBeforeHeating,
    } = getStratifiedTemperaturesFromWeightedTemperature({
      temperatureDifference,
      weightedTemperature: temperatureBeforeHeating,
    });
    const showersLeftBefore = calculateStratifiedShowersLeft({
      bottomTemperature: bottomTemperatureBeforeHeating,
      fullTankAverageTemperature: settings.fullTankAverageTemperature,
      fullTankShowers: settings.fullTankShowers,
      maxTankTemperature: settings.maxTankTemperature,
      minTankTemperature: settings.absoluteMinimumTemperature,
      topTemperature: topTemperatureBeforeHeating,
    }).showersLeft;
    const spike = spikesByHour.get(helsinkiHour) ?? null;
    const violatedSpikeReserve = false;

    temperature = temperatureBeforeHeating + heatingGain;
    const {
      bottomTemperature: bottomTemperatureAfter,
      topTemperature: topTemperatureAfter,
    } = getStratifiedTemperaturesFromWeightedTemperature({
      temperatureDifference,
      weightedTemperature: temperature,
    });

    if (isHeatingSelected) {
      totalCost += hour.price;
    }

    const showersLeftAfter = calculateStratifiedShowersLeft({
      bottomTemperature: bottomTemperatureAfter,
      fullTankAverageTemperature: settings.fullTankAverageTemperature,
      fullTankShowers: settings.fullTankShowers,
      maxTankTemperature: settings.maxTankTemperature,
      minTankTemperature: settings.absoluteMinimumTemperature,
      topTemperature: topTemperatureAfter,
    }).showersLeft;
    const violatedReserve =
      showersLeftBefore < settings.safetyShowerReserve ||
      showersLeftAfter < settings.safetyShowerReserve;
    const violatedAbsoluteSafety =
      temperatureBefore < settings.absoluteMinimumTemperature ||
      temperatureBeforeHeating < settings.absoluteMinimumTemperature ||
      temperature < settings.absoluteMinimumTemperature;

    if (violatedReserve) {
      violations.add("safety shower reserve would be violated");
    }

    if (violatedAbsoluteSafety) {
      violations.add("absolute temperature safety limit would be violated");
    }

    if (!largestSpike || (spike && spike.drop > largestSpike.drop)) {
      if (spike) {
        largestSpike = {
          drop: spike.drop,
          hour: spike.hour,
          requiredShowersBefore: spike.requiredShowersBefore,
          showersLeftBefore,
          startDate: hour.startDate,
          temperatureBefore: temperatureBeforeHeating,
        };
      }
    }

    minimumPredictedTemperature = Math.min(
      minimumPredictedTemperature,
      temperatureBefore,
      temperatureBeforeHeating,
      temperature,
    );
    minimumPredictedShowersLeft = Math.min(
      minimumPredictedShowersLeft,
      showersLeftBefore,
      showersLeftAfter,
    );
    forecast.push({
      appliedDrop,
      bottomTemperatureAfter,
      bottomTemperatureBeforeHeating,
      heatingGain,
      helsinkiHour,
      hourlyDrop,
      isHeatingSelected,
      showersLeftAfter,
      showersLeftBefore,
      segmentHours,
      startDate: hour.startDate,
      temperatureAfter: temperature,
      temperatureBefore,
      temperatureBeforeHeating,
      topTemperatureAfter,
      topTemperatureBeforeHeating,
      violatedAbsoluteSafety,
      violatedReserve,
      violatedSpikeReserve,
    });
  }

  const finalShowersLeft =
    forecast[forecast.length - 1]?.showersLeftAfter ??
    minimumPredictedShowersLeft;

  if (finalShowersLeft < settings.targetShowerReserve) {
    violations.add("target shower reserve would not be restored");
  }

  return {
    forecast,
    largestSpike,
    minimumPredictedShowersLeft,
    minimumPredictedTemperature,
    selectedHeatingHourIds,
    totalCost,
    valid: violations.size === 0,
    violations: [...violations],
  };
}

export function optimizeHeatingPlan({
  currentBottomTemperature,
  currentTopTemperature,
  currentWeightedTemperature,
  heatingGainPerHour,
  hourlyDrops,
  hours,
  settings,
  tankReadings = [],
}: {
  currentBottomTemperature: number;
  currentTopTemperature: number;
  currentWeightedTemperature?: number;
  heatingGainPerHour?: number;
  hourlyDrops: HourlyTemperatureDropProfile;
  hours: HeatingOptimizationHour[];
  settings: HeatingOptimizationSettings;
  tankReadings?: TankTemperatureReading[];
}): HeatingOptimizationResult {
  const sortedHours = [...hours].sort(
    (first, second) => first.date.getTime() - second.date.getTime(),
  );
  const heatingGainEstimate =
    typeof heatingGainPerHour === "number" && Number.isFinite(heatingGainPerHour)
      ? {
          acceptedSegmentCount: 0,
          bottomGainPerHour: null,
          discoveredSegmentCount: 0,
          fallbackUsed: false,
          gainPerHour: heatingGainPerHour,
          rejectedSegmentCount: 0,
          sampleCount: 0,
          samples: [],
          topGainPerHour: null,
        }
      : estimateHeatingGainPerHour(
          tankReadings,
          settings.fallbackHeatingGainPerHour,
        );
  const spikes = detectConsumptionSpikes(hourlyDrops, settings);
  const maxHeatingHours = Math.min(settings.maxHeatingHours, sortedHours.length);
  const rejectedShifts: RejectedShift[] = [];
  let bestResult: HeatingSimulationResult | null = null;
  let bestInvalidResult: HeatingSimulationResult | null = null;
  let firstValidSelectionCount: number | null = null;
  const validCombinationCountsBySelectionCount: Record<number, number> = {};

  for (let selectionCount = 0; selectionCount <= maxHeatingHours; selectionCount += 1) {
    let bestResultForSelectionCount: HeatingSimulationResult | null = null;
    let validCombinationCount = 0;

    createCombinations(sortedHours.length, selectionCount, (selectedIndexes) => {
      const selectedHeatingHourIds = selectedIndexes.map(
        (index) => sortedHours[index].id,
      );
      const result = simulateHeatingPlan({
        currentBottomTemperature,
        currentTopTemperature,
        currentWeightedTemperature,
        heatingGainPerHour: heatingGainEstimate.gainPerHour,
        hourlyDrops,
        hours: sortedHours,
        selectedHeatingHourIds,
        settings,
        spikes,
      });

      if (!result.valid) {
        const minimumShowersLeftBeforeNextHeating = Math.min(
          ...result.forecast
            .filter((item) => !item.isHeatingSelected)
            .map((item) => item.showersLeftAfter),
          result.minimumPredictedShowersLeft,
        );

        rejectedShifts.push({
          minimumShowersLeftBeforeNextHeating,
          reason: result.violations.join("; "),
          selectedHeatingHourIds,
        });
        bestInvalidResult =
          !bestInvalidResult ||
          result.minimumPredictedShowersLeft >
            bestInvalidResult.minimumPredictedShowersLeft
            ? result
            : bestInvalidResult;
        return;
      }

      const resultCost = getCombinationCost(sortedHours, selectedIndexes);
      validCombinationCount += 1;

      if (
        !bestResultForSelectionCount ||
        resultCost < bestResultForSelectionCount.totalCost
      ) {
        bestResultForSelectionCount = {
          ...result,
          totalCost: resultCost,
        };
      }
    });

    validCombinationCountsBySelectionCount[selectionCount] =
      validCombinationCount;

    if (bestResultForSelectionCount) {
      firstValidSelectionCount = selectionCount;
      bestResult = bestResultForSelectionCount;
      break;
    }
  }

  const finalResult =
    bestResult ??
    bestInvalidResult ??
    simulateHeatingPlan({
      currentBottomTemperature,
      currentTopTemperature,
      currentWeightedTemperature,
      heatingGainPerHour: heatingGainEstimate.gainPerHour,
      hourlyDrops,
      hours: sortedHours,
      selectedHeatingHourIds: [],
      settings,
      spikes,
    });

  return {
    ...finalResult,
    diagnostics: {
      firstValidSelectionCount,
      forecast: finalResult.forecast,
      heatingGainEstimate: {
        fallbackUsed: heatingGainEstimate.fallbackUsed,
        gainPerHour: heatingGainEstimate.gainPerHour,
      },
      largestSpike: finalResult.largestSpike,
      minimumPredictedShowersLeft: finalResult.minimumPredictedShowersLeft,
      minimumPredictedTemperature: finalResult.minimumPredictedTemperature,
      rejectedShifts,
      selectedPlanCost: finalResult.totalCost,
      selectedHeatingHourIds: finalResult.selectedHeatingHourIds,
      validCombinationCountsBySelectionCount,
    },
    heatingGainEstimate,
    spikes,
  };
}
