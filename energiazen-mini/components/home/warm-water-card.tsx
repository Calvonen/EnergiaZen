import { Fragment, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { supabase } from "@/lib/supabase";
import {
  buildV2HomeReservePresentation,
  type V2HomeReserveSnapshot,
} from "@/lib/v2HomeReservePresentation";

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

const TANK_WIDTH = 86;
const TANK_HEIGHT = 168;
const TANK_BORDER_WIDTH = 2;
const TANK_INNER_HEIGHT = TANK_HEIGHT - TANK_BORDER_WIDTH * 2;
const SCALE_LABEL_LINE_HEIGHT = 11;
const LIMIT_LABEL_LINE_HEIGHT = 14;
const PRIMARY_VALUE_LINE_HEIGHT = 34;
const LIMIT_COLOR = "#9fc7ff";
const HOME_RESERVE_REFRESH_MS = 60_000;
const SCALE_TICKS = [100, 75, 50, 25, 0] as const;

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function markerTop(percent: number) {
  return 100 - clamp(percent, 0, 100);
}

function formatKwh(value: number) {
  return value.toFixed(1).replace(".", ",");
}

export type WarmWaterCardProps = {
  // Legacy props stay accepted while V1 remains the production controller.
  // The card itself is read-only V2 presentation and does not change control ownership.
  fillPercent: number;
  fullTankShowers: number;
  onPress: () => void;
  safetyShowerReserve: number;
  showersAccessibilityLabel: string;
  showersValueLabel: string;
  targetShowerReserve: number;
};

export function WarmWaterCard({ onPress }: WarmWaterCardProps) {
  const theme = getWarmWaterCardTheme();
  const [reserve, setReserve] = useState<V2HomeReserveSnapshot | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    let active = true;

    const loadReserve = async () => {
      try {
        const { data, error } = await supabase.rpc("get_v2_energy_reserve_home");
        if (!active) return;
        if (error) {
          setReserve(null);
          return;
        }
        const row = Array.isArray(data) ? data[0] : null;
        setReserve((row as V2HomeReserveSnapshot | undefined) ?? null);
      } catch {
        if (active) setReserve(null);
      }
    };

    void loadReserve();
    const interval = setInterval(() => {
      setNowMs(Date.now());
      void loadReserve();
    }, HOME_RESERVE_REFRESH_MS);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, []);

  const presentation = useMemo(() => {
    const reservePresentation = buildV2HomeReservePresentation(reserve, nowMs);
    if (!reservePresentation.available || reservePresentation.percent === null ||
        reservePresentation.energyKwh === null || reservePresentation.capacityKwh === null) {
      return {
        accessibilityLabel: "Lämminvesivaraus, V2-energiavara ei ole juuri nyt saatavilla",
        energyLabel: "V2-varaus ei saatavilla",
        fillPercent: 0,
        percentLabel: "--",
      };
    }

    return {
      accessibilityLabel: `Lämminvesivaraus ${Math.round(reservePresentation.percent)} prosenttia, ${formatKwh(reservePresentation.energyKwh)} kilowattituntia ${formatKwh(reservePresentation.capacityKwh)} kilowattitunnista`,
      energyLabel: `${formatKwh(reservePresentation.energyKwh)} / ${formatKwh(reservePresentation.capacityKwh)} kWh`,
      fillPercent: reservePresentation.fillPercent,
      percentLabel: `${Math.round(reservePresentation.percent)} %`,
    };
  }, [nowMs, reserve]);

  const safetyPercent = clamp(reserve?.safety_reserve_percent ?? 30, 0, 100);
  const targetPercent = clamp(reserve?.target_reserve_percent ?? 75, 0, 100);
  const limitMarkers = [
    { key: "safety", label: `${Math.round(safetyPercent)} %`, percent: safetyPercent },
    { key: "target", label: `${Math.round(targetPercent)} %`, percent: targetPercent },
  ];

  return (
    <View style={[styles.metricCard, styles.waterCard, {
      backgroundColor: theme.backgroundColor,
      borderColor: theme.borderColor,
      shadowColor: theme.shadowColor,
    }]}>
      <Pressable
        accessibilityLabel={presentation.accessibilityLabel}
        accessibilityRole="button"
        android_ripple={{ color: "rgba(255,255,255,0.1)" }}
        onPress={onPress}
        style={({ pressed }) => [styles.metricCardPressable, pressed && styles.pressedMetricCard]}
      >
        <View style={styles.cardLabelRow}>
          <Text style={styles.cardLabel}>Lämminvesivaraus</Text>
        </View>
        <View style={styles.warmWaterContent}>
          <View style={styles.warmWaterTankArea}>
            <View style={styles.tankScaleRow}>
              <View style={styles.scaleColumnLeft}>
                <View style={styles.scaleNumbers}>
                  {SCALE_TICKS.map((tick) => (
                    <Text allowFontScaling={false} key={tick} style={[styles.scaleNumberLeft, { top: `${markerTop(tick)}%` }]}>
                      {tick}
                    </Text>
                  ))}
                </View>
              </View>
              <View style={styles.tankVisual}>
                <View style={[styles.tankFill, {
                  backgroundColor: theme.fillColor,
                  height: `${presentation.fillPercent}%`,
                  shadowColor: theme.shadowColor,
                }]} />
                {presentation.fillPercent > 0 ? (
                  <View style={[styles.tankSurface, {
                    backgroundColor: theme.surfaceColor,
                    bottom: `${presentation.fillPercent}%`,
                  }]} />
                ) : null}
                <View pointerEvents="none" style={styles.tankScaleLines}>
                  {SCALE_TICKS.map((tick) => (
                    <Fragment key={tick}>
                      <View style={[styles.tankScaleLineSegment, styles.tankScaleLineLeft, { top: `${markerTop(tick)}%` }]} />
                      <View style={[styles.tankScaleLineSegment, styles.tankScaleLineRight, { top: `${markerTop(tick)}%` }]} />
                    </Fragment>
                  ))}
                  {limitMarkers.map((marker) => (
                    <View key={marker.key} style={[styles.tankScaleLineSegment, styles.tankScaleLineCenterLimit, { top: `${markerTop(marker.percent)}%` }]} />
                  ))}
                </View>
                <View style={[styles.tankBubble, styles.tankBubbleOne]} />
                <View style={[styles.tankBubble, styles.tankBubbleTwo]} />
                <View style={[styles.tankBubble, styles.tankBubbleThree]} />
                <Text style={styles.tankPrimaryValue}>{presentation.percentLabel}</Text>
              </View>
              <View style={styles.scaleColumnRight}>
                <View style={styles.scaleNumbers}>
                  {limitMarkers.map((marker) => (
                    <Text allowFontScaling={false} key={marker.key} style={[styles.scaleNumberRightLimit, { top: `${markerTop(marker.percent)}%` }]}>
                      {marker.label}
                    </Text>
                  ))}
                </View>
              </View>
            </View>
            <Text style={styles.energyLabel}>{presentation.energyLabel}</Text>
          </View>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  metricCard: { alignItems: "center", borderRadius: 28, borderWidth: 1.5, flex: 1, justifyContent: "space-between", minHeight: 160, overflow: "hidden", paddingHorizontal: 14, paddingVertical: 13, shadowOpacity: 0.38, shadowRadius: 24 },
  metricCardPressable: { alignItems: "center", flex: 1, justifyContent: "space-between", position: "relative", width: "100%" },
  waterCard: { shadowOpacity: 0.42 },
  warmWaterContent: { alignItems: "stretch", alignSelf: "stretch", flex: 1, justifyContent: "center", marginTop: 6, width: "100%" },
  warmWaterTankArea: { alignItems: "center", alignSelf: "stretch", flex: 1, justifyContent: "center", marginTop: 10, minHeight: 108, width: "100%" },
  pressedMetricCard: { opacity: 0.82 },
  cardLabelRow: { alignItems: "center", flexDirection: "row", justifyContent: "center", minHeight: 24 },
  cardLabel: { color: "rgba(247,251,255,0.82)", fontSize: 12, fontWeight: "900", letterSpacing: 0.3, textAlign: "center", textTransform: "uppercase" },
  tankScaleRow: { alignItems: "flex-start", flexDirection: "row" },
  scaleColumnLeft: { alignItems: "flex-end", marginRight: 10, width: 24 },
  scaleColumnRight: { alignItems: "flex-start", marginLeft: 10, width: 40 },
  scaleNumbers: { height: TANK_INNER_HEIGHT, marginTop: TANK_BORDER_WIDTH, position: "relative", width: "100%" },
  scaleNumberLeft: { color: "rgba(255,255,255,0.55)", fontSize: 10, fontWeight: "800", lineHeight: SCALE_LABEL_LINE_HEIGHT, position: "absolute", right: 0, transform: [{ translateY: -SCALE_LABEL_LINE_HEIGHT / 2 }] },
  scaleNumberRightLimit: { color: LIMIT_COLOR, fontSize: 11, fontWeight: "900", left: 0, lineHeight: LIMIT_LABEL_LINE_HEIGHT, position: "absolute", transform: [{ translateY: -LIMIT_LABEL_LINE_HEIGHT / 2 }] },
  tankVisual: { backgroundColor: "rgba(2,11,30,0.42)", borderColor: "rgba(221,247,255,0.72)", borderRadius: 26, borderWidth: TANK_BORDER_WIDTH, height: TANK_HEIGHT, overflow: "hidden", position: "relative", width: TANK_WIDTH },
  tankScaleLines: { bottom: 0, left: 0, position: "absolute", right: 0, top: 0 },
  tankScaleLineSegment: { backgroundColor: "rgba(255,255,255,0.27)", height: 1, position: "absolute" },
  tankScaleLineLeft: { left: 0, width: "26%" },
  tankScaleLineRight: { right: 0, width: "26%" },
  tankScaleLineCenterLimit: { backgroundColor: LIMIT_COLOR, height: 2, left: 0, right: 0 },
  tankFill: { backgroundColor: "#40d9ff", borderTopColor: "rgba(255,255,255,0.42)", borderTopWidth: 1, bottom: 0, left: 0, position: "absolute", right: 0, shadowColor: "#40d9ff", shadowOpacity: 0.56, shadowRadius: 16 },
  tankSurface: { backgroundColor: "rgba(255,255,255,0.78)", borderRadius: 999, height: 3, left: 8, marginBottom: -1.5, position: "absolute", right: 8 },
  tankBubble: { backgroundColor: "rgba(255,255,255,0.78)", borderRadius: 999, height: 5, position: "absolute", width: 5 },
  tankBubbleOne: { bottom: 14, left: 16 },
  tankBubbleTwo: { bottom: 34, right: 14 },
  tankBubbleThree: { bottom: 48, left: 25, opacity: 0.72 },
  tankPrimaryValue: { color: "#ffffff", fontSize: 27, fontWeight: "900", left: 0, letterSpacing: -0.4, lineHeight: PRIMARY_VALUE_LINE_HEIGHT, position: "absolute", right: 0, textAlign: "center", textShadowColor: "rgba(0,0,0,0.34)", textShadowOffset: { height: 1, width: 0 }, textShadowRadius: 8, top: (TANK_HEIGHT - PRIMARY_VALUE_LINE_HEIGHT) / 2 },
  energyLabel: { color: "rgba(247,251,255,0.78)", fontSize: 11, fontWeight: "800", marginTop: 8, textAlign: "center" },
});
