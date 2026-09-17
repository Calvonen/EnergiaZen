import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useSettingsScenario } from "./settingsScenarioContext";
import { supabase } from "./supabase";
import {
  buildV2HomeReservePresentation,
  type V2HomeReserveSnapshot,
} from "./v2HomeReservePresentation";

const refreshIntervalMs = 60_000;

export function useV2HomeReserve() {
  const { persistedSettings } = useSettingsScenario();
  const recommendedPreheatPercent = persistedSettings.v2TargetReservePercent;
  const [snapshot, setSnapshot] = useState<V2HomeReserveSnapshot | null>(null);
  const [pendingLocalRecommendation, setPendingLocalRecommendation] = useState(false);
  const requestGenerationRef = useRef(0);
  const previousRecommendationRef = useRef(recommendedPreheatPercent);
  const pendingBaselineRunAtRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const requestGeneration = ++requestGenerationRef.current;
    const { data, error } = await supabase.rpc("get_v2_energy_reserve_home");

    if (requestGeneration !== requestGenerationRef.current) {
      return;
    }

    if (error) {
      setSnapshot(null);
      return;
    }

    const row = Array.isArray(data) ? data[0] ?? null : data;
    setSnapshot((row ?? null) as V2HomeReserveSnapshot | null);
  }, []);

  // A recommendation change after this hook has mounted is a committed local
  // Settings change, not a fresh-install default. Keep that just-saved value
  // authoritative while the RPC may still expose an older last-good shadow
  // row. Record the row we had at save time so an unchanged stale snapshot
  // cannot acknowledge the new setting accidentally.
  useEffect(() => {
    if (previousRecommendationRef.current === recommendedPreheatPercent) {
      return;
    }

    previousRecommendationRef.current = recommendedPreheatPercent;
    pendingBaselineRunAtRef.current = snapshot?.run_at ?? null;
    setPendingLocalRecommendation(true);
    void refresh();
  }, [recommendedPreheatPercent, refresh, snapshot?.run_at]);

  // Release the local override only after shadow telemetry has advanced beyond
  // the row visible when the save happened and reports the same recommendation.
  // Fresh-install hydration never enters this pending state, so authoritative
  // backend telemetry still wins over a local 90% default there.
  useEffect(() => {
    if (!pendingLocalRecommendation) {
      return;
    }

    const telemetryRecommendation = snapshot?.recommended_preheat_percent;
    const runAt = snapshot?.run_at ?? null;
    const baselineRunAt = pendingBaselineRunAtRef.current;
    const telemetryAdvanced =
      baselineRunAt === null
        ? runAt !== null
        : runAt !== null && Date.parse(runAt) > Date.parse(baselineRunAt);

    if (
      telemetryAdvanced &&
      telemetryRecommendation === recommendedPreheatPercent
    ) {
      pendingBaselineRunAtRef.current = null;
      setPendingLocalRecommendation(false);
    }
  }, [pendingLocalRecommendation, recommendedPreheatPercent, snapshot]);

  useEffect(() => {
    void refresh();
    const intervalId = setInterval(() => void refresh(), refreshIntervalMs);

    return () => {
      clearInterval(intervalId);
      // Invalidate any request that belongs to the unmounted/obsolete effect.
      requestGenerationRef.current += 1;
    };
  }, [refresh]);

  return useMemo(
    () =>
      buildV2HomeReservePresentation(
        snapshot,
        Date.now(),
        recommendedPreheatPercent,
        pendingLocalRecommendation,
      ),
    [pendingLocalRecommendation, recommendedPreheatPercent, snapshot],
  );
}
