import {
  PropsWithChildren,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { defaultSettings, EnergiaZenSettings, loadSettings } from "./settings";
import {
  SettingsScenarioState,
  commitSettingsScenario,
  createSettingsScenarioState,
  discardSettingsScenario,
} from "./settingsScenario";
import { supabase } from "./supabase";
import { upsertHeatingControlSettings } from "./heatingControlSettingsSupabase";
import {
  ensureHeatingControlSettingsBackfilled,
  heatingControlSettingsCompletenessColumns,
  isHeatingControlSettingsSyncOutcomeSynced,
  type HeatingControlSettingsCompletenessRow,
} from "./heatingControlSettingsBackfill";

// Retry cadence for a failed backfill check (network error, remote write
// error, etc.) - deliberately not aggressive: while unsynced,
// shouldPublishHeatingPlanFromApp keeps this install's own legacy automatic
// publisher active (see app/(tabs)/index.tsx), so nothing is left without
// working automatic publication while this keeps retrying in the
// background.
const heatingControlSettingsSyncRetryIntervalMs = 5 * 60 * 1000;

type DraftSettingsUpdate =
  | EnergiaZenSettings
  | ((current: EnergiaZenSettings) => EnergiaZenSettings);

type SettingsScenarioContextValue = SettingsScenarioState & {
  areSettingsLoaded: boolean;
  commitPersistedSettings: (
    settings: EnergiaZenSettings,
    draftSnapshot: EnergiaZenSettings,
  ) => void;
  discardDraftSettings: () => void;
  // False until this install's heating_control_settings row in Supabase is
  // confirmed to carry every authoritative optimizer field (either it
  // already did, or the backfill below just wrote localSettings into it).
  // Starts false (fail-safe default) on every mount, including for an
  // install that was already fully synced before - the check below
  // re-confirms it quickly rather than trusting a stale assumption.
  isHeatingControlSettingsSynced: boolean;
  updateDraftSettings: (update: DraftSettingsUpdate) => void;
};

const SettingsScenarioContext = createContext<SettingsScenarioContextValue | null>(
  null,
);

export function SettingsScenarioProvider({ children }: PropsWithChildren) {
  const [scenarioState, setScenarioState] = useState(() =>
    createSettingsScenarioState(defaultSettings),
  );
  const [areSettingsLoaded, setAreSettingsLoaded] = useState(false);

  useEffect(() => {
    let isMounted = true;

    void loadSettings().then((settings) => {
      if (!isMounted) {
        return;
      }

      setScenarioState(createSettingsScenarioState(settings));
      setAreSettingsLoaded(true);
    });

    return () => {
      isMounted = false;
    };
  }, []);

  const persistedSettingsRef = useRef(scenarioState.persistedSettings);
  useEffect(() => {
    persistedSettingsRef.current = scenarioState.persistedSettings;
  }, [scenarioState.persistedSettings]);

  const [isHeatingControlSettingsSynced, setIsHeatingControlSettingsSynced] =
    useState(false);

  // Codex P1 (PR #193, upgrade path): existing installs can have a
  // heating_control_settings row created before the authoritative optimizer
  // columns existed (all NULL), or no row at all. run-heating-optimizer
  // fails closed on that (control_mode_missing/settings_incomplete) and
  // never publishes, while the app's own legacy automatic publisher is
  // gated off by BACKEND_PRIMARY_HEATING_PLAN_ENABLED - together that could
  // freeze an existing user's heating_plans until they happened to open
  // Settings and press Save. This effect runs the same backfill silently,
  // without requiring a settings-screen visit: once loadSettings() resolves
  // the app's real local settings, it checks whether Supabase already has a
  // complete authoritative row and - only if not - reuses the exact same
  // upsertHeatingControlSettings/buildHeatingControlSettingsPayload path the
  // Settings screen's own Save button uses to write it. A fixed-mode
  // install's heating_need_mode is written back as "fixed", never forced to
  // "automatic".
  useEffect(() => {
    if (!areSettingsLoaded) {
      return;
    }

    let isActive = true;
    let retryTimeoutId: ReturnType<typeof setTimeout> | null = null;

    async function attemptSync() {
      const outcome = await ensureHeatingControlSettingsBackfilled({
        fetchRow: async () => {
          const { data, error } = await supabase
            .from("heating_control_settings")
            .select(heatingControlSettingsCompletenessColumns)
            .eq("id", 1)
            .maybeSingle();

          return {
            data: data as HeatingControlSettingsCompletenessRow | null,
            error,
          };
        },
        localSettings: persistedSettingsRef.current,
        upsert: async (settings) => {
          await upsertHeatingControlSettings(supabase, settings);
        },
      });

      if (!isActive) {
        return;
      }

      const synced = isHeatingControlSettingsSyncOutcomeSynced(outcome);
      setIsHeatingControlSettingsSynced(synced);

      if (!synced) {
        retryTimeoutId = setTimeout(
          () => void attemptSync(),
          heatingControlSettingsSyncRetryIntervalMs,
        );
      }
    }

    void attemptSync();

    return () => {
      isActive = false;
      if (retryTimeoutId !== null) {
        clearTimeout(retryTimeoutId);
      }
    };
  }, [areSettingsLoaded]);

  const updateDraftSettings = useCallback((update: DraftSettingsUpdate) => {
    setScenarioState((current) => {
      const draftSettings =
        typeof update === "function"
          ? update(current.draftSettings)
          : update;

      return createSettingsScenarioState(
        current.persistedSettings,
        draftSettings,
      );
    });
  }, []);

  const discardDraftSettings = useCallback(() => {
    setScenarioState((current) =>
      discardSettingsScenario(current.persistedSettings),
    );
  }, []);

  const commitPersistedSettings = useCallback(
    (settings: EnergiaZenSettings, draftSnapshot: EnergiaZenSettings) => {
      setScenarioState((current) =>
        commitSettingsScenario(settings, draftSnapshot, current.draftSettings),
      );
    },
    [],
  );

  const value = useMemo(
    () => ({
      ...scenarioState,
      areSettingsLoaded,
      commitPersistedSettings,
      discardDraftSettings,
      isHeatingControlSettingsSynced,
      updateDraftSettings,
    }),
    [
      areSettingsLoaded,
      commitPersistedSettings,
      discardDraftSettings,
      isHeatingControlSettingsSynced,
      scenarioState,
      updateDraftSettings,
    ],
  );

  return (
    <SettingsScenarioContext.Provider value={value}>
      {children}
    </SettingsScenarioContext.Provider>
  );
}

export function useSettingsScenario() {
  const value = useContext(SettingsScenarioContext);

  if (!value) {
    throw new Error("useSettingsScenario must be used inside SettingsScenarioProvider");
  }

  return value;
}
