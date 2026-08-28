import type { HeatingOptimizationHour } from "./heatingOptimizer";
import { getFinnishDateKey, getHelsinkiHourNumber } from "./heatingLogic";

export const postHeatingCooldownSafetyTopTemperature = 50;

export function getCooldownBlockedHeatingHourId({
  isCurrentlyHeating,
  now,
  optimizerHours,
  optimizerSelectedHourIds,
  storedTodayHours,
  todayPlanDate,
  topTemperature,
}: {
  isCurrentlyHeating: boolean;
  now: Date;
  optimizerHours: HeatingOptimizationHour[];
  optimizerSelectedHourIds: string[];
  storedTodayHours: number[];
  todayPlanDate: string;
  topTemperature: number | null;
}): string | null {
  if (
    !isCurrentlyHeating ||
    topTemperature === null ||
    topTemperature < postHeatingCooldownSafetyTopTemperature
  ) {
    return null;
  }

  const currentHour = optimizerHours.find(
    (hour) =>
      getFinnishDateKey(hour.startDate) === todayPlanDate &&
      hour.date.getTime() <= now.getTime() &&
      hour.endDate.getTime() > now.getTime(),
  );
  if (!currentHour) {
    return null;
  }

  const currentHourNumber = getHelsinkiHourNumber(currentHour.date);
  if (!storedTodayHours.includes(currentHourNumber)) {
    return null;
  }

  const nextHour = optimizerHours.find(
    (hour) => hour.date.getTime() === currentHour.endDate.getTime(),
  );
  if (!nextHour || getFinnishDateKey(nextHour.startDate) !== todayPlanDate) {
    return null;
  }

  const nextHourNumber = getHelsinkiHourNumber(nextHour.date);
  if (storedTodayHours.includes(nextHourNumber)) {
    return null;
  }

  return optimizerSelectedHourIds.includes(nextHour.id) ? nextHour.id : null;
}
