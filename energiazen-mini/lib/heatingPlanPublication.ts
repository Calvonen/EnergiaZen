export type ComparableHeatingPlan = {
  mode?: string | null;
  plan_date?: string | null;
  planned_hours?: unknown;
  target_hours?: number | null;
};

export type PublishedHeatingPlanState<TResult, THour> = {
  hours: THour[];
  inputKey: string;
  result: TResult | null;
  runId: number;
};

export type HeatingOptimizationRunSource = "active" | "scenario";

export function canPublishActiveHeatingPlan({
  isOptimizationCurrent,
  source,
}: {
  isOptimizationCurrent: boolean;
  source: HeatingOptimizationRunSource;
}) {
  return source === "active" && isOptimizationCurrent;
}

export function publishLatestHeatingPlan<
  TState extends PublishedHeatingPlanState<unknown, unknown>,
>(current: TState, next: TState): TState {
  if (!next.result || next.runId <= current.runId) {
    return current;
  }

  return next;
}

function normalizePlanHours(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter((hour) => Number.isInteger(hour)))]
    .map(Number)
    .sort((first, second) => first - second);
}

export function areHeatingPlansOperationallyEqual(
  first: ComparableHeatingPlan | null | undefined,
  second: ComparableHeatingPlan | null | undefined,
) {
  return (
    first?.mode === second?.mode &&
    first?.plan_date === second?.plan_date &&
    first?.target_hours === second?.target_hours &&
    JSON.stringify(normalizePlanHours(first?.planned_hours)) ===
      JSON.stringify(normalizePlanHours(second?.planned_hours))
  );
}

export function getChangedHeatingPlans<T extends ComparableHeatingPlan>(
  currentPlans: Record<string, ComparableHeatingPlan | undefined>,
  nextPlans: T[],
) {
  return nextPlans.filter(
    (plan) =>
      !plan.plan_date ||
      !areHeatingPlansOperationallyEqual(
        currentPlans[plan.plan_date],
        plan,
      ),
  );
}

// While the current hour's heating status is unknown (heating: null, e.g.
// ESP32 couldn't reach Shelly), an unrelated re-optimization must not be
// allowed to drop that hour from what's already published - the Shelly
// controller script turns the relay off the moment its own hour is missing
// from heating_plans, regardless of whether it's actually mid-cycle
// (Codex P1 review, PR #147). This only ever restores an hour that was
// ALREADY published for the current hour; it never adds a new hour, never
// touches any other hour, and never runs once heating is confirmed true or
// false again.
export function preserveCurrentHourWhileHeatingUnknown({
  currentHourNumber,
  heating,
  nextPlannedHours,
  previousPlannedHours,
}: {
  currentHourNumber: number;
  heating: boolean | null;
  nextPlannedHours: number[];
  previousPlannedHours: number[];
}): number[] {
  if (
    heating !== null ||
    !previousPlannedHours.includes(currentHourNumber) ||
    nextPlannedHours.includes(currentHourNumber)
  ) {
    return nextPlannedHours;
  }

  return [...nextPlannedHours, currentHourNumber].sort(
    (first, second) => first - second,
  );
}

export function getHeatingPlanPresentationSource({
  hasPublishedOptimization,
  hasStoredPlan,
}: {
  hasPublishedOptimization: boolean;
  hasStoredPlan: boolean;
}) {
  if (hasPublishedOptimization) {
    return "optimizer" as const;
  }

  if (hasStoredPlan) {
    return "stored" as const;
  }

  return "none" as const;
}
