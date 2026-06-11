import { useRouter } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { defaultSettings } from "@/lib/settings";

const settingsRows = [
  {
    accent: "#36f4d4",
    label: "Varaajan koko",
    value: `${defaultSettings.tankVolumeLiters} l`,
  },
  {
    accent: "#54eaa0",
    label: "Lämmitystarve",
    value: `${defaultSettings.heatingHoursPerDay} h / vrk`,
  },
  {
    accent: "#ffcf5a",
    label: "Hintaeron raja",
    value: `${defaultSettings.priceDifferenceThresholdCents} c/kWh`,
  },
  {
    accent: "#5aa7ff",
    label: "Minimilämpö",
    value: `${defaultSettings.minTankTemperature} °C`,
  },
  {
    accent: "#ff5f6d",
    label: "Maksimilämpö",
    value: `${defaultSettings.maxTankTemperature} °C`,
  },
  {
    accent: "#b889ff",
    label: "Täysi varaaja",
    value: `${defaultSettings.showersAtMaxTemperature} suihkua`,
  },
] as const;

export default function SettingsScreen() {
  const router = useRouter();

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
          {settingsRows.map((row) => (
            <View key={row.label} style={styles.settingRow}>
              <View
                style={[styles.settingAccent, { backgroundColor: row.accent }]}
              />
              <Text style={styles.settingLabel}>{row.label}</Text>
              <Text style={styles.settingValue}>{row.value}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
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
});
