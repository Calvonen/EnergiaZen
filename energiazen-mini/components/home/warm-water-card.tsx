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
const LIMIT_LABEL_LINE_HEIGHT = 14;
const PRIMARY_VALUE_LINE_HEIGHT = 34;
// Sama sininen kuin etusivun lämmityssuunnitelmakortin "Käytetyt rajat"
// -tekstissä (app/(tabs)/index.tsx: heatingPlanLimitsText/-Subtitle), jotta
// tavoite/turvaraja tunnistaa samaksi asiaksi kummassakin paikassa.
const LIMIT_COLOR = "#9fc7ff";

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

// Vasemman reunan suihkumäärä-asteikko: alkuperäinen, pelkkä kokonaisluku-
// ruudukko 0..fullTankShowers - ei riipu tavoite-/turvarajasta.
type TankScaleTick = {
  heightPercent: number;
  showers: number;
};

function buildTankScaleTicks(fullTankShowers: number): TankScaleTick[] {
  const tickCount = Math.max(1, Math.round(fullTankShowers));

  return Array.from({ length: tickCount + 1 }, (_, index) => {
    const showers = tickCount - index;

    return {
      heightPercent: (index / tickCount) * 100,
      showers,
    };
  });
}

// Oikea reuna näyttää enää pelkät käytetyt rajat (tavoite ja turvaraja,
// settings.targetShowerReserve/safetyShowerReserve) - samat suihkumäärät
// kuin lämmityssuunnitelmakortin "Käytetyt rajat" -tekstissä, ei mitään
// muuta lukua. Rivi piirretään myös säiliön poikki menevänä viivana, jotta
// raja erottuu myös täytön päältä ilman tekstiä.
type LimitMarker = {
  heightPercent: number;
  label: string;
};

function formatShowerCount(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(".", ",");
}

function buildLimitMarkers({
  fullTankShowers,
  safetyShowerReserve,
  targetShowerReserve,
}: {
  fullTankShowers: number;
  safetyShowerReserve: number;
  targetShowerReserve: number;
}): LimitMarker[] {
  const tickCount = Math.max(1, Math.round(fullTankShowers));

  return [safetyShowerReserve, targetShowerReserve].map((value) => {
    const clampedValue = clamp(value, 0, tickCount);

    return {
      heightPercent: 100 - (clampedValue / tickCount) * 100,
      label: formatShowerCount(clampedValue),
    };
  });
}

export type WarmWaterCardProps = {
  fillPercent: number;
  fullTankShowers: number;
  onPress: () => void;
  safetyShowerReserve: number;
  showersAccessibilityLabel: string;
  showersValueLabel: string;
  targetShowerReserve: number;
};

export function WarmWaterCard({
  fillPercent,
  fullTankShowers,
  onPress,
  safetyShowerReserve,
  showersAccessibilityLabel,
  showersValueLabel,
  targetShowerReserve,
}: WarmWaterCardProps) {
  const theme = getWarmWaterCardTheme();
  const scaleTicks = buildTankScaleTicks(fullTankShowers);
  const limitMarkers = buildLimitMarkers({
    fullTankShowers,
    safetyShowerReserve,
    targetShowerReserve,
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
                  {limitMarkers.map((marker) => (
                    <View
                      key={marker.label}
                      style={[
                        styles.tankScaleLineSegment,
                        styles.tankScaleLineCenterLimit,
                        { top: `${marker.heightPercent}%` },
                      ]}
                    />
                  ))}
                </View>
                <View style={[styles.tankBubble, styles.tankBubbleOne]} />
                <View style={[styles.tankBubble, styles.tankBubbleTwo]} />
                <View style={[styles.tankBubble, styles.tankBubbleThree]} />
                <Text style={styles.tankPrimaryValue}>{showersValueLabel}</Text>
              </View>
              <View style={styles.scaleColumnRight}>
                <View style={styles.scaleNumbers}>
                  {limitMarkers.map((marker) => (
                    <Text
                      allowFontScaling={false}
                      key={marker.label}
                      style={[
                        styles.scaleNumberRightLimit,
                        { top: `${marker.heightPercent}%` },
                      ]}
                    >
                      {marker.label}
                    </Text>
                  ))}
                </View>
              </View>
            </View>
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
    // Matches temperature-card's metricCard paddingVertical so both card
    // titles land on the same vertical level.
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
    marginTop: 6,
    width: "100%",
  },
  warmWaterTankArea: {
    alignItems: "center",
    alignSelf: "stretch",
    flex: 1,
    justifyContent: "center",
    // Small deliberate nudge down from center, now that the tank graphic
    // is the only child of warmWaterContent (the temperature label used
    // to be a separate sibling below it, which pulled the group's visual
    // center upward).
    marginTop: 10,
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
    // Matches temperature-card's cardLabelRow minHeight so both card
    // titles land on the same vertical level.
    minHeight: 24,
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
  // Tavoite- ja turvarajan rivi oikeassa reunassa - ainoat oikean puolen
  // luvut (ks. LIMIT_COLOR).
  scaleNumberRightLimit: {
    color: LIMIT_COLOR,
    fontSize: 13,
    fontWeight: "900",
    left: 0,
    lineHeight: LIMIT_LABEL_LINE_HEIGHT,
    position: "absolute",
    transform: [{ translateY: -LIMIT_LABEL_LINE_HEIGHT / 2 }],
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
  // Tavoite-/turvarajan viiva kulkee koko säiliön poikki (myös täytön
  // päällä), ei vain reunan tikkiviivana - näin raja erottuu selvästi
  // ilman tekstiä.
  tankScaleLineCenterLimit: {
    backgroundColor: LIMIT_COLOR,
    height: 2,
    left: 0,
    right: 0,
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
});
