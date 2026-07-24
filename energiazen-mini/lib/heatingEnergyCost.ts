export const heatingEnergyCostSettings = {
  gridAndTaxCentsPerKwh: 8.22,
  heaterPowerKw: 3.0,
  spotMarginCentsPerKwh: 0.4,
};

export type HeatingEnergyCostSettings = typeof heatingEnergyCostSettings;

export type HeatingPriceInterval = {
  endDate: Date | string;
  price?: number | null;
  startDate: Date | string;
};

function toTimestamp(value: Date | string) {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();

  return Number.isFinite(timestamp) ? timestamp : null;
}

function getTotalCentsPerKwh(
  spotPriceCentsPerKwh: number | null | undefined,
  settings: HeatingEnergyCostSettings,
) {
  if (
    typeof spotPriceCentsPerKwh !== "number" ||
    !Number.isFinite(spotPriceCentsPerKwh)
  ) {
    return null;
  }

  return (
    spotPriceCentsPerKwh +
    settings.spotMarginCentsPerKwh +
    settings.gridAndTaxCentsPerKwh
  );
}

export function calculateTotalElectricityPriceCentsPerKwh(
  spotPriceCentsPerKwh: number,
  settings: HeatingEnergyCostSettings = heatingEnergyCostSettings,
) {
  const total = getTotalCentsPerKwh(spotPriceCentsPerKwh, settings);

  return total === null ? null : Math.round(total * 10_000) / 10_000;
}

export function calculateHeatingCostEuros({
  energyKwh,
  settings = heatingEnergyCostSettings,
  spotPriceCentsPerKwh,
}: {
  energyKwh: number;
  settings?: HeatingEnergyCostSettings;
  spotPriceCentsPerKwh?: number | null;
}) {
  const totalCentsPerKwh = getTotalCentsPerKwh(
    spotPriceCentsPerKwh,
    settings,
  );

  if (!Number.isFinite(energyKwh) || totalCentsPerKwh === null) {
    return null;
  }

  return (energyKwh * totalCentsPerKwh) / 100;
}

export function calculatePlannedHeatingHourCostEuros({
  durationHours = 1,
  settings = heatingEnergyCostSettings,
  spotPriceCentsPerKwh,
}: {
  durationHours?: number;
  settings?: HeatingEnergyCostSettings;
  spotPriceCentsPerKwh?: number | null;
}) {
  if (!Number.isFinite(durationHours)) {
    return null;
  }

  return calculateHeatingCostEuros({
    energyKwh: settings.heaterPowerKw * durationHours,
    settings,
    spotPriceCentsPerKwh,
  });
}

export function calculatePlannedHeatingPlanCostEuros({
  hours,
  settings = heatingEnergyCostSettings,
}: {
  hours: { price?: number | null }[];
  settings?: HeatingEnergyCostSettings;
}) {
  if (hours.length === 0) {
    return 0;
  }

  return hours.reduce<number | null>((sum, hour) => {
    const cost = calculatePlannedHeatingHourCostEuros({
      settings,
      spotPriceCentsPerKwh: hour.price,
    });

    return sum === null || cost === null ? null : sum + cost;
  }, 0);
}

export function calculateHeatingPeriodCostEuros({
  endedAt,
  priceIntervals,
  settings = heatingEnergyCostSettings,
  startedAt,
}: {
  endedAt: Date | string;
  priceIntervals: HeatingPriceInterval[];
  settings?: HeatingEnergyCostSettings;
  startedAt: Date | string;
}) {
  const periodStart = toTimestamp(startedAt);
  const periodEnd = toTimestamp(endedAt);

  if (periodStart === null || periodEnd === null || periodEnd <= periodStart) {
    return 0;
  }

  let coveredMs = 0;
  let costEuros = 0;

  for (const interval of priceIntervals) {
    const intervalStart = toTimestamp(interval.startDate);
    const intervalEnd = toTimestamp(interval.endDate);

    if (intervalStart === null || intervalEnd === null || intervalEnd <= intervalStart) {
      continue;
    }

    const overlapStart = Math.max(periodStart, intervalStart);
    const overlapEnd = Math.min(periodEnd, intervalEnd);

    if (overlapEnd <= overlapStart) {
      continue;
    }

    const overlapMs = overlapEnd - overlapStart;
    const overlapHours = overlapMs / (60 * 60 * 1000);
    const segmentCost = calculatePlannedHeatingHourCostEuros({
      durationHours: overlapHours,
      settings,
      spotPriceCentsPerKwh: interval.price,
    });

    if (segmentCost === null) {
      return null;
    }

    coveredMs += overlapMs;
    costEuros += segmentCost;
  }

  return coveredMs >= periodEnd - periodStart ? costEuros : null;
}
