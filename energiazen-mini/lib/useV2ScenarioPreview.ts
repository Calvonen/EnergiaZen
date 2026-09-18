import { useEffect, useState } from "react";

import type { EnergiaZenSettings } from "./settings";
import { supabase } from "./supabase";

export type V2ScenarioPreview = {
  available: boolean;
  reason: string | null;
  current_conservative_energy_kwh: number | null;
  energy_capacity_kwh: number | null;
  current_percent: number | null;
  safety_reserve_percent: number;
  recommended_preheat_percent: number;
  selected_heating_hour_ids: string[];
  selected_heating_energy_kwh: number | null;
  total_cost_cents: number | null;
  forecast_min_conservative_energy_kwh: number | null;
  forecast_final_conservative_energy_kwh: number | null;
  forecast_horizon_end_at: string | null;
  forecast_min_percent: number | null;
  forecast_final_percent: number | null;
  strategy: string | null;
  plan_valid: boolean | null;
  learned_drop_profile_used: boolean;
  preview_only: true;
};

export type V2ScenarioPreviewState = {
  data: V2ScenarioPreview | null;
  error: string | null;
  loading: boolean;
};

const PREVIEW_DEBOUNCE_MS = 300;
const PREVIEW_REFRESH_MS = 60_000;
const PREVIEW_REQUEST_TIMEOUT_MS = 15_000;

export function useV2ScenarioPreview({
  enabled,
  settings,
}: {
  enabled: boolean;
  settings: EnergiaZenSettings;
}): V2ScenarioPreviewState {
  const [state, setState] = useState<V2ScenarioPreviewState>({
    data: null,
    error: null,
    loading: false,
  });

  useEffect(() => {
    if (!enabled) {
      setState({ data: null, error: null, loading: false });
      return;
    }

    // Draft inputs changed: never keep showing a plan calculated with the
    // previous draft while a replacement request is in flight. Periodic
    // refreshes inside this same effect may retain the current data.
    setState({ data: null, error: null, loading: true });

    let active = true;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let activeRequestController: AbortController | null = null;

    const scheduleRefresh = () => {
      if (!active) return;
      refreshTimer = setTimeout(() => {
        void loadPreview();
      }, PREVIEW_REFRESH_MS);
    };

    const loadPreview = async () => {
      setState((current) => ({
        data: current.data,
        error: null,
        loading: true,
      }));

      const controller = new AbortController();
      activeRequestController = controller;
      const requestTimeout = setTimeout(
        () => controller.abort(),
        PREVIEW_REQUEST_TIMEOUT_MS,
      );

      try {
        const { data, error } = await supabase.functions.invoke(
          "preview-v2-energy-plan",
          {
            body: {
              automaticMaxHeatingHours: settings.automaticMaxHeatingHours,
              maxTankTemperature: settings.maxTankTemperature,
              v2SafetyReservePercent: settings.v2SafetyReservePercent,
              v2TargetReservePercent: settings.v2TargetReservePercent,
            },
            signal: controller.signal,
          },
        );

        if (!active) return;
        if (error) {
          setState({
            data: null,
            error: error.message || "V2-skenaarion laskenta epäonnistui",
            loading: false,
          });
          return;
        }

        setState({
          data: (data ?? null) as V2ScenarioPreview | null,
          error: null,
          loading: false,
        });
      } catch (error: unknown) {
        if (!active) return;
        setState({
          data: null,
          error:
            error instanceof Error
              ? error.message
              : "V2-skenaarion laskenta epäonnistui",
          loading: false,
        });
      } finally {
        clearTimeout(requestTimeout);
        if (activeRequestController === controller) {
          activeRequestController = null;
        }
        scheduleRefresh();
      }
    };

    const debounceTimer = setTimeout(() => {
      void loadPreview();
    }, PREVIEW_DEBOUNCE_MS);

    return () => {
      active = false;
      clearTimeout(debounceTimer);
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      activeRequestController?.abort();
      activeRequestController = null;
    };
  }, [
    enabled,
    settings.automaticMaxHeatingHours,
    settings.maxTankTemperature,
    settings.v2SafetyReservePercent,
    settings.v2TargetReservePercent,
  ]);

  return state;
}
