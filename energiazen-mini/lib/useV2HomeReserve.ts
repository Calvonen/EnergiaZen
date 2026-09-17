import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useSettingsScenario } from "./settingsScenarioContext";
import { supabase } from "./supabase";
import {
  buildV2HomeReservePresentation,
  type V2HomeReserveSnapshot,
} from "./v2HomeReservePresentation";
import {
  getPendingV2Recommendation,
  isPendingV2RecommendationAcknowledged,
  persistPendingV2Recommendation,
} from "./v2RecommendationSaveBaseline";

const refreshIntervalMs = 60_000;

export function useV2HomeReserve() {
  const { persistedSettings } = useSettingsScenario();
  const recommendedPreheatPercent = persistedSettings.v2TargetReservePercent;
  const [snapshot, setSnapshot] = useState<V2HomeReserveSnapshot | null>(null);
  const [, setPendingRevision] = useState(0);
  const requestGenerationRef = useRef(0);

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

  // A successful Settings save persists a pending recommendation marker that
  // survives component remounts and app restarts. Clear it only when a shadow
  // row created after that save confirms the same recommendation. Until then,
  // buildV2HomeReservePresentation applies the same precedence to every caller.
  useEffect(() => {
    const pending = getPendingV2Recommendation();
    if (
      !pending ||
      !isPendingV2RecommendationAcknowledged({
        pending,
        runAt: snapshot?.run_at,
        telemetryRecommendation: snapshot?.recommended_preheat_percent,
      })
    ) {
      return;
    }

    void persistPendingV2Recommendation(null)
      .catch(() => {
        // The in-memory marker is already cleared; a later successful settings
        // load/save can clean up a stale durable marker.
      })
      .finally(() => setPendingRevision((revision) => revision + 1));
  }, [snapshot]);

  useEffect(() => {
    void refresh();
  }, [recommendedPreheatPercent, refresh]);

  useEffect(() => {
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
      ),
    [recommendedPreheatPercent, snapshot],
  );
}
