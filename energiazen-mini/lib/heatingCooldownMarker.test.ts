import assert from "node:assert/strict";

import { getCooldownBlockedHeatingHourId } from "./heatingCooldownMarker";
import type { HeatingOptimizationHour } from "./heatingOptimizer";

function createHour(id: string, start: string): HeatingOptimizationHour {
  const date = new Date(start);

  return {
    date,
    endDate: new Date(date.getTime() + 60 * 60 * 1000),
    id,
    isCurrentHour: id === "current" || id === "first-03",
    price: 1,
    segmentHours: 1,
    startDate: start,
  };
}

export function runHeatingCooldownMarkerUnitTests() {
  const currentHour = createHour("current", "2025-01-15T10:00:00+02:00");
  const nextHour = createHour("next", "2025-01-15T11:00:00+02:00");
  const baseBackendValidation = {
    health_status: "healthy",
    last_validated_plan_at: "2025-01-15T08:29:30.000Z",
    validated_plan_date: "2025-01-15",
    validated_plan_fingerprint: "2025-01-15|10",
    validated_planned_hours: [10],
  };
  const baseInput = {
    backendValidation: baseBackendValidation,
    isCurrentlyHeating: true,
    now: new Date("2025-01-15T10:30:00+02:00"),
    optimizerHours: [currentHour, nextHour],
    optimizerReadingCreatedAt: "2025-01-15T08:29:00.000Z",
    optimizerSelectedHourIds: [currentHour.id, nextHour.id],
    storedTodayHours: [10],
    todayPlanDate: "2025-01-15",
    topTemperature: 50,
  };

  assert.equal(
    getCooldownBlockedHeatingHourId(baseInput),
    nextHour.id,
    "the optimizer-selected adjacent hour should be marked when cooldown removed it",
  );
  assert.equal(
    getCooldownBlockedHeatingHourId({
      ...baseInput,
      backendValidation: {
        ...baseBackendValidation,
        validated_plan_fingerprint: "2025-01-15|10,11",
        validated_planned_hours: [10, 11],
      },
      storedTodayHours: [10, 11],
    }),
    null,
    "an already-planned next hour must keep its normal heating marker",
  );
  assert.equal(
    getCooldownBlockedHeatingHourId({ ...baseInput, topTemperature: 49.9 }),
    null,
    "cooldown must not block below the 50 degree safety threshold",
  );
  assert.equal(
    getCooldownBlockedHeatingHourId({
      ...baseInput,
      isCurrentlyHeating: false,
    }),
    null,
    "cooldown must not be diagnosed when heating is inactive",
  );
  assert.equal(
    getCooldownBlockedHeatingHourId({
      ...baseInput,
      optimizerReadingCreatedAt: "2025-01-15T08:29:31.000Z",
    }),
    null,
    "a tank reading newer than backend validation must suppress the marker",
  );

  const firstRepeatedHour = createHour(
    "first-03",
    "2025-10-26T03:00:00+03:00",
  );
  const secondRepeatedHour = createHour(
    "second-03",
    "2025-10-26T03:00:00+02:00",
  );
  assert.equal(
    getCooldownBlockedHeatingHourId({
      ...baseInput,
      backendValidation: {
        health_status: "healthy",
        last_validated_plan_at: "2025-10-26T00:29:30.000Z",
        validated_plan_date: "2025-10-26",
        validated_plan_fingerprint: "2025-10-26|3",
        validated_planned_hours: [3],
      },
      now: new Date("2025-10-26T03:30:00+03:00"),
      optimizerHours: [firstRepeatedHour, secondRepeatedHour],
      optimizerReadingCreatedAt: "2025-10-26T00:29:00.000Z",
      optimizerSelectedHourIds: [firstRepeatedHour.id, secondRepeatedHour.id],
      storedTodayHours: [3],
      todayPlanDate: "2025-10-26",
    }),
    null,
    "the second repeated Helsinki 03:00 is already represented by the stored hour",
  );
}
