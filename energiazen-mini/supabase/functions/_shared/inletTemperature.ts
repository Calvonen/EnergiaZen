import type { TankTemperatureReading } from "./tankTemperatureForecast";

// Plausible range for a cold-water inlet sensor. Readings outside this are
// almost certainly a disconnected/faulty sensor rather than a real
// measurement, and are excluded before any further processing.
export const MIN_VALID_INLET_TEMPERATURE_C = 1;
export const MAX_VALID_INLET_TEMPERATURE_C = 30;

// A candidate minimum is confirmed by another valid reading within this
// many minutes of it (in either direction) - not just the immediately
// adjacent sample - since the inlet can genuinely drop several degrees
// within a single one-minute sampling interval when water starts flowing.
const CONFIRMATION_WINDOW_MINUTES = 3;

// The confirming reading may be up to this many degrees warmer than the
// candidate (it's expected to still be on the way down, or just past the
// bottom of the dip) but never colder - a colder nearby reading would mean
// *that* reading is the better candidate, and it gets checked in its own
// right since candidates are tried from lowest to highest.
const MAX_CONFIRMATION_WARMER_DELTA_C = 2;

type InletReadingSample = {
  createdAt: string;
  inletTemperatureC: number;
};

export function isValidInletTemperature(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_VALID_INLET_TEMPERATURE_C &&
    value <= MAX_VALID_INLET_TEMPERATURE_C
  );
}

// Valid readings only, sorted chronologically by created_at so the
// confirmation-window walk below can rely on ascending time order and stop
// as soon as it walks past CONFIRMATION_WINDOW_MINUTES.
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

function minutesBetween(aIso: string, bIso: string): number {
  return Math.abs(new Date(bIso).getTime() - new Date(aIso).getTime()) / 60000;
}

function isWithinConfirmationBand(
  neighborValue: number,
  candidateValue: number,
): boolean {
  return (
    neighborValue >= candidateValue &&
    neighborValue <= candidateValue + MAX_CONFIRMATION_WARMER_DELTA_C
  );
}

// Whether samples[index] is confirmed by some other reading within
// CONFIRMATION_WINDOW_MINUTES of it (walking outward in both directions
// through the time-sorted samples, stopping as soon as the elapsed time
// exceeds the window - two readings that are adjacent only because
// everything between them was filtered out, but are actually far apart in
// real time, are correctly never treated as "nearby").
function isConfirmedLow(samples: InletReadingSample[], index: number) {
  const candidate = samples[index];

  for (let i = index - 1; i >= 0; i--) {
    if (minutesBetween(samples[i].createdAt, candidate.createdAt) >
      CONFIRMATION_WINDOW_MINUTES) {
      break;
    }
    if (
      isWithinConfirmationBand(
        samples[i].inletTemperatureC,
        candidate.inletTemperatureC,
      )
    ) {
      return true;
    }
  }

  for (let i = index + 1; i < samples.length; i++) {
    if (minutesBetween(candidate.createdAt, samples[i].createdAt) >
      CONFIRMATION_WINDOW_MINUTES) {
      break;
    }
    if (
      isWithinConfirmationBand(
        samples[i].inletTemperatureC,
        candidate.inletTemperatureC,
      )
    ) {
      return true;
    }
  }

  return false;
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
 * A single isolated low reading is not trusted as the minimum, but a real,
 * fast cold-water dip is not rejected either: the inlet can genuinely drop
 * several degrees within one sampling interval once water starts flowing.
 * Instead of requiring the immediately adjacent reading to be within a
 * tight tolerance, a candidate is accepted once some other valid reading
 * within CONFIRMATION_WINDOW_MINUTES of it is no more than
 * MAX_CONFIRMATION_WARMER_DELTA_C degrees warmer (never colder - a colder
 * nearby reading is itself a better candidate, and gets tried first).
 * Candidates are checked from lowest to highest, so this returns the
 * lowest value that clears that bar, or null if no valid reading is ever
 * confirmed (including when there are fewer than two valid readings at
 * all).
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
    if (isConfirmedLow(samples, index)) {
      return samples[index].inletTemperatureC;
    }
  }

  return null;
}
