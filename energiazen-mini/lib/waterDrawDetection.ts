// Shared by lib/heatingGain.ts (heating-segment acceptance) and
// lib/heatingRecoveryDrop.ts (post-heating recovery window) - both need to
// tell whether a water draw (shower, tap use) happened during a window of
// tank_readings, using the same inlet-sensor signature.
//
// A stagnant inlet pipe drifts warmer over time (seen on real hardware:
// values climbing steadily over tens of minutes while idle), while a draw
// pulls in genuinely cold mains water - a fast drop is therefore a
// reliable draw signal regardless of the pipe's current baseline
// temperature. That's why this looks for a *relative* drop within a short
// trailing window rather than an absolute threshold.
export const waterDrawDetectionLimits = {
  minDropCelsius: 2,
  windowMinutes: 5,
} as const;

export type InletTemperatureSample = {
  inletTemperatureC: number | null;
  time: number;
};

// True if any sample in orderedSamples (chronological) is at least
// minDropCelsius colder than some earlier sample within windowMinutes of
// it - walking outward from each sample rather than only comparing
// adjacent ones, since a poll gap could otherwise hide a real draw between
// two samples. Samples without a valid inlet reading are simply skipped,
// so callers are judged exactly as if no inlet data were available.
export function detectsWaterDraw(
  orderedSamples: InletTemperatureSample[],
): boolean {
  for (let laterIndex = 1; laterIndex < orderedSamples.length; laterIndex++) {
    const later = orderedSamples[laterIndex];

    if (later.inletTemperatureC === null) {
      continue;
    }

    for (let earlierIndex = laterIndex - 1; earlierIndex >= 0; earlierIndex--) {
      const earlier = orderedSamples[earlierIndex];
      const minutesApart = (later.time - earlier.time) / (60 * 1000);

      if (minutesApart > waterDrawDetectionLimits.windowMinutes) {
        break;
      }
      if (earlier.inletTemperatureC === null) {
        continue;
      }
      if (
        earlier.inletTemperatureC - later.inletTemperatureC >=
        waterDrawDetectionLimits.minDropCelsius
      ) {
        return true;
      }
    }
  }

  return false;
}
