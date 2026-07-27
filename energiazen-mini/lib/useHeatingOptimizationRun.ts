import { useEffect, useMemo, useRef, useState } from "react";

import {
  createHeatingOptimizationSettings,
  HeatingOptimizationHour,
  HeatingOptimizationResult,
  optimizeHeatingPlan,
} from "./heatingOptimizer";
import {
  createHeatingOptimizationInputKey,
  createHeatingOptimizationRunController,
  HeatingOptimizationInputSnapshot,
  materializeHeatingOptimizationHours,
  shouldRunHeatingOptimization,
} from "./heatingOptimizationRun";
import { publishLatestHeatingPlan } from "./heatingPlanPublication";
import type { PublishedHeatingPlanState } from "./heatingPlanPublication";
import type { EnergiaZenSettings } from "./settings";

export type HeatingOptimizationRunState = PublishedHeatingPlanState<
  HeatingOptimizationResult,
  HeatingOptimizationHour
> & {
  appSettings: EnergiaZenSettings;
  todayPlanDate: string | null;
  tomorrowPlanDate: string | null;
};

export type UseHeatingOptimizationRunOptions = Omit<
  HeatingOptimizationInputSnapshot,
  "settings"
> & {
  appSettings: EnergiaZenSettings;
  fallbackHeatingGainPerHour: number;
  isEnabled: boolean;
  todayPlanDate: string | null;
  tomorrowPlanDate: string | null;
};

export function useHeatingOptimizationRun({
  appSettings,
  currentBottomTemperature,
  currentTopTemperature,
  currentWeightedTemperature,
  fallbackHeatingGainPerHour,
  heatingHistory,
  hourlyDrops,
  hours,
  isCurrentlyHeating,
  isEnabled,
  manualRefreshRevision,
  mode,
  readingCreatedAt,
  todayPlanDate,
  tomorrowPlanDate,
}: UseHeatingOptimizationRunOptions): HeatingOptimizationRunState & {
  result: HeatingOptimizationResult | null;
} {
  const optimizationSettings = useMemo(
    () =>
      createHeatingOptimizationSettings(appSettings, fallbackHeatingGainPerHour),
    [appSettings, fallbackHeatingGainPerHour],
  );
  const snapshot: HeatingOptimizationInputSnapshot = useMemo(
    () => ({
      currentBottomTemperature,
      currentTopTemperature,
      currentWeightedTemperature,
      heatingHistory,
      hourlyDrops,
      hours,
      isCurrentlyHeating,
      manualRefreshRevision,
      mode,
      readingCreatedAt,
      settings: optimizationSettings,
    }),
    [
      currentBottomTemperature,
      currentTopTemperature,
      currentWeightedTemperature,
      heatingHistory,
      hourlyDrops,
      hours,
      isCurrentlyHeating,
      manualRefreshRevision,
      mode,
      optimizationSettings,
      readingCreatedAt,
    ],
  );
  const inputKey = useMemo(
    () => createHeatingOptimizationInputKey(snapshot),
    [snapshot],
  );
  const controllerRef = useRef(createHeatingOptimizationRunController());
  const [state, setState] = useState<HeatingOptimizationRunState>({
    appSettings,
    hours: [],
    inputKey: "",
    result: null,
    runId: 0,
    todayPlanDate: null,
    tomorrowPlanDate: null,
  });

  useEffect(() => {
    const controller = controllerRef.current;
    const runId = controller.start(inputKey);

    if (runId === null) {
      return;
    }

    const acceptedRunId = runId;
    const runHours = materializeHeatingOptimizationHours(
      snapshot.hours,
      new Date(),
    );

    async function runOptimization() {
      let result: HeatingOptimizationResult | null = null;

      if (
        shouldRunHeatingOptimization({
          currentBottomTemperature: snapshot.currentBottomTemperature,
          currentTopTemperature: snapshot.currentTopTemperature,
          currentWeightedTemperature: snapshot.currentWeightedTemperature,
          hoursCount: runHours.length,
          isEnabled,
          mode: snapshot.mode,
        })
      ) {
        result = await Promise.resolve().then(() =>
          optimizeHeatingPlan({
            currentBottomTemperature: snapshot.currentBottomTemperature as number,
            currentTopTemperature: snapshot.currentTopTemperature as number,
            currentWeightedTemperature:
              snapshot.currentWeightedTemperature as number,
            hourlyDrops: snapshot.hourlyDrops,
            hours: runHours,
            isCurrentlyHeating: snapshot.isCurrentlyHeating,
            settings: snapshot.settings,
            tankReadings: snapshot.heatingHistory,
          }),
        );
      }

      if (!controller.canCommit(acceptedRunId)) {
        return;
      }

      if (result) {
        setState((current) =>
          publishLatestHeatingPlan(current, {
            appSettings,
            hours: runHours,
            inputKey,
            result,
            runId: acceptedRunId,
            todayPlanDate,
            tomorrowPlanDate,
          }),
        );
      }
    }

    void runOptimization();
  }, [
    appSettings,
    inputKey,
    isEnabled,
    snapshot,
    todayPlanDate,
    tomorrowPlanDate,
  ]);

  useEffect(() => () => controllerRef.current.invalidate(), []);

  const result = state.inputKey === inputKey ? state.result : null;

  return { ...state, result };
}
