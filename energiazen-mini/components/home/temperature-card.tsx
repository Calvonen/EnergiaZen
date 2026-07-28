import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from "react-native";

export type TemperatureCardTheme = {
  backgroundColor: string;
  borderColor: string;
  shadowColor: string;
};

export type TemperatureCardTankUpdatedStatus = {
  isWarning: boolean;
  text: string;
};

export type TemperatureCardProps = {
  accessibilityLabel: string;
  bottomTempLabel: string;
  isTankHeating: boolean;
  onPress: () => void;
  pulseStyle: Animated.WithAnimatedValue<ViewStyle>;
  segmentColors: string[];
  tankUpdatedStatus: TemperatureCardTankUpdatedStatus | null;
  theme: TemperatureCardTheme;
  topTempLabel: string;
};

export function TemperatureCard({
  accessibilityLabel,
  bottomTempLabel,
  isTankHeating,
  onPress,
  pulseStyle,
  segmentColors,
  tankUpdatedStatus,
  theme,
  topTempLabel,
}: TemperatureCardProps) {
  return (
    <Animated.View
      style={[
        styles.metricCard,
        styles.temperatureCard,
        {
          backgroundColor: theme.backgroundColor,
          borderColor: theme.borderColor,
          shadowColor: theme.shadowColor,
        },
        isTankHeating && pulseStyle,
      ]}
    >
      <Pressable
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        android_ripple={{ color: "rgba(255,255,255,0.1)" }}
        onPress={onPress}
        style={({ pressed }) => [
          styles.metricCardPressable,
          pressed && styles.pressedMetricCard,
        ]}
      >
        <View style={styles.cardLabelRow}>
          <Text style={styles.cardIcon}>🔥</Text>
          <Text style={styles.cardLabel}>Varaaja</Text>
        </View>
        <View style={styles.temperatureStack}>
          <View style={styles.temperatureValues}>
            <View style={styles.temperatureReadings}>
              <View style={styles.temperatureTopSensor}>
                <Text style={styles.temperatureValue}>{topTempLabel}°</Text>
              </View>
              <View style={styles.temperatureBottomSensor}>
                <Text style={styles.temperatureLowValue}>
                  {bottomTempLabel}°
                </Text>
              </View>
            </View>
            {tankUpdatedStatus ? (
              <Text
                style={[
                  styles.tankUpdatedText,
                  tankUpdatedStatus.isWarning &&
                    styles.tankUpdatedWarningText,
                ]}
              >
                {tankUpdatedStatus.text}
              </Text>
            ) : null}
          </View>
          <View style={styles.temperatureBar} accessible={false}>
            {segmentColors.map((segmentColor, segmentIndex) => (
              <View
                key={`temperature-segment-${segmentIndex}`}
                style={[
                  styles.temperatureBarSegment,
                  {
                    backgroundColor: segmentColor,
                    shadowColor: segmentColor,
                  },
                ]}
              />
            ))}
          </View>
        </View>
      </Pressable>
    </Animated.View>
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
  temperatureCard: {
    borderWidth: 1.5,
    position: "relative",
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
  tankUpdatedText: {
    alignSelf: "stretch",
    color: "rgba(247,251,255,0.62)",
    fontSize: 9,
    fontWeight: "800",
    lineHeight: 11,
    marginBottom: 1,
    textAlign: "left",
  },
  tankUpdatedWarningText: {
    color: "#ffcf7a",
  },
  temperatureStack: {
    alignItems: "stretch",
    alignSelf: "stretch",
    flex: 1,
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
    marginRight: -5,
    marginTop: 8,
    paddingRight: 2,
    width: "100%",
  },
  temperatureValues: {
    alignSelf: "stretch",
    flex: 1,
    justifyContent: "space-between",
    minWidth: 0,
    paddingBottom: 1,
    paddingLeft: 4,
    paddingRight: 4,
  },
  temperatureReadings: {
    alignItems: "flex-start",
    flex: 1,
    justifyContent: "space-around",
    paddingBottom: 14,
    paddingTop: 2,
  },
  temperatureTopSensor: {
    alignItems: "flex-start",
    alignSelf: "center",
    marginRight: 6,
  },
  temperatureBottomSensor: {
    alignItems: "flex-start",
    alignSelf: "center",
    marginLeft: 4,
    marginTop: 12,
  },
  temperatureValue: {
    color: "#ffffff",
    fontSize: 46,
    fontWeight: "900",
    letterSpacing: -1.6,
    lineHeight: 48,
    textAlign: "right",
    textShadowColor: "rgba(0,0,0,0.24)",
    textShadowOffset: { height: 2, width: 0 },
    textShadowRadius: 10,
  },
  temperatureBar: {
    alignItems: "center",
    alignSelf: "stretch",
    gap: 4,
    justifyContent: "space-between",
    marginRight: 0,
  },
  temperatureBarSegment: {
    borderRadius: 7,
    flex: 1,
    minHeight: 8,
    shadowOpacity: 0.28,
    shadowRadius: 6,
    width: 13,
  },
  temperatureLowValue: {
    color: "rgba(247,251,255,0.86)",
    fontSize: 24,
    fontWeight: "900",
    letterSpacing: -0.6,
    lineHeight: 26,
    textAlign: "right",
    textShadowColor: "rgba(0,0,0,0.2)",
    textShadowOffset: { height: 1, width: 0 },
    textShadowRadius: 8,
  },
});
