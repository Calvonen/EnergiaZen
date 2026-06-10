import { useEffect, useMemo, useRef } from "react";
import { Animated, ScrollView, StyleSheet, Text, View } from "react-native";

const currentPrice = 2.4;
const tankTemperature = 58;
const warmWaterHours = 17;
const nextCheapPeriod = "01:00–05:00";
const hourlyPrices = [9.4, 8.2, 5.1, 2.8, 2.4, 3.2, 6.8, 10.5, 13.2, 16.5, 18.1, 14.8, 10.9, 7.5, 4.8, 3.9, 5.7, 8.6, 12.4, 15.2, 11.1, 7.2, 4.3, 3.1];

function getPriceTheme(price: number) {
  if (price <= 3) {
    return { ringColor: "#72ff9d", status: "HALPA" };
  }

  if (price <= 8) {
    return { ringColor: "#36f4d4", status: "NORMAALI" };
  }

  if (price < 15) {
    return { ringColor: "#ffad4d", status: "NORMAALI" };
  }

  return { ringColor: "#ff5f6d", status: "KALLIS" };
}

function formatFinnishDecimal(value: number) {
  return value.toFixed(1).replace(".", ",");
}

export default function HomeScreen() {
  const pulseAnimation = useRef(new Animated.Value(0)).current;
  const { ringColor, status } = getPriceTheme(currentPrice);
  const maxChartPrice = Math.max(...hourlyPrices);

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnimation, {
          toValue: 1,
          duration: 1600,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnimation, {
          toValue: 0,
          duration: 1600,
          useNativeDriver: true,
        }),
      ])
    );

    animation.start();

    return () => animation.stop();
  }, [pulseAnimation]);

  const pulseStyle = useMemo(
    () => ({
      opacity: pulseAnimation.interpolate({
        inputRange: [0, 1],
        outputRange: [0.35, 0.08],
      }),
      transform: [
        {
          scale: pulseAnimation.interpolate({
            inputRange: [0, 1],
            outputRange: [1, 1.16],
          }),
        },
      ],
    }),
    [pulseAnimation]
  );

  return (
    <View style={styles.screen}>
      <View style={[styles.glow, styles.greenGlow]} />
      <View style={[styles.glow, styles.blueGlow]} />

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <Text style={styles.title}>⚡ EnergiaZen Mini</Text>
          <Text style={styles.subtitle}>Älykäs varaajan ohjaus</Text>
        </View>

        <View style={styles.ringStage}>
          <Animated.View style={[styles.pulse, pulseStyle, { borderColor: ringColor, shadowColor: ringColor }]} />
          <View style={[styles.ring, { borderColor: ringColor, shadowColor: ringColor }]}>
            <Text style={[styles.status, { color: ringColor }]}>{status}</Text>
            <Text style={styles.price}>{formatFinnishDecimal(currentPrice)}</Text>
            <Text style={styles.unit}>c/kWh</Text>
          </View>
        </View>

        <View style={styles.cardsRow}>
          <View style={styles.metricCard}>
            <Text style={styles.cardLabel}>🔥 Varaajan lämpötila</Text>
            <Text style={styles.cardValue}>{tankTemperature} °C</Text>
          </View>

          <View style={styles.metricCard}>
            <Text style={styles.cardLabel}>💧 Lämmin vesi riittää</Text>
            <Text style={styles.cardValue}>{warmWaterHours} h</Text>
          </View>
        </View>

        <View style={styles.cheapPeriodCard}>
          <Text style={styles.cheapPeriodLabel}>🌙 Seuraava halpa jakso</Text>
          <Text style={styles.cheapPeriodValue}>{nextCheapPeriod}</Text>
        </View>

        <View style={styles.chartCard}>
          <View style={styles.chartHeader}>
            <Text style={styles.chartTitle}>24 h hintakaavio</Text>
            <Text style={styles.chartUnit}>c/kWh</Text>
          </View>

          <View style={styles.chartBars}>
            {hourlyPrices.map((price, index) => {
              const barHeight = 18 + (price / maxChartPrice) * 64;
              const barColor = getPriceTheme(price).ringColor;

              return <View key={`${price}-${index}`} style={[styles.chartBar, { height: barHeight, backgroundColor: barColor }]} />;
            })}
          </View>

          <View style={styles.chartTimes}>
            <Text style={styles.chartTime}>00</Text>
            <Text style={styles.chartTime}>12</Text>
            <Text style={styles.chartTime}>24</Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#050816",
    overflow: "hidden",
  },
  content: {
    alignItems: "center",
    flexGrow: 1,
    justifyContent: "center",
    paddingBottom: 28,
    paddingHorizontal: 20,
    paddingTop: 46,
  },
  glow: {
    borderRadius: 999,
    height: 280,
    opacity: 0.26,
    shadowOpacity: 0.45,
    shadowRadius: 60,
    position: "absolute",
    width: 280,
  },
  greenGlow: {
    backgroundColor: "#49f0a5",
    shadowColor: "#49f0a5",
    right: -150,
    top: 80,
  },
  blueGlow: {
    backgroundColor: "#4b9dff",
    shadowColor: "#4b9dff",
    bottom: 70,
    left: -170,
  },
  header: {
    alignItems: "center",
    marginBottom: 14,
  },
  title: {
    color: "#f7fbff",
    fontSize: 27,
    fontWeight: "900",
    letterSpacing: -0.4,
    textAlign: "center",
  },
  subtitle: {
    color: "#9fb5de",
    fontSize: 15,
    fontWeight: "700",
    marginTop: 4,
    textAlign: "center",
  },
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
  status: {
    fontSize: 21,
    fontWeight: "900",
    letterSpacing: 2.2,
    marginBottom: 10,
    textShadowColor: "rgba(255,255,255,0.2)",
    textShadowRadius: 12,
  },
  price: {
    color: "#ffffff",
    fontSize: 68,
    fontWeight: "900",
    letterSpacing: -2,
  },
  unit: {
    color: "#cfe9ff",
    fontSize: 18,
    fontWeight: "700",
    marginTop: -4,
  },
  cardsRow: {
    flexDirection: "row",
    gap: 12,
    marginBottom: 14,
    width: "100%",
  },
  metricCard: {
    backgroundColor: "rgba(255,255,255,0.08)",
    borderColor: "rgba(125,232,255,0.24)",
    borderRadius: 24,
    borderWidth: 1,
    flex: 1,
    minHeight: 126,
    padding: 16,
    shadowColor: "#1df4c2",
    shadowOpacity: 0.18,
    shadowRadius: 18,
  },
  cardLabel: {
    color: "#b7c7ea",
    fontSize: 14,
    fontWeight: "800",
    lineHeight: 20,
  },
  cardValue: {
    color: "#ffffff",
    fontSize: 34,
    fontWeight: "900",
    marginTop: 18,
  },
  cheapPeriodCard: {
    alignItems: "center",
    backgroundColor: "rgba(54,244,212,0.09)",
    borderColor: "rgba(54,244,212,0.28)",
    borderRadius: 26,
    borderWidth: 1,
    marginBottom: 18,
    padding: 18,
    width: "100%",
  },
  cheapPeriodLabel: {
    color: "#bed1ff",
    fontSize: 16,
    fontWeight: "800",
  },
  cheapPeriodValue: {
    color: "#ffffff",
    fontSize: 30,
    fontWeight: "900",
    marginTop: 6,
  },
  chartCard: {
    backgroundColor: "rgba(255,255,255,0.07)",
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 24,
    borderWidth: 1,
    padding: 16,
    width: "100%",
  },
  chartHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  chartTitle: {
    color: "#f8fbff",
    fontSize: 16,
    fontWeight: "900",
  },
  chartUnit: {
    color: "#8ea4cf",
    fontSize: 13,
    fontWeight: "800",
  },
  chartBars: {
    alignItems: "flex-end",
    flexDirection: "row",
    gap: 4,
    height: 92,
  },
  chartBar: {
    borderRadius: 8,
    flex: 1,
    opacity: 0.9,
  },
  chartTimes: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 8,
  },
  chartTime: {
    color: "#8190b5",
    fontSize: 12,
    fontWeight: "800",
  },
});
