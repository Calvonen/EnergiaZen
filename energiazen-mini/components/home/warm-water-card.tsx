import { Pressable, StyleSheet, Text, View } from "react-native";

function getWarmWaterCardTheme() {
  const accent = "#26d9d2";

  return {
    backgroundColor: `${accent}2b`,
    borderColor: `${accent}a8`,
    fillColor: accent,
    shadowColor: "#16bfc8",
    surfaceColor: "#d9fff9",
  };
}

export type WarmWaterCardProps = {
  averageTempLabel: string;
  fillPercent: number;
  onPress: () => void;
  showersAccessibilityLabel: string;
  showersLabel: string;
};

export function WarmWaterCard({
  averageTempLabel,
  fillPercent,
  onPress,
  showersAccessibilityLabel,
  showersLabel,
}: WarmWaterCardProps) {
  const theme = getWarmWaterCardTheme();

  return (
    <View
      style={[
        styles.metricCard,
        styles.waterCard,
        {
          backgroundColor: theme.backgroundColor,
          borderColor: theme.borderColor,
          shadowColor: theme.shadowColor,
        },
      ]}
    >
      <Pressable
        accessibilityLabel={`Lämmintä vettä ${showersAccessibilityLabel}`}
        accessibilityRole="button"
        android_ripple={{ color: "rgba(255,255,255,0.1)" }}
        onPress={onPress}
        style={({ pressed }) => [
          styles.metricCardPressable,
          pressed && styles.pressedMetricCard,
        ]}
      >
        <View style={styles.cardLabelRow}>
          <Text style={styles.cardIcon}>💧</Text>
          <Text style={styles.cardLabel}>Lämmin vesi</Text>
        </View>
        <View style={styles.warmWaterContent}>
          <View style={styles.warmWaterTankArea}>
            <View style={styles.tankVisual}>
              <View
                style={[
                  styles.tankFill,
                  {
                    backgroundColor: theme.fillColor,
                    height: `${fillPercent}%`,
                    shadowColor: theme.shadowColor,
                  },
                ]}
              />
              <View
                style={[
                  styles.tankSurface,
                  {
                    backgroundColor: theme.surfaceColor,
                    bottom: `${fillPercent}%`,
                  },
                ]}
              />
              <View style={[styles.tankBubble, styles.tankBubbleOne]} />
              <View style={[styles.tankBubble, styles.tankBubbleTwo]} />
              <View style={[styles.tankBubble, styles.tankBubbleThree]} />
              <Text style={styles.tankAverageTemperature}>
                {averageTempLabel}
              </Text>
            </View>
          </View>
          <View style={styles.waterShowersInfo}>
            <Text style={styles.waterValue}>{showersLabel}</Text>
            <Text numberOfLines={1} style={styles.waterDescriptionText}>
              Lämmintä suihkua jäljellä
            </Text>
          </View>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  metricCard: {
    alignItems: "center",
    borderRadius: 28,
    borderWidth: 1.5,
    flex: 1,
    justifyContent: "space-between",
    minHeight: 160,
    overflow: "hidden",
    paddingHorizontal: 14,
    paddingVertical: 13,
    shadowOpacity: 0.38,
    shadowRadius: 24,
  },
  metricCardPressable: {
    alignItems: "center",
    flex: 1,
    justifyContent: "space-between",
    position: "relative",
    width: "100%",
  },
  waterCard: {
    shadowOpacity: 0.42,
  },
  warmWaterContent: {
    alignItems: "stretch",
    alignSelf: "stretch",
    flex: 1,
    justifyContent: "center",
    marginTop: 10,
    width: "100%",
  },
  warmWaterTankArea: {
    alignItems: "center",
    alignSelf: "stretch",
    flex: 1,
    justifyContent: "center",
    minHeight: 108,
    width: "100%",
  },
  pressedMetricCard: {
    opacity: 0.82,
  },
  cardLabelRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    minHeight: 24,
  },
  cardIcon: {
    fontSize: 18,
    lineHeight: 22,
    textAlign: "center",
  },
  cardLabel: {
    color: "rgba(247,251,255,0.82)",
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0.3,
    textAlign: "center",
    textTransform: "uppercase",
  },
  tankVisual: {
    backgroundColor: "rgba(2,11,30,0.42)",
    borderColor: "rgba(221,247,255,0.72)",
    borderRadius: 26,
    borderWidth: 2,
    height: 112,
    overflow: "hidden",
    position: "relative",
    width: 82,
  },
  tankFill: {
    backgroundColor: "#40d9ff",
    borderTopColor: "rgba(255,255,255,0.42)",
    borderTopWidth: 1,
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    shadowColor: "#40d9ff",
    shadowOpacity: 0.56,
    shadowRadius: 16,
  },
  tankSurface: {
    backgroundColor: "rgba(255,255,255,0.78)",
    borderRadius: 999,
    height: 3,
    left: 8,
    marginBottom: -1.5,
    position: "absolute",
    right: 8,
  },
  tankBubble: {
    backgroundColor: "rgba(255,255,255,0.78)",
    borderRadius: 999,
    height: 5,
    position: "absolute",
    width: 5,
  },
  tankBubbleOne: {
    bottom: 14,
    left: 16,
  },
  tankBubbleTwo: {
    bottom: 34,
    right: 14,
  },
  tankBubbleThree: {
    bottom: 48,
    left: 25,
    opacity: 0.72,
  },
  tankAverageTemperature: {
    color: "#ffffff",
    fontSize: 28,
    fontWeight: "900",
    left: 0,
    letterSpacing: -0.4,
    lineHeight: 32,
    position: "absolute",
    right: 0,
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.34)",
    textShadowOffset: { height: 1, width: 0 },
    textShadowRadius: 8,
    top: 39,
  },
  waterShowersInfo: {
    alignItems: "center",
    alignSelf: "stretch",
    marginTop: 8,
    width: "100%",
  },
  waterValue: {
    alignSelf: "stretch",
    color: "#f8fbff",
    fontSize: 18,
    fontWeight: "900",
    letterSpacing: -0.2,
    lineHeight: 22,
    textAlign: "center",
  },
  waterDescriptionText: {
    alignSelf: "stretch",
    color: "rgba(247,251,255,0.66)",
    fontSize: 9,
    fontWeight: "800",
    lineHeight: 11,
    marginTop: 1,
    textAlign: "center",
  },
});
