import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from "react-native";

export type PriceCardProps = {
  accessibilityLabel: string;
  hasPrice: boolean;
  isPriceLoading: boolean;
  onPress: () => void;
  priceLabel: string;
  pulseStyle: Animated.WithAnimatedValue<ViewStyle>;
  ringColor: string;
  totalPriceLabel: string;
};

export function PriceCard({
  accessibilityLabel,
  hasPrice,
  isPriceLoading,
  onPress,
  priceLabel,
  pulseStyle,
  ringColor,
  totalPriceLabel,
}: PriceCardProps) {
  return (
    <View style={styles.ringStage}>
      <Animated.View
        style={[
          styles.pulse,
          pulseStyle,
          { borderColor: ringColor, shadowColor: ringColor },
        ]}
      />
      <Pressable
        accessibilityHint="Avaa sähkön hintahistorian"
        accessibilityLabel={accessibilityLabel}
        accessibilityRole="button"
        android_ripple={{ color: "rgba(255,255,255,0.1)" }}
        onPress={onPress}
        style={({ pressed }) => [
          styles.ring,
          { borderColor: ringColor, shadowColor: ringColor },
          pressed && styles.pressedRing,
        ]}
      >
        {!hasPrice ? (
          <Text style={styles.priceMessage}>
            {isPriceLoading ? "Haetaan hintaa..." : "Hintaa ei saatavilla"}
          </Text>
        ) : (
          <>
            <Text style={styles.price}>{priceLabel}</Text>
            <Text style={styles.unit}>c/kWh</Text>
            <View style={styles.totalPriceBlock}>
              <Text style={styles.totalPriceLabel}>Yhteensä</Text>
              <Text style={styles.totalPriceValue}>
                {totalPriceLabel}
                {" c/kWh"}
              </Text>
            </View>
          </>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  ringStage: {
    alignItems: "center",
    height: 286,
    justifyContent: "center",
    marginBottom: 18,
    width: 286,
  },
  pulse: {
    borderRadius: 143,
    borderWidth: 2,
    height: 286,
    position: "absolute",
    shadowOpacity: 0.8,
    shadowRadius: 32,
    width: 286,
  },
  ring: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.07)",
    borderRadius: 122,
    borderWidth: 5,
    height: 244,
    justifyContent: "center",
    shadowOpacity: 0.85,
    shadowRadius: 34,
    width: 244,
  },
  pressedRing: {
    opacity: 0.86,
    transform: [{ scale: 0.98 }],
  },
  price: {
    color: "#ffffff",
    fontSize: 68,
    fontWeight: "900",
    letterSpacing: -2,
  },
  priceMessage: {
    color: "#ffffff",
    fontSize: 23,
    fontWeight: "900",
    lineHeight: 31,
    paddingHorizontal: 28,
    textAlign: "center",
  },
  unit: {
    color: "#cfe9ff",
    fontSize: 18,
    fontWeight: "700",
    marginTop: -4,
  },
  totalPriceBlock: {
    alignItems: "center",
    marginTop: 9,
  },
  totalPriceLabel: {
    color: "#9fc7df",
    fontSize: 12,
    fontWeight: "800",
    lineHeight: 15,
  },
  totalPriceValue: {
    color: "#e9fbff",
    fontSize: 17,
    fontWeight: "900",
    lineHeight: 21,
  },
});
