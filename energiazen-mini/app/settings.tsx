import { useEffect, useMemo, useState } from "react";
import { useRouter } from "expo-router";
import {
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
  loadSettings,
  saveSettings,
} from "@/lib/settings";

type SettingsRow = {
  accent: string;
  key?: EditableSettingKey;
  label: string;
  value: string;
};

const editableSettings = {
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
  showersAtMaxTemperature: {
    max: 10,
    min: 3,
    unit: "suihkua",
  },
  testTankTemperature: {
    max: 80,
    min: 20,
    unit: "°C",
  },
} as const satisfies Record<
  EditableSettingKey,
  { max: number; min: number; unit: string }
>;

export default function SettingsScreen() {
  const router = useRouter();
  const [settings, setSettings] = useState(defaultSettings);
  const [selectedSettingKey, setSelectedSettingKey] =
    useState<EditableSettingKey | null>(null);

  const settingsRows = useMemo(
    (): SettingsRow[] => [
      {
        accent: "#36f4d4",
        label: "Varaajan koko",
        value: `${settings.tankVolumeLiters} l`,
      },
      {
        accent: "#54eaa0",
        key: "heatingHoursPerDay",
        label: "Lämmitystarve",
        value: `${settings.heatingHoursPerDay} h / vrk`,
      },
      {
        accent: "#ffcf5a",
        key: "priceDifferenceThresholdCents",
        label: "Hintaeron raja",
        value: `${settings.priceDifferenceThresholdCents} c/kWh`,
      },
      {
        accent: "#5aa7ff",
        label: "Minimilämpö",
        value: `${settings.minTankTemperature} °C`,
      },
      {
        accent: "#ff5f6d",
        label: "Maksimilämpö",
        value: `${settings.maxTankTemperature} °C`,
      },
      {
        accent: "#b889ff",
        key: "showersAtMaxTemperature",
        label: "Täysi varaaja",
        value: `${settings.showersAtMaxTemperature} suihkua`,
      },
    ],
    [settings],
  );

  const testTemperatureRow = useMemo(
    (): SettingsRow => ({
      accent: "#ff8bd1",
      key: "testTankTemperature",
      label: "Varaajan lämpötila",
      value: `${settings.testTankTemperature} °C`,
    }),
    [settings.testTankTemperature],
  );

  const selectedRow = [...settingsRows, testTemperatureRow].find(
    (row) => row.key === selectedSettingKey,
  );
  const selectedSetting = selectedSettingKey
    ? editableSettings[selectedSettingKey]
    : null;
  const selectedSettingOptions = selectedSetting
    ? Array.from(
        { length: selectedSetting.max - selectedSetting.min + 1 },
        (_, index) => selectedSetting.min + index,
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
  };

  const updateSetting = (key: EditableSettingKey, value: number) => {
    saveUpdatedSettings({
      ...settings,
      [key]: value,
    });
    setSelectedSettingKey(null);
  };

  const updateTestTemperatureEnabled = (value: boolean) => {
    saveUpdatedSettings({
      ...settings,
      useTestTankTemperature: value,
    });
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
          <View style={styles.headerTextGroup}>
            <Text style={styles.eyebrow}>Lämmityslogiikka</Text>
            <Text style={styles.title}>Asetukset</Text>
          </View>
        </View>

        <View style={styles.heroCard}>
          <Text style={styles.heroIcon}>⚙️</Text>
          <Text style={styles.heroTitle}>Perusarvot</Text>
          <Text style={styles.heroDescription}>
            Näitä arvoja käytetään varaajan ohjauksen ja lämpimän veden arvion
            perustana.
          </Text>
        </View>

        <View style={styles.settingsCard}>
          {settingsRows.map((row) => {
            const rowContent = (
              <>
                <View
                  style={[
                    styles.settingAccent,
                    { backgroundColor: row.accent },
                  ]}
                />
                <Text style={styles.settingLabel}>{row.label}</Text>
                <Text style={styles.settingValue}>{row.value}</Text>
              </>
            );

            if (row.key) {
              const rowKey = row.key;

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
          })}

          <Text style={styles.sectionLabel}>Testitila</Text>
          <View style={styles.settingRow}>
            <View
              style={[
                styles.settingAccent,
                {
                  backgroundColor: settings.useTestTankTemperature
                    ? "#72ff9d"
                    : "#8ea4cf",
                },
              ]}
            />
            <Text style={styles.settingLabel}>Käytä testilämpötilaa</Text>
            <Switch
              accessibilityLabel="Käytä testilämpötilaa"
              onValueChange={updateTestTemperatureEnabled}
              thumbColor={
                settings.useTestTankTemperature ? "#f7fbff" : "#c3cee4"
              }
              trackColor={{
                false: "rgba(142,164,207,0.35)",
                true: "rgba(54,244,212,0.55)",
              }}
              value={settings.useTestTankTemperature}
            />
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={() => setSelectedSettingKey("testTankTemperature")}
            style={styles.settingRow}
          >
            <View
              style={[
                styles.settingAccent,
                { backgroundColor: testTemperatureRow.accent },
              ]}
            />
            <Text style={styles.settingLabel}>{testTemperatureRow.label}</Text>
            <Text style={styles.settingValue}>{testTemperatureRow.value}</Text>
          </Pressable>
        </View>
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
    paddingTop: 20,
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
    marginBottom: 20,
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
  headerTextGroup: {
    flex: 1,
  },
  eyebrow: {
    color: "#36f4d4",
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 1.1,
    textTransform: "uppercase",
  },
  title: {
    color: "#f7fbff",
    fontSize: 32,
    fontWeight: "900",
    letterSpacing: -0.8,
    marginTop: 3,
  },
  heroCard: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.07)",
    borderColor: "rgba(255,255,255,0.14)",
    borderRadius: 28,
    borderWidth: 1,
    marginBottom: 16,
    paddingHorizontal: 22,
    paddingVertical: 24,
    shadowColor: "#36f4d4",
    shadowOpacity: 0.18,
    shadowRadius: 24,
  },
  heroIcon: {
    fontSize: 34,
    lineHeight: 40,
    marginBottom: 8,
  },
  heroTitle: {
    color: "#ffffff",
    fontSize: 23,
    fontWeight: "900",
    letterSpacing: -0.3,
  },
  heroDescription: {
    color: "#b9d7ff",
    fontSize: 14,
    fontWeight: "700",
    lineHeight: 20,
    marginTop: 9,
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
    flex: 1,
    fontSize: 15,
    fontWeight: "800",
  },
  settingValue: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "900",
    letterSpacing: -0.2,
    textAlign: "right",
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
