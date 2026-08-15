import {
  fallbackHourlyTemperatureDrop,
  HourlyTemperatureDropProfile,
  TankTemperatureReading,
} from "./tankTemperatureForecast.ts";
import { estimateHeatingGainPerHour } from "./heatingGain.ts";
import type { HeatingGainEstimate } from "./heatingGain.ts";

export { estimateHeatingGainPerHour } from "./heatingGain.ts";
export type { HeatingGainEstimate } from "./heatingGain.ts";

export type HeatingOptimizationHour = {
  date: Date;
  endDate: Date;
  id: string;
  isCurrentHour: boolean;
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
  // Optional so every existing call site that builds this object directly
  // (bypassing createHeatingOptimizationSettings) keeps compiling unchanged.
  // optimizeHeatingPlan treats a missing value as 0 (today's behaviour).
  priceToleranceCents?: number;
  safetyShowerReserve: number;
  targetShowerReserve: number;
};

export type HeatingOptimizationSettingsSource = {
  fullTankAverageTemperature: number;
  fullTankShowers: number;
  automaticMaxHeatingHours: number;
  maxTankTemperature?: number;
  minTankTemperature: number;
  // See HeatingOptimizationSettings.priceToleranceCents - same "missing = 0" rule.
  priceToleranceCents?: number;
  safetyShowerReserve: number;
  targetShowerReserve: number;
};

export type StratifiedShowersEstimate = {
  energyTemperatureRange: number;
  energyRatio: number;
  fillRatio: number;
  fullTankTemp: number;
  minimumUsableTopTemperature: number;
  showersLeft: number;
  topUsability: number;
  topUsabilityTemperatureRange: number;
  weightedTemperature: number;
};

export type StratifiedShowerLimitingFactor = {
  factor: "balanced" | "energyRatio" | "topUsability";
  value: number;
};

export function getStratifiedShowerLimitingFactor(
  estimate: Pick<StratifiedShowersEstimate, "energyRatio" | "topUsability">,
): StratifiedShowerLimitingFactor {
  if (estimate.energyRatio < estimate.topUsability) {
    return { factor: "energyRatio", value: estimate.energyRatio };
  }

  if (estimate.topUsability < estimate.energyRatio) {
    return { factor: "topUsability", value: estimate.topUsability };
  }

  return { factor: "balanced", value: estimate.energyRatio };
}

export type ConsumptionSpike = {
  drop: number;
  hour: number;
  requiredShowersBefore: number;
};

export type HourlyHeatingForecast = {
  bottomTemperatureAfter: number;
  bottomTemperatureBeforeHeating: number;
  appliedDrop: number;
  effectiveDrop: number;
  heatingGain: number;
  helsinkiHour: number;
  hourlyDrop: number;
  isHeatingSelected: boolean;
  isRecoveryHour: boolean;
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

export type HeatingStartFillRatioDiagnostic = {
  alreadyHeatingAtSegmentStart: boolean;
  blockedByStartFillRatio: boolean;
  candidateHour: string;
  projectedFillRatioBeforeHeating: number;
  projectedShowersBeforeHeating: number;
  selected: boolean;
};

export type HeatingSimulationResult = {
  finalShowersLeft: number;
  forecast: HourlyHeatingForecast[];
  heatingStartFillRatioDiagnostics: HeatingStartFillRatioDiagnostic[];
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
  targetCheckShowersLeft: number;
  targetCheckTime: string | null;
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
    currentFillRatio: number;
    currentShowers: number;
    currentHourStartBlockedByFillRatio: boolean;
    forecast: HourlyHeatingForecast[];
    fullTankShowers: number;
    heatingGainEstimate: Pick<
      HeatingGainEstimate,
      "fallbackUsed" | "gainPerHour"
    >;
    heatingStartFillRatioDiagnostics: HeatingStartFillRatioDiagnostic[];
    largestSpike: HeatingSimulationResult["largestSpike"];
    minimumPredictedShowersLeft: number;
    minimumPredictedTemperature: number;
    rejectedShifts: RejectedShift[];
    selectedPlanCost: number;
    startHeatingThresholdShowers: number;
    selectedHeatingHourIds: string[];
    validCombinationCountsBySelectionCount: Record<number, number>;
  };
  heatingGainEstimate: HeatingGainEstimate;
  spikes: ConsumptionSpike[];
};

const millisecondsPerHour = 60 * 60 * 1000;
export const startHeatingFillRatio = 0.9;

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

