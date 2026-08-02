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
// Kaksi arvoa lasketaan samaksi riviksi vain jos ne osuvat suunnilleen
// samaan kohtaan asteikkoa - normalizeShowerReserves pyöristää sekä
// tavoitteen että turvarajan 0,5 suihkun tarkkuuteen, joten tätä pienempi
// toleranssi riittää tunnistamaan täsmäävän kokonaisluku-tikin.
const LIMIT_MATCH_TOLERANCE = 0.05;

// Näyttää suihkumäärää (0..fullTankShowers) vastaavan lämpötila-asteikon
// säiliögrafiikan viereen. Käyttää samaa kaavaa kuin oikea epälineaarinen
// calculateStratifiedShowersLeft (lib/heatingOptimizer.ts):
// showersLeft = energyRatio * topUsability * fullTankShowers, missä
// energyRatio nollautuu minTankTemperature-arvossa. topUsability (0..1)
// tulee valmiina laskettuna warmWaterEstimate.topUsability-arvosta, koska se
// riippuu yläanturin raakalämpötilasta erikseen eikä pelkästä
// näytettävästä painotetusta lämpötilasta - kun yläanturi ei ole
// täyslämmin (topUsability < 1), suihkumäärä ei koskaan voi saavuttaa
// fullTankShowers-määrää vaikka keskilämpötila olisi maksimissaan, joten
// ylimmät tikit näyttävät tällöin saman (saavuttamattoman) kattolämpötilan.
type TankScaleTick = {
  heightPercent: number;
  showers: number;
  temperature: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function formatFinnishDecimal(value: number) {
  return value.toFixed(1).replace(".", ",");
}

// Vasemman reunan suihkumäärärivit: samat kokonaisluku-tikit kuin muualla
// (0..fullTankShowers), mutta tavoite- ja turvarajan kohdalle merkitään
// isLimit-lippu - joko olemassa olevaan tikkiin (kun raja osuu
// kokonaislukuun) tai omana ylimääräisenä rivinä (kun raja on esim. 2,5).
// Ei vaikuta oikean reunan lämpötila-asteikkoon eikä säiliön viivoihin -
// ne pysyvät ennallaan buildTankScaleTicksin varassa.
type LeftScaleEntry = {
  heightPercent: number;
  isLimit: boolean;
  label: string;
};

function buildLeftScaleEntries({
  fullTankShowers,
  safetyShowerReserve,
  targetShowerReserve,
}: {
  fullTankShowers: number;
  safetyShowerReserve: number;
  targetShowerReserve: number;
}): LeftScaleEntry[] {
  const tickCount = Math.max(1, Math.round(fullTankShowers));
  const limitValues = [
    clamp(safetyShowerReserve, 0, tickCount),
    clamp(targetShowerReserve, 0, tickCount),
  ];

  const baseEntries = Array.from({ length: tickCount + 1 }, (_, index) => {
    const showers = tickCount - index;
    const isLimit = limitValues.some(
      (value) => Math.abs(value - showers) < LIMIT_MATCH_TOLERANCE,
    );

    return {
      heightPercent: (index / tickCount) * 100,
      isLimit,
      label: String(showers),
      value: showers,
    };
  });

  const extraLimitEntries = limitValues
    .filter(
      (value) =>
        !baseEntries.some(
          (entry) => Math.abs(entry.value - value) < LIMIT_MATCH_TOLERANCE,
        ),
    )
    .map((value) => ({
      heightPercent: 100 - (value / tickCount) * 100,
      isLimit: true,
      label: formatFinnishDecimal(value),
      value,
    }));

  return [...baseEntries, ...extraLimitEntries].map(
    ({ heightPercent, isLimit, label }) => ({ heightPercent, isLimit, label }),
  );
}

function buildTankScaleTicks({
  fullTankAverageTemperature,
  fullTankShowers,
  minTankTemperature,
  topUsability,
}: {
  fullTankAverageTemperature: number;
  fullTankShowers: number;
  minTankTemperature: number;
  topUsability: number;
}): TankScaleTick[] {
  const tickCount = Math.max(1, Math.round(fullTankShowers));
  const safeTopUsability = topUsability > 0 ? topUsability : 1;

  return Array.from({ length: tickCount + 1 }, (_, index) => {
    const showers = tickCount - index;
    const requiredEnergyRatio = clamp(
      showers / (tickCount * safeTopUsability),
      0,
      1,
    );
    const temperature =
      minTankTemperature +
      requiredEnergyRatio * (fullTankAverageTemperature - minTankTemperature);

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
  safetyShowerReserve: number;
  showersAccessibilityLabel: string;
  showersValueLabel: string;
  targetShowerReserve: number;
  temperatureLabel: string;
  topUsability: number;
};

export function WarmWaterCard({
  fillPercent,
  fullTankAverageTemperature,
  fullTankShowers,
  minTankTemperature,
  onPress,
  safetyShowerReserve,
  showersAccessibilityLabel,
  showersValueLabel,
  targetShowerReserve,
  temperatureLabel,
  topUsability,
}: WarmWaterCardProps) {
  const theme = getWarmWaterCardTheme();
  const scaleTicks = buildTankScaleTicks({
    fullTankAverageTemperature,
    fullTankShowers,
    minTankTemperature,
    topUsability,
  });
  const leftScaleEntries = buildLeftScaleEntries({
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
                  {leftScaleEntries.map((entry) => (
                    <Text
                      allowFontScaling={false}
                      key={entry.label}
                      style={[
                        entry.isLimit
                          ? styles.scaleNumberLeftLimit
                          : styles.scaleNumberLeft,
                        { top: `${entry.heightPercent}%` },
                      ]}
                    >
                      {entry.label}
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
                  {leftScaleEntries
                    .filter((entry) => entry.isLimit)
                    .map((entry) => (
                      <View
                        key={entry.label}
                        style={[
                          styles.tankScaleLineSegment,
                          styles.tankScaleLineLeftLimit,
                          { top: `${entry.heightPercent}%` },
                        ]}
                      />
                    ))}
                </View>
                <View style={[styles.tankBubble, styles.tankBubbleOne]} />
                <View style={[styles.tankBubble, styles.tankBubbleTwo]} />
                <View style={[styles.tankBubble, styles.tankBubbleThree]} />
                <Text style={styles.tankPrimaryValue}>{showersValueLabel}</Text>
                <Text style={styles.tankSecondaryValue}>{temperatureLabel}</Text>
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
  // Tavoite- ja turvarajan rivi - isompi fontti ja sininen väri erottaa sen
  // muista suihkumäärän tikeistä (ks. LIMIT_COLOR).
  scaleNumberLeftLimit: {
    color: LIMIT_COLOR,
    fontSize: 13,
    fontWeight: "900",
    lineHeight: LIMIT_LABEL_LINE_HEIGHT,
    position: "absolute",
    right: 0,
    transform: [{ translateY: -LIMIT_LABEL_LINE_HEIGHT / 2 }],
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
  // Paksumpi, sininen viiva tavoite-/turvarajan kohdalla - vain vasen puoli,
  // piirretään tankScaleLineLeftin päälle samalla korkeudella.
  tankScaleLineLeftLimit: {
    backgroundColor: LIMIT_COLOR,
    height: 2,
    left: 0,
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
  // Positioned inside the tank graphic itself, horizontally centered like
  // tankPrimaryValue, well clear of its vertically-centered box (top ~67 to
  // ~101 of the 168-tall tank) and clearly above the tank's bottom edge.
  tankSecondaryValue: {
    bottom: 16,
    color: "rgba(247,251,255,0.82)",
    fontSize: 17,
    fontWeight: "900",
    left: 0,
    letterSpacing: -0.2,
    position: "absolute",
    right: 0,
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.34)",
    textShadowOffset: { height: 1, width: 0 },
    textShadowRadius: 8,
  },
});
