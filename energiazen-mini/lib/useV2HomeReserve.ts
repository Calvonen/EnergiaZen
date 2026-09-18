import { useEffect, useMemo, useState } from "react";

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
const requestTimeoutMs = 15_000;
const clockTickMs = 60_000;

export function useV2HomeReserve() {
  const { persistedSettings } = useSettingsScenario();
  const recommendedPreheatPercent = persistedSettings.v2TargetReservePercent;
  const [snapshot, setSnapshot] = useState<V2HomeReserveSnapshot | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [, setPendingRevision] = useState(0);

  // Poll serially: schedule the next request only after the current one settles.
  // This prevents a slow RPC from being invalidated forever by a fixed interval.
  // A bounded request lifetime also ensures a hung request cannot stop polling.
  useEffect(() => {
    let active = true;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    let activeRequestController: AbortController | null = null;

    const scheduleNext = () => {
      if (!active) return;
      refreshTimer = setTimeout(() => {
        void loadReserve();
      }, refreshIntervalMs);
    };

    const loadReserve = async () => {
      const controller = new AbortController();
      activeRequestController = controller;
      const requestTimeout = setTimeout(() => controller.abort(), requestTimeoutMs);

      try {
        const { data, error } = await supabase
          .rpc("get_v2_energy_reserve_home")
          .abortSignal(controller.signal);

        if (!active) return;

        setNowMs(Date.now());
        if (error) {
          setSnapshot(null);
        } else {
          const row = Array.isArray(data) ? data[0] ?? null : data;
          setSnapshot((row ?? null) as V2HomeReserveSnapshot | null);
        }
      } catch {
        if (active) {
          setNowMs(Date.now());
          setSnapshot(null);
        }
      } finally {
        clearTimeout(requestTimeout);
        if (activeRequestController === controller) {
          activeRequestController = null;
        }
        scheduleNext();
      }
    };

    void loadReserve();

    return () => {
      active = false;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      activeRequestController?.abort();
      activeRequestController = null;
    };
  }, [recommendedPreheatPercent]);

  // Freshness must advance even when the RPC result itself does not change.
  useEffect(() => {
    const clockTimer = setInterval(() => setNowMs(Date.now()), clockTickMs);
    return () => clearInterval(clockTimer);
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

  return useMemo(
    () =>
      buildV2HomeReservePresentation(
        snapshot,
        nowMs,
        recommendedPreheatPercent,
      ),
    [nowMs, recommendedPreheatPercent, snapshot],
  );
}