function getSelectedHoursCost(
  hours: HeatingOptimizationHour[],
  selectedHeatingHourIds: string[],
) {
  const selectedIds = new Set(selectedHeatingHourIds);

  return hours.reduce(
    (sum, hour) => (selectedIds.has(hour.id) ? sum + hour.price : sum),
    0,
  );
}

function getMinimumPrice(hours: HeatingOptimizationHour[]) {
  return hours.reduce(
    (minimum, hour) => Math.min(minimum, hour.price),
    Number.POSITIVE_INFINITY,
  );
}

// price tolerance / hintojen tasoitus: hours priced within `priceToleranceCents`
// of the window's cheapest hour are treated as equally cheap for the purpose
// of RANKING optionalHours combinations against each other. This never
// changes hour.price itself (real electricity_prices values, and everything
// reported to the UI/DB, stay untouched) - it only changes which combination
// optimizeHeatingPlan considers "the cheapest" when several are tied under
// tolerance.
function getEffectivePrice(
  price: number,
  minimumPrice: number,
  priceToleranceCents: number,
) {
  return price <= minimumPrice + priceToleranceCents ? minimumPrice : price;
}

function getSelectedHoursEffectiveCost(
  hours: HeatingOptimizationHour[],
  selectedHeatingHourIds: string[],
  minimumPrice: number,
  priceToleranceCents: number,
) {
  const selectedIds = new Set(selectedHeatingHourIds);

  return hours.reduce(
    (sum, hour) =>
      selectedIds.has(hour.id)
        ? sum + getEffectivePrice(hour.price, minimumPrice, priceToleranceCents)
        : sum,
    0,
  );
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
    energyTemperatureRange,
    energyRatio,
    fillRatio,
    fullTankTemp,
    minimumUsableTopTemperature,
    showersLeft,
    topUsability,
    topUsabilityTemperatureRange,
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
    priceToleranceCents: settings.priceToleranceCents ?? 0,
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

// A minimal, opt-in override for the hour immediately following a heating
// hour: when recovery is off (the default), this always returns hourlyDrop,
// so simulateHeatingPlan's output is unchanged. See docs/PROJECT_CONTEXT.md's
// heating-gain notes for why this hour behaves differently from a resting hour.
export function getEffectiveDrop({
  hourlyDrop,
  isRecoveryHour,
  recoveryDropEnabled,
  recoveryDropPerHour,
}: {
  hourlyDrop: number;
  isRecoveryHour: boolean;
  recoveryDropEnabled: boolean;
  recoveryDropPerHour?: number;
}) {
  if (
    !recoveryDropEnabled ||
    !isRecoveryHour ||
    typeof recoveryDropPerHour !== "number" ||
    !Number.isFinite(recoveryDropPerHour)
  ) {
    return hourlyDrop;
  }

  return recoveryDropPerHour;
}

export function simulateHeatingPlan({
  currentBottomTemperature,
  currentTopTemperature,
  currentWeightedTemperature,
  heatingGainPerHour,
  hourlyDrops,
  hours,
  isCurrentlyHeating = false,
  recoveryDropEnabled = false,
  recoveryDropPerHour,
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
  isCurrentlyHeating?: boolean;
  recoveryDropEnabled?: boolean;
  recoveryDropPerHour?: number;
  selectedHeatingHourIds: string[];
  settings: HeatingOptimizationSettings;
  spikes?: ConsumptionSpike[];
}): HeatingSimulationResult {
  const selectedHourIds = new Set(selectedHeatingHourIds);
  const spikesByHour = new Map(spikes.map((spike) => [spike.hour, spike]));
  const forecast: HourlyHeatingForecast[] = [];
  const heatingStartFillRatioDiagnostics: HeatingStartFillRatioDiagnostic[] = [];
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
  let previousHourEndTime: number | null = null;
  let wasHeatingAtPreviousSegmentEnd: boolean = false;
  let lastSelectedShowersLeftAfter: number | null = null;
  let lastSelectedHourEndTime: string | null = null;

  for (const hour of hours) {
    const helsinkiHour = getHelsinkiHourNumber(hour.date);
    const hourlyDrop =
      hourlyDrops[helsinkiHour] ?? fallbackHourlyTemperatureDrop;
    const segmentHours = Number.isFinite(hour.segmentHours)
      ? clamp(hour.segmentHours, 0, 1)
      : 1;
    const isHeatingSelected = selectedHourIds.has(hour.id);
    const temperatureBefore = temperature;
    const {
      bottomTemperature: bottomTemperatureAtSegmentStart,
      topTemperature: topTemperatureAtSegmentStart,
    } = getStratifiedTemperaturesFromWeightedTemperature({
      temperatureDifference,
      weightedTemperature: temperatureBefore,
    });
    const projectedShowersBeforeHeating = calculateStratifiedShowersLeft({
      bottomTemperature: bottomTemperatureAtSegmentStart,
      fullTankAverageTemperature: settings.fullTankAverageTemperature,
      fullTankShowers: settings.fullTankShowers,
      maxTankTemperature: settings.maxTankTemperature,
      minTankTemperature: settings.absoluteMinimumTemperature,
      topTemperature: topTemperatureAtSegmentStart,
    }).showersLeft;
    const projectedFillRatioBeforeHeating =
      settings.fullTankShowers > 0
        ? projectedShowersBeforeHeating / settings.fullTankShowers
        : Number.POSITIVE_INFINITY;
    const alreadyHeatingAtSegmentStart: boolean = hour.isCurrentHour
      ? isCurrentlyHeating
      : wasHeatingAtPreviousSegmentEnd &&
        previousHourEndTime === hour.date.getTime();
    const blockedByStartFillRatio: boolean =
      projectedFillRatioBeforeHeating >= startHeatingFillRatio &&
      !alreadyHeatingAtSegmentStart;
    const heatingApplied: boolean =
      isHeatingSelected && !blockedByStartFillRatio;
    // Recovery only covers the one hour immediately after a selected heating
    // hour ends, not a hour that is itself heating - reuses the same
    // contiguity check as alreadyHeatingAtSegmentStart above.
    const isRecoveryHour: boolean =
      !heatingApplied &&
      wasHeatingAtPreviousSegmentEnd &&
      previousHourEndTime === hour.date.getTime();
    const effectiveDrop = getEffectiveDrop({
      hourlyDrop,
      isRecoveryHour,
      recoveryDropEnabled,
      recoveryDropPerHour,
    });
    const appliedDrop = effectiveDrop * segmentHours;
    const heatingGain = heatingApplied
      ? heatingGainPerHour * segmentHours
      : 0;

    heatingStartFillRatioDiagnostics.push({
      alreadyHeatingAtSegmentStart,
      blockedByStartFillRatio,
      candidateHour: hour.id,
      projectedFillRatioBeforeHeating,
      projectedShowersBeforeHeating,
      selected: isHeatingSelected,
    });

    if (isHeatingSelected && blockedByStartFillRatio) {
      violations.add("heating start fill ratio would be exceeded");
    }

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

    // Clamp a HEATED hour's result to the same "full tank" reference
    // calculateStratifiedShowersLeft uses for its energyRatio/topUsability
    // ceiling below - otherwise heating an already (near) full tank keeps
    // pushing this weighted temperature past what's physically possible. The
    // overshoot is invisible in that hour's own showersLeft (already clamped
    // there), but it would otherwise carry forward uncapped into later
    // hours' drop calculations, making the tank look like it cools from a
    // higher-than-achievable starting point - i.e. crediting a heating hour
    // for capacity the tank was never able to hold, without recognizing that
    // a second contiguous heating hour is doing effectively nothing.
    //
    // Only applies when heatingApplied: fullTankAverageTemperature and
    // maxTankTemperature are independently configurable (e.g. a 70C "full"
    // reference under an 80C hard max), so an UNHEATED hour's temperature
    // can legitimately sit above the reference already (a real sensor
    // reading, or simply the previous hour's own already-legitimate value) -
    // clamping it down there too would discard real stored heat from every
    // later forecast hour. Math.max(...) with temperatureBeforeHeating below
    // guards the heated case the same way: never reduce below where the
    // hour started, only cap what heating adds on top of it.
    temperature = heatingApplied
      ? Math.min(
          temperatureBeforeHeating + heatingGain,
          Math.max(temperatureBeforeHeating, settings.fullTankAverageTemperature),
        )
      : temperatureBeforeHeating;
    const {
      bottomTemperature: bottomTemperatureAfter,
      topTemperature: topTemperatureAfter,
    } = getStratifiedTemperaturesFromWeightedTemperature({
      temperatureDifference,
      weightedTemperature: temperature,
    });

    if (heatingApplied) {
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
    if (isHeatingSelected) {
      lastSelectedShowersLeftAfter = showersLeftAfter;
      lastSelectedHourEndTime = hour.endDate.toISOString();
    }

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
      effectiveDrop,
      heatingGain,
      helsinkiHour,
      hourlyDrop,
      isHeatingSelected,
      isRecoveryHour,
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
    previousHourEndTime = hour.endDate.getTime();
    wasHeatingAtPreviousSegmentEnd = heatingApplied;
  }

  const finalShowersLeft =
    forecast[forecast.length - 1]?.showersLeftAfter ??
    minimumPredictedShowersLeft;

  // The target moment is right after the last SELECTED heating hour, not the
  // end of the whole (up to ~30h, spanning into tomorrow) simulation
  // horizon. Otherwise an otherwise-sound plan fails validity purely because
  // of decay that happens long after the last hour it was ever asked to
  // cover. With no heating hours selected at all, the target still applies
  // to the end of the horizon (unchanged "no heating needed" behaviour).
  const targetCheckShowersLeft =
    lastSelectedShowersLeftAfter !== null
      ? lastSelectedShowersLeftAfter
      : finalShowersLeft;
  const targetCheckTime = lastSelectedHourEndTime;

  if (targetCheckShowersLeft < settings.targetShowerReserve) {
    violations.add("target shower reserve would not be restored");
  }

  return {
    finalShowersLeft,
    forecast,
    heatingStartFillRatioDiagnostics,
    largestSpike,
    minimumPredictedShowersLeft,
    minimumPredictedTemperature,
    selectedHeatingHourIds,
    targetCheckShowersLeft,
    targetCheckTime,
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
  isCurrentlyHeating = false,
  recoveryDropEnabled = false,
  recoveryDropPerHour,
  settings,
  tankReadings = [],
}: {
  currentBottomTemperature: number;
  currentTopTemperature: number;
  currentWeightedTemperature?: number;
  heatingGainPerHour?: number;
  hourlyDrops: HourlyTemperatureDropProfile;
  hours: HeatingOptimizationHour[];
  isCurrentlyHeating?: boolean;
  recoveryDropEnabled?: boolean;
  recoveryDropPerHour?: number;
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
          segmentDiscovery: {
            acceptedSegmentCount: 0,
            acceptedWithWarningsSegmentCount: 0,
            discoveredSegmentCount: 0,
            rejectedSegments: [],
            rejectedSegmentCount: 0,
            rejectionReasonCounts: {},
            segments: [],
            warningReasonCounts: {},
          },
          topGainPerHour: null,
        }
      : estimateHeatingGainPerHour(
          tankReadings,
          settings.fallbackHeatingGainPerHour,
        );
  const spikes = detectConsumptionSpikes(hourlyDrops, settings);
  const currentShowers = calculateStratifiedShowersLeft({
    bottomTemperature: currentBottomTemperature,
    fullTankAverageTemperature: settings.fullTankAverageTemperature,
    fullTankShowers: settings.fullTankShowers,
    maxTankTemperature: settings.maxTankTemperature,
    minTankTemperature: settings.absoluteMinimumTemperature,
    topTemperature: currentTopTemperature,
  }).showersLeft;
  const startHeatingThresholdShowers =
    settings.fullTankShowers * startHeatingFillRatio;
  const currentFillRatio =
    settings.fullTankShowers > 0
      ? currentShowers / settings.fullTankShowers
      : 0;
  const hasCurrentHour = sortedHours.some((hour) => hour.isCurrentHour);
  const currentHourStartBlockedByFillRatio =
    hasCurrentHour &&
    !isCurrentlyHeating &&
    currentShowers >= startHeatingThresholdShowers;
  // A hard requirement: if heating is already running this hour, that hour
  // must survive every re-optimization until it ends, so a fresh run can
  // never drop it and cut the running cycle short mid-hour.
  const lockedHours = isCurrentlyHeating
    ? sortedHours.filter((hour) => hour.isCurrentHour)
    : [];
  const lockedHourIds = lockedHours.map((hour) => hour.id);
  const lockedHourIdSet = new Set(lockedHourIds);
  const optionalHours = sortedHours.filter(
    (hour) => !lockedHourIdSet.has(hour.id),
  );
  const maxOptionalHeatingHours = Math.max(
    0,
    Math.min(settings.maxHeatingHours, sortedHours.length) -
      lockedHourIds.length,
  );
  const rejectedShifts: RejectedShift[] = [];
  let bestResult: HeatingSimulationResult | null = null;
  let bestInvalidResult: HeatingSimulationResult | null = null;
  let firstValidSelectionCount: number | null = null;
  const validCombinationCountsBySelectionCount: Record<number, number> = {};
  // See getEffectivePrice's comment: this is the "tarkasteluikkunan alin
  // hinta" the price tolerance band is measured from, computed once over the
  // whole candidate window (same hours the optimizer already considers).
  const minimumPrice = getMinimumPrice(sortedHours);
  const priceToleranceCents = settings.priceToleranceCents ?? 0;

  for (
    let selectionCount = 0;
    selectionCount <= maxOptionalHeatingHours;
    selectionCount += 1
  ) {
    let bestResultForSelectionCount: HeatingSimulationResult | null = null;
    let bestEffectiveCostForSelectionCount = Number.POSITIVE_INFINITY;
    let validCombinationCount = 0;

    createCombinations(optionalHours.length, selectionCount, (selectedIndexes) => {
      const selectedHeatingHourIds = [
        ...lockedHourIds,
        ...selectedIndexes.map((index) => optionalHours[index].id),
      ];
      const result = simulateHeatingPlan({
        currentBottomTemperature,
        currentTopTemperature,
        currentWeightedTemperature,
        heatingGainPerHour: heatingGainEstimate.gainPerHour,
        hourlyDrops,
        hours: sortedHours,
        isCurrentlyHeating,
        recoveryDropEnabled,
        recoveryDropPerHour,
        selectedHeatingHourIds,
        settings,
        spikes,
      });

      if (!result.valid) {
        const selectedStartWasBlocked =
          result.heatingStartFillRatioDiagnostics.some(
            (item) => item.selected && item.blockedByStartFillRatio,
          );
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
        if (!selectedStartWasBlocked) {
          bestInvalidResult =
            !bestInvalidResult ||
            result.minimumPredictedShowersLeft >
              bestInvalidResult.minimumPredictedShowersLeft
              ? result
              : bestInvalidResult;
        }
        return;
      }

      const resultCost = getSelectedHoursCost(sortedHours, selectedHeatingHourIds);
      // Ranking only - never replaces resultCost (the real price, kept in
      // totalCost below for diagnostics/UI/publication) or hour.price
      // anywhere else. Ties under tolerance keep today's tie-break: the
      // first combination found wins (strict "<"), same as before this
      // change - see the price-tolerance design report for why a
      // thermal-aware tie-break is deliberately out of scope here.
      const effectiveCost = getSelectedHoursEffectiveCost(
        sortedHours,
        selectedHeatingHourIds,
        minimumPrice,
        priceToleranceCents,
      );
      validCombinationCount += 1;

      if (
        !bestResultForSelectionCount ||
        effectiveCost < bestEffectiveCostForSelectionCount
      ) {
        bestResultForSelectionCount = {
          ...result,
          totalCost: resultCost,
        };
        bestEffectiveCostForSelectionCount = effectiveCost;
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
      isCurrentlyHeating,
      recoveryDropEnabled,
      recoveryDropPerHour,
      selectedHeatingHourIds: lockedHourIds,
      settings,
      spikes,
    });

  return {
    ...finalResult,
    diagnostics: {
      firstValidSelectionCount,
      currentFillRatio,
      currentShowers,
      currentHourStartBlockedByFillRatio,
      forecast: finalResult.forecast,
      fullTankShowers: settings.fullTankShowers,
      heatingGainEstimate: {
        fallbackUsed: heatingGainEstimate.fallbackUsed,
        gainPerHour: heatingGainEstimate.gainPerHour,
      },
      heatingStartFillRatioDiagnostics:
        finalResult.heatingStartFillRatioDiagnostics.filter(
          (item) => item.selected || item.blockedByStartFillRatio,
        ),
      largestSpike: finalResult.largestSpike,
      minimumPredictedShowersLeft: finalResult.minimumPredictedShowersLeft,
      minimumPredictedTemperature: finalResult.minimumPredictedTemperature,
      rejectedShifts,
      selectedPlanCost: finalResult.totalCost,
      startHeatingThresholdShowers,
      selectedHeatingHourIds: finalResult.selectedHeatingHourIds,
      validCombinationCountsBySelectionCount,
    },
    heatingGainEstimate,
    spikes,
  };
}
