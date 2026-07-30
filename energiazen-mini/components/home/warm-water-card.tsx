import { Fragment } from "react";
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

// Säiliön mitat (täytyy täsmätä styles.tankVisual-tyyliin): koska
// absoluuttisesti sijoitetut lapset (esim. tankScaleLines) asemoituvat
// säiliön reunuksen SISÄPUOLELLE, asteikon numeroiden oma "rivikorkeus"
// pitää laskea samasta sisäkorkeudesta, jotta viivat ja numerot osuvat
// täsmälleen samalle korkeudelle.
const TANK_WIDTH = 86;
const TANK_HEIGHT = 168;
const TANK_BORDER_WIDTH = 2;
const TANK_INNER_HEIGHT = TANK_HEIGHT - TANK_BORDER_WIDTH * 2;
const SCALE_LABEL_LINE_HEIGHT = 11;
const PRIMARY_VALUE_LINE_HEIGHT = 34;

// Kevyt, pelkästään näytettävä asteikko säiliögrafiikan päälle. Käyttää
// samaa lineaarista lämpötila <-> suihkut-muunnosta kuin
// estimateShowersLeftFromWeightedTemperature (lib/heatingOptimizer.ts):
// suihkut jaetaan tasavälein 0..fullTankShowers, ja jokaista suihkumäärää
// vastaava lämpötila lasketaan samalla lineaarisella asteikolla
// minTankTemperature..fullTankAverageTemperature. Ei vaikuta eikä liity
// varsinaiseen (epälineaariseen) täyttöasteen laskentaan - pelkkä visuaalinen
// apuasteikko.
type TankScaleTick = {
  heightPercent: number;
  showers: number;
  temperature: number;
};

function buildTankScaleTicks({
  fullTankAverageTemperature,
  fullTankShowers,
  minTankTemperature,
}: {
  fullTankAverageTemperature: number;
  fullTankShowers: number;
  minTankTemperature: number;
}): TankScaleTick[] {
  const tickCount = Math.max(1, Math.round(fullTankShowers));

  return Array.from({ length: tickCount + 1 }, (_, index) => {
    const showers = tickCount - index;
    const ratio = showers / tickCount;
    const temperature =
      minTankTemperature +
      ratio * (fullTankAverageTemperature - minTankTemperature);

    return {
      heightPercent: (index / tickCount) * 100,
      showers,
      temperature: Math.round(temperature),
    };
  });
}

export type WarmWaterCardProps = {
  fillPercent: number;
  fullTankAverageTemperature: number;
  fullTankShowers: number;
  minTankTemperature: number;
  onPress: () => void;
  showersAccessibilityLabel: string;
  showersValueLabel: string;
  temperatureLabel: string;
};

