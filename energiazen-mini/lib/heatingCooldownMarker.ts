import type { HeatingOptimizationHour } from "./heatingOptimizer";
import { getFinnishDateKey, getHelsinkiHourNumber } from "./heatingLogic";

export const postHeatingCooldownSafetyTopTemperature = 50;
export const backendOptimizerValidationMaxAgeMs = 90 * 60 * 1000;

export type BackendHeatingOptimizerValidation = {
  health_status: string | null;
  last_validated_plan_at: string | null;
  validated_plan_date: string | null;
  validated_tank_reading_at: string | null;
  validated_plan_fingerprint: string | null;
  validated_planned_hours: unknown;
};

function normalizePlanHours(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return [...new Set(value.filter((hour) => Number.isInteger(hour)))]
    .map(Number)
    .sort((first, second) => first - second);
}

function buildPlanFingerprint(planDate: string, plannedHours: unknown) {
  const hours = normalizePlanHours(plannedHours);
  return /^\d{4}-\d{2}-\d{2}$/.test(planDate) && hours
    ? `${planDate}|${hours.join(",")}`
    : null;
}

export function isBackendValidationCurrentForCooldown({
  backendValidation,
  now,
  optimizerReadingCreatedAt,
  storedTodayHours,
  todayPlanDate,
}: {
  backendValidation: BackendHeatingOptimizerValidation | null;
  now: Date;
  optimizerReadingCreatedAt: string | null;
  storedTodayHours: number[];
  todayPlanDate: string;
}): boolean {
  if (!backendValidation || backendValidation.health_status !== "healthy") {
    return false;
  }

  const validationAt = Date.parse(
    backendValidation.last_validated_plan_at ?? "",
  );
  const readingAt = Date.parse(optimizerReadingCreatedAt ?? "");
  const validatedTankReadingAt = Date.parse(
    backendValidation.validated_tank_reading_at ?? "",
  );
  const nowMs = now.getTime();
  if (
    !Number.isFinite(validationAt) ||
    !Number.isFinite(readingAt) ||
    !Number.isFinite(validatedTankReadingAt) ||
    validationAt > nowMs ||
    nowMs - validationAt > backendOptimizerValidationMaxAgeMs ||
    validatedTankReadingAt !== readingAt ||
    backendValidation.validated_plan_date !== todayPlanDate
  ) {
    return false;
  }

  const normalizedStoredHours = normalizePlanHours(storedTodayHours);
  const normalizedValidatedHours = normalizePlanHours(
    backendValidation.validated_planned_hours,
  );
  if (
    !normalizedStoredHours ||
    !normalizedValidatedHours ||
    JSON.stringify(normalizedStoredHours) !==
      JSON.stringify(normalizedValidatedHours)
  ) {
    return false;
  }

  return (
    backendValidation.validated_plan_fingerprint ===
    buildPlanFingerprint(todayPlanDate, normalizedStoredHours)
  );
}

export function getCooldownBlockedHeatingHourId({
  backendValidation,
  isCurrentlyHeating,
  now,
  optimizerHours,
  optimizerReadingCreatedAt,
  optimizerSelectedHourIds,
  storedTodayHours,
  todayPlanDate,
  topTemperature,
}: {
  backendValidation: BackendHeatingOptimizerValidation | null;
  isCurrentlyHeating: boolean;
  now: Date;
  optimizerHours: HeatingOptimizationHour[];
  optimizerReadingCreatedAt: string | null;
  optimizerSelectedHourIds: string[];
  storedTodayHours: number[];
  todayPlanDate: string;
  topTemperature: number | null;
}): string | null {
  if (
    !isCurrentlyHeating ||
    topTemperature === null ||
    topTemperature < postHeatingCooldownSafetyTopTemperature ||
    !isBackendValidationCurrentForCooldown({
      backendValidation,
      now,
      optimizerReadingCreatedAt,
      storedTodayHours,
      todayPlanDate,
    })
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
