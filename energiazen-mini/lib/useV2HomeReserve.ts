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
  subscribePendingV2Recommendation,
} from "./v2RecommendationSaveBaseline";

const refreshIntervalMs = 60_000;
const requestTimeoutMs = 15_000;
const clockTickMs = 60_000;

export function useV2HomeReserve() {
  const { persistedSettings } = useSettingsScenario();
  const recommendedPreheatPercent = persistedSettings.v2TargetReservePercent;
  const [snapshot, setSnapshot] = useState<V2HomeReserveSnapshot | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [pendingRevision, setPendingRevision] = useState(0);

  useEffect(
    () =>
      subscribePendingV2Recommendation(() =>
        setPendingRevision((revision) => revision + 1),
      ),
    [],
  );

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

  useEffect(() => {
    const clockTimer = setInterval(() => setNowMs(Date.now()), clockTickMs);
    return () => clearInterval(clockTimer);
  }, []);

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

    void persistPendingV2Recommendation(null).catch(() => {
      // The in-memory marker is already cleared; a later successful settings
      // load/save can clean up a stale durable marker.
    });
  }, [snapshot]);

  return useMemo(
    () =>
      buildV2HomeReservePresentation(
        snapshot,
        nowMs,
        recommendedPreheatPercent,
      ),
    [nowMs, pendingRevision, recommendedPreheatPercent, snapshot],
  );
}
