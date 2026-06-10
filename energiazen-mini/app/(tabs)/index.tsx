import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

const tankTemperature = 58;
const warmWaterHours = 17;
const nextCheapPeriod = "01:00–05:00";
const priceApiUrl = "https://api.spot-hinta.fi/TodayAndDayForward?region=FI&priceResolution=60";
const hoursToShow = 24;

const helsinkiTimeFormatter = new Intl.DateTimeFormat("fi-FI", {
  hour: "2-digit",
  hour12: false,
  timeZone: "Europe/Helsinki",
});

type SpotPriceResponse = {
  DateTime?: string | null;
  PriceNoTax?: number | null;
  PriceWithTax?: number | null;
};

type HourlyPrice = {
  date: Date;
  endDate: Date;
  hourLabel: string;
  id: string;
  price: number;
};

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

function normalizePriceToCents(value: number) {
  return value < 1 ? value * 100 : value;
}

function formatFinnishDecimal(value: number) {
  return value.toFixed(1).replace(".", ",");
}

function formatHourLabel(date: Date) {
  return `${helsinkiTimeFormatter.format(date).replace(".", "")}:00`;
}

function startOfCurrentHour(date = new Date()) {
  const currentHour = new Date(date);
  currentHour.setMinutes(0, 0, 0);
  return currentHour;
}

function normalizeSpotPrices(data: SpotPriceResponse[]) {
  const currentHour = startOfCurrentHour();

  return data
    .map((item) => {
      const price = item.PriceWithTax ?? item.PriceNoTax;
      const date = item.DateTime ? new Date(item.DateTime) : null;

      if (!date || Number.isNaN(date.getTime()) || typeof price !== "number" || Number.isNaN(price)) {
        return null;
      }

      return {
        date,
        endDate: new Date(date.getTime() + 60 * 60 * 1000),
        hourLabel: formatHourLabel(date),
        id: item.DateTime ?? date.toISOString(),
        price: normalizePriceToCents(price),
      } satisfies HourlyPrice;
    })
    .filter((item): item is HourlyPrice => item !== null)
    .filter((item) => item.endDate.getTime() > currentHour.getTime())
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .slice(0, hoursToShow);
}

