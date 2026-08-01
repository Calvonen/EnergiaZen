import type { TankTemperatureReading } from "./tankTemperatureForecast";

// Plausible range for a cold-water inlet sensor. Readings outside this are
// almost certainly a disconnected/faulty sensor rather than a real
// measurement, and are excluded before any further processing.
export const MIN_VALID_INLET_TEMPERATURE_C = 1;
export const MAX_VALID_INLET_TEMPERATURE_C = 30;

// Two valid readings that are adjacent in time (see getValidOrderedSamples)
// and within this many degrees of each other are treated as confirming the
// same underlying low level.
const CONSECUTIVE_LOW_TOLERANCE_C = 1;

type InletReadingSample = {
  createdAt: string;
  inletTemperatureC: number;
};

function isValidInletTemperature(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_VALID_INLET_TEMPERATURE_C &&
    value <= MAX_VALID_INLET_TEMPERATURE_C
  );
}

// Valid readings only, sorted chronologically. "Adjacent" for the
// consecutive-low check below means adjacent in this filtered list: a
// rejected reading in between two valid ones does not break
// consecutiveness, since the ESP32 already reports invalid readings as
// null/omitted rather than a fabricated number.
function getValidOrderedSamples(
  readings: TankTemperatureReading[],
): InletReadingSample[] {
  return readings
    .filter(
      (reading): reading is TankTemperatureReading & { created_at: string } =>
        typeof reading.created_at === "string" &&
        isValidInletTemperature(reading.inlet_temp),
    )
    .map((reading) => ({
      createdAt: reading.created_at,
      inletTemperatureC: reading.inlet_temp as number,
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Computes the lowest confirmed inlet-water temperature from a set of
 * `tank_readings` rows. Callers are expected to pass rows already scoped to
 * the desired window (e.g. the last 7 days) - this function does not do any
 * date-based filtering itself.
 *
 * Only readings between MIN_VALID_INLET_TEMPERATURE_C and
 * MAX_VALID_INLET_TEMPERATURE_C are considered; null, NaN, and
 * out-of-range values are treated as a missing/faulty reading and ignored.
 *
 * A single isolated low reading is not trusted as the minimum: a genuine
 * cold-water dip lasts multiple sensor samples (the ESP32 reads about once
 * a minute), while a one-off sensor glitch does not. A candidate value is
 * only accepted once at least one neighboring valid reading is within
 * CONSECUTIVE_LOW_TOLERANCE_C degrees of it. Candidates are checked from
 * lowest to highest, so this returns the lowest value that clears that
 * bar - or null if no valid reading is ever corroborated by a neighbor
 * (including when there are fewer than two valid readings at all).
 */
export function calculateMinimumValidInletTemperature(
  readings: TankTemperatureReading[],
): number | null {
  const samples = getValidOrderedSamples(readings);

  if (samples.length < 2) {
    return null;
  }

  const indexesByAscendingValue = samples
    .map((_, index) => index)
    .sort(
      (a, b) => samples[a].inletTemperatureC - samples[b].inletTemperatureC,
    );

  for (const index of indexesByAscendingValue) {
    const value = samples[index].inletTemperatureC;
    const previous = samples[index - 1];
    const next = samples[index + 1];

    const confirmedByPrevious =
      previous !== undefined &&
      Math.abs(previous.inletTemperatureC - value) <=
        CONSECUTIVE_LOW_TOLERANCE_C;
    const confirmedByNext =
      next !== undefined &&
      Math.abs(next.inletTemperatureC - value) <= CONSECUTIVE_LOW_TOLERANCE_C;

    if (confirmedByPrevious || confirmedByNext) {
      return value;
    }
  }

  return null;
}
