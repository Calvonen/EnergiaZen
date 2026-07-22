import {
  HourlyTemperatureDropProfile,
  TankTemperatureReading,
} from "./tankTemperatureForecast";

export type HeatingOptimizationHour = {
  date: Date;
  endDate: Date;
  id: string;
  price: number;
  startDate: string;
};

export type HeatingOptimizationSettings = {
  absoluteMinimumTemperature: number;
  fallbackHeatingGainPerHour: number;
  fullTankAverageTemperature: number;
  fullTankShowers: number;
  maxHeatingHours: number;
  minimumShowerReserve: number;
  spikeReserveShowers?: number;
};

export type HeatingOptimizationSettingsSource = {
  fullTankAverageTemperature: number;
  fullTankShowers: number;
  heatingHoursPerDay: number;
  minTankTemperature: number;
  minimumShowersBeforeExpensiveTomorrow: number;
};

export type HeatingGainEstimate = {
  fallbackUsed: boolean;
  gainPerHour: number;
  sampleCount: number;
  samples: number[];
};

export type ConsumptionSpike = {
  drop: number;
  hour: number;
  requiredShowersBefore: number;
};

export type HourlyHeatingForecast = {
  heatingGain: number;
  helsinkiHour: number;
  hourlyDrop: number;
  isHeatingSelected: boolean;
  showersLeftAfter: number;
  showersLeftBefore: number;
  startDate: string;
  temperatureAfter: number;
  temperatureBefore: number;
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

const helsinkiHourFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  hour12: false,
  timeZone: "Europe/Helsinki",
});

function getHelsinkiHourNumber(date: Date) {
  const hour = Number(helsinkiHourFormatter.format(date));

  return hour === 24 ? 0 : hour;
}

