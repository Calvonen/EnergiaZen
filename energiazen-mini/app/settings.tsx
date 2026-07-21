import { useCallback, useEffect, useMemo, useState } from "react";
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
  loadSettings,
  saveSettings,
} from "@/lib/settings";
import { supabase } from "@/lib/supabase";

type SettingsRow = {
  accent: string;
  description?: string;
  key?: EditableSettingKey;
  label: string;
  subheadingBefore?: string;
  value: string;
};

type SettingsSection = {
  rows: SettingsRow[];
  title: string;
};

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
  unit: string;
};

const editableSettings: Record<EditableSettingKey, EditableSettingOption> = {
  tankSizeLiters: {
    options: [200, 250, 290, 300, 500],
    unit: "l",
  },
  heatingHoursPerDay: {
    max: 6,
    min: 1,
    unit: "h / vrk",
  },
  priceDifferenceThresholdCents: {
    max: 10,
    min: 0,
    unit: "c/kWh",
  },
  fullTankShowers: {
    max: 10,
    min: 3,
    unit: "suihkua",
  },
  minimumShowersBeforeExpensiveTomorrow: {
    max: 8,
    min: 1,
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

export default function SettingsScreen() {
  const router = useRouter();
  const [settings, setSettings] = useState(defaultSettings);
  const [selectedSettingKey, setSelectedSettingKey] =
    useState<EditableSettingKey | null>(null);
  const [isCalibratingFullTank, setIsCalibratingFullTank] = useState(false);

  const settingsSections = useMemo(
    (): SettingsSection[] => [
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
        title: "Suihkulaskennan asetukset",
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
      {
        title: "Pörssisähkön ohjausasetukset",
        rows: [
          {
            accent: "#54eaa0",
            key: "heatingHoursPerDay",
            label: "Lämmitystarve h/vrk",
            value: `${settings.heatingHoursPerDay} h / vrk`,
          },
          {
            accent: "#ffcf5a",
            description:
              "Kuinka paljon huomisen halvimpien tuntien pitää olla tämän päivän tunteja halvempia, jotta lämmitystä siirretään.",
            key: "priceDifferenceThresholdCents",
            label: "Hintarajaero",
            subheadingBefore: "Lämmityksen siirto huomiselle",
            value: `${settings.priceDifferenceThresholdCents} c/kWh`,
          },
          {
            accent: "#36f4d4",
            description:
              "Lämmitystä voidaan siirtää huomiseen vain, jos suihkuja on vähintään tämä määrä.",
            key: "minimumShowersBeforeExpensiveTomorrow",
            label: "Vähimmäisvaraus suihkuina",
            value: `${settings.minimumShowersBeforeExpensiveTomorrow} suihkua`,
          },
        ],
      },
    ],
    [settings],
  );
  const settingsRows = settingsSections.flatMap((section) => section.rows);

  const selectedRow = settingsRows.find(
    (row) => row.key === selectedSettingKey,
  );
  const selectedSetting = selectedSettingKey
    ? editableSettings[selectedSettingKey]
    : null;
  const selectedSettingOptions = selectedSetting
    ? selectedSetting.options ??
      Array.from(
        { length: selectedSetting.max! - selectedSetting.min! + 1 },
        (_, index) => selectedSetting.min! + index,
      )
    : [];

  useEffect(() => {
    let isMounted = true;

    loadSettings().then((storedSettings) => {
      if (isMounted) {
        setSettings(storedSettings);
      }
    });

    return () => {
      isMounted = false;
    };
  }, []);

  const saveUpdatedSettings = (updatedSettings: typeof settings) => {
    setSettings(updatedSettings);
    saveSettings(updatedSettings).catch(() => undefined);
    void (async () => {
      try {
        const { error } = await supabase
          .from("heating_control_settings")
          .upsert(
            {
              id: 1,
              backup_hours: updatedSettings.backupHours,
              fallback_enabled: updatedSettings.fallbackEnabled,
              timezone: "Europe/Helsinki",
              updated_at: new Date().toISOString(),
            },
            { onConflict: "id" },
          );

        if (error) {
          console.warn("Failed to save heating control settings", error);
        }
      } catch (error: unknown) {
        console.warn("Failed to save heating control settings", error);
      }
    })();
  };

  const updateSetting = (key: EditableSettingKey, value: number) => {
    saveUpdatedSettings({
      ...settings,
      [key]: value,
    });
    setSelectedSettingKey(null);
  };

  const updateHeatingNeedMode = (heatingNeedMode: HeatingNeedMode) => {
    saveUpdatedSettings({
      ...settings,
      heatingNeedMode,
    });
  };

  const toggleBackupHour = (hour: number) => {
    const isSelected = settings.backupHours.includes(hour);

    if (
      isSelected &&
      settings.fallbackEnabled &&
      settings.backupHours.length === 1
    ) {
      return;
    }

    saveUpdatedSettings({
      ...settings,
      backupHours: isSelected
        ? settings.backupHours.filter((backupHour) => backupHour !== hour)
        : [...settings.backupHours, hour].sort((a, b) => a - b),
    });
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
          {settingsSections.map((section) => (
            <View key={section.title} style={styles.settingsSection}>
              <Text style={styles.sectionLabel}>{section.title}</Text>
              {section.title === "Pörssisähkön ohjausasetukset" ? (
                <View style={styles.modeSettingGroup}>
                  <View style={styles.modeSettingHeader}>
                    <Text style={styles.settingLabel}>
                      Lämmitystarpeen määritys
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
                </View>
              ) : null}
              {section.rows.map((row) => {
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
                            onPress={() => setSelectedSettingKey(rowKey)}
                            style={styles.settingRowMainAction}
                          >
                            {rowContent}
                          </Pressable>
                          <Pressable
                            accessibilityRole="button"
                            disabled={isCalibratingFullTank}
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
                  </View>
                );
              })}
            </View>
          ))}
          <View style={styles.settingsSection}>
            <Text style={styles.sectionLabel}>Varakäyttö</Text>
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
                onValueChange={(fallbackEnabled) => {
                  saveUpdatedSettings({
                    ...settings,
                    backupHours:
                      fallbackEnabled && settings.backupHours.length === 0
                        ? defaultSettings.backupHours
                        : settings.backupHours,
                    fallbackEnabled,
                  });
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
          </View>
        </View>

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
  signOutButton: {
    alignItems: "center",
    backgroundColor: "rgba(255,95,109,0.14)",
    borderColor: "rgba(255,95,109,0.38)",
    borderRadius: 18,
    borderWidth: 1,
    marginTop: 16,
    paddingVertical: 14,
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