export default function HomeScreen() {
  const pulseAnimation = useRef(new Animated.Value(0)).current;
  const [hourlyPrices, setHourlyPrices] = useState<HourlyPrice[]>([]);
  const [isPriceLoading, setIsPriceLoading] = useState(true);
  const [selectedHourlyPrice, setSelectedHourlyPrice] = useState<HourlyPrice | null>(null);
  const currentHourStart = startOfCurrentHour();
  const currentPriceItem = hourlyPrices.find(
    (item) => item.date.getTime() <= Date.now() && item.endDate.getTime() > Date.now()
  );
  const currentPrice = currentPriceItem?.price ?? null;
  const { ringColor, status } = currentPrice === null ? { ringColor: "#36f4d4", status: "" } : getPriceTheme(currentPrice);
  const maxChartPrice = Math.max(...hourlyPrices.map((item) => Math.max(item.price, 0)), 1);
  const cheapestHour = hourlyPrices.reduce<HourlyPrice | null>((cheapest, item) => (!cheapest || item.price < cheapest.price ? item : cheapest), null);
  const mostExpensiveHour = hourlyPrices.reduce<HourlyPrice | null>(
    (mostExpensive, item) => (!mostExpensive || item.price > mostExpensive.price ? item : mostExpensive),
    null
  );

  useEffect(() => {
    const controller = new AbortController();

    async function fetchHourlyPrices() {
      setIsPriceLoading(true);
      try {
        const response = await fetch(priceApiUrl, { signal: controller.signal });

        if (!response.ok) {
          throw new Error("Price fetch failed");
        }

        const data = (await response.json()) as SpotPriceResponse[];
        const prices = normalizeSpotPrices(data);

        if (prices.length === 0) {
          throw new Error("Hourly prices missing from response");
        }

        setHourlyPrices(prices);
        setSelectedHourlyPrice((selected) => {
          if (!selected) {
            return prices.find((item) => item.date.getTime() <= Date.now() && item.endDate.getTime() > Date.now()) ?? prices[0];
          }

          return prices.find((item) => item.id === selected.id) ?? prices[0];
        });
      } catch {
        if (!controller.signal.aborted) {
          setHourlyPrices([]);
          setSelectedHourlyPrice(null);
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsPriceLoading(false);
        }
      }
    }

    fetchHourlyPrices();

    return () => controller.abort();
  }, []);

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
            {currentPrice === null ? (
              <Text style={styles.priceMessage}>{isPriceLoading ? "Haetaan hintaa..." : "Hintaa ei saatavilla"}</Text>
            ) : (
              <>
                <Text style={[styles.status, { color: ringColor }]}>{status}</Text>
                <Text style={styles.price}>{formatFinnishDecimal(currentPrice)}</Text>
                <Text style={styles.unit}>c/kWh</Text>
              </>
            )}
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

          {isPriceLoading && hourlyPrices.length === 0 ? (
            <Text style={styles.chartMessage}>Haetaan seuraavan 24 tunnin hintoja...</Text>
          ) : hourlyPrices.length === 0 ? (
            <Text style={styles.chartMessage}>Hintakaaviota ei saatavilla</Text>
          ) : (
            <>
              <View style={styles.chartBars}>
                {hourlyPrices.map((item) => {
                  const isCurrentHour = item.date.getTime() <= currentHourStart.getTime() && item.endDate.getTime() > currentHourStart.getTime();
                  const isCheapest = cheapestHour?.id === item.id;
                  const isMostExpensive = mostExpensiveHour?.id === item.id;
                  const isSelected = selectedHourlyPrice?.id === item.id;
                  const barHeight = 18 + (Math.max(item.price, 0) / maxChartPrice) * 64;
                  const barColor = isCheapest ? "#72ff9d" : isMostExpensive ? "#ff5f6d" : getPriceTheme(item.price).ringColor;

                  return (
                    <Pressable
                      accessibilityLabel={`${item.hourLabel}, ${formatFinnishDecimal(item.price)} senttiä kilowattitunnilta`}
                      accessibilityRole="button"
                      key={item.id}
                      onPress={() => setSelectedHourlyPrice(item)}
                      style={styles.chartBarButton}
                    >
                      <View
                        style={[
                          styles.chartBar,
                          {
                            backgroundColor: barColor,
                            borderColor: isCurrentHour ? "#ffffff" : isSelected ? "rgba(255,255,255,0.72)" : "transparent",
                            height: barHeight,
                            shadowColor: barColor,
                          },
                          isCurrentHour && styles.currentChartBar,
                          isSelected && styles.selectedChartBar,
                        ]}
                      />
                    </Pressable>
                  );
                })}
              </View>

              <View style={styles.chartTimes}>
                <Text style={styles.chartTime}>{hourlyPrices[0]?.hourLabel ?? "--:--"}</Text>
                <Text style={styles.chartTime}>{hourlyPrices[Math.floor(hourlyPrices.length / 2)]?.hourLabel ?? "--:--"}</Text>
                <Text style={styles.chartTime}>{hourlyPrices[hourlyPrices.length - 1]?.hourLabel ?? "--:--"}</Text>
              </View>

              {selectedHourlyPrice ? (
                <Text style={styles.selectedPriceText}>
                  {selectedHourlyPrice.hourLabel}: {formatFinnishDecimal(selectedHourlyPrice.price)} c/kWh
                </Text>
              ) : null}

              <View style={styles.extremePrices}>
                <Text style={styles.extremePriceText}>
                  Halvin tunti: {cheapestHour ? `${cheapestHour.hourLabel} (${formatFinnishDecimal(cheapestHour.price)} c/kWh)` : "--"}
                </Text>
                <Text style={styles.extremePriceText}>
                  Kallein tunti: {mostExpensiveHour ? `${mostExpensiveHour.hourLabel} (${formatFinnishDecimal(mostExpensiveHour.price)} c/kWh)` : "--"}
                </Text>
              </View>
            </>
          )}
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
    paddingTop: 58,
  },
  glow: {
    borderRadius: 999,
    height: 280,
    opacity: 0.27,
    position: "absolute",
    shadowOpacity: 0.55,
    shadowRadius: 72,
    width: 280,
  },
  greenGlow: {
    backgroundColor: "#54eaa0",
    boxShadow: "0 0 92px 44px rgba(84,234,160,0.32)",
    right: -150,
    shadowColor: "#54eaa0",
    top: 80,
  },
  blueGlow: {
    backgroundColor: "#5aa7ff",
    bottom: 70,
    boxShadow: "0 0 96px 46px rgba(90,167,255,0.3)",
    left: -170,
    shadowColor: "#5aa7ff",
  },
  header: {
    alignItems: "center",
    marginBottom: 12,
  },
  title: {
    color: "#f7fbff",
    fontSize: 28,
    fontWeight: "900",
    letterSpacing: -0.4,
    textAlign: "center",
  },
  subtitle: {
    color: "#b9d7ff",
    fontSize: 15,
    fontWeight: "700",
    marginTop: 5,
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
  chartBarButton: {
    alignItems: "center",
    flex: 1,
    height: 92,
    justifyContent: "flex-end",
  },
  chartBar: {
    borderRadius: 8,
    borderWidth: 1.5,
    opacity: 0.9,
    shadowOpacity: 0.25,
    shadowRadius: 8,
    width: "100%",
  },
  currentChartBar: {
    opacity: 1,
    shadowOpacity: 0.72,
    shadowRadius: 14,
  },
  selectedChartBar: {
    opacity: 1,
    transform: [{ translateY: -4 }],
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
  chartMessage: {
    color: "#cfe9ff",
    fontSize: 15,
    fontWeight: "800",
    paddingVertical: 34,
    textAlign: "center",
  },
  selectedPriceText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "900",
    marginTop: 12,
    textAlign: "center",
  },
  extremePrices: {
    borderTopColor: "rgba(255,255,255,0.1)",
    borderTopWidth: 1,
    gap: 6,
    marginTop: 14,
    paddingTop: 14,
  },
  extremePriceText: {
    color: "#d9e9ff",
    fontSize: 14,
    fontWeight: "800",
    textAlign: "center",
  },
});
