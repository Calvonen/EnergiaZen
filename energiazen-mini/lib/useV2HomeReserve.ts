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
  const requestGenerationRef = useRef(0);

  // Keep the user setting outside the async RPC response. This means an old
  // request can never restore a recommendation captured before the latest
  // Settings save. The generation guard below also prevents an older request
  // from replacing a newer reserve snapshot if requests overlap.
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
      ),
    [recommendedPreheatPercent, snapshot],
  );
}
