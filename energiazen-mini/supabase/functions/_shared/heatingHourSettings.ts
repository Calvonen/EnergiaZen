export const defaultAutomaticMaxHeatingHours = 3;
export const defaultFixedHeatingHoursPerDay = 3;

function normalizeHeatingHours(value: number | undefined, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(Math.max(Math.round(value), 1), 6)
    : fallback;
}

export function normalizeStoredHeatingHours({
  automaticMaxHeatingHours,
  fixedHeatingHoursPerDay,
  heatingHoursPerDay,
}: {
  automaticMaxHeatingHours?: number;
  fixedHeatingHoursPerDay?: number;
  heatingHoursPerDay?: number;
}) {
  const legacyHeatingHours = normalizeHeatingHours(
    heatingHoursPerDay,
    defaultAutomaticMaxHeatingHours,
  );

  return {
    automaticMaxHeatingHours: normalizeHeatingHours(
      automaticMaxHeatingHours,
      legacyHeatingHours,
    ),
    fixedHeatingHoursPerDay: normalizeHeatingHours(
      fixedHeatingHoursPerDay,
      legacyHeatingHours,
    ),
  };
}
