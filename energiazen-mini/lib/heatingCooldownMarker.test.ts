import assert from "node:assert/strict";

import {
  buildCooldownPriceSnapshot,
  getCooldownBlockedHeatingHourId,
} from "./heatingCooldownMarker";
import type { HeatingOptimizationHour } from "./heatingOptimizer";

function createHour(
  id: string,
  start: string,
  price = 1,
): HeatingOptimizationHour {
  const date = new Date(start);

  return {
    date,
    endDate: new Date(date.getTime() + 60 * 60 * 1000),
    id,
    isCurrentHour: id === "current" || id === "first-03",
    price,
    segmentHours: 1,
    startDate: start,
  };
}

export function runHeatingCooldownMarkerUnitTests() {
  const currentHour = createHour("current", "2025-01-15T10:00:00+02:00");
  const nextHour = createHour("next", "2025-01-15T11:00:00+02:00");
  const pastHour = createHour("past", "2025-01-15T02:00:00+02:00", 0.5);
  const baseOptimizerHours = [currentHour, nextHour];
  const basePriceHours = [pastHour, currentHour, nextHour];
  const baseBackendValidation = {
    health_status: "healthy",
    last_validated_plan_at: "2025-01-15T08:29:30.000Z",
    validated_plan_date: "2025-01-15",
    validated_tank_reading_at: "2025-01-15T08:29:00.000Z",
    validated_price_snapshot: buildCooldownPriceSnapshot(
      basePriceHours,
      "2025-01-15",
      "2025-01-16",
    ),
    validated_plan_fingerprint: "2025-01-15|10",
    validated_planned_hours: [10],
  };
  const baseInput = {
    backendValidation: baseBackendValidation,
    isCurrentlyHeating: true,
    now: new Date("2025-01-15T10:30:00+02:00"),
    optimizerHours: baseOptimizerHours,
    priceHours: basePriceHours,
    optimizerReadingCreatedAt: "2025-01-15T08:29:00.000Z",
    optimizerSelectedHourIds: [currentHour.id, nextHour.id],
    storedTodayHours: [10],
    todayPlanDate: "2025-01-15",
    tomorrowPlanDate: "2025-01-16",
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
    "an app reading different from the backend validated tank snapshot must suppress the marker",
  );
  assert.equal(
    getCooldownBlockedHeatingHourId({
      ...baseInput,
      backendValidation: {
        ...baseBackendValidation,
        validated_tank_reading_at: "2025-01-15T08:29:31.000Z",
      },
    }),
    null,
    "a newer backend tank snapshot than the app optimizer input must suppress the marker",
  );
  const appPriceChangedHours = [
    pastHour,
    currentHour,
    createHour("next", "2025-01-15T11:00:00+02:00", 2),
  ];
  assert.equal(
    getCooldownBlockedHeatingHourId({
      ...baseInput,
      priceHours: appPriceChangedHours,
    }),
    null,
    "a price snapshot different from the backend validated optimizer input must suppress the marker",
  );
  assert.equal(
    getCooldownBlockedHeatingHourId({
      ...baseInput,
      backendValidation: {
        ...baseBackendValidation,
        validated_price_snapshot: null,
      },
    }),
    null,
    "missing backend price identity must fail closed",
  );
  const changedPastMinimumPriceHours = [
    createHour("past", "2025-01-15T02:00:00+02:00", 0.25),
    currentHour,
    nextHour,
  ];
  assert.equal(
    getCooldownBlockedHeatingHourId({
      ...baseInput,
      priceHours: changedPastMinimumPriceHours,
    }),
    null,
    "a changed already-ended daily-minimum price must suppress the marker",
  );

  const firstRepeatedHour = createHour(
    "first-03",
    "2025-10-26T03:00:00+03:00",
  );
  const secondRepeatedHour = createHour(
    "second-03",
    "2025-10-26T03:00:00+02:00",
  );
  const repeatedHours = [firstRepeatedHour, secondRepeatedHour];
  assert.equal(
    getCooldownBlockedHeatingHourId({
      ...baseInput,
      backendValidation: {
        health_status: "healthy",
        last_validated_plan_at: "2025-10-26T00:29:30.000Z",
        validated_plan_date: "2025-10-26",
        validated_tank_reading_at: "2025-10-26T00:29:00.000Z",
        validated_price_snapshot: buildCooldownPriceSnapshot(
          repeatedHours,
          "2025-10-26",
          "2025-10-27",
        ),
        validated_plan_fingerprint: "2025-10-26|3",
        validated_planned_hours: [3],
      },
      now: new Date("2025-10-26T03:30:00+03:00"),
      optimizerHours: repeatedHours,
      priceHours: repeatedHours,
      optimizerReadingCreatedAt: "2025-10-26T00:29:00.000Z",
      optimizerSelectedHourIds: [firstRepeatedHour.id, secondRepeatedHour.id],
      storedTodayHours: [3],
      todayPlanDate: "2025-10-26",
      tomorrowPlanDate: "2025-10-27",
    }),
    null,
    "the second repeated Helsinki 03:00 is already represented by the stored hour",
  );
}
