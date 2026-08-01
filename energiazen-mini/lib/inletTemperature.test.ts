import {
  calculateMinimumValidInletTemperature,
  MAX_VALID_INLET_TEMPERATURE_C,
  MIN_VALID_INLET_TEMPERATURE_C,
} from "./inletTemperature";
import { TankTemperatureReading } from "./tankTemperatureForecast";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function reading(
  createdAt: string,
  inletTemperature: number | null | undefined,
): TankTemperatureReading {
  return {
    created_at: createdAt,
    inlet_temp: inletTemperature,
  };
}

function readingsFromMinuteOffsets(
  values: Array<number | null | undefined>,
): TankTemperatureReading[] {
  const start = Date.UTC(2026, 6, 20, 0, 0, 0);

  return values.map((value, index) =>
    reading(new Date(start + index * 60_000).toISOString(), value),
  );
}

export function runInletTemperatureUnitTests() {
  // Normal week minimum: a gradual dip and recovery, minimum reading is
  // corroborated by its neighbors on both sides.
  {
    const readings = readingsFromMinuteOffsets([
      18.2, 15.1, 12.4, 9.8, 8.6, 8.9, 11.2, 14.0, 17.5,
    ]);

    assertEqual(
      calculateMinimumValidInletTemperature(readings),
      8.6,
      "normal week minimum should be the lowest corroborated reading",
    );
  }

  // null values are ignored, not treated as 0 or as invalid-but-present.
  {
    const readings = readingsFromMinuteOffsets([
      10.0,
      null,
      9.5,
      9.4,
      null,
      12.0,
    ]);

    assertEqual(
      calculateMinimumValidInletTemperature(readings),
      9.4,
      "null readings should be excluded, not treated as a low value",
    );
  }

  // NaN / non-finite values are excluded the same way as null.
  {
    const readings = readingsFromMinuteOffsets([10.0, 9.6, 9.5, 12.0]);
    readings.push(reading("2026-07-20T00:05:00.000Z", Number.NaN));
    readings.push(reading("2026-07-20T00:06:00.000Z", Number.POSITIVE_INFINITY));

    assertEqual(
      calculateMinimumValidInletTemperature(readings),
      9.5,
      "NaN/Infinity readings should be excluded from the minimum",
    );
  }

  // Out-of-range values (below MIN or above MAX) are excluded even though
  // they are otherwise well-formed numbers - a disconnected/faulty sensor
  // reading, not a real cold-water measurement.
  {
    const readings = readingsFromMinuteOffsets([
      MIN_VALID_INLET_TEMPERATURE_C - 0.1,
      MAX_VALID_INLET_TEMPERATURE_C + 5,
      11.0,
      10.7,
      13.0,
    ]);

    assertEqual(
      calculateMinimumValidInletTemperature(readings),
      10.7,
      "out-of-range readings should never be selected as the minimum",
    );
  }

  // A single isolated low reading (a spike/glitch) must not be accepted as
  // the minimum - it has no corroborating neighbor within tolerance, so
  // the function should fall through to the lowest reading that *is*
  // corroborated by a neighbor.
  {
    const readings = readingsFromMinuteOffsets([
      20.0, 20.1, 2.0, 19.9, 20.2, 20.0,
    ]);

    const result = calculateMinimumValidInletTemperature(readings);
    assertEqual(
      result === 2.0,
      false,
      "an isolated single low reading must not be returned as the minimum",
    );
    assertEqual(
      result,
      19.9,
      "should fall back to the lowest reading corroborated by a neighbor",
    );
  }

  // Two consecutive low readings close to each other should be accepted:
  // the low level is confirmed, and the lower of the pair is reported.
  {
    const readings = readingsFromMinuteOffsets([
      20.0, 20.1, 5.2, 5.0, 20.3, 20.0,
    ]);

    assertEqual(
      calculateMinimumValidInletTemperature(readings),
      5.0,
      "two consecutive close low readings should confirm the minimum",
    );
  }

  // No valid data at all (empty input, or every reading invalid) returns
  // null rather than throwing or returning a misleading number.
  {
    assertEqual(
      calculateMinimumValidInletTemperature([]),
      null,
      "empty input should return null",
    );

    const readings = readingsFromMinuteOffsets([
      null,
      undefined,
      Number.NaN,
      MAX_VALID_INLET_TEMPERATURE_C + 1,
    ]);

    assertEqual(
      calculateMinimumValidInletTemperature(readings),
      null,
      "input with no valid readings should return null",
    );
  }

  // A single valid reading (no neighbor to corroborate it at all) also
  // returns null - one sample is never enough to trust as the minimum.
  {
    const readings = readingsFromMinuteOffsets([12.5]);

    assertEqual(
      calculateMinimumValidInletTemperature(readings),
      null,
      "a lone valid reading with no neighbor should return null",
    );
  }
}
