import { ReactNode, useCallback, useMemo, useState } from "react";
import { useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  defaultSettings,
  EditableSettingKey,
  HeatingNeedMode,
  normalizeSettings,
  saveSettings,
} from "@/lib/settings";
import { upsertHeatingControlSettings } from "@/lib/heatingControlSettingsSupabase";
import {
  areSettingsEqual,
  persistSettingsDraft,
  SettingsDraftLocalSaveError,
  SettingsDraftSaveError,
  SettingsValidationField,
  updateDraftSetting,
  validateSettingsDraft,
} from "@/lib/settingsDraft";
import { useSettingsScenario } from "@/lib/settingsScenarioContext";
import { supabase } from "@/lib/supabase";
import { getShowerReserveOptions } from "@/lib/showerReserveSettings";
import { getHeatingModeSettingKeys } from "@/lib/heatingModeSettings";
import {
  getFallbackSettingsSummary,
  getShowerCalculationSummary,
  getTankSettingsSummary,
  getWarmWaterReserveSummary,
  isWarmWaterReserveSectionVisible,
  toggleExpandedSection,
} from "@/lib/settingsSectionSummaries";
import {
  fetchLatestTemperatureDropProfile,
  getTemperatureDropProfileHours,
  isTemperatureDropProfileFresh,
  TemperatureDropProfile,
} from "@/lib/temperatureDropProfile";

type SettingsRow = {
  accent: string;
  description?: string;
  key?: EditableSettingKey;
  label: string;
  subheadingBefore?: string;
  validationKey?: SettingsValidationField;
  value: string;
};

type SettingsSection = {
  rows: SettingsRow[];
  title: string;
};

type CollapsibleSectionKey = "fallback" | "showers" | "tank" | "warmWater";

function CollapsibleSettingsSection({
  accessibilityLabel,
  children,
  expanded,
  onToggle,
  summary,
  title,
}: {
  accessibilityLabel: string;
  children: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  summary: string;
  title: string;
}) {
  return (
    <View style={styles.collapsibleSection}>
      <Pressable
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={onToggle}
        style={({ pressed }) => [
          styles.collapsibleSectionHeader,
          pressed && styles.collapsibleSectionHeaderPressed,
        ]}
      >
        <View style={styles.collapsibleSectionHeaderText}>
          <Text style={styles.collapsibleSectionTitle}>{title}</Text>
          <Text numberOfLines={2} style={styles.collapsibleSectionSummary}>
            {summary}
          </Text>
        </View>
        <Text style={styles.collapsibleSectionChevron}>
          {expanded ? "⌃" : "⌄"}
        </Text>
      </Pressable>
      {expanded ? (
        <View style={styles.collapsibleSectionContent}>{children}</View>
      ) : null}
    </View>
  );
}

type TankReadingCalibrationRow = {
  bottom_temp: number | null;
  created_at: string;
  top_temp: number | null;
};

type CalibrationCandidate = {
  bottomTemp: number;
  createdAt: string;
  topTemp: number;
  weightedTemp: number;
};

type EditableSettingOption = {
  max?: number;
  min?: number;
  options?: readonly number[];
  step?: number;
  unit: string;
};

const editableSettings: Record<EditableSettingKey, EditableSettingOption> = {
  tankSizeLiters: {
    options: [200, 250, 290, 300, 500],
    unit: "l",
  },
  automaticMaxHeatingHours: {
    max: 6,
    min: 1,
    unit: "h",
  },
  fixedHeatingHoursPerDay: {
    max: 6,
    min: 1,
    unit: "h / vrk",
  },
  fullTankShowers: {
    max: 10,
    min: 3,
    unit: "suihkua",
  },
  targetShowerReserve: {
    max: 10,
    min: 0.5,
    step: 0.5,
    unit: "suihkua",
  },
  safetyShowerReserve: {
    max: 9.5,
    min: 0,
    step: 0.5,
    unit: "suihkua",
  },
  maxTankTemperature: {
    options: [55, 60, 65, 70, 75, 80],
    unit: "°C",
  },
  fullTankAverageTemperature: {
    max: 90,
    min: 20,
    unit: "°C",
  },
};

const heatingNeedModeOptions: {
  label: string;
  value: HeatingNeedMode;
}[] = [
  { label: "Automaattinen", value: "automatic" },
  { label: "Kiinteä tuntimäärä", value: "fixed" },
];

const helsinkiProfileDateTimeFormatter = new Intl.DateTimeFormat("fi-FI", {
  day: "2-digit",
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  month: "2-digit",
  timeZone: "Europe/Helsinki",
  year: "numeric",
});

function formatProfileDateTime(value: string | null) {
  const date = value ? new Date(value) : null;

  return date && !Number.isNaN(date.getTime())
    ? helsinkiProfileDateTimeFormatter.format(date)
    : "--";
}

function formatProfileDrop(value: number | null) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(2).replace(".", ",")
    : "--";
}

function getHighestProfileHour(
  hours: { drop: number; hour: number; observationDays: number }[],
) {
  return hours.reduce<(typeof hours)[number] | null>(
    (highest, item) => (!highest || item.drop > highest.drop ? item : highest),
    null,
  );
}

const profileDropColorStops = [
  { color: [38, 217, 210], position: 0 },
  { color: [84, 234, 160], position: 0.5 },
  { color: [255, 155, 48], position: 0.8 },
  { color: [255, 95, 109], position: 1 },
] as const;

function getProfileDropColor(value: number, minimum: number, maximum: number) {
  const normalizedValue =
    maximum > minimum
      ? Math.min(1, Math.max(0, (value - minimum) / (maximum - minimum)))
      : 0;
  const upperStopIndex = profileDropColorStops.findIndex(
    ({ position }) => normalizedValue <= position,
  );
  const upperStop =
    profileDropColorStops[
      upperStopIndex === -1
        ? profileDropColorStops.length - 1
        : upperStopIndex
    ];
  const lowerStop =
    profileDropColorStops[Math.max(0, upperStopIndex - 1)] ?? upperStop;
  const stopRange = upperStop.position - lowerStop.position;
  const mix = stopRange > 0 ? (normalizedValue - lowerStop.position) / stopRange : 0;
  const [red, green, blue] = lowerStop.color.map((channel, index) =>
    Math.round(channel + (upperStop.color[index] - channel) * mix),
  );

  return `rgb(${red}, ${green}, ${blue})`;
}

