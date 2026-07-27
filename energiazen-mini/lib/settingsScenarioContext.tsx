import {
  PropsWithChildren,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { defaultSettings, EnergiaZenSettings, loadSettings } from "./settings";
import {
  SettingsScenarioState,
  commitSettingsScenario,
  createSettingsScenarioState,
  discardSettingsScenario,
} from "./settingsScenario";

type DraftSettingsUpdate =
  | EnergiaZenSettings
  | ((current: EnergiaZenSettings) => EnergiaZenSettings);

type SettingsScenarioContextValue = SettingsScenarioState & {
  areSettingsLoaded: boolean;
  commitPersistedSettings: (settings: EnergiaZenSettings) => void;
  discardDraftSettings: () => void;
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

  const commitPersistedSettings = useCallback((settings: EnergiaZenSettings) => {
    setScenarioState(commitSettingsScenario(settings));
  }, []);

  const value = useMemo(
    () => ({
      ...scenarioState,
      areSettingsLoaded,
      commitPersistedSettings,
      discardDraftSettings,
      updateDraftSettings,
    }),
    [
      areSettingsLoaded,
      commitPersistedSettings,
      discardDraftSettings,
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
