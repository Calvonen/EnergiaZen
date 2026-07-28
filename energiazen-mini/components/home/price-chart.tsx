import { Pressable, StyleSheet, Text, View } from "react-native";

import { HourlyPrice } from "@/lib/heatingLogic";

const chartPlotHeight = 96;

export type ChartAxisLabel = {
  bottom: number;
  label: string;
  value: number;
};

export type ChartGridLine = {
  bottom: number;
  value: number;
};

export type ChartBar = {
  accessibilityLabel: string;
  barBottom: number;
  barColor: string;
  cappedBarHeight: number;
  heatingMarker: string | null;
  heatingMarkerLabel: string | null;
  hourLabel: string;
  id: string;
  isCurrentHour: boolean;
  isFirstTimeLabel: boolean;
  isLastTimeLabel: boolean;
  isMiddleTimeLabel: boolean;
  isPastHour: boolean;
  isSelected: boolean;
  item: HourlyPrice;
  markerBottom: number;
  priceLabel: string;
  tooltipBottom: number;
};

export type PriceChartProps = {
  averageSpotPriceLabel: string;
  axisLabels: ChartAxisLabel[];
  bars: ChartBar[];
  gridLines: ChartGridLine[];
  onClearSelection: () => void;
  onSelectBar: (item: HourlyPrice) => void;
};

