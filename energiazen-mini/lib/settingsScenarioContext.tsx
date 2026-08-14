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
import { buildHeatingControlSettingsPayload } from "./heatingControlSettingsPayload";
import {
  ensureHeatingControlSettingsBackfilled,
  heatingControlSettingsCompletenessColumns,
  isHeatingControlSettingsSyncOutcomeSynced,
  mergeHeatingControlSettingsBackfillPayload,
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

// Codex P2 follow-up: a plain boolean could not distinguish "the first
// completeness check hasn't resolved yet" from "it resolved and the row is
// confirmed incomplete" - both read as the same false, so Home's fail-safe
// legacy publisher (see app/(tabs)/index.tsx) treated a brand new mount as
// already-confirmed-unsynced and could publish an automatic plan from the
// app before the check had even run once. The explicit third state closes
// that gap: "pending" only ever applies to the window before the FIRST
// attemptSync call in the effect below resolves; every outcome after that -
// including every retry - lands on "synced" or "unsynced", never back on
// "pending".
export type HeatingControlSettingsSyncStatus = "pending" | "synced" | "unsynced";

type SettingsScenarioContextValue = SettingsScenarioState & {
  areSettingsLoaded: boolean;
  commitPersistedSettings: (
    settings: EnergiaZenSettings,
    draftSnapshot: EnergiaZenSettings,
    heatingControlSettingsUpdatedAt: string | null,
  ) => void;
  discardDraftSettings: () => void;
  // "pending" until this install's heating_control_settings row in
  // Supabase has been checked at least once for carrying every
  // authoritative optimizer field (either it already did, or the backfill
  // below just wrote localSettings into it); then "synced" or "unsynced"
  // for the rest of this mount's lifetime (a failed retry keeps it
  // "unsynced", it never reverts to "pending"). Starts "pending" on every
  // mount, including for an install that was already fully synced before -
  // the check below re-confirms it quickly rather than trusting a stale
  // assumption, and Home must not publish an automatic plan from the app
  // while that first confirmation is still outstanding.
  heatingControlSettingsSyncStatus: HeatingControlSettingsSyncStatus;
  heatingControlSettingsUpdatedAt: string | null;
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

  const [heatingControlSettingsSyncStatus, setHeatingControlSettingsSyncStatus] =
    useState<HeatingControlSettingsSyncStatus>("pending");
  const [heatingControlSettingsUpdatedAt, setHeatingControlSettingsUpdatedAt] =
    useState<string | null>(null);

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
  // complete authoritative row and - only if not - writes localSettings via
  // buildHeatingControlSettingsPayload, the same payload shape the Settings
  // screen's own Save button uses. A fixed-mode install's heating_need_mode
  // is written back as "fixed", never forced to "automatic".
  //
  // Codex P2 follow-up: fetchRow() and the write are separate round trips,
  // so another device (or a Settings save on this one, mid-flight) can make
  // the row authoritative in between. The write below is a compare-and-swap
  // on the row's own updated_at (or on "no row exists yet" via
  // ignoreDuplicates) so it can never blindly overwrite a newer row with
  // this stale local snapshot - see ensureHeatingControlSettingsBackfilled's
  // own comment for how a lost race is resolved.
  useEffect(() => {
    if (!areSettingsLoaded) {
      return;
    }

    let isActive = true;
    let retryTimeoutId: ReturnType<typeof setTimeout> | null = null;

    async function attemptSync() {
      let syncedSettingsUpdatedAt: string | null = null;
      const outcome = await ensureHeatingControlSettingsBackfilled({
        fetchRow: async () => {
          const { data, error } = await supabase
            .from("heating_control_settings")
            .select(heatingControlSettingsCompletenessColumns)
            .eq("id", 1)
            .maybeSingle();

          const row = data as HeatingControlSettingsCompletenessRow | null;
          syncedSettingsUpdatedAt = row?.updated_at ?? null;

          return {
            data: row,
            error,
          };
        },
        localSettings: persistedSettingsRef.current,
        upsertIfUnchanged: async (settings, observedRow) => {
          // Codex P2 (PR #193, startup backfill follow-up): merge, don't
          // overwrite - a field the observed row is already authoritative
          // for is preserved verbatim; only fields the row is still missing
          // fall back to localPayload. See
          // mergeHeatingControlSettingsBackfillPayload's own comment.
          const localPayload = buildHeatingControlSettingsPayload(settings);
          const payload = mergeHeatingControlSettingsBackfillPayload(
            localPayload,
            observedRow,
          );
          const table = supabase.from("heating_control_settings");

          if (!observedRow) {
            // No row observed - insert only if one still doesn't exist by
            // the time this reaches the database; a concurrent insert wins
            // and this becomes a no-op (empty `data`), not an overwrite.
            const { data, error } = await table
              .upsert(payload, { onConflict: "id", ignoreDuplicates: true })
              .select("id");

            if (error) {
              throw error;
            }

            const wrote = Array.isArray(data) && data.length > 0;
            if (wrote) {
              syncedSettingsUpdatedAt = payload.updated_at;
            }

            return wrote;
          }

          // A row was observed with this exact updated_at - only overwrite
          // if it still has that value. Anyone else's write in between
          // changes updated_at (every writer - this backfill,
          // upsertHeatingControlSettings, and the manual-migration paths -
          // sets it), so the filter simply matches nothing and no row is
          // returned.
          const { data, error } =
            observedRow.updated_at === null
              ? await table
                  .update(payload)
                  .eq("id", 1)
                  .is("updated_at", null)
                  .select("id")
              : await table
                  .update(payload)
                  .eq("id", 1)
                  .eq("updated_at", observedRow.updated_at)
                  .select("id");

          if (error) {
            throw error;
          }

          const wrote = Array.isArray(data) && data.length > 0;
          if (wrote) {
            syncedSettingsUpdatedAt = payload.updated_at;
          }

          return wrote;
        },
      });

      if (!isActive) {
        return;
      }

      const synced = isHeatingControlSettingsSyncOutcomeSynced(outcome);
      setHeatingControlSettingsSyncStatus(synced ? "synced" : "unsynced");
      setHeatingControlSettingsUpdatedAt(
        synced ? syncedSettingsUpdatedAt : null,
      );

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
    (
      settings: EnergiaZenSettings,
      draftSnapshot: EnergiaZenSettings,
      settingsUpdatedAt: string | null,
    ) => {
      setScenarioState((current) =>
        commitSettingsScenario(settings, draftSnapshot, current.draftSettings),
      );
      setHeatingControlSettingsUpdatedAt(settingsUpdatedAt);
    },
    [],
  );

  const value = useMemo(
    () => ({
      ...scenarioState,
      areSettingsLoaded,
      commitPersistedSettings,
      discardDraftSettings,
      heatingControlSettingsSyncStatus,
      heatingControlSettingsUpdatedAt,
      updateDraftSettings,
    }),
    [
      areSettingsLoaded,
      commitPersistedSettings,
      discardDraftSettings,
      heatingControlSettingsSyncStatus,
      heatingControlSettingsUpdatedAt,
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
