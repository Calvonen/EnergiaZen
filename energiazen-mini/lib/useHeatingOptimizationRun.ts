import { useEffect, useMemo, useRef, useState } from "react";
import * as Updates from "expo-updates";

import { estimateRecoveryDropPerHour } from "./heatingRecoveryDrop";
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
import { isRecoveryDropEnabledForChannel } from "./recoveryDropEnvironment";
import type { EnergiaZenSettings } from "./settings";

// Development/preview-only rollout while RecoveryDrop is being validated
// with real production data - see docs/PROJECT_CONTEXT.md's heating-gain
// notes and GitHub issue "RecoveryDrop v2". Stays false on every production
// build regardless of this value, because Updates.channel there is
// "production", which isRecoveryDropEnabledForChannel never allows.
const recoveryDropEnabled = isRecoveryDropEnabledForChannel(Updates.channel);

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
  // Both are derived from appSettings inside this hook (see the snapshot
  // useMemo below) rather than being separate caller-supplied inputs.
  "settings" | "heatingGainSource"
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
  recoveryReadings,
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
      heatingGainSource: appSettings.heatingGainSource,
      heatingHistory,
      hourlyDrops,
      hours,
      isCurrentlyHeating,
      manualRefreshRevision,
      mode,
      readingCreatedAt,
      recoveryReadings,
      settings: optimizationSettings,
    }),
    [
      appSettings.heatingGainSource,
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
      recoveryReadings,
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
          now: new Date(),
          readingCreatedAt: snapshot.readingCreatedAt,
        })
      ) {
        result = await Promise.resolve().then(() => {
          const recoveryDropPerHour = recoveryDropEnabled
            ? estimateRecoveryDropPerHour(snapshot.recoveryReadings ?? [])
                .dropPerHour
            : undefined;

          return optimizeHeatingPlan({
            currentBottomTemperature: snapshot.currentBottomTemperature as number,
            currentTopTemperature: snapshot.currentTopTemperature as number,
            currentWeightedTemperature:
              snapshot.currentWeightedTemperature as number,
            // Explicit value bypasses estimateHeatingGainPerHour entirely
            // (see optimizeHeatingPlan) - only set it when the user has
            // chosen to distrust the learned estimate; otherwise leave it
            // undefined so learned-vs-fallback keeps being decided
            // automatically by data availability, as before.
            heatingGainPerHour:
              appSettings.heatingGainSource === "fixed"
                ? fallbackHeatingGainPerHour
                : undefined,
            hourlyDrops: snapshot.hourlyDrops,
            hours: runHours,
            isCurrentlyHeating: snapshot.isCurrentlyHeating,
            recoveryDropEnabled,
            recoveryDropPerHour,
            settings: snapshot.settings,
            tankReadings: snapshot.heatingHistory,
          });
        });
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