export default function SettingsScreen() {
  const router = useRouter();
  const {
    areSettingsLoaded,
    commitPersistedSettings,
    discardDraftSettings,
    draftSettings,
    persistedSettings: savedSettings,
    updateDraftSettings,
  } = useSettingsScenario();
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<{
    kind: "error" | "success";
    message: string;
  } | null>(null);
  const settings = draftSettings;
  const [selectedSettingKey, setSelectedSettingKey] =
    useState<EditableSettingKey | null>(null);
  const [isCalibratingFullTank, setIsCalibratingFullTank] = useState(false);
  const [temperatureDropProfile, setTemperatureDropProfile] =
    useState<TemperatureDropProfile | null>(null);
  const [isProfileLoading, setIsProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [showHourlyDetails, setShowHourlyDetails] = useState(false);
  const [expandedSections, setExpandedSections] = useState<
    Record<CollapsibleSectionKey, boolean>
  >({
    fallback: false,
    showers: false,
    tank: false,
    warmWater: false,
  });

  const loadTemperatureDropProfile = useCallback(async () => {
    setIsProfileLoading(true);
    setProfileError(null);

    try {
      setTemperatureDropProfile(
        await fetchLatestTemperatureDropProfile(supabase),
      );
    } catch (error) {
      console.warn("Failed to load temperature drop profile", error);
      setProfileError("Lämpöhäviöprofiilia ei voitu hakea.");
    } finally {
      setIsProfileLoading(false);
    }
  }, []);

  const settingsSections = useMemo(
    (): SettingsSection[] => {
      const heatingModeSettingKeys = new Set(
        getHeatingModeSettingKeys(settings.heatingNeedMode),
      );
      const showAutomaticSettings =
        heatingModeSettingKeys.has("targetShowerReserve") &&
        isWarmWaterReserveSectionVisible(settings.heatingNeedMode);

      return [
      {
        title: "Varaajan perusasetukset",
        rows: [
          {
            accent: "#36f4d4",
            key: "tankSizeLiters",
            label: "Varaajan koko",
            value: `${settings.tankSizeLiters} l`,
          },
          {
            accent: "#5aa7ff",
            label: "Minimilämpö",
            validationKey: "minTankTemperature",
            value: `${settings.minTankTemperature} °C`,
          },
          {
            accent: "#ff5f6d",
            key: "maxTankTemperature",
            label: "Maksimilämpö",
            value: `${settings.maxTankTemperature} °C`,
          },
        ],
      },
      {
        title: "Pörssisähkön ohjausasetukset",
        rows: [],
      },
      {
        title: "Suihkulaskenta",
        rows: [
          {
            accent: "#ff9b30",
            key: "fullTankAverageTemperature",
            label: "Täyden varaajan vertailulämpö",
            value: `${settings.fullTankAverageTemperature} °C`,
          },
          {
            accent: "#b889ff",
            key: "fullTankShowers",
            label: "Täysi varaaja suihkuina",
            value: `${settings.fullTankShowers} suihkua`,
          },
        ],
      },
      ...(showAutomaticSettings
        ? [{
        title: "Lämminvesivaraus",
        rows: [
          {
            accent: "#36f4d4",
            description:
              "Optimointi pyrkii pitämään käytettävissä yleensä vähintään tämän määrän suihkuja. Varaus voi hetkellisesti laskea tavoitteen alle, jos edullisia lämmitystunteja on tulossa.",
            key: "targetShowerReserve",
            label: "Tavoitevaraus suihkuina",
            value: `${settings.targetShowerReserve} suihkua`,
          },
          {
            accent: "#ffcf5a",
            description:
              "Ennustettu varaus ei saa laskea tämän alle. Jos raja uhkaa alittua, lämmitystä aikaistetaan hinnasta riippumatta.",
            key: "safetyShowerReserve",
            label: "Turvaraja suihkuina",
            value: `${settings.safetyShowerReserve} suihkua`,
          },
          {
            accent: "#54eaa0",
            description:
              "Optimointi voi käyttää enintään tämän määrän lämmitystunteja tarkasteluikkunan aikana. Todellinen tuntimäärä määräytyy varaajan ennusteen mukaan.",
            key: "automaticMaxHeatingHours",
            label: "Lämmitystuntien enimmäismäärä",
            value: `${settings.automaticMaxHeatingHours} h`,
          },
        ],
      } as SettingsSection]
        : [{
            title: "Kiinteä lämmitys",
            rows: [
              {
                accent: "#54eaa0",
                description:
                  "Varaajaa lämmitetään joka vuorokausi tämän määrän verran vuorokauden halvimmilla tunneilla.",
                key: "fixedHeatingHoursPerDay",
                label: "Lämmitystunnit vuorokaudessa",
                value: `${settings.fixedHeatingHoursPerDay} h / vrk`,
              },
            ],
          } as SettingsSection]),
    ];
    },
    [settings],
  );
  const settingsRows = settingsSections.flatMap((section) => section.rows);
  const getCollapsibleSectionDetails = (title: string) => {
    switch (title) {
      case "Varaajan perusasetukset":
        return {
          key: "tank" as const,
          summary: getTankSettingsSummary(settings),
        };
      case "Suihkulaskenta":
        return {
          key: "showers" as const,
          summary: getShowerCalculationSummary(settings.fullTankShowers),
        };
      case "Lämminvesivaraus":
        return {
          key: "warmWater" as const,
          summary: getWarmWaterReserveSummary(settings),
        };
      default:
        return null;
    }
  };

  const selectedRow = settingsRows.find(
    (row) => row.key === selectedSettingKey,
  );
  const selectedSetting = selectedSettingKey
    ? editableSettings[selectedSettingKey]
    : null;
  const selectedSettingOptions = selectedSetting
    ? selectedSetting.options ??
      (selectedSettingKey === "targetShowerReserve" ||
      selectedSettingKey === "safetyShowerReserve"
        ? getShowerReserveOptions({
            fullTankShowers: settings.fullTankShowers,
            safetyShowerReserve: settings.safetyShowerReserve,
            targetShowerReserve: settings.targetShowerReserve,
            type:
              selectedSettingKey === "targetShowerReserve"
                ? "target"
                : "safety",
          })
        : (() => {
        const step = selectedSetting.step ?? 1;

        return Array.from(
          {
            length:
              Math.floor((selectedSetting.max! - selectedSetting.min!) / step) +
              1,
          },
          (_, index) => selectedSetting.min! + index * step,
        );
      })())
    : [];

  const updateSetting = (key: EditableSettingKey, value: number) => {
    if (isSavingSettings) {
      return;
    }

    updateDraftSettings((current) => updateDraftSetting(current, key, value));
    setSaveFeedback(null);
    setSelectedSettingKey(null);
  };

  const updateHeatingNeedMode = (heatingNeedMode: HeatingNeedMode) => {
    if (isSavingSettings) {
      return;
    }

    updateDraftSettings((current) => ({ ...current, heatingNeedMode }));
    setSaveFeedback(null);
  };

  const toggleBackupHour = (hour: number) => {
    if (isSavingSettings) {
      return;
    }

    const isSelected = settings.backupHours.includes(hour);

    if (
      isSelected &&
      settings.fallbackEnabled &&
      settings.backupHours.length === 1
    ) {
      return;
    }

    updateDraftSettings((current) => ({
      ...current,
      backupHours: isSelected
        ? current.backupHours.filter((backupHour) => backupHour !== hour)
        : [...current.backupHours, hour].sort((a, b) => a - b),
    }));
    setSaveFeedback(null);
  };

  const settingsValidation = useMemo(
    () => validateSettingsDraft(draftSettings, savedSettings),
    [draftSettings, savedSettings],
  );
  const hasUnsavedChanges = !areSettingsEqual(
    draftSettings,
    savedSettings,
  );
  const isSaveDisabled =
    !areSettingsLoaded ||
    !hasUnsavedChanges ||
    settingsValidation.errors.length > 0 ||
    isSavingSettings;
  const isCancelDisabled = !hasUnsavedChanges || isSavingSettings;

  const handleCancelSettings = () => {
    if (isCancelDisabled) {
      return;
    }

    discardDraftSettings();
    setSelectedSettingKey(null);
    setSaveFeedback(null);
  };

  const handleSaveSettings = async () => {
    if (isSaveDisabled) {
      return;
    }

    const draftSnapshot = draftSettings;
    const settingsToSave = normalizeSettings(draftSnapshot);
    setIsSavingSettings(true);
    setSaveFeedback(null);

    try {
      const persistedSettings = await persistSettingsDraft({
        draftSettings: settingsToSave,
        savedSettings,
        saveLocal: saveSettings,
        saveRemote: async (nextSettings) => {
          await upsertHeatingControlSettings(supabase, nextSettings);
        },
      });

      commitPersistedSettings(persistedSettings, draftSnapshot);
      setSaveFeedback({
        kind: "success",
        message: "Asetukset tallennettiin.",
      });
      Alert.alert("Asetukset tallennettu", "Uudet asetukset ovat käytössä.");
    } catch (error) {
      const localSaveFailed = error instanceof SettingsDraftLocalSaveError;
      const rollbackFailed =
        error instanceof SettingsDraftSaveError &&
        !error.rollbackSucceeded;
      const message = localSaveFailed
        ? "Paikallinen tallennus epäonnistui. Muutokset säilyvät luonnoksena."
        : rollbackFailed
          ? "Tallennus epäonnistui eikä paikallista palautusta voitu varmistaa. Yritä uudelleen."
          : "Supabase-tallennus epäonnistui. Paikalliset asetukset palautettiin ja muutokset säilyvät luonnoksena.";

      console.warn("Failed to save settings draft", error);
      setSaveFeedback({ kind: "error", message });
      Alert.alert("Tallennus epäonnistui", message);
    } finally {
      setIsSavingSettings(false);
    }
  };

  useFocusEffect(
    useCallback(() => {
      let isActive = true;

      supabase.auth.getSession().then(({ data: { session } }) => {
        if (isActive && !session) {
          router.replace("/login");
        }
      });

      return () => {
        isActive = false;
      };
    }, [router]),
  );

  useFocusEffect(
    useCallback(() => {
      void loadTemperatureDropProfile();
    }, [loadTemperatureDropProfile]),
  );

  const isProfileFresh = temperatureDropProfile
    ? isTemperatureDropProfileFresh(temperatureDropProfile)
    : false;
  const profileStatus = temperatureDropProfile
    ? isProfileFresh
      ? "Ajantasainen"
      : "Vanhentunut"
    : "Ei saatavilla";
  const activeProfileSource = isProfileFresh
    ? "30 päivän viikkoprofiili"
    : "Paikallinen 7 päivän profiili";
  const profileHours = temperatureDropProfile
    ? getTemperatureDropProfileHours(temperatureDropProfile)
    : [];
  const highestProfileHour = getHighestProfileHour(profileHours);
  const highestProfileDrop = highestProfileHour?.drop ?? 0;
  const lowestProfileDrop =
    profileHours.length > 0
      ? Math.min(...profileHours.map(({ drop }) => drop))
      : 0;

  const formatCalibrationTime = (createdAt: string) => {
    const calibrationDate = new Date(createdAt);
    const day = String(calibrationDate.getDate()).padStart(2, "0");
    const month = String(calibrationDate.getMonth() + 1).padStart(2, "0");
    const hours = String(calibrationDate.getHours()).padStart(2, "0");
    const minutes = String(calibrationDate.getMinutes()).padStart(2, "0");

    return `${day}.${month}. klo ${hours}:${minutes}`;
  };

  const confirmFullTankCalibration = (candidate: CalibrationCandidate) => {
    const roundedAverageTemp = Math.round(candidate.weightedTemp);
    const currentAverageTemp = settings.fullTankAverageTemperature;
    const calibrationDetails = [
      `Löytyi korkein 70/30-lämpö: ${roundedAverageTemp} °C`,
      `Nykyinen asetus: ${currentAverageTemp} °C`,
      `Ylä: ${Math.round(candidate.topTemp)} °C`,
      `Ala: ${Math.round(candidate.bottomTemp)} °C`,
      `Ajankohta: ${formatCalibrationTime(candidate.createdAt)}`,
    ];

    if (Math.abs(roundedAverageTemp - currentAverageTemp) < 1) {
      Alert.alert(
        "Kalibroi täysi varaaja",
        [
          "Nykyinen kalibrointi on jo ajan tasalla.",
          "",
          ...calibrationDetails,
        ].join("\n"),
        [{ text: "OK" }],
      );
      return;
    }

    Alert.alert(
      "Kalibroi täysi varaaja",
      calibrationDetails.join("\n"),
      [
        { text: "Peruuta", style: "cancel" },
        {
          text: "Käytä tätä",
          onPress: () =>
            updateSetting("fullTankAverageTemperature", roundedAverageTemp),
        },
      ],
    );
  };

  const calibrateFullTankFromWeek = async () => {
    if (isCalibratingFullTank) {
      return;
    }

    setIsCalibratingFullTank(true);

    try {
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);

      const pageSize = 1000;
      let from = 0;
      let readings: TankReadingCalibrationRow[] = [];

      while (true) {
        const { data, error } = await supabase
          .from("tank_readings")
          .select("created_at, top_temp, bottom_temp")
          .gte("created_at", weekAgo.toISOString())
          .order("created_at", { ascending: true })
          .range(from, from + pageSize - 1);

        if (error) {
          throw error;
        }

        const page = (data ?? []) as TankReadingCalibrationRow[];
        readings = readings.concat(page);

        if (page.length < pageSize) {
          break;
        }

        from += pageSize;
      }

      const bestCandidate = readings.reduce<CalibrationCandidate | null>(
        (best, reading) => {
          if (
            typeof reading.top_temp !== "number" ||
            typeof reading.bottom_temp !== "number"
          ) {
            return best;
          }

          const weightedTemp =
            reading.top_temp * 0.7 + reading.bottom_temp * 0.3;

          if (!best || weightedTemp > best.weightedTemp) {
            return {
              bottomTemp: reading.bottom_temp,
              createdAt: reading.created_at,
              topTemp: reading.top_temp,
              weightedTemp,
            };
          }

          return best;
        },
        null,
      );


      if (!bestCandidate) {
        Alert.alert(
          "Kalibrointia ei voitu tehdä",
          "Viimeiseltä 7 päivältä ei löytynyt kelvollisia lämpötilarivejä.",
        );
        return;
      }

      confirmFullTankCalibration(bestCandidate);
    } catch {
      Alert.alert(
        "Kalibrointi epäonnistui",
        "Viikon lämpötiladataa ei voitu hakea. Yritä hetken kuluttua uudelleen.",
      );
    } finally {
      setIsCalibratingFullTank(false);
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.replace("/login");
  };

  const settingsSavePanel = (
    <View style={styles.settingsSavePanel}>
      {hasUnsavedChanges ? (
        <Text style={styles.unsavedSettingsText}>
          Tallentamattomia muutoksia
        </Text>
      ) : null}

      {settingsValidation.errors.length > 0 ? (
        <View style={styles.validationSummary}>
          <Text style={styles.validationSummaryErrorTitle}>
            Korjaa ennen tallennusta
          </Text>
          {settingsValidation.errors.map((issue) => (
            <Text
              key={`summary-error-${issue.field}-${issue.message}`}
              style={styles.validationSummaryErrorText}
            >
              {issue.message}
            </Text>
          ))}
        </View>
      ) : null}

      {settingsValidation.warnings.length > 0 ? (
        <View style={styles.validationSummary}>
          <Text style={styles.validationSummaryWarningTitle}>
            Huomioitavaa
          </Text>
          {settingsValidation.warnings.map((issue) => (
            <Text
              key={`summary-warning-${issue.field}-${issue.message}`}
              style={styles.validationSummaryWarningText}
            >
              {issue.message}
            </Text>
          ))}
        </View>
      ) : null}

      {saveFeedback ? (
        <Text
          style={[
            styles.saveFeedback,
            saveFeedback.kind === "success"
              ? styles.saveFeedbackSuccess
              : styles.saveFeedbackError,
          ]}
        >
          {saveFeedback.message}
        </Text>
      ) : null}

      {isSavingSettings ? (
        <Text style={styles.savingSettingsText}>Tallennetaan...</Text>
      ) : null}

      <View style={styles.settingsSaveActions}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: isCancelDisabled }}
          disabled={isCancelDisabled}
          onPress={handleCancelSettings}
          style={({ pressed }) => [
            styles.cancelSettingsButton,
            isCancelDisabled && styles.settingsActionDisabled,
            pressed && !isCancelDisabled && styles.settingsActionPressed,
          ]}
        >
          <Text style={styles.cancelSettingsButtonText}>Hylkää muutokset</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: isSaveDisabled }}
          disabled={isSaveDisabled}
          onPress={handleSaveSettings}
          style={({ pressed }) => [
            styles.saveSettingsButton,
            isSaveDisabled && styles.settingsActionDisabled,
            pressed && !isSaveDisabled && styles.settingsActionPressed,
          ]}
        >
          <Text style={styles.saveSettingsButtonText}>
            {isSavingSettings ? "Tallennetaan..." : "Tallenna asetukset"}
          </Text>
        </Pressable>
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.screen}>
      <View style={[styles.glow, styles.greenGlow]} />
      <View style={[styles.glow, styles.blueGlow]} />

      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headerRow}>
          <Pressable
            accessibilityLabel="Palaa etusivulle"
            accessibilityRole="button"
            onPress={() => router.back()}
            style={styles.backButton}
          >
            <Text style={styles.backButtonText}>‹</Text>
          </Pressable>
        </View>

        <View style={styles.heroCard}>
          <Text style={styles.heroIcon}>⚙️</Text>
          <Text style={styles.heroTitle}>OHJAUKSEN ASETUKSET</Text>
        </View>

        <View style={styles.settingsCard}>
          {settingsSections.map((section) => {
            const sectionContent = (
              <>
              {section.title === "Pörssisähkön ohjausasetukset" ? (
                <View style={styles.modeSettingGroup}>
                  <View style={styles.modeSettingHeader}>
                    <Text style={styles.settingLabel}>
                      Lämmitystila
                    </Text>
                    <Text style={styles.settingDescription}>
                      Automaattinen säätää lämmitystunteja varaajan
                      suihkuvarauksen perusteella. Kiinteä käyttää aina
                      asetettua tuntimäärää.
                    </Text>
                  </View>
                  <View style={styles.modeSelector}>
                    {heatingNeedModeOptions.map((option) => {
                      const isActive =
                        settings.heatingNeedMode === option.value;

                      return (
                        <Pressable
                          accessibilityRole="button"
                          disabled={isSavingSettings}
                          key={option.value}
                          onPress={() => updateHeatingNeedMode(option.value)}
                          style={({ pressed }) => [
                            styles.modeOption,
                            isActive && styles.modeOptionActive,
                            pressed && styles.modeOptionPressed,
                          ]}
                        >
                          <Text
                            style={[
                              styles.modeOptionText,
                              isActive && styles.modeOptionTextActive,
                            ]}
                          >
                            {option.label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                  {settingsSavePanel}
                </View>
              ) : null}
              {section.rows.map((row) => {
                const validationField = row.validationKey ?? row.key;
                const fieldErrors = validationField
                  ? settingsValidation.errors.filter(
                      (issue) => issue.field === validationField,
                    )
                  : [];
                const fieldWarnings = validationField
                  ? settingsValidation.warnings.filter(
                      (issue) => issue.field === validationField,
                    )
                  : [];
                const rowContent = (
                  <>
                    <View
                      style={[
                        styles.settingAccent,
                        { backgroundColor: row.accent },
                      ]}
                    />
                    <View style={styles.settingTextGroup}>
                      <Text style={styles.settingLabel}>{row.label}</Text>
                      {row.description ? (
                        <Text style={styles.settingDescription}>
                          {row.description}
                        </Text>
                      ) : null}
                    </View>
                    <Text style={styles.settingValue}>{row.value}</Text>
                  </>
                );

                const renderedRow = (() => {
                  if (row.key) {
                    const rowKey = row.key;

                    if (rowKey === "fullTankAverageTemperature") {
                      return (
                        <View
                          key={row.label}
                          style={styles.settingRowWithAction}
                        >
                          <Pressable
                            accessibilityRole="button"
                            disabled={isSavingSettings}
                            onPress={() => setSelectedSettingKey(rowKey)}
                            style={styles.settingRowMainAction}
                          >
                            {rowContent}
                          </Pressable>
                          <Pressable
                            accessibilityRole="button"
                            disabled={
                              isCalibratingFullTank || isSavingSettings
                            }
                            onPress={calibrateFullTankFromWeek}
                            style={({ pressed }) => [
                              styles.calibrateButton,
                              (pressed || isCalibratingFullTank) &&
                                styles.calibrateButtonPressed,
                            ]}
                          >
                            <Text style={styles.calibrateButtonText}>
                              {isCalibratingFullTank
                                ? "Kalibroidaan..."
                                : "Kalibroi viikon datasta"}
                            </Text>
                          </Pressable>
                        </View>
                      );
                    }

                    return (
                      <Pressable
                        accessibilityRole="button"
                        disabled={isSavingSettings}
                        key={row.label}
                        onPress={() => setSelectedSettingKey(rowKey)}
                        style={styles.settingRow}
                      >
                        {rowContent}
                      </Pressable>
                    );
                  }

                  return (
                    <View key={row.label} style={styles.settingRow}>
                      {rowContent}
                    </View>
                  );
                })();

                return (
                  <View key={row.label}>
                    {row.subheadingBefore ? (
                      <Text style={styles.settingSubsectionLabel}>
                        {row.subheadingBefore}
                      </Text>
                    ) : null}
                    {renderedRow}
                    {fieldErrors.map((issue) => (
                      <Text
                        key={`error-${issue.message}`}
                        style={styles.settingValidationError}
                      >
                        {issue.message}
                      </Text>
                    ))}
                    {fieldWarnings.map((issue) => (
                      <Text
                        key={`warning-${issue.message}`}
                        style={styles.settingValidationWarning}
                      >
                        {issue.message}
                      </Text>
                    ))}
                  </View>
                );
              })}
              </>
            );
            const collapsibleDetails = getCollapsibleSectionDetails(
              section.title,
            );

            if (collapsibleDetails) {
              const { key, summary } = collapsibleDetails;

              return (
                <CollapsibleSettingsSection
                  accessibilityLabel={`${section.title}, ${expandedSections[key] ? "sulje" : "avaa"}`}
                  expanded={expandedSections[key]}
                  key={section.title}
                  onToggle={() =>
                    setExpandedSections((current) =>
                      toggleExpandedSection(current, key),
                    )
                  }
                  summary={summary}
                  title={section.title}
                >
                  {sectionContent}
                </CollapsibleSettingsSection>
              );
            }

            return (
              <View key={section.title} style={styles.settingsSection}>
                <Text style={styles.sectionLabel}>{section.title}</Text>
                {sectionContent}
              </View>
            );
          })}
        </View>

        <CollapsibleSettingsSection
            accessibilityLabel={`Varakäyttö, ${expandedSections.fallback ? "sulje" : "avaa"}`}
            expanded={expandedSections.fallback}
            onToggle={() =>
              setExpandedSections((current) =>
                toggleExpandedSection(current, "fallback"),
              )
            }
            summary={getFallbackSettingsSummary(settings)}
            title="Varakäyttö"
          >
            <View style={styles.fallbackHeader}>
              <View style={styles.settingTextGroup}>
                <Text style={styles.settingLabel}>
                  Käytä varatunteja yhteyskatkossa
                </Text>
                <Text style={styles.settingDescription}>
                  Shelly käyttää näitä tunteja, jos päivän EnergyZen-suunnitelmaa
                  ei saada haettua.
                </Text>
              </View>
              <Switch
                accessibilityLabel="Käytä varatunteja yhteyskatkossa"
                disabled={isSavingSettings}
                onValueChange={(fallbackEnabled) => {
                  updateDraftSettings((current) => ({
                    ...current,
                    backupHours:
                      fallbackEnabled && current.backupHours.length === 0
                        ? defaultSettings.backupHours
                        : current.backupHours,
                    fallbackEnabled,
                  }));
                  setSaveFeedback(null);
                }}
                trackColor={{ false: "#39445d", true: "#238b7c" }}
                thumbColor={settings.fallbackEnabled ? "#36f4d4" : "#9aaaca"}
                value={settings.fallbackEnabled}
              />
            </View>
            <View style={styles.backupHourGrid}>
              {Array.from({ length: 24 }, (_, hour) => {
                const isActive = settings.backupHours.includes(hour);
                const nextHour = String((hour + 1) % 24).padStart(2, "0");

                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: isActive }}
                    disabled={isSavingSettings}
                    key={hour}
                    onPress={() => toggleBackupHour(hour)}
                    style={({ pressed }) => [
                      styles.backupHourButton,
                      isActive && styles.backupHourButtonActive,
                      pressed && styles.modeOptionPressed,
                    ]}
                  >
                    <Text
                      style={[
                        styles.backupHourText,
                        isActive && styles.backupHourTextActive,
                      ]}
                    >
                      {String(hour).padStart(2, "0")}–{nextHour}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
        </CollapsibleSettingsSection>

        <View style={styles.profileCard}>
          <View style={styles.profileHeader}>
            <View style={styles.profileHeaderText}>
              <Text style={styles.profileTitle}>Lämpöhäviöprofiili</Text>
              <Text
                style={[
                  styles.profileStatus,
                  isProfileFresh && styles.profileStatusFresh,
                ]}
              >
                {profileStatus}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              disabled={isProfileLoading}
              onPress={loadTemperatureDropProfile}
              style={({ pressed }) => [
                styles.profileRefreshButton,
                (pressed || isProfileLoading) &&
                  styles.profileRefreshButtonPressed,
              ]}
            >
              <Text style={styles.profileRefreshButtonText}>
                {isProfileLoading ? "Päivitetään..." : "Päivitä tiedot"}
              </Text>
            </Pressable>
          </View>

          {profileError ? (
            <Text style={styles.profileError}>{profileError}</Text>
          ) : null}

          <View style={styles.profileMetadata}>
            <View style={styles.profileMetadataRow}>
              <Text style={styles.profileMetadataLabel}>Käytössä</Text>
              <Text style={styles.profileMetadataValue}>
                {activeProfileSource}
              </Text>
            </View>
            <View style={styles.profileMetadataRow}>
              <Text style={styles.profileMetadataLabel}>Viimeisin päivitys</Text>
              <Text style={styles.profileMetadataValue}>
                {formatProfileDateTime(
                  temperatureDropProfile?.created_at ?? null,
                )}
              </Text>
            </View>
            <View style={styles.profileMetadataRow}>
              <Text style={styles.profileMetadataLabel}>Lähdejakso</Text>
              <Text style={styles.profileMetadataValue}>
                {formatProfileDateTime(
                  temperatureDropProfile?.source_start ?? null,
                )}
                {" – "}
                {formatProfileDateTime(
                  temperatureDropProfile?.source_end ?? null,
                )}
              </Text>
            </View>
            <View style={styles.profileMetadataRow}>
              <Text style={styles.profileMetadataLabel}>Lähdepäiviä</Text>
              <Text style={styles.profileMetadataValue}>
                {temperatureDropProfile?.source_days ?? "--"}
              </Text>
            </View>
            <View style={styles.profileMetadataRow}>
              <Text style={styles.profileMetadataLabel}>Yleinen lämpöhäviö</Text>
              <Text style={styles.profileMetadataValue}>
                {formatProfileDrop(
                  temperatureDropProfile?.general_fallback ?? null,
                )}{" "}
                °C/h
              </Text>
            </View>
            <View style={styles.profileMetadataRow}>
              <Text style={styles.profileMetadataLabel}>Algoritmi</Text>
              <Text style={styles.profileMetadataValue}>
                {temperatureDropProfile?.algorithm_version ?? "--"}
              </Text>
            </View>
          </View>

          {highestProfileHour ? (
            <>
              <Text style={styles.profileHighestText}>
                Korkein lämpöhäviö:{" "}
                {String(highestProfileHour.hour).padStart(2, "0")}–
                {String((highestProfileHour.hour + 1) % 24).padStart(2, "0")}{" "}
                • {formatProfileDrop(highestProfileHour.drop)} °C/h
              </Text>
              <Pressable
                accessibilityHint="Näyttää tai piilottaa tarkat tuntikohtaiset tiedot."
                accessibilityLabel="Lämpöhäviöprofiilin 24 tunnin pylväskaavio"
                accessibilityRole="button"
                accessibilityState={{ expanded: showHourlyDetails }}
                onPress={() => setShowHourlyDetails((visible) => !visible)}
                style={({ pressed }) => [
                  styles.profileChartButton,
                  pressed && styles.profileChartButtonPressed,
                ]}
              >
                <View style={styles.profileChart}>
                  {profileHours.map(({ drop, hour }) => {
                    const isHighest = hour === highestProfileHour.hour;
                    const barColor = getProfileDropColor(
                      drop,
                      lowestProfileDrop,
                      highestProfileDrop,
                    );
                    const barHeight =
                      highestProfileDrop > 0
                        ? Math.max(4, (drop / highestProfileDrop) * 64)
                        : 4;

                    return (
                      <View key={hour} style={styles.profileChartColumn}>
                        <View style={styles.profileChartBarArea}>
                          <View
                            style={[
                              styles.profileChartBar,
                              { backgroundColor: barColor, height: barHeight },
                              isHighest && styles.profileChartBarHighest,
                            ]}
                          />
                        </View>
                        <Text style={styles.profileChartHourLabel}>
                          {String(hour).padStart(2, "0")}
                        </Text>
                      </View>
                    );
                  })}
                </View>
                <Text style={styles.profileChartToggleText}>
                  {showHourlyDetails
                    ? "Piilota tuntikohtaiset tiedot"
                    : "Näytä tuntikohtaiset tiedot"}
                </Text>
              </Pressable>
            </>
          ) : (
            <Text style={styles.profileEmptyText}>
              Tuntikohtaisia profiilitietoja ei ole saatavilla.
            </Text>
          )}

          {showHourlyDetails && highestProfileHour ? (
            <View style={styles.profileHourList}>
              {profileHours.map(({ drop, hour, observationDays }) => {
                const isHighest = hour === highestProfileHour.hour;
                const nextHour = (hour + 1) % 24;

                return (
                  <View
                    key={hour}
                    style={[
                      styles.profileHourRow,
                      isHighest && styles.profileHourRowHighest,
                    ]}
                  >
                    <Text
                      style={[
                        styles.profileHourLabel,
                        isHighest && styles.profileHourTextHighest,
                      ]}
                    >
                      {String(hour).padStart(2, "0")}–
                      {String(nextHour).padStart(2, "0")}
                    </Text>
                    <Text
                      style={[
                        styles.profileHourDrop,
                        isHighest && styles.profileHourTextHighest,
                      ]}
                    >
                      {formatProfileDrop(drop)} °C/h
                    </Text>
                    <Text style={styles.profileHourObservations}>
                      {observationDays} pv
                    </Text>
                  </View>
                );
              })}
            </View>
          ) : null}
        </View>

        <Pressable
          accessibilityRole="button"
          onPress={() => router.push("/heating-learning")}
          style={styles.diagnosticsLink}
        >
          <Text style={styles.diagnosticsLinkText}>
            Lämmitystehon oppiminen
          </Text>
          <Text style={styles.diagnosticsLinkChevron}>›</Text>
        </Pressable>

        <Pressable
          accessibilityRole="button"
          onPress={handleSignOut}
          style={styles.signOutButton}
        >
          <Text style={styles.signOutButtonText}>Kirjaudu ulos</Text>
        </Pressable>
      </ScrollView>

      <Modal
        animationType="fade"
        onRequestClose={() => setSelectedSettingKey(null)}
        transparent
        visible={selectedSettingKey !== null}
      >
        <Pressable
          accessibilityRole="button"
          onPress={() => setSelectedSettingKey(null)}
          style={styles.selectorOverlay}
        >
          <Pressable style={styles.selectorCard}>
            <Text style={styles.selectorTitle}>{selectedRow?.label}</Text>
            {selectedSettingKey && selectedSetting ? (
              <ScrollView
                showsVerticalScrollIndicator={false}
                style={styles.selectorOptions}
              >
                {selectedSettingOptions.map((option) => (
                  <Pressable
                    accessibilityRole="button"
                    disabled={isSavingSettings}
                    key={option}
                    onPress={() => updateSetting(selectedSettingKey, option)}
                    style={styles.selectorOption}
                  >
                    <Text style={styles.selectorOptionText}>
                      {option} {selectedSetting.unit}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: "#050816",
    flex: 1,
    overflow: "hidden",
  },
  content: {
    flexGrow: 1,
    paddingBottom: 34,
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  glow: {
    borderRadius: 999,
    height: 280,
    opacity: 0.24,
    position: "absolute",
    shadowOpacity: 0.55,
    shadowRadius: 72,
    width: 280,
  },
  greenGlow: {
    backgroundColor: "#54eaa0",
    boxShadow: "0 0 92px 44px rgba(84,234,160,0.28)",
    right: -150,
    shadowColor: "#54eaa0",
    top: 80,
  },
  blueGlow: {
    backgroundColor: "#5aa7ff",
    bottom: 70,
    boxShadow: "0 0 96px 46px rgba(90,167,255,0.26)",
    left: -170,
    shadowColor: "#5aa7ff",
  },
  headerRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14,
    marginBottom: 8,
  },
  backButton: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderColor: "rgba(255,255,255,0.16)",
    borderRadius: 999,
    borderWidth: 1,
    height: 44,
    justifyContent: "center",
    shadowColor: "#36f4d4",
    shadowOpacity: 0.2,
    shadowRadius: 14,
    width: 44,
  },
  backButtonText: {
    color: "#f7fbff",
    fontSize: 34,
    fontWeight: "700",
    lineHeight: 36,
    marginTop: -3,
  },
  heroCard: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.07)",
    borderColor: "rgba(255,255,255,0.14)",
    borderRadius: 28,
    borderWidth: 1,
    marginBottom: 14,
    paddingHorizontal: 22,
    paddingVertical: 14,
    shadowColor: "#36f4d4",
    shadowOpacity: 0.18,
    shadowRadius: 24,
  },
  heroIcon: {
    fontSize: 30,
    lineHeight: 34,
    marginBottom: 5,
    textAlign: "center",
  },
  heroTitle: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "900",
    letterSpacing: 0.8,
    textAlign: "center",
  },
  settingsCard: {
    backgroundColor: "rgba(255,255,255,0.07)",
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 24,
    borderWidth: 1,
    overflow: "hidden",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  settingsSection: {
    marginBottom: 10,
    paddingBottom: 8,
  },
  collapsibleSection: {
    backgroundColor: "rgba(255,255,255,0.035)",
    borderColor: "rgba(255,255,255,0.1)",
    borderRadius: 16,
    borderWidth: 1,
    marginVertical: 6,
    overflow: "hidden",
  },
  collapsibleSectionHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    minHeight: 72,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  collapsibleSectionHeaderPressed: {
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  collapsibleSectionHeaderText: {
    flex: 1,
    gap: 5,
  },
  collapsibleSectionTitle: {
    color: "#d9e9ff",
    fontSize: 14,
    fontWeight: "900",
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  collapsibleSectionSummary: {
    color: "#8ea4cf",
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 17,
  },
  collapsibleSectionChevron: {
    color: "#36f4d4",
    fontSize: 24,
    fontWeight: "900",
    lineHeight: 26,
    textAlign: "center",
    width: 28,
  },
  collapsibleSectionContent: {
    borderTopColor: "rgba(255,255,255,0.1)",
    borderTopWidth: 1,
    paddingHorizontal: 14,
    paddingTop: 4,
  },
  sectionLabel: {
    color: "#8ea4cf",
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 1,
    marginTop: 16,
    paddingBottom: 2,
    textTransform: "uppercase",
  },
  settingRow: {
    alignItems: "center",
    borderBottomColor: "rgba(255,255,255,0.09)",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 12,
    minHeight: 66,
    paddingVertical: 14,
  },
  settingAccent: {
    borderRadius: 999,
    height: 10,
    shadowOpacity: 0.5,
    shadowRadius: 10,
    width: 10,
  },
  settingLabel: {
    color: "#d9e9ff",
    fontSize: 15,
    fontWeight: "800",
  },
  settingTextGroup: {
    flex: 1,
    gap: 4,
  },
  settingDescription: {
    color: "#8ea4cf",
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 16,
  },
  settingValidationError: {
    color: "#ff9aa4",
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 17,
    paddingBottom: 8,
    paddingHorizontal: 22,
  },
  settingValidationWarning: {
    color: "#ffdc7a",
    fontSize: 12,
    fontWeight: "700",
    lineHeight: 17,
    paddingBottom: 8,
    paddingHorizontal: 22,
  },
  settingSubsectionLabel: {
    color: "#9aaaca",
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0.4,
    marginTop: 14,
    paddingBottom: 4,
  },
  modeSettingGroup: {
    borderBottomColor: "rgba(255,255,255,0.09)",
    borderBottomWidth: 1,
    gap: 10,
    paddingVertical: 14,
  },
  modeSettingHeader: {
    gap: 4,
  },
  modeSelector: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    gap: 4,
    padding: 4,
  },
  modeOption: {
    alignItems: "center",
    borderRadius: 10,
    flex: 1,
    justifyContent: "center",
    minHeight: 40,
    paddingHorizontal: 8,
    paddingVertical: 9,
  },
  modeOptionActive: {
    backgroundColor: "rgba(54,244,212,0.18)",
  },
  modeOptionPressed: {
    opacity: 0.72,
  },
  modeOptionText: {
    color: "#9fb0d2",
    fontSize: 13,
    fontWeight: "900",
    textAlign: "center",
  },
  modeOptionTextActive: {
    color: "#dffefa",
  },
  fallbackHeader: {
    alignItems: "center",
    borderBottomColor: "rgba(255,255,255,0.09)",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 12,
    paddingVertical: 14,
  },
  backupHourGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingTop: 14,
  },
  backupHourButton: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.06)",
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 10,
    borderWidth: 1,
    minWidth: 64,
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  backupHourButtonActive: {
    backgroundColor: "rgba(54,244,212,0.18)",
    borderColor: "rgba(54,244,212,0.5)",
  },
  backupHourText: {
    color: "#9fb0d2",
    fontSize: 12,
    fontWeight: "900",
  },
  backupHourTextActive: {
    color: "#dffefa",
  },
  settingInputGroup: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    marginLeft: "auto",
  },
  settingInput: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "800",
    minWidth: 44,
    padding: 0,
    textAlign: "right",
  },
  settingRowWithAction: {
    borderBottomColor: "rgba(255,255,255,0.09)",
    borderBottomWidth: 1,
    paddingVertical: 14,
  },
  settingRowMainAction: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    minHeight: 38,
  },
  settingValue: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "900",
    letterSpacing: -0.2,
    textAlign: "right",
  },
  calibrateButton: {
    alignItems: "center",
    alignSelf: "flex-end",
    backgroundColor: "rgba(54,244,212,0.14)",
    borderColor: "rgba(54,244,212,0.34)",
    borderRadius: 14,
    borderWidth: 1,
    marginTop: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  calibrateButtonPressed: {
    opacity: 0.62,
  },
  calibrateButtonText: {
    color: "#dffefa",
    fontSize: 13,
    fontWeight: "900",
  },
  settingsSavePanel: {
    backgroundColor: "rgba(255,255,255,0.07)",
    borderColor: "rgba(255,255,255,0.14)",
    borderRadius: 8,
    borderWidth: 1,
    gap: 10,
    marginTop: 14,
    padding: 14,
  },
  unsavedSettingsText: {
    color: "#ffdc7a",
    fontSize: 13,
    fontWeight: "900",
  },
  validationSummary: {
    gap: 4,
  },
  validationSummaryErrorTitle: {
    color: "#ff9aa4",
    fontSize: 12,
    fontWeight: "900",
  },
  validationSummaryErrorText: {
    color: "#ffc1c7",
    fontSize: 12,
    fontWeight: "600",
    lineHeight: 17,
  },
  validationSummaryWarningTitle: {
    color: "#ffdc7a",
    fontSize: 12,
    fontWeight: "900",
  },
  validationSummaryWarningText: {
    color: "#ffe9a8",
    fontSize: 12,
    fontWeight: "600",
    lineHeight: 17,
  },
  saveFeedback: {
    fontSize: 12,
    fontWeight: "800",
    lineHeight: 17,
  },
  saveFeedbackSuccess: {
    color: "#72ff9d",
  },
  saveFeedbackError: {
    color: "#ff9aa4",
  },
  savingSettingsText: {
    color: "#9fc7ff",
    fontSize: 12,
    fontWeight: "800",
  },
  settingsSaveActions: {
    flexDirection: "row",
    gap: 8,
  },
  cancelSettingsButton: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.06)",
    borderColor: "rgba(255,255,255,0.16)",
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    justifyContent: "center",
    minHeight: 46,
    paddingHorizontal: 8,
  },
  cancelSettingsButtonText: {
    color: "#cfe0ff",
    fontSize: 13,
    fontWeight: "900",
    textAlign: "center",
  },
  saveSettingsButton: {
    alignItems: "center",
    backgroundColor: "rgba(54,244,212,0.18)",
    borderColor: "rgba(54,244,212,0.48)",
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    justifyContent: "center",
    minHeight: 46,
    paddingHorizontal: 8,
  },
  saveSettingsButtonText: {
    color: "#dffefa",
    fontSize: 13,
    fontWeight: "900",
    textAlign: "center",
  },
  settingsActionDisabled: {
    opacity: 0.4,
  },
  settingsActionPressed: {
    opacity: 0.72,
  },
  diagnosticsLink: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 18,
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 24,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  diagnosticsLinkText: {
    color: "#cfe9ff",
    fontSize: 14,
    fontWeight: "800",
  },
  diagnosticsLinkChevron: {
    color: "#cfe9ff",
    fontSize: 18,
    fontWeight: "900",
  },
  signOutButton: {
    alignItems: "center",
    backgroundColor: "rgba(255,95,109,0.14)",
    borderColor: "rgba(255,95,109,0.38)",
    borderRadius: 18,
    borderWidth: 1,
    marginTop: 16,
    paddingVertical: 14,
  },
  profileCard: {
    backgroundColor: "rgba(255,255,255,0.07)",
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 24,
    borderWidth: 1,
    marginTop: 14,
    padding: 16,
  },
  profileError: {
    color: "#ff9aa4",
    fontSize: 12,
    fontWeight: "800",
    marginTop: 10,
  },
  profileHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
  },
  profileHeaderText: {
    flex: 1,
    gap: 4,
  },
  profileChart: {
    alignItems: "flex-end",
    flexDirection: "row",
    height: 84,
  },
  profileChartBar: {
    borderRadius: 3,
    minHeight: 4,
    opacity: 0.84,
    width: "72%",
  },
  profileChartBarArea: {
    alignItems: "center",
    height: 66,
    justifyContent: "flex-end",
    width: "100%",
  },
  profileChartBarHighest: {
    backgroundColor: "#ff5f6d",
    opacity: 1,
    shadowColor: "#ff5f6d",
    shadowOpacity: 0.5,
    shadowRadius: 6,
  },
  profileChartButton: {
    backgroundColor: "rgba(255,255,255,0.04)",
    borderColor: "rgba(255,255,255,0.1)",
    borderRadius: 14,
    borderWidth: 1,
    marginTop: 10,
    paddingHorizontal: 8,
    paddingTop: 10,
  },
  profileChartButtonPressed: {
    opacity: 0.72,
  },
  profileChartColumn: {
    alignItems: "center",
    flex: 1,
    minWidth: 0,
  },
  profileChartHourLabel: {
    color: "rgba(207,233,255,0.55)",
    fontSize: 7,
    fontWeight: "800",
    lineHeight: 12,
    textAlign: "center",
  },
  profileChartToggleText: {
    color: "#9fb0d2",
    fontSize: 11,
    fontWeight: "900",
    paddingBottom: 9,
    textAlign: "center",
  },
  profileEmptyText: {
    color: "#8ea4cf",
    fontSize: 12,
    fontWeight: "700",
    marginTop: 14,
    textAlign: "center",
  },
  profileHighestText: {
    color: "#d9e9ff",
    fontSize: 12,
    fontWeight: "900",
    marginTop: 14,
  },
  profileHourDrop: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "900",
  },
  profileHourList: {
    borderColor: "rgba(255,255,255,0.1)",
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 14,
    overflow: "hidden",
  },
  profileHourRow: {
    alignItems: "center",
    borderBottomColor: "rgba(255,255,255,0.07)",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 8,
    justifyContent: "space-between",
    minHeight: 34,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  profileHourRowHighest: {
    backgroundColor: "rgba(255,95,109,0.12)",
  },
  profileHourLabel: {
    color: "#8ea4cf",
    fontSize: 12,
    fontWeight: "900",
    width: 54,
  },
  profileHourObservations: {
    color: "#8ea4cf",
    fontSize: 11,
    fontWeight: "700",
    textAlign: "right",
    width: 42,
  },
  profileHourTextHighest: {
    color: "#ff8d98",
  },
  profileMetadata: {
    gap: 8,
    marginTop: 14,
  },
  profileMetadataLabel: {
    color: "#8ea4cf",
    fontSize: 12,
    fontWeight: "800",
  },
  profileMetadataRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 12,
    justifyContent: "space-between",
  },
  profileMetadataValue: {
    color: "#d9e9ff",
    flex: 1,
    fontSize: 12,
    fontWeight: "800",
    textAlign: "right",
  },
  profileRefreshButton: {
    backgroundColor: "rgba(54,244,212,0.14)",
    borderColor: "rgba(54,244,212,0.34)",
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  profileRefreshButtonPressed: {
    opacity: 0.6,
  },
  profileRefreshButtonText: {
    color: "#dffefa",
    fontSize: 12,
    fontWeight: "900",
  },
  profileStatus: {
    color: "#ffcf5a",
    fontSize: 12,
    fontWeight: "900",
  },
  profileStatusFresh: {
    color: "#54eaa0",
  },
  profileTitle: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "900",
  },
  signOutButtonText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "900",
  },
  selectorCard: {
    backgroundColor: "#10172a",
    borderColor: "rgba(255,255,255,0.16)",
    borderRadius: 24,
    borderWidth: 1,
    padding: 18,
    width: "82%",
  },
  selectorOption: {
    borderBottomColor: "rgba(255,255,255,0.09)",
    borderBottomWidth: 1,
    paddingVertical: 14,
  },
  selectorOptions: {
    marginTop: 8,
    maxHeight: 360,
  },
  selectorOptionText: {
    color: "#ffffff",
    fontSize: 17,
    fontWeight: "900",
    textAlign: "center",
  },
  selectorOverlay: {
    alignItems: "center",
    backgroundColor: "rgba(5,8,22,0.72)",
    flex: 1,
    justifyContent: "center",
    padding: 20,
  },
  selectorTitle: {
    color: "#d9e9ff",
    fontSize: 18,
    fontWeight: "900",
    textAlign: "center",
  },
});