function getWeightedTemperature(reading: TankTemperatureReading) {
  if (
    typeof reading.top_temp !== "number" ||
    typeof reading.bottom_temp !== "number" ||
    !Number.isFinite(reading.top_temp) ||
    !Number.isFinite(reading.bottom_temp)
  ) {
    return null;
  }

  return reading.top_temp * 0.7 + reading.bottom_temp * 0.3;
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

export function createHeatingOptimizationSettings(
  settings: HeatingOptimizationSettingsSource,
  fallbackHeatingGainPerHour: number,
): HeatingOptimizationSettings {
  return {
    absoluteMinimumTemperature: settings.minTankTemperature,
    fallbackHeatingGainPerHour,
    fullTankAverageTemperature: settings.fullTankAverageTemperature,
    fullTankShowers: settings.fullTankShowers,
    maxHeatingHours: settings.heatingHoursPerDay,
    minimumShowerReserve: settings.minimumShowersBeforeExpensiveTomorrow,
  };
}

export function estimateHeatingGainPerHour(
  readings: TankTemperatureReading[],
  fallbackHeatingGainPerHour: number,
): HeatingGainEstimate {
  const sortedReadings = [...readings].sort((first, second) =>
    String(first.created_at ?? "").localeCompare(
      String(second.created_at ?? ""),
    ),
  );
  const samples: number[] = [];
  let heatingStart: { temperature: number; time: number } | null = null;
  let previousHeatingReading: { temperature: number; time: number } | null =
    null;

  const closeCurrentHeatingSegment = () => {
    if (!heatingStart || !previousHeatingReading) {
      heatingStart = null;
      previousHeatingReading = null;
      return;
    }

    const durationHours =
      (previousHeatingReading.time - heatingStart.time) / millisecondsPerHour;
    const gain = previousHeatingReading.temperature - heatingStart.temperature;

    if (durationHours >= 0.5 && gain > 0) {
      samples.push(gain / durationHours);
    }

    heatingStart = null;
    previousHeatingReading = null;
  };

  for (const reading of sortedReadings) {
    const time = reading.created_at ? new Date(reading.created_at).getTime() : NaN;
    const temperature = getWeightedTemperature(reading);

    if (!Number.isFinite(time) || temperature === null) {
      continue;
    }

    if (reading.heating === true) {
      if (!heatingStart) {
        heatingStart = { temperature, time };
      }

      previousHeatingReading = { temperature, time };
      continue;
    }

    closeCurrentHeatingSegment();
  }

  closeCurrentHeatingSegment();

  const medianGain = getMedian(samples);

  return {
    fallbackUsed: medianGain === null,
    gainPerHour: medianGain ?? fallbackHeatingGainPerHour,
    sampleCount: samples.length,
    samples,
  };
}

export function detectConsumptionSpikes(
  hourlyDrops: HourlyTemperatureDropProfile,
  settings: Pick<HeatingOptimizationSettings, "minimumShowerReserve" | "spikeReserveShowers">,
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
  const reserveMargin = settings.spikeReserveShowers ?? 0;

  return drops
    .map((drop, hour): ConsumptionSpike | null =>
      drop > threshold
        ? {
            drop,
            hour,
            requiredShowersBefore:
              settings.minimumShowerReserve + reserveMargin,
          }
        : null,
    )
    .filter((item): item is ConsumptionSpike => item !== null)
    .sort((first, second) => second.drop - first.drop);
}

export function simulateHeatingPlan({
  currentWeightedTemperature,
  heatingGainPerHour,
  hourlyDrops,
  hours,
  selectedHeatingHourIds,
  settings,
  spikes = detectConsumptionSpikes(hourlyDrops, settings),
}: {
  currentWeightedTemperature: number;
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
  let temperature = currentWeightedTemperature;
  let minimumPredictedTemperature = currentWeightedTemperature;
  let minimumPredictedShowersLeft = estimateShowersLeftFromWeightedTemperature({
    absoluteMinimumTemperature: settings.absoluteMinimumTemperature,
    fullTankAverageTemperature: settings.fullTankAverageTemperature,
    fullTankShowers: settings.fullTankShowers,
    weightedTemperature: currentWeightedTemperature,
  });
  let largestSpike: HeatingSimulationResult["largestSpike"] = null;
  let totalCost = 0;

  for (const hour of hours) {
    const helsinkiHour = getHelsinkiHourNumber(hour.date);
    const hourlyDrop = hourlyDrops[helsinkiHour] ?? 0;
    const isHeatingSelected = selectedHourIds.has(hour.id);
    const heatingGain = isHeatingSelected ? heatingGainPerHour : 0;
    const temperatureBefore = temperature;
    const showersLeftBefore = estimateShowersLeftFromWeightedTemperature({
      absoluteMinimumTemperature: settings.absoluteMinimumTemperature,
      fullTankAverageTemperature: settings.fullTankAverageTemperature,
      fullTankShowers: settings.fullTankShowers,
      weightedTemperature: temperatureBefore,
    });
    const spike = spikesByHour.get(helsinkiHour) ?? null;
    const violatedSpikeReserve =
      spike !== null &&
      showersLeftBefore < spike.requiredShowersBefore;

    temperature = temperature - hourlyDrop + heatingGain;

    if (isHeatingSelected) {
      totalCost += hour.price;
    }

    const showersLeftAfter = estimateShowersLeftFromWeightedTemperature({
      absoluteMinimumTemperature: settings.absoluteMinimumTemperature,
      fullTankAverageTemperature: settings.fullTankAverageTemperature,
      fullTankShowers: settings.fullTankShowers,
      weightedTemperature: temperature,
    });
    const violatedReserve =
      showersLeftBefore < settings.minimumShowerReserve ||
      showersLeftAfter < settings.minimumShowerReserve;
    const violatedAbsoluteSafety =
      temperatureBefore < settings.absoluteMinimumTemperature ||
      temperature < settings.absoluteMinimumTemperature;

    if (violatedReserve) {
      violations.add("minimum shower reserve would be violated");
    }

    if (violatedAbsoluteSafety) {
      violations.add("absolute temperature safety limit would be violated");
    }

    if (violatedSpikeReserve) {
      violations.add("reserve before consumption spike would be violated");
    }

    if (!largestSpike || (spike && spike.drop > largestSpike.drop)) {
      if (spike) {
        largestSpike = {
          drop: spike.drop,
          hour: spike.hour,
          requiredShowersBefore: spike.requiredShowersBefore,
          showersLeftBefore,
          startDate: hour.startDate,
          temperatureBefore,
        };
      }
    }

    minimumPredictedTemperature = Math.min(
      minimumPredictedTemperature,
      temperatureBefore,
      temperature,
    );
    minimumPredictedShowersLeft = Math.min(
      minimumPredictedShowersLeft,
      showersLeftBefore,
      showersLeftAfter,
    );
    forecast.push({
      heatingGain,
      helsinkiHour,
      hourlyDrop,
      isHeatingSelected,
      showersLeftAfter,
      showersLeftBefore,
      startDate: hour.startDate,
      temperatureAfter: temperature,
      temperatureBefore,
      violatedAbsoluteSafety,
      violatedReserve,
      violatedSpikeReserve,
    });
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
  currentWeightedTemperature,
  heatingGainPerHour,
  hourlyDrops,
  hours,
  settings,
  tankReadings = [],
}: {
  currentWeightedTemperature: number;
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
          fallbackUsed: false,
          gainPerHour: heatingGainPerHour,
          sampleCount: 0,
          samples: [],
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
