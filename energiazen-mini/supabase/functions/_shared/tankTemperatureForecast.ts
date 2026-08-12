import {
  areTimestampsInSameSensorGeometryEpoch,
  filterToLatestSensorGeometryEpoch,
} from "./energyModelV2/sensorGeometry.ts";

export type TankTemperatureReading = {
  created_at?: string | null;
  top_temp?: number | null;
  bottom_temp?: number | null;
  inlet_temp?: number | null;
  heating?: boolean | null;
};

export type HourlyTemperatureDropProfile = Record<number, number>;

export const fallbackHourlyTemperatureDrop = 0.25;

const maxReadingIntervalMinutes = 30;
const tomorrowShiftReasonFragment = "siirrettiin huomiseen";

type ForecastHeatingStartCandidate = {
  date: Date;
  status?: "completed" | "planned" | "missed";
};

const helsinkiHourFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  hour12: false,
  timeZone: "Europe/Helsinki",
});
const helsinkiDateFormatter = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Europe/Helsinki",
  year: "numeric",
});

function getHelsinkiHourNumber(date: Date) {
  const hour = Number(helsinkiHourFormatter.format(date));

  return hour === 24 ? 0 : hour;
}

function getHelsinkiDateKey(date: Date) {
  return helsinkiDateFormatter.format(date);
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

function createFallbackProfile(value: number) {
  return Object.fromEntries(
    Array.from({ length: 24 }, (_, hour) => [hour, value]),
  ) as HourlyTemperatureDropProfile;
}

export function getCurrentWeightedTemperature(
  topTemperature: number | null,
  bottomTemperature: number | null,
) {
  if (
    typeof topTemperature !== "number" ||
    typeof bottomTemperature !== "number" ||
    !Number.isFinite(topTemperature) ||
    !Number.isFinite(bottomTemperature)
  ) {
    return null;
  }

  return topTemperature * 0.7 + bottomTemperature * 0.3;
}

export function buildHourlyTemperatureDropProfile(
  readings: TankTemperatureReading[],
) {
  return buildHourlyTemperatureDropProfileResult(readings).hourlyDrops;
}

export function buildHourlyTemperatureDropProfileResult(
  readings: TankTemperatureReading[],
) {
  const dayHourDrops = new Map<string, { drop: number; hour: number }>();
  const sortedReadings = filterToLatestSensorGeometryEpoch(readings).sort((a, b) => {
    const firstTime = a.created_at ? new Date(a.created_at).getTime() : NaN;
    const secondTime = b.created_at ? new Date(b.created_at).getTime() : NaN;

    return firstTime - secondTime;
  });

  for (let index = 1; index < sortedReadings.length; index += 1) {
    const previous = sortedReadings[index - 1];
    const current = sortedReadings[index];
    const previousDate = previous.created_at
      ? new Date(previous.created_at)
      : null;
    const currentDate = current.created_at ? new Date(current.created_at) : null;
    const previousTemperature = getWeightedTemperature(previous);
    const currentTemperature = getWeightedTemperature(current);

    if (
      !previousDate ||
      !currentDate ||
      Number.isNaN(previousDate.getTime()) ||
      Number.isNaN(currentDate.getTime()) ||
      previousTemperature === null ||
      currentTemperature === null ||
      !areTimestampsInSameSensorGeometryEpoch(
        previous.created_at ?? "",
        current.created_at ?? "",
      ) ||
      // Only an explicitly confirmed heating=false pair is a trustworthy
      // "just cooling" observation - true is excluded as before, but so is
      // an unreadable Shelly status (heating: null): it must not be
      // silently treated as "not heating" and folded into the drop rate.
      previous.heating !== false ||
      current.heating !== false
    ) {
      continue;
    }

    const intervalMinutes =
      (currentDate.getTime() - previousDate.getTime()) / (60 * 1000);

    if (intervalMinutes <= 0 || intervalMinutes > maxReadingIntervalMinutes) {
      continue;
    }

    const temperatureDrop = previousTemperature - currentTemperature;

    if (temperatureDrop <= 0) {
      continue;
    }

    const hour = getHelsinkiHourNumber(previousDate);
    const dayHourKey = `${getHelsinkiDateKey(previousDate)}:${hour}`;
    const currentDayHourDrop = dayHourDrops.get(dayHourKey);

    dayHourDrops.set(dayHourKey, {
      drop: (currentDayHourDrop?.drop ?? 0) + temperatureDrop,
      hour,
    });
  }

  const dayHourDropSums = [...dayHourDrops.values()];
  const generalMedian =
    getMedian(dayHourDropSums.map((item) => item.drop)) ??
    fallbackHourlyTemperatureDrop;
  const dropsByHour = Array.from({ length: 24 }, (_, hour) =>
    dayHourDropSums
      .filter((item) => item.hour === hour)
      .map((item) => item.drop),
  );

  const hourlyDrops = Object.fromEntries(
    dropsByHour.map((drops, hour) => [
      hour,
      getMedian(drops) ?? generalMedian,
    ]),
  ) as HourlyTemperatureDropProfile;

  return { generalFallback: generalMedian, hourlyDrops };
}

export function predictWeightedTemperature({
  currentTemperature,
  from,
  hourlyDropProfile,
  to,
}: {
  currentTemperature: number;
  from: Date;
  hourlyDropProfile: HourlyTemperatureDropProfile;
  to: Date;
}) {
  if (
    !Number.isFinite(currentTemperature) ||
    Number.isNaN(from.getTime()) ||
    Number.isNaN(to.getTime()) ||
    to.getTime() <= from.getTime()
  ) {
    return currentTemperature;
  }

  let predictedTemperature = currentTemperature;
  let cursor = new Date(from);

  while (cursor.getTime() < to.getTime()) {
    const hour = getHelsinkiHourNumber(cursor);
    const minutesUntilNextHour =
      60 - cursor.getMinutes() - cursor.getSeconds() / 60;
    const nextHour = new Date(
      cursor.getTime() + minutesUntilNextHour * 60 * 1000,
    );
    const segmentEnd =
      nextHour.getTime() < to.getTime() ? nextHour : new Date(to);
    const segmentHours =
      (segmentEnd.getTime() - cursor.getTime()) / (60 * 60 * 1000);
    const hourlyDrop =
      hourlyDropProfile[hour] ?? fallbackHourlyTemperatureDrop;

    predictedTemperature -= hourlyDrop * segmentHours;
    cursor = segmentEnd;
  }

  return predictedTemperature;
}

export function getForecastHeatingHours({
  currentHeatingHours,
  isFixedHeatingNeed = false,
  predictedTemperature,
  settingsHeatingHoursPerDay,
}: {
  currentHeatingHours: number;
  isFixedHeatingNeed?: boolean;
  predictedTemperature: number;
  settingsHeatingHoursPerDay: number;
}) {
  if (isFixedHeatingNeed) {
    return currentHeatingHours;
  }

  let forecastHours = currentHeatingHours;

  if (predictedTemperature < 50) {
    forecastHours = 3;
  } else if (predictedTemperature < 65) {
    forecastHours = 2;
  }

  return Math.max(
    currentHeatingHours,
    Math.min(settingsHeatingHoursPerDay, currentHeatingHours + 1, forecastHours),
  );
}

export function isHeatingShiftedToTomorrow(reason: string) {
  return reason.includes(tomorrowShiftReasonFragment);
}

function getFirstFutureHeatingStart(
  hours: ForecastHeatingStartCandidate[],
  currentTime: Date,
) {
  return [...hours]
    .filter(
      (item) =>
        item.date.getTime() > currentTime.getTime() &&
        (item.status === undefined || item.status === "planned"),
    )
    .sort((a, b) => a.date.getTime() - b.date.getTime())[0]?.date ?? null;
}

export function getForecastTargetHeatingStart({
  currentTime,
  isShiftedToTomorrow,
  preliminaryTodayHeatingHours,
  tomorrowHeatingHours,
}: {
  currentTime: Date;
  isShiftedToTomorrow: boolean;
  preliminaryTodayHeatingHours: ForecastHeatingStartCandidate[];
  tomorrowHeatingHours: ForecastHeatingStartCandidate[];
}) {
  const firstFutureTodayHeatingStart = getFirstFutureHeatingStart(
    preliminaryTodayHeatingHours,
    currentTime,
  );
  const firstFutureTomorrowHeatingStart = getFirstFutureHeatingStart(
    tomorrowHeatingHours,
    currentTime,
  );

  if (isShiftedToTomorrow) {
    return firstFutureTomorrowHeatingStart;
  }

  return firstFutureTodayHeatingStart ?? firstFutureTomorrowHeatingStart;
}

export function getFallbackTemperatureDropProfile() {
  return createFallbackProfile(fallbackHourlyTemperatureDrop);
}