export function PriceChart({
  averageSpotPriceLabel,
  axisLabels,
  bars,
  gridLines,
  onClearSelection,
  onSelectBar,
}: PriceChartProps) {
  return (
    <>
      <Pressable
        accessibilityLabel="Tyhjennä kaavion valinta"
        onPress={onClearSelection}
        style={styles.chartTouchArea}
      >
        <View style={styles.chartPlotRow}>
          <View pointerEvents="none" style={styles.chartScale}>
            {axisLabels.map((axisLabel) => (
              <Text
                key={axisLabel.value}
                numberOfLines={1}
                style={[styles.chartScaleLabel, { bottom: axisLabel.bottom }]}
              >
                {axisLabel.label}
              </Text>
            ))}
          </View>

          <View style={styles.chartPlot}>
            <Text pointerEvents="none" style={styles.chartInnerUnit}>
              c/kWh
            </Text>
            <View pointerEvents="none" style={styles.chartGrid}>
              {gridLines.map((gridLine) => (
                <View
                  key={gridLine.value}
                  style={[styles.chartGridLine, { bottom: gridLine.bottom }]}
                />
              ))}
            </View>

            <View style={styles.chartBars}>
              {bars.map((bar) => (
                <Pressable
                  accessibilityHint="Näyttää valitun tunnin hinnan kaavion yläpuolella."
                  accessibilityLabel={bar.accessibilityLabel}
                  accessibilityRole="button"
                  key={bar.id}
                  onPress={(event) => {
                    event.stopPropagation();
                    onSelectBar(bar.item);
                  }}
                  style={styles.chartBarButton}
                >
                  {bar.isSelected ? (
                    <View
                      pointerEvents="none"
                      style={[
                        styles.chartTooltip,
                        { bottom: bar.tooltipBottom },
                      ]}
                    >
                      <Text style={styles.chartTooltipTime}>
                        {bar.hourLabel}
                      </Text>
                      <Text style={styles.chartTooltipPrice}>
                        {bar.priceLabel} c/kWh
                      </Text>
                      {bar.heatingMarkerLabel ? (
                        <Text style={styles.chartTooltipMarker}>
                          {bar.heatingMarker} {bar.heatingMarkerLabel}
                        </Text>
                      ) : null}
                      <View style={styles.chartTooltipArrow} />
                    </View>
                  ) : null}

                  {bar.heatingMarker ? (
                    <Text
                      pointerEvents="none"
                      style={[
                        styles.chartHourMarker,
                        { bottom: bar.markerBottom },
                      ]}
                    >
                      {bar.heatingMarker}
                    </Text>
                  ) : null}

                  <View
                    style={[
                      styles.chartBar,
                      {
                        backgroundColor: bar.barColor,
                        borderColor: bar.isSelected
                          ? "#ffffff"
                          : bar.isCurrentHour
                            ? "rgba(255,255,255,0.74)"
                            : "transparent",
                        bottom: bar.barBottom,
                        height: bar.cappedBarHeight,
                        shadowColor: bar.barColor,
                      },
                      bar.isPastHour && styles.pastChartBar,
                      bar.isCurrentHour && styles.currentChartBar,
                      bar.isSelected && styles.selectedChartBar,
                    ]}
                  />
                </Pressable>
              ))}
            </View>
          </View>
        </View>
      </Pressable>

      <View style={styles.chartTimesRow}>
        <View style={styles.chartScaleSpacer} />
        <View style={styles.chartTimes}>
          {bars.map((bar) => (
            <View key={bar.id} style={styles.chartTimeSlot}>
              {bar.isFirstTimeLabel ||
              bar.isMiddleTimeLabel ||
              bar.isLastTimeLabel ? (
                <View
                  pointerEvents="none"
                  style={styles.chartTimeLabelOverlay}
                >
                  <Text numberOfLines={1} style={styles.chartTime}>
                    {bar.hourLabel}
                  </Text>
                </View>
              ) : null}
            </View>
          ))}
        </View>
      </View>

      <View style={styles.dailyAveragePriceInfo}>
        <Text style={styles.dailyAveragePriceText}>
          Päivän keskihinta {averageSpotPriceLabel} c/kWh
        </Text>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  chartTouchArea: {
    height: 124,
    justifyContent: "flex-end",
  },
  chartPlotRow: {
    alignItems: "flex-end",
    flexDirection: "row",
    gap: 8,
    overflow: "visible",
  },
  chartScale: {
    height: chartPlotHeight,
    position: "relative",
    width: 24,
  },
  chartScaleLabel: {
    color: "rgba(207,233,255,0.52)",
    fontSize: 10,
    fontWeight: "800",
    lineHeight: 12,
    position: "absolute",
    right: 0,
    transform: [{ translateY: 6 }],
  },
  chartPlot: {
    flex: 1,
    height: chartPlotHeight,
    overflow: "visible",
    position: "relative",
  },
  chartInnerUnit: {
    color: "rgba(207,233,255,0.58)",
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 0.2,
    lineHeight: 12,
    position: "absolute",
    right: 0,
    top: -16,
  },
  chartGrid: {
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  chartGridLine: {
    backgroundColor: "rgba(207,233,255,0.1)",
    height: 1,
    left: 0,
    position: "absolute",
    right: 0,
  },
  chartBars: {
    alignItems: "flex-end",
    flexDirection: "row",
    gap: 4,
    height: chartPlotHeight,
    overflow: "visible",
  },
  chartBarButton: {
    alignItems: "center",
    flex: 1,
    height: chartPlotHeight,
    justifyContent: "flex-end",
    overflow: "visible",
    position: "relative",
  },
  chartHourMarker: {
    fontSize: 11,
    lineHeight: 13,
    marginBottom: 2,
    position: "absolute",
    textAlign: "center",
  },
  chartBar: {
    borderRadius: 8,
    borderWidth: 1.5,
    opacity: 0.9,
    position: "absolute",
    shadowOpacity: 0.25,
    shadowRadius: 8,
    width: "100%",
  },
  pastChartBar: {
    opacity: 0.28,
    shadowOpacity: 0.08,
  },
  currentChartBar: {
    borderWidth: 2,
    opacity: 1,
    shadowColor: "#ffffff",
    shadowOpacity: 0.42,
    shadowRadius: 12,
  },
  selectedChartBar: {
    borderWidth: 2,
    opacity: 1,
    shadowOpacity: 0.95,
    shadowRadius: 18,
    transform: [{ translateY: -4 }],
  },
  chartTooltip: {
    alignItems: "center",
    backgroundColor: "rgba(8,13,31,0.96)",
    borderColor: "rgba(255,255,255,0.22)",
    borderRadius: 14,
    borderWidth: 1,
    left: "50%",
    marginLeft: -55,
    paddingHorizontal: 10,
    paddingVertical: 8,
    position: "absolute",
    shadowColor: "#36f4d4",
    shadowOpacity: 0.32,
    shadowRadius: 16,
    width: 110,
    zIndex: 10,
  },
  chartTooltipTime: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "900",
    lineHeight: 17,
  },
  chartTooltipPrice: {
    color: "#bfffee",
    fontSize: 12,
    fontWeight: "900",
    lineHeight: 16,
  },
  chartTooltipMarker: {
    color: "#ffffff",
    fontSize: 10,
    fontWeight: "800",
    marginTop: 4,
    textAlign: "center",
  },
  chartTooltipArrow: {
    borderLeftColor: "transparent",
    borderLeftWidth: 6,
    borderRightColor: "transparent",
    borderRightWidth: 6,
    borderTopColor: "rgba(8,13,31,0.96)",
    borderTopWidth: 7,
    bottom: -7,
    height: 0,
    position: "absolute",
    width: 0,
  },
  chartTimesRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
  },
  chartScaleSpacer: {
    width: 24,
  },
  chartTimes: {
    flex: 1,
    flexDirection: "row",
    gap: 4,
    overflow: "visible",
  },
  chartTimeSlot: {
    flex: 1,
    overflow: "visible",
    position: "relative",
  },
  // Symmetric negative left/right offsets give this a fixed, generous width
  // centered on the (narrow, one-band-wide) slot, so Yoga measures the text
  // against that width instead of the slot's own ~12px share and never
  // wraps/truncates it, while the overlay's center still lines up exactly
  // with the slot (and therefore the bar) it belongs to.
  chartTimeLabelOverlay: {
    alignItems: "center",
    left: -24,
    position: "absolute",
    right: -24,
  },
  chartTime: {
    color: "#8190b5",
    fontSize: 10,
    fontWeight: "800",
  },
  dailyAveragePriceInfo: {
    borderTopColor: "rgba(255,255,255,0.1)",
    borderTopWidth: 1,
    marginTop: 14,
    paddingTop: 14,
  },
  dailyAveragePriceText: {
    color: "#8190b5",
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
  },
});