export function WarmWaterCard({
  fillPercent,
  fullTankAverageTemperature,
  fullTankShowers,
  minTankTemperature,
  onPress,
  showersAccessibilityLabel,
  showersValueLabel,
  temperatureLabel,
}: WarmWaterCardProps) {
  const theme = getWarmWaterCardTheme();
  const scaleTicks = buildTankScaleTicks({
    fullTankAverageTemperature,
    fullTankShowers,
    minTankTemperature,
  });

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
          <Text style={styles.cardLabel}>Lämpimät suihkut</Text>
        </View>
        <View style={styles.warmWaterContent}>
          <View style={styles.warmWaterTankArea}>
            <View style={styles.tankScaleRow}>
              <View style={styles.scaleColumnLeft}>
                <View style={styles.scaleNumbers}>
                  {scaleTicks.map((tick) => (
                    <Text
                      allowFontScaling={false}
                      key={tick.showers}
                      style={[
                        styles.scaleNumberLeft,
                        { top: `${tick.heightPercent}%` },
                      ]}
                    >
                      {tick.showers}
                    </Text>
                  ))}
                </View>
                <Text allowFontScaling={false} style={styles.scaleShowerIcon}>
                  🚿
                </Text>
              </View>
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
                <View pointerEvents="none" style={styles.tankScaleLines}>
                  {scaleTicks.map((tick) => (
                    <Fragment key={tick.showers}>
                      <View
                        style={[
                          styles.tankScaleLineSegment,
                          styles.tankScaleLineLeft,
                          { top: `${tick.heightPercent}%` },
                        ]}
                      />
                      <View
                        style={[
                          styles.tankScaleLineSegment,
                          styles.tankScaleLineRight,
                          { top: `${tick.heightPercent}%` },
                        ]}
                      />
                    </Fragment>
                  ))}
                </View>
                <View style={[styles.tankBubble, styles.tankBubbleOne]} />
                <View style={[styles.tankBubble, styles.tankBubbleTwo]} />
                <View style={[styles.tankBubble, styles.tankBubbleThree]} />
                <Text style={styles.tankPrimaryValue}>{showersValueLabel}</Text>
              </View>
              <View style={styles.scaleColumnRight}>
                <View style={styles.scaleNumbers}>
                  {scaleTicks.map((tick) => (
                    <Text
                      allowFontScaling={false}
                      key={tick.showers}
                      style={[
                        styles.scaleNumberRight,
                        { top: `${tick.heightPercent}%` },
                      ]}
                    >
                      {tick.temperature}°
                    </Text>
                  ))}
                </View>
              </View>
            </View>
          </View>
          <Text style={styles.secondaryTemperatureValue}>
            {temperatureLabel}
          </Text>
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
    paddingVertical: 11,
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
    marginTop: 6,
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
    justifyContent: "center",
    minHeight: 18,
  },
  cardLabel: {
    color: "rgba(247,251,255,0.82)",
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0.3,
    textAlign: "center",
    textTransform: "uppercase",
  },
  tankScaleRow: {
    alignItems: "flex-start",
    flexDirection: "row",
  },
  scaleColumnLeft: {
    alignItems: "flex-end",
    marginRight: 10,
    width: 20,
  },
  scaleColumnRight: {
    alignItems: "flex-start",
    marginLeft: 10,
    width: 26,
  },
  scaleNumbers: {
    // Alkaa TANK_BORDER_WIDTHin verran alempaa ja on TANK_INNER_HEIGHTin
    // korkuinen, jotta 0-100% -pohjaiset top-arvot osuvat samalle
    // korkeudelle kuin tankScaleLines (joka on säiliön reunuksen sisällä).
    height: TANK_INNER_HEIGHT,
    marginTop: TANK_BORDER_WIDTH,
    position: "relative",
    width: "100%",
  },
  scaleNumberLeft: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 10,
    fontWeight: "800",
    lineHeight: SCALE_LABEL_LINE_HEIGHT,
    position: "absolute",
    right: 0,
    transform: [{ translateY: -SCALE_LABEL_LINE_HEIGHT / 2 }],
  },
  scaleNumberRight: {
    color: "rgba(255,255,255,0.55)",
    fontSize: 10,
    fontWeight: "800",
    left: 0,
    lineHeight: SCALE_LABEL_LINE_HEIGHT,
    position: "absolute",
    transform: [{ translateY: -SCALE_LABEL_LINE_HEIGHT / 2 }],
  },
  scaleShowerIcon: {
    fontSize: 12,
    marginTop: 4,
    textAlign: "center",
    width: "100%",
  },
  tankVisual: {
    backgroundColor: "rgba(2,11,30,0.42)",
    borderColor: "rgba(221,247,255,0.72)",
    borderRadius: 26,
    borderWidth: TANK_BORDER_WIDTH,
    height: TANK_HEIGHT,
    overflow: "hidden",
    position: "relative",
    width: TANK_WIDTH,
  },
  tankScaleLines: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  tankScaleLineSegment: {
    backgroundColor: "rgba(255,255,255,0.27)",
    height: 1,
    position: "absolute",
  },
  tankScaleLineLeft: {
    left: 0,
    width: "26%",
  },
  tankScaleLineRight: {
    right: 0,
    width: "26%",
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
  tankPrimaryValue: {
    color: "#ffffff",
    fontSize: 30,
    fontWeight: "900",
    left: 0,
    letterSpacing: -0.4,
    lineHeight: PRIMARY_VALUE_LINE_HEIGHT,
    position: "absolute",
    right: 0,
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.34)",
    textShadowOffset: { height: 1, width: 0 },
    textShadowRadius: 8,
    top: (TANK_HEIGHT - PRIMARY_VALUE_LINE_HEIGHT) / 2,
  },
  secondaryTemperatureValue: {
    color: "rgba(247,251,255,0.7)",
    fontSize: 18,
    fontWeight: "900",
    letterSpacing: -0.2,
    marginTop: 5,
    textAlign: "center",
  },
});
