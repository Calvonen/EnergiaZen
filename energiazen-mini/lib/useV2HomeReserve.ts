import { useCallback, useEffect, useState } from "react";

import { supabase } from "./supabase";
import {
  buildV2HomeReservePresentation,
  type V2HomeReservePresentation,
  type V2HomeReserveSnapshot,
} from "./v2HomeReservePresentation";

const refreshIntervalMs = 60_000;

const unavailablePresentation: V2HomeReservePresentation = {
  available: false,
  fillPercent: 0,
  percent: null,
  energyKwh: null,
  capacityKwh: null,
  safetyReservePercent: null,
  targetReservePercent: null,
  forecastMinimumEnergyKwh: null,
  forecastMinimumPercent: null,
  forecastHorizonEndAt: null,
};

export function useV2HomeReserve() {
  const [presentation, setPresentation] = useState<V2HomeReservePresentation>(
    unavailablePresentation,
  );

  const refresh = useCallback(async () => {
    const { data, error } = await supabase.rpc("get_v2_energy_reserve_home");
    if (error) {
      setPresentation(unavailablePresentation);
      return;
    }

    const row = Array.isArray(data) ? data[0] ?? null : data;
    setPresentation(
      buildV2HomeReservePresentation(
        (row ?? null) as V2HomeReserveSnapshot | null,
        Date.now(),
      ),
    );
  }, []);

  useEffect(() => {
    void refresh();
    const intervalId = setInterval(() => void refresh(), refreshIntervalMs);
    return () => clearInterval(intervalId);
  }, [refresh]);

  return presentation;
}
