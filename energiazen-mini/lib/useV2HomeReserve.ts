import { useCallback, useEffect, useState } from "react";

import { useSettingsScenario } from "./settingsScenarioContext";
import { supabase } from "./supabase";
import {
  buildV2HomeReservePresentation,
  type V2HomeReservePresentation,
  type V2HomeReserveSnapshot,
} from "./v2HomeReservePresentation";

const refreshIntervalMs = 60_000;

function buildUnavailablePresentation(
  recommendedPreheatPercent: number,
): V2HomeReservePresentation {
  return buildV2HomeReservePresentation(
    null,
    Date.now(),
    recommendedPreheatPercent,
  );
}

export function useV2HomeReserve() {
  const { persistedSettings } = useSettingsScenario();
  const recommendedPreheatPercent = persistedSettings.v2TargetReservePercent;
  const [presentation, setPresentation] = useState<V2HomeReservePresentation>(
    () => buildUnavailablePresentation(recommendedPreheatPercent),
  );

  const refresh = useCallback(async () => {
    const { data, error } = await supabase.rpc("get_v2_energy_reserve_home");
    if (error) {
      setPresentation(buildUnavailablePresentation(recommendedPreheatPercent));
      return;
    }

    const row = Array.isArray(data) ? data[0] ?? null : data;
    setPresentation(
      buildV2HomeReservePresentation(
        (row ?? null) as V2HomeReserveSnapshot | null,
        Date.now(),
        recommendedPreheatPercent,
      ),
    );
  }, [recommendedPreheatPercent]);

  useEffect(() => {
    void refresh();
    const intervalId = setInterval(() => void refresh(), refreshIntervalMs);
    return () => clearInterval(intervalId);
  }, [refresh]);

  return presentation;
}
