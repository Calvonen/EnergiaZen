import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  GestureResponderEvent,
  InteractionManager,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { debugLog } from "@/lib/debug";
import { defaultSettings } from "@/lib/settings";
import { supabase } from "@/lib/supabase";
import {
  addHelsinkiCalendarDays,
  createTemperatureHistoryDayCache,
  dayHistoryBucketMinutes,
  formatHelsinkiDaySelectorLabel,
  getHelsinkiDayRange,
  getTodayHelsinkiDayKey,
  getTemperatureHistoryDayCacheKey,
  isTodayHelsinkiDay,
} from "@/lib/temperatureHistoryDay";
import {
  buildInletTrendSlots,
  formatInletTrendWeekRangeLabel,
  getInletTrendPeriod,
  getWeeklyInletTemperaturePointHeightPercent,
  InletTrendSlot,
  mapWeeklyInletTemperatureRows,
  WeeklyInletTemperaturePoint,
} from "@/lib/inletTemperatureTrend";

type HistoryTab = "24h" | "day";

type TemperatureHistoryPoint = {
  timestamp: string;
  topTemp: number;
  bottomTemp: number;
  averageTemp: number;
};

type SelectedHistoryPoint = {
  index: number;
  point: TemperatureHistoryPoint;
  pointX: number;
};

type SelectedInletTrendSlot = {
  index: number;
  slot: InletTrendSlot;
  x: number;
};

type TankReadingRow = {
  created_at?: string | null;
  top_temp?: number | null;
  bottom_temp?: number | null;
};

type XAxisLabel = {
  align: "left" | "center" | "right";
  text: string;
};

const DEBUG_HISTORY_PERFORMANCE = false;
const chartHeight = 190;
const chartMinTemp = defaultSettings.minTankTemperature;
const chartMaxTemp = 70;
const closePointOffset = 2;
const tooltipWidth = 104;
const tooltipTouchGap = 12;
const topTemperatureColor = "#FF8A4C";
const averageTemperatureColor = "#2DD4BF";
const bottomTemperatureColor = "#60A5FA";
const tooltipBottomOffset = 28;
const inletTrendChartHeight = 72;
const inletTrendScale = [20, 10, 0];
const inletTemperatureColor = "#5ec8f2";
const dayXAxisTargets = [
  { label: "00", minute: 0 },
  { label: "06", minute: 6 * 60 },
  { label: "12", minute: 12 * 60 },
  { label: "18", minute: 18 * 60 },
  { label: "24", minute: 24 * 60 },
];

function getPerformanceNow() {
  return Date.now();
}

function logTemperatureHistoryPerformance(
  range: string,
  event: string,
  data: Record<string, unknown>,
) {
  if (!DEBUG_HISTORY_PERFORMANCE) {
    return;
  }

  console.log("[EnergyZen perf][temperature-history]", {
    event,
    range,
    ...data,
  });
}

let temperatureHistory24hCache: TemperatureHistoryPoint[] = [];
let temperatureHistory24hLoaded = false;
const temperatureHistoryDayCache =
  createTemperatureHistoryDayCache<TemperatureHistoryPoint[]>();
const inletTrendPeriodCache =
  createTemperatureHistoryDayCache<WeeklyInletTemperaturePoint[]>();

const timeFormatter = new Intl.DateTimeFormat("fi-FI", {
  hour: "2-digit",
  hour12: false,
  timeZone: "Europe/Helsinki",
});

const tooltipTimeFormatter = new Intl.DateTimeFormat("fi-FI", {
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  timeZone: "Europe/Helsinki",
});

const tooltipClockFormatter = new Intl.DateTimeFormat("fi-FI", {
  hour: "numeric",
  hour12: false,
  minute: "2-digit",
  timeZone: "Europe/Helsinki",
});

function formatHour(timestamp: string) {
  return `${timeFormatter.format(new Date(timestamp)).replace(".", "")}:00`;
}

function formatTooltipTime(timestamp: string) {
  return tooltipTimeFormatter.format(new Date(timestamp)).replace(".", ":");
}

function formatDayTooltipTime(timestamp: string) {
  const time = tooltipClockFormatter
    .format(new Date(timestamp))
    .replace(":", ".");

  return `klo ${time}`;
}

function getDatePart(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
) {
  return parts.find((part) => part.type === type)?.value ?? "";
}

function roundTemperature(value: number) {
  return Math.round(value * 10) / 10;
}

function calculateWeightedTemperature(topTemp: number, bottomTemp: number) {
  return topTemp * 0.7 + bottomTemp * 0.3;
}

function getHistoryRangeStart(rangeMs: number) {
  return new Date(Date.now() - rangeMs).toISOString();
}

function sortHistoryByCreatedAtAscending(history: TemperatureHistoryPoint[]) {
  return [...history].sort(
    (firstPoint, secondPoint) =>
      new Date(firstPoint.timestamp).getTime() -
      new Date(secondPoint.timestamp).getTime(),
  );
}

function mapTankReadingToHistoryPoint(
  reading: TankReadingRow,
): TemperatureHistoryPoint | null {
  if (
    !reading.created_at ||
    typeof reading.top_temp !== "number" ||
    typeof reading.bottom_temp !== "number"
  ) {
    return null;
  }

  return {
    averageTemp: calculateWeightedTemperature(
      reading.top_temp,
      reading.bottom_temp,
    ),
    bottomTemp: reading.bottom_temp,
    timestamp: reading.created_at,
    topTemp: reading.top_temp,
  };
}

async function fetchTemperatureHistoryPoints(
  startIso: string,
  rangeLabel: string,
  bucketMinutes: number,
  mode: "average" | "latest",
) {
  const fetchStartedAt = getPerformanceNow();
  const { data, error } = await supabase.rpc("get_temperature_history_points", {
    p_bucket_minutes: bucketMinutes,
    p_mode: mode,
    p_start: startIso,
  });

  if (error) {
    throw error;
  }

  const history = sortHistoryByCreatedAtAscending(
    ((data ?? []) as TankReadingRow[])
      .map(mapTankReadingToHistoryPoint)
      .filter((point): point is TemperatureHistoryPoint => point !== null),
  );

  logTemperatureHistoryPerformance(rangeLabel, "temperature history fetch", {
    bucketMinutes,
    durationMs: getPerformanceNow() - fetchStartedAt,
    mode,
    rawRowCount: history.length,
    rowCount: history.length,
  });

  return history;
}

function getVisibleHistory(
  history: TemperatureHistoryPoint[],
  selectedTab: HistoryTab,
) {
  return selectedTab === "24h" && history.length > 144
    ? sampleHistoryByLatestPoint(history, 10 * 60 * 1000)
    : history;
}

function sampleHistoryByLatestPoint(
  history: TemperatureHistoryPoint[],
  bucketSizeMs: number,
) {
  const latestPointByBucket = new Map<number, TemperatureHistoryPoint>();

  history.forEach((point) => {
    const pointTime = new Date(point.timestamp).getTime();
    const bucket = Math.floor(pointTime / bucketSizeMs);
    latestPointByBucket.set(bucket, point);
  });

  return [...latestPointByBucket.values()].sort(
    (firstPoint, secondPoint) =>
      new Date(firstPoint.timestamp).getTime() -
      new Date(secondPoint.timestamp).getTime(),
  );
}

function getTopTemperature(point: TemperatureHistoryPoint) {
  return point.topTemp;
}

function getBottomTemperature(point: TemperatureHistoryPoint) {
  return point.bottomTemp;
}

function getAverageTemperature(point: TemperatureHistoryPoint) {
  return point.averageTemp;
}

function getPointBottom(temperature: number) {
  const ratio = Math.min(
    Math.max((temperature - chartMinTemp) / (chartMaxTemp - chartMinTemp), 0),
    1,
  );

  return ratio * chartHeight;
}

function getAdjustedPointBottoms(
  topTemperature: number,
  bottomTemperature: number,
) {
  const topBottom = getPointBottom(topTemperature);
  const bottomBottom = getPointBottom(bottomTemperature);

  if (Math.abs(topBottom - bottomBottom) > closePointOffset * 2) {
    return { bottomBottom, topBottom };
  }

  return {
    bottomBottom: Math.max(bottomBottom - closePointOffset, 0),
    topBottom: Math.min(topBottom + closePointOffset, chartHeight),
  };
}

function shouldShowXAxisLabel(
  index: number,
  historyLength: number,
) {
  if (historyLength <= 5) {
    return true;
  }

  const labelCount = 5;
  const interval = (historyLength - 1) / (labelCount - 1);

  return Array.from({ length: labelCount }).some(
    (_, labelIndex) => index === Math.round(labelIndex * interval),
  );
}

function getHelsinkiMinuteOfDay(timestamp: string) {
  const parts = tooltipClockFormatter.formatToParts(new Date(timestamp));
  const hour = Number(getDatePart(parts, "hour"));
  const minute = Number(getDatePart(parts, "minute"));

  return hour * 60 + minute;
}

function getDayXAxisLabels(history: TemperatureHistoryPoint[]) {
  const labels = new Map<number, XAxisLabel>();
  const usedIndexes = new Set<number>();

  dayXAxisTargets.forEach((target, targetIndex) => {
    let closestIndex = -1;
    let closestDistance = Number.POSITIVE_INFINITY;

    history.forEach((point, index) => {
      const minuteOfDay = getHelsinkiMinuteOfDay(point.timestamp);
      const distance = Math.abs(minuteOfDay - target.minute);

      if (distance < closestDistance && !usedIndexes.has(index)) {
        closestDistance = distance;
        closestIndex = index;
      }
    });

    if (closestIndex === -1) {
      return;
    }

    usedIndexes.add(closestIndex);
    labels.set(closestIndex, {
      align:
        targetIndex === 0
          ? "left"
          : targetIndex === dayXAxisTargets.length - 1
            ? "right"
            : "center",
      text: target.label,
    });
  });

  return labels;
}

type ChartLineSegment = {
  angle: string;
  color: string;
  height: number;
  key: string;
  left: number;
  top: number;
  width: number;
};

function getChartLineSegments(
  history: TemperatureHistoryPoint[],
  chartWidth: number,
) {
  if (history.length < 2 || chartWidth <= 0) {
    return [];
  }

  const columnWidth = chartWidth / history.length;
  const segments: ChartLineSegment[] = [];

  history.slice(0, -1).forEach((point, index) => {
    const nextPoint = history[index + 1];
    const currentTemps = getAdjustedPointBottoms(
      getTopTemperature(point),
      getBottomTemperature(point),
    );
    const nextTemps = getAdjustedPointBottoms(
      getTopTemperature(nextPoint),
      getBottomTemperature(nextPoint),
    );
    const currentAverageBottom = getPointBottom(getAverageTemperature(point));
    const nextAverageBottom = getPointBottom(getAverageTemperature(nextPoint));
    const currentX = columnWidth * index + columnWidth / 2;
    const nextX = columnWidth * (index + 1) + columnWidth / 2;

    [
      {
        color: topTemperatureColor,
        currentBottom: currentTemps.topBottom,
        keyPrefix: "top",
        nextBottom: nextTemps.topBottom,
      },
      {
        color: bottomTemperatureColor,
        currentBottom: currentTemps.bottomBottom,
        keyPrefix: "bottom",
        nextBottom: nextTemps.bottomBottom,
      },
      {
        color: averageTemperatureColor,
        currentBottom: currentAverageBottom,
        keyPrefix: "average",
        lineHeight: 1.5,
        nextBottom: nextAverageBottom,
      },
    ].forEach(
      ({ color, currentBottom, keyPrefix, lineHeight = 2, nextBottom }) => {
        const currentY = chartHeight - currentBottom;
        const nextY = chartHeight - nextBottom;
        const deltaX = nextX - currentX;
        const deltaY = nextY - currentY;
        const width = Math.hypot(deltaX, deltaY);
        const angle = `${Math.atan2(deltaY, deltaX)}rad`;

        segments.push({
          angle,
          color,
          height: lineHeight,
          key: `${keyPrefix}-${index}`,
          left: currentX,
          top: currentY,
          width,
        });
      },
    );
  });

  return segments;
}

function getInletTrendPointBottom(minimumInletTempC: number) {
  return (
    (getWeeklyInletTemperaturePointHeightPercent(minimumInletTempC) / 100) *
    inletTrendChartHeight
  );
}

type InletTrendLineSegment = {
  angle: string;
  height: number;
  key: string;
  left: number;
  top: number;
  width: number;
};

function getInletTrendLineSegments(
  slots: InletTrendSlot[],
  chartWidth: number,
): InletTrendLineSegment[] {
  if (slots.length < 2 || chartWidth <= 0) {
    return [];
  }

  const columnWidth = chartWidth / slots.length;
  const segments: InletTrendLineSegment[] = [];

  slots.slice(0, -1).forEach((slot, index) => {
    const nextSlot = slots[index + 1];

    if (slot.minimumInletTempC === null || nextSlot.minimumInletTempC === null) {
      return;
    }

    const currentX = columnWidth * index + columnWidth / 2;
    const nextX = columnWidth * (index + 1) + columnWidth / 2;
    const currentY =
      inletTrendChartHeight - getInletTrendPointBottom(slot.minimumInletTempC);
    const nextY =
      inletTrendChartHeight - getInletTrendPointBottom(nextSlot.minimumInletTempC);
    const deltaX = nextX - currentX;
    const deltaY = nextY - currentY;

    segments.push({
      angle: `${Math.atan2(deltaY, deltaX)}rad`,
      height: 1,
      key: `inlet-trend-${index}`,
      left: currentX,
      top: currentY,
      width: Math.hypot(deltaX, deltaY),
    });
  });

  return segments;
}

export default function TemperatureHistoryScreen() {
  const insets = useSafeAreaInsets();
  const mountedAtRef = useRef(getPerformanceNow());
  const initialTabRef = useRef<HistoryTab>("24h");
  const firstRenderLoggedRef = useRef(false);
  const firstContentLoggedRef = useRef(false);
  const fetchCountRef = useRef(0);
  const inFlightRef = useRef<Record<"24h", boolean>>({
    "24h": false,
  });
  const inFlightDayKeysRef = useRef(new Set<string>());
  const [selectedTab, setSelectedTab] = useState<HistoryTab>("24h");
  const [selectedDayKey, setSelectedDayKey] = useState(() =>
    getTodayHelsinkiDayKey(),
  );
  const selectedDayKeyRef = useRef(selectedDayKey);
  const [history24h, setHistory24h] = useState<TemperatureHistoryPoint[]>(
    temperatureHistory24hCache,
  );
  const [historyDay, setHistoryDay] = useState<TemperatureHistoryPoint[]>(
    () =>
      temperatureHistoryDayCache.get(
        getTemperatureHistoryDayCacheKey({
          dayKey: getTodayHelsinkiDayKey(),
        }),
      ) ?? [],
  );
  const [isInteractionComplete, setIsInteractionComplete] = useState(false);
  const [isLoading24h, setIsLoading24h] = useState(false);
  const [isLoadingDay, setIsLoadingDay] = useState(false);
  const [backgroundRefreshingTab, setBackgroundRefreshingTab] =
    useState<HistoryTab | null>(null);
  const [chartWidth, setChartWidth] = useState(0);
  const historyTooltipLeft = useRef(new Animated.Value(0)).current;
  const [selectedHistoryPoint, setSelectedHistoryPoint] =
    useState<SelectedHistoryPoint | null>(null);
  const [weeklyInletTrend, setWeeklyInletTrend] = useState<
    WeeklyInletTemperaturePoint[]
  >([]);
  const [isLoadingWeeklyInletTrend, setIsLoadingWeeklyInletTrend] =
    useState(false);
  const [inletTrendChartWidth, setInletTrendChartWidth] = useState(0);
  const [inletTrendPeriodOffset, setInletTrendPeriodOffset] = useState(0);
  const [selectedInletTrendSlot, setSelectedInletTrendSlot] =
    useState<SelectedInletTrendSlot | null>(null);
  const inletTrendPeriodOffsetRef = useRef(inletTrendPeriodOffset);
  const inFlightInletTrendOffsetsRef = useRef(new Set<number>());

  const loadWeeklyInletTrend = useCallback(async (offset: number) => {
    const cacheKey = String(offset);

    if (inFlightInletTrendOffsetsRef.current.has(offset)) {
      return;
    }

    const cachedPoints = inletTrendPeriodCache.get(cacheKey);

    if (cachedPoints) {
      if (inletTrendPeriodOffsetRef.current === offset) {
        setWeeklyInletTrend(cachedPoints);
      }
      return;
    }

    if (inletTrendPeriodOffsetRef.current === offset) {
      setWeeklyInletTrend([]);
      setIsLoadingWeeklyInletTrend(true);
    }
    inFlightInletTrendOffsetsRef.current.add(offset);

    try {
      const period = getInletTrendPeriod(offset);
      const { data, error } = await supabase.rpc(
        "get_weekly_minimum_inlet_temperature",
        { p_end: period.endIso, p_start: period.startIso },
      );

      if (error) {
        throw error;
      }

      const points = mapWeeklyInletTemperatureRows(data);
      inletTrendPeriodCache.set(cacheKey, points);

      if (inletTrendPeriodOffsetRef.current === offset) {
        setWeeklyInletTrend(points);
      }
    } catch (error) {
      console.warn(
        "Tulovesitrendin haku epäonnistui",
        error instanceof Error ? error.message : error,
      );
    } finally {
      inFlightInletTrendOffsetsRef.current.delete(offset);
      if (inletTrendPeriodOffsetRef.current === offset) {
        setIsLoadingWeeklyInletTrend(false);
      }
    }
  }, []);

  const loadHistoryTab = useCallback(async (tab: "24h", force = false) => {
    if (inFlightRef.current[tab]) {
      return;
    }
    if (!force && tab === "24h" && temperatureHistory24hLoaded) {
      return;
    }

    inFlightRef.current[tab] = true;
    fetchCountRef.current += 1;
    const viewLoadStartedAt = getPerformanceNow();
    const rangeStart = getHistoryRangeStart(24 * 60 * 60 * 1000);
    const bucketMinutes = 10;
    const mode = "latest";
    const hasCachedData = temperatureHistory24hLoaded;

    logTemperatureHistoryPerformance(tab, "query started", {
      fetchCount: fetchCountRef.current,
      force,
      hasCachedData,
    });

    if (hasCachedData) {
      setBackgroundRefreshingTab(tab);
    } else {
      setIsLoading24h(true);
    }

    try {
      const nextHistory = await fetchTemperatureHistoryPoints(
        rangeStart,
        tab,
        bucketMinutes,
        mode,
      );

      temperatureHistory24hCache = nextHistory;
      temperatureHistory24hLoaded = true;
      setHistory24h(nextHistory);

      logTemperatureHistoryPerformance(tab, "query completed", {
        durationMs: getPerformanceNow() - viewLoadStartedAt,
        fetchCount: fetchCountRef.current,
        rowCount: nextHistory.length,
      });
      logTemperatureHistoryPerformance(tab, "view load", {
        durationMs: getPerformanceNow() - viewLoadStartedAt,
        rowCount: nextHistory.length,
      });
    } catch (error) {
      console.warn(
        "Lämpöhistorian haku epäonnistui",
        error instanceof Error ? error.message : error,
      );
    } finally {
      inFlightRef.current[tab] = false;
      setBackgroundRefreshingTab((currentTab) =>
        currentTab === tab ? null : currentTab,
      );
      setIsLoading24h(false);
    }
  }, []);

  const loadDayHistory = useCallback(
    async (dayKey: string, force = false) => {
      const cacheKey = getTemperatureHistoryDayCacheKey({
        bucketMinutes: dayHistoryBucketMinutes,
        dayKey,
        view: "day",
      });

      if (inFlightDayKeysRef.current.has(dayKey)) {
        return;
      }
      if (!force && temperatureHistoryDayCache.has(cacheKey)) {
        setHistoryDay(temperatureHistoryDayCache.get(cacheKey) ?? []);
        return;
      }

      const cachedHistory = temperatureHistoryDayCache.get(cacheKey);
      const hasCachedData = cachedHistory !== undefined;

      if (hasCachedData) {
        setHistoryDay(cachedHistory);
        setBackgroundRefreshingTab("day");
      } else {
        setIsLoadingDay(true);
      }

      inFlightDayKeysRef.current.add(dayKey);
      fetchCountRef.current += 1;
      const viewLoadStartedAt = getPerformanceNow();
      const { endIso, startIso } = getHelsinkiDayRange(dayKey);

      logTemperatureHistoryPerformance("day", "query started", {
        dayKey,
        endIso,
        fetchCount: fetchCountRef.current,
        force,
        hasCachedData,
        startIso,
      });

      try {
        const fetchedHistory = await fetchTemperatureHistoryPoints(
          startIso,
          dayKey,
          dayHistoryBucketMinutes,
          "average",
        );
        const endTime = new Date(endIso).getTime();
        const nextHistory = fetchedHistory.filter(
          (point) => new Date(point.timestamp).getTime() < endTime,
        );

        temperatureHistoryDayCache.set(cacheKey, nextHistory);
        if (selectedDayKeyRef.current === dayKey) {
          setHistoryDay(nextHistory);
        }

        logTemperatureHistoryPerformance("day", "query completed", {
          dayKey,
          durationMs: getPerformanceNow() - viewLoadStartedAt,
          rowCount: nextHistory.length,
        });
      } catch (error) {
        console.warn(
          "Lämpöhistorian haku epäonnistui",
          error instanceof Error ? error.message : error,
        );
      } finally {
        inFlightDayKeysRef.current.delete(dayKey);
        if (selectedDayKeyRef.current === dayKey) {
          setBackgroundRefreshingTab((currentTab) =>
            currentTab === "day" ? null : currentTab,
          );
          setIsLoadingDay(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    logTemperatureHistoryPerformance(initialTabRef.current, "navigation mounted", {
      fetchCount: fetchCountRef.current,
    });
  }, []);

  useEffect(() => {
    if (firstRenderLoggedRef.current) {
      return;
    }
    firstRenderLoggedRef.current = true;
    const elapsedMs = getPerformanceNow() - mountedAtRef.current;

    logTemperatureHistoryPerformance(initialTabRef.current, "first render", {
      durationMs: elapsedMs,
      estimatedElementCount: 18,
      targetUnderMs: 100,
    });
    logTemperatureHistoryPerformance(initialTabRef.current, "first content visible", {
      durationMs: elapsedMs,
      estimatedElementCount: 18,
      targetUnderMs: 100,
    });
    firstContentLoggedRef.current = true;
  }, []);

  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      setIsInteractionComplete(true);
      logTemperatureHistoryPerformance(
        initialTabRef.current,
        "interaction completed",
        {
          durationMs: getPerformanceNow() - mountedAtRef.current,
        },
      );
      if (selectedTab === "24h") {
        void loadHistoryTab("24h");
      } else {
        void loadDayHistory(selectedDayKey);
      }
    });

    return () => task.cancel();
  }, [loadDayHistory, loadHistoryTab, selectedDayKey, selectedTab]);

  useFocusEffect(
    useCallback(() => {
      if (selectedTab === "24h") {
        void loadHistoryTab("24h", true);
        return;
      }

      if (isTodayHelsinkiDay(selectedDayKey)) {
        void loadDayHistory(selectedDayKey, true);
      }
    }, [loadDayHistory, loadHistoryTab, selectedDayKey, selectedTab]),
  );

  useEffect(() => {
    const intervalId = setInterval(() => {
      if (selectedTab === "24h") {
        void loadHistoryTab("24h", true);
      }
    }, 60 * 1000);

    return () => clearInterval(intervalId);
  }, [loadHistoryTab, selectedTab]);

  useEffect(() => {
    selectedDayKeyRef.current = selectedDayKey;
  }, [selectedDayKey]);

  useEffect(() => {
    if (selectedTab !== "day" || !isInteractionComplete) {
      return;
    }

    const cachedHistory = temperatureHistoryDayCache.get(
      getTemperatureHistoryDayCacheKey({
        bucketMinutes: dayHistoryBucketMinutes,
        dayKey: selectedDayKey,
        view: "day",
      }),
    );
    if (cachedHistory) {
      setHistoryDay(cachedHistory);
    }
    void loadDayHistory(selectedDayKey);
  }, [isInteractionComplete, loadDayHistory, selectedDayKey, selectedTab]);

  useEffect(() => {
    inletTrendPeriodOffsetRef.current = inletTrendPeriodOffset;
    setSelectedInletTrendSlot(null);
  }, [inletTrendPeriodOffset]);

  useEffect(() => {
    if (!isInteractionComplete) {
      return;
    }

    const cachedPoints = inletTrendPeriodCache.get(String(inletTrendPeriodOffset));
    if (cachedPoints) {
      setWeeklyInletTrend(cachedPoints);
    }
    void loadWeeklyInletTrend(inletTrendPeriodOffset);
  }, [inletTrendPeriodOffset, isInteractionComplete, loadWeeklyInletTrend]);

  useEffect(() => {
    return () => setSelectedHistoryPoint(null);
  }, [selectedDayKey, selectedTab]);

  useEffect(() => {
    debugLog("history loaded", {
      day: historyDay.length,
      dayKey: selectedDayKey,
      firstDay: historyDay[0]?.timestamp,
      h24: history24h.length,
      first24h: history24h[0]?.timestamp,
      latest24h: history24h.at(-1)?.timestamp,
      latestDay: historyDay.at(-1)?.timestamp,
    });
  }, [history24h, historyDay, selectedDayKey]);

  const visibleHistory = useMemo(() => {
    const trendStartedAt = getPerformanceNow();
    const sourceHistory = selectedTab === "24h" ? history24h : historyDay;
    const nextVisibleHistory = isInteractionComplete
      ? getVisibleHistory(sourceHistory, selectedTab)
      : [];

    logTemperatureHistoryPerformance(selectedTab, "trend data build", {
      durationMs: getPerformanceNow() - trendStartedAt,
      sourceRowCount: sourceHistory.length,
      visibleRowCount: nextVisibleHistory.length,
    });

    return nextVisibleHistory;
  }, [history24h, historyDay, isInteractionComplete, selectedTab]);

  useEffect(() => {
    setSelectedHistoryPoint(null);
  }, [chartWidth, visibleHistory]);

  const latestPoint = visibleHistory[visibleHistory.length - 1];
  const chartScale = useMemo(() => [70, 60, 50, 40, 30, 20, 10], []);
  const isDayView = selectedTab === "day";
  const isSelectedDayToday = isTodayHelsinkiDay(selectedDayKey);
  const isSelectedTabLoading =
    (selectedTab === "24h" ? isLoading24h : isLoadingDay) ||
    backgroundRefreshingTab === selectedTab;
  const selectedInletTrendTooltipLeft = selectedInletTrendSlot
    ? Math.min(
        Math.max(selectedInletTrendSlot.x - tooltipWidth / 2, 0),
        Math.max(inletTrendChartWidth - tooltipWidth, 0),
      )
    : 0;
  const lineSegments = useMemo(
    () => getChartLineSegments(visibleHistory, chartWidth),
    [chartWidth, visibleHistory],
  );
  const inletTrendPeriod = useMemo(
    () => getInletTrendPeriod(inletTrendPeriodOffset),
    [inletTrendPeriodOffset],
  );
  const inletTrendSlots = useMemo(
    () => buildInletTrendSlots(inletTrendPeriod, weeklyInletTrend),
    [inletTrendPeriod, weeklyInletTrend],
  );
  const inletTrendLineSegments = useMemo(
    () => getInletTrendLineSegments(inletTrendSlots, inletTrendChartWidth),
    [inletTrendChartWidth, inletTrendSlots],
  );
  const dayXAxisLabels = useMemo(
    () => (isDayView ? getDayXAxisLabels(visibleHistory) : null),
    [isDayView, visibleHistory],
  );

  const selectPreviousDay = useCallback(() => {
    setSelectedDayKey((currentDayKey) =>
      addHelsinkiCalendarDays(currentDayKey, -1),
    );
  }, []);

  const selectNextDay = useCallback(() => {
    setSelectedDayKey((currentDayKey) => {
      if (isTodayHelsinkiDay(currentDayKey)) {
        return currentDayKey;
      }

      const nextDayKey = addHelsinkiCalendarDays(currentDayKey, 1);

      return isTodayHelsinkiDay(nextDayKey) || nextDayKey < getTodayHelsinkiDayKey()
        ? nextDayKey
        : currentDayKey;
    });
  }, []);

  const selectPreviousInletTrendPeriod = useCallback(() => {
    setInletTrendPeriodOffset((currentOffset) => currentOffset + 1);
  }, []);

  const selectNextInletTrendPeriod = useCallback(() => {
    setInletTrendPeriodOffset((currentOffset) => Math.max(currentOffset - 1, 0));
  }, []);

  const updateSelectedHistoryPoint = useCallback(
    (event: GestureResponderEvent) => {
      if (chartWidth <= 0) {
        return;
      }

      const chartData = visibleHistory;

      if (chartData.length === 0) {
        setSelectedHistoryPoint(null);
        return;
      }

      const touchX = Math.min(
        Math.max(event.nativeEvent.locationX, 0),
        chartWidth,
      );
      const columnWidth = chartWidth / chartData.length;
      const nearestIndex = Math.min(
        Math.max(Math.round((touchX - columnWidth / 2) / columnWidth), 0),
        chartData.length - 1,
      );

      const tooltipLeft = Math.min(
        Math.max(
          touchX < chartWidth / 2
            ? touchX + tooltipTouchGap
            : touchX - tooltipTouchGap - tooltipWidth,
          0,
        ),
        Math.max(chartWidth - tooltipWidth, 0),
      );

      // Keep continuous pointer tracking outside React state. Updating state for
      // every native move used to reconcile the entire chart before the next
      // event, which made a single drag advance in short, delayed bursts.
      historyTooltipLeft.setValue(tooltipLeft);
      setSelectedHistoryPoint((currentPoint) =>
        currentPoint?.index === nearestIndex
          ? currentPoint
          : {
              index: nearestIndex,
              point: chartData[nearestIndex],
              pointX: columnWidth * nearestIndex + columnWidth / 2,
            },
      );
    },
    [chartWidth, historyTooltipLeft, visibleHistory],
  );

  const updateSelectedInletTrendSlot = useCallback(
    (event: GestureResponderEvent) => {
      if (inletTrendChartWidth <= 0 || inletTrendSlots.length === 0) {
        return;
      }

      const touchX = Math.min(
        Math.max(event.nativeEvent.locationX, 0),
        inletTrendChartWidth,
      );
      const columnWidth = inletTrendChartWidth / inletTrendSlots.length;
      const nearestIndex = Math.min(
        Math.max(Math.round((touchX - columnWidth / 2) / columnWidth), 0),
        inletTrendSlots.length - 1,
      );

      setSelectedInletTrendSlot({
        index: nearestIndex,
        slot: inletTrendSlots[nearestIndex],
        x: columnWidth * nearestIndex + columnWidth / 2,
      });
    },
    [inletTrendChartWidth, inletTrendSlots],
  );

  return (
    <View style={styles.screen}>
      <View style={[styles.glow, styles.greenGlow]} />
      <View style={[styles.glow, styles.blueGlow]} />

      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 8 },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={styles.title}>Lämpöhistoria</Text>
          <Text style={styles.subtitle}>Varaajan ylä- ja ala-anturi</Text>
        </View>

        <View style={styles.tabSelector}>
          {(["24h", "day"] as const).map((tab) => {
            const isActive = selectedTab === tab;

            return (
              <Pressable
                accessibilityLabel={`Näytä ${tab === "24h" ? "24 tunnin" : "edellisten päivien"} lämpöhistoria`}
                accessibilityRole="button"
                key={tab}
                onPress={() => setSelectedTab(tab)}
                style={[styles.tabButton, isActive && styles.activeTabButton]}
              >
                <Text
                  style={[styles.tabText, isActive && styles.activeTabText]}
                >
                  {tab === "24h" ? "24 h" : "Edelliset päivät"}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {isSelectedTabLoading ? (
          <View style={styles.tabLoader}>
            <ActivityIndicator color="#36f4d4" size="small" />
            <Text style={styles.tabLoaderText}>
              {backgroundRefreshingTab === selectedTab
                ? "Päivitetään..."
                : `Ladataan ${selectedTab === "24h" ? "24 h" : "päivän"} historiaa...`}
            </Text>
          </View>
        ) : null}

        {!isInteractionComplete ? (
          <View style={styles.placeholderCard}>
            <Text style={styles.placeholderText}>Lämpöhistoria valmistuu...</Text>
          </View>
        ) : (
        <View style={styles.historyCard}>
          <View style={styles.summaryRow}>
            <View style={styles.summaryPill}>
              <Text numberOfLines={1} style={styles.summaryLabel}>
                Ylä °C
              </Text>
              <Text style={styles.topSummaryValue}>
                {latestPoint
                  ? roundTemperature(getTopTemperature(latestPoint)).toFixed(1)
                  : "--"}
              </Text>
            </View>
            <View style={styles.summaryPill}>
              <Text numberOfLines={1} style={styles.summaryLabel}>
                70/30 °C
              </Text>
              <Text style={styles.averageSummaryValue}>
                {latestPoint
                  ? roundTemperature(
                      calculateWeightedTemperature(
                        getTopTemperature(latestPoint),
                        getBottomTemperature(latestPoint),
                      ),
                    ).toFixed(1)
                  : "--"}
              </Text>
            </View>
            <View style={styles.summaryPill}>
              <Text numberOfLines={1} style={styles.summaryLabel}>
                Ala °C
              </Text>
              <Text style={styles.bottomSummaryValue}>
                {latestPoint
                  ? roundTemperature(getBottomTemperature(latestPoint)).toFixed(
                      1,
                    )
                  : "--"}
              </Text>
            </View>
          </View>

          <View style={styles.legendRow}>
            <Text style={styles.legendTop}>
              Ylä
            </Text>
            <Text style={styles.legendAverage}>
              70/30
            </Text>
            <Text style={styles.legendBottom}>
              Ala
            </Text>
          </View>

          {visibleHistory.length === 0 ? (
            <Text style={styles.emptyHistoryText}>
              {selectedTab === "day"
                ? "Tältä päivältä ei ole lämpötilatietoja"
                : "Ei vielä lämpöhistoriaa."}
            </Text>
          ) : (
            <>
              <View style={styles.chartRow}>
                <View style={styles.scaleColumn}>
                  {chartScale.map((value) => (
                    <Text key={value} style={styles.scaleText}>
                      {value}°
                    </Text>
                  ))}
                </View>

                <View
                  onLayout={(event) =>
                    setChartWidth(event.nativeEvent.layout.width)
                  }
                  onMoveShouldSetResponder={() => true}
                  onResponderGrant={updateSelectedHistoryPoint}
                  onResponderMove={updateSelectedHistoryPoint}
                  onResponderTerminationRequest={() => false}
                  onStartShouldSetResponder={() => true}
                  style={styles.chartArea}
                >
                  {chartScale.map((value) => (
                    <View
                      key={value}
                      style={[
                        styles.gridLine,
                        { bottom: getPointBottom(value) },
                      ]}
                    />
                  ))}

                  {lineSegments.map((segment) => (
                    <View
                      key={segment.key}
                      style={[
                        styles.chartLine,
                        {
                          backgroundColor: segment.color,
                          height: segment.height,
                          left: segment.left,
                          top: segment.top,
                          transform: [{ rotateZ: segment.angle }],
                          width: segment.width,
                        },
                      ]}
                    />
                  ))}

                  {selectedHistoryPoint ? (
                    <>
                      <View
                        pointerEvents="none"
                        style={[
                          styles.selectedMarkerLine,
                          { left: selectedHistoryPoint.pointX },
                        ]}
                      />
                      <Animated.View
                        pointerEvents="none"
                        style={[
                          styles.historyTooltip,
                          { left: historyTooltipLeft },
                        ]}
                      >
                        <Text style={styles.historyTooltipTime}>
                          {isDayView
                            ? formatDayTooltipTime(
                                selectedHistoryPoint.point.timestamp,
                              )
                            : formatTooltipTime(
                                selectedHistoryPoint.point.timestamp,
                              )}
                        </Text>
                        <Text style={styles.historyTooltipTop}>
                          Ylä{" "}
                          {roundTemperature(
                            getTopTemperature(selectedHistoryPoint.point),
                          ).toFixed(1)}{" "}
                          °C
                        </Text>
                        <Text style={styles.historyTooltipBottom}>
                          Ala{" "}
                          {roundTemperature(
                            getBottomTemperature(selectedHistoryPoint.point),
                          ).toFixed(1)}{" "}
                          °C
                        </Text>
                        <Text style={styles.historyTooltipAverage}>
                          70/30{" "}
                          {roundTemperature(
                            getAverageTemperature(selectedHistoryPoint.point),
                          ).toFixed(1)}{" "}
                          °C
                        </Text>
                      </Animated.View>
                    </>
                  ) : null}

                  <View style={styles.historyColumns}>
                    {visibleHistory.map((point, index) => {
                      const topTemperature = getTopTemperature(point);
                      const bottomTemperature = getBottomTemperature(point);
                      const averageTemperature = getAverageTemperature(point);
                      const defaultXAxisLabel = formatHour(point.timestamp);
                      const dayXAxisLabel = dayXAxisLabels?.get(index);
                      const xAxisLabel =
                        dayXAxisLabel?.text ?? defaultXAxisLabel;
                      const { bottomBottom, topBottom } =
                        getAdjustedPointBottoms(
                          topTemperature,
                          bottomTemperature,
                        );

                      return (
                        <View
                          accessibilityLabel={`${xAxisLabel}, yläanturi ${topTemperature} astetta, ala-anturi ${bottomTemperature} astetta, painotettu lämpö ${averageTemperature} astetta`}
                          key={point.timestamp}
                          style={styles.historyColumn}
                        >
                          <View
                            style={[
                              styles.tempDot,
                              styles.topTempDot,
                              { bottom: topBottom },
                            ]}
                          />
                          <View
                            style={[
                              styles.tempDot,
                              styles.bottomTempDot,
                              { bottom: bottomBottom },
                            ]}
                          />
                          <View
                            style={[
                              styles.tempDot,
                              styles.averageTempDot,
                              { bottom: getPointBottom(averageTemperature) },
                            ]}
                          />
                          {(isDayView
                            ? dayXAxisLabel
                            : shouldShowXAxisLabel(
                                index,
                                visibleHistory.length,
                              )) ? (
                            <Text
                              style={[
                                styles.hourLabel,
                                dayXAxisLabel?.align === "left" &&
                                  styles.hourLabelLeft,
                                dayXAxisLabel?.align === "right" &&
                                  styles.hourLabelRight,
                              ]}
                            >
                              {xAxisLabel}
                            </Text>
                          ) : null}
                        </View>
                      );
                    })}
                  </View>
                </View>
              </View>
            </>
          )}
          {selectedTab === "day" ? (
            <View style={styles.daySelector}>
              <Pressable
                accessibilityLabel="Näytä edellinen päivä"
                accessibilityRole="button"
                onPress={selectPreviousDay}
                style={styles.dayArrowButton}
              >
                <Text style={styles.dayArrowText}>‹</Text>
              </Pressable>
              <Text style={styles.daySelectorLabel}>
                {formatHelsinkiDaySelectorLabel(selectedDayKey)}
              </Text>
              <Pressable
                accessibilityLabel="Näytä seuraava päivä"
                accessibilityRole="button"
                disabled={isSelectedDayToday}
                onPress={selectNextDay}
                style={[
                  styles.dayArrowButton,
                  isSelectedDayToday && styles.dayArrowButtonDisabled,
                ]}
              >
                <Text
                  style={[
                    styles.dayArrowText,
                    isSelectedDayToday && styles.dayArrowTextDisabled,
                  ]}
                >
                  ›
                </Text>
              </Pressable>
            </View>
          ) : null}
        </View>
        )}

        {isInteractionComplete ? (
          <View style={styles.inletTrendCard}>
            <Text style={styles.inletTrendTitle}>
              Tulovesi anturi, viikoittainen
            </Text>

            {weeklyInletTrend.length === 0 ? (
              <Text style={styles.inletTrendEmptyText}>
                {isLoadingWeeklyInletTrend
                  ? "Ladataan..."
                  : "Ei vielä tulovesidataa tältä jaksolta."}
              </Text>
            ) : (
              <View style={styles.chartRow}>
                <View style={styles.inletTrendScaleColumn}>
                  {inletTrendScale.map((value) => (
                    <Text key={value} style={styles.scaleText}>
                      {value}°
                    </Text>
                  ))}
                </View>

                <View
                  onLayout={(event) =>
                    setInletTrendChartWidth(event.nativeEvent.layout.width)
                  }
                  onMoveShouldSetResponder={() => true}
                  onResponderGrant={updateSelectedInletTrendSlot}
                  onResponderMove={updateSelectedInletTrendSlot}
                  onStartShouldSetResponder={() => true}
                  style={styles.inletTrendChartArea}
                >
                  {inletTrendScale.map((value) => (
                    <View
                      key={value}
                      style={[
                        styles.gridLine,
                        { bottom: getInletTrendPointBottom(value) },
                      ]}
                    />
                  ))}

                  {inletTrendLineSegments.map((segment) => (
                    <View
                      key={segment.key}
                      style={[
                        styles.inletTrendLine,
                        {
                          height: segment.height,
                          left: segment.left,
                          top: segment.top,
                          transform: [{ rotateZ: segment.angle }],
                          width: segment.width,
                        },
                      ]}
                    />
                  ))}

                  {selectedInletTrendSlot ? (
                    <>
                      <View
                        pointerEvents="none"
                        style={[
                          styles.inletTrendSelectedMarkerLine,
                          { left: selectedInletTrendSlot.x },
                        ]}
                      />
                      <View
                        pointerEvents="none"
                        style={[
                          styles.inletTrendTooltip,
                          { left: selectedInletTrendTooltipLeft },
                        ]}
                      >
                        <Text style={styles.inletTrendTooltipTime}>
                          {formatInletTrendWeekRangeLabel(
                            selectedInletTrendSlot.slot.weekStart,
                          )}
                        </Text>
                        <Text style={styles.inletTrendTooltipValue}>
                          {selectedInletTrendSlot.slot.minimumInletTempC === null
                            ? "Ei vahvistettua lukemaa"
                            : `Alin ${selectedInletTrendSlot.slot.minimumInletTempC} °C`}
                        </Text>
                      </View>
                    </>
                  ) : null}

                  <View style={styles.inletTrendColumns}>
                    {inletTrendSlots.map((slot) => (
                      <View
                        accessibilityLabel={
                          slot.minimumInletTempC === null
                            ? `Viikko ${formatInletTrendWeekRangeLabel(slot.weekStart)}, ei vahvistettua lukemaa`
                            : `Viikko ${formatInletTrendWeekRangeLabel(slot.weekStart)}, alin tulovesilämpötila ${slot.minimumInletTempC} astetta`
                        }
                        key={slot.weekStart}
                        style={styles.inletTrendColumn}
                      >
                        {slot.minimumInletTempC === null ? null : (
                          <View
                            style={[
                              styles.inletTrendDot,
                              {
                                bottom: getInletTrendPointBottom(
                                  slot.minimumInletTempC,
                                ),
                              },
                            ]}
                          />
                        )}
                      </View>
                    ))}
                  </View>
                </View>
              </View>
            )}

            <View style={styles.daySelector}>
              <Pressable
                accessibilityLabel="Näytä edellinen 3 kuukauden jakso"
                accessibilityRole="button"
                onPress={selectPreviousInletTrendPeriod}
                style={styles.dayArrowButton}
              >
                <Text style={styles.dayArrowText}>‹</Text>
              </Pressable>
              <Text style={styles.daySelectorLabel}>
                {inletTrendPeriod.label}
              </Text>
              <Pressable
                accessibilityLabel="Näytä seuraava 3 kuukauden jakso"
                accessibilityRole="button"
                disabled={inletTrendPeriod.isCurrent}
                onPress={selectNextInletTrendPeriod}
                style={[
                  styles.dayArrowButton,
                  inletTrendPeriod.isCurrent && styles.dayArrowButtonDisabled,
                ]}
              >
                <Text
                  style={[
                    styles.dayArrowText,
                    inletTrendPeriod.isCurrent && styles.dayArrowTextDisabled,
                  ]}
                >
                  ›
                </Text>
              </Pressable>
            </View>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#050816", overflow: "hidden" },
  content: {
    alignItems: "center",
    flexGrow: 1,
    paddingBottom: 32,
    paddingHorizontal: 20,
  },
  glow: {
    borderRadius: 999,
    height: 280,
    opacity: 0.24,
    position: "absolute",
    shadowOpacity: 0.5,
    shadowRadius: 72,
    width: 280,
  },
  greenGlow: { backgroundColor: "#54eaa0", right: -150, top: 80 },
  blueGlow: { backgroundColor: "#5aa7ff", bottom: 70, left: -170 },
  header: { alignItems: "center", marginBottom: 8 },
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
    marginTop: 2,
    textAlign: "center",
  },
  tabSelector: {
    backgroundColor: "rgba(255,255,255,0.06)",
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    marginBottom: 8,
    padding: 3,
    width: "100%",
  },
  tabButton: {
    alignItems: "center",
    borderColor: "transparent",
    borderRadius: 999,
    borderWidth: 1,
    flex: 1,
    paddingVertical: 7,
  },
  activeTabButton: {
    backgroundColor: "rgba(54,244,212,0.18)",
    borderColor: "rgba(191,255,238,0.38)",
    shadowColor: "#36f4d4",
    shadowOpacity: 0.28,
    shadowRadius: 12,
  },
  tabText: { color: "#8ea4cf", fontSize: 14, fontWeight: "900" },
  activeTabText: { color: "#f8fbff" },
  daySelector: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.06)",
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    justifyContent: "center",
    marginTop: 14,
    padding: 8,
    width: "100%",
  },
  dayArrowButton: {
    alignItems: "center",
    backgroundColor: "rgba(5,8,22,0.46)",
    borderColor: "rgba(255,255,255,0.14)",
    borderRadius: 999,
    borderWidth: 1,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  dayArrowButtonDisabled: {
    opacity: 0.38,
  },
  dayArrowText: {
    color: "#f7fbff",
    fontSize: 30,
    fontWeight: "900",
    lineHeight: 32,
  },
  dayArrowTextDisabled: {
    color: "#8190b5",
  },
  daySelectorLabel: {
    color: "#f7fbff",
    flex: 1,
    fontSize: 17,
    fontWeight: "900",
    textAlign: "center",
  },
  tabLoader: {
    alignItems: "center",
    backgroundColor: "rgba(54,244,212,0.1)",
    borderColor: "rgba(54,244,212,0.24)",
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    marginBottom: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    width: "100%",
  },
  tabLoaderText: { color: "#cfe9ff", fontSize: 13, fontWeight: "800" },
  historyCard: {
    backgroundColor: "rgba(255,255,255,0.07)",
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 24,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 8,
    width: "100%",
  },
  summaryRow: { flexDirection: "row", gap: 10, marginBottom: 6 },
  summaryPill: {
    backgroundColor: "rgba(5,8,22,0.46)",
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 16,
    borderWidth: 1,
    flex: 1,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  summaryLabel: {
    color: "#b9d7ff",
    flexShrink: 1,
    fontSize: 12,
    fontWeight: "900",
  },
  topSummaryValue: {
    color: topTemperatureColor,
    fontSize: 29,
    fontWeight: "900",
    marginTop: 3,
  },
  averageSummaryValue: {
    color: averageTemperatureColor,
    fontSize: 29,
    fontWeight: "900",
    marginTop: 3,
  },
  bottomSummaryValue: {
    color: bottomTemperatureColor,
    fontSize: 29,
    fontWeight: "900",
    marginTop: 3,
  },
  legendRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 6,
  },
  legendTop: { color: topTemperatureColor, fontSize: 12, fontWeight: "900" },
  legendBottom: { color: bottomTemperatureColor, fontSize: 12, fontWeight: "900" },
  legendAverage: { color: averageTemperatureColor, fontSize: 12, fontWeight: "900" },
  emptyHistoryText: {
    color: "#cfe9ff",
    fontSize: 15,
    fontWeight: "900",
    paddingVertical: 48,
    textAlign: "center",
  },
  chartRow: { flexDirection: "row", gap: 8 },
  scaleColumn: {
    height: chartHeight,
    justifyContent: "space-between",
    width: 32,
  },
  scaleText: {
    color: "rgba(207,233,255,0.52)",
    fontSize: 10,
    fontWeight: "800",
    textAlign: "right",
  },
  chartArea: { flex: 1, height: chartHeight + 58, position: "relative" },
  gridLine: {
    backgroundColor: "rgba(207,233,255,0.1)",
    height: 1,
    left: 0,
    position: "absolute",
    right: 0,
  },
  chartLine: {
    borderRadius: 999,
    opacity: 0.78,
    position: "absolute",
    transformOrigin: "left center",
    zIndex: 1,
  },
  historyColumns: { flexDirection: "row", height: chartHeight + 58 },
  historyColumn: {
    flex: 1,
    height: chartHeight,
    justifyContent: "flex-end",
    overflow: "visible",
    position: "relative",
  },
  tempDot: {
    borderRadius: 999,
    height: 7,
    left: "50%",
    marginBottom: -3.5,
    marginLeft: -3.5,
    position: "absolute",
    width: 7,
    zIndex: 2,
  },
  topTempDot: {
    backgroundColor: topTemperatureColor,
    shadowColor: topTemperatureColor,
    shadowOpacity: 0.7,
    shadowRadius: 8,
  },
  bottomTempDot: {
    backgroundColor: bottomTemperatureColor,
    shadowColor: bottomTemperatureColor,
    shadowOpacity: 0.7,
    shadowRadius: 8,
  },
  averageTempDot: {
    backgroundColor: averageTemperatureColor,
    shadowColor: averageTemperatureColor,
    shadowOpacity: 0.7,
    shadowRadius: 8,
  },
  selectedMarkerLine: {
    backgroundColor: "rgba(247,251,255,0.38)",
    bottom: 58,
    height: chartHeight,
    position: "absolute",
    width: 1,
    zIndex: 4,
  },
  historyTooltip: {
    backgroundColor: "rgba(5,8,22,0.92)",
    borderColor: "rgba(255,255,255,0.18)",
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 6,
    paddingVertical: 5,
    bottom: tooltipBottomOffset,
    position: "absolute",
    width: tooltipWidth,
    zIndex: 5,
  },
  historyTooltipTime: {
    color: "#f7fbff",
    fontSize: 9,
    fontWeight: "900",
    marginBottom: 2,
  },
  historyTooltipTop: { color: topTemperatureColor, fontSize: 9, fontWeight: "900" },
  historyTooltipBottom: {
    color: bottomTemperatureColor,
    fontSize: 9,
    fontWeight: "900",
    marginTop: 1,
  },
  historyTooltipAverage: {
    color: averageTemperatureColor,
    fontSize: 9,
    fontWeight: "900",
    marginTop: 1,
  },
  hourLabel: {
    bottom: -52,
    color: "#8190b5",
    fontSize: 9,
    fontWeight: "800",
    left: -32,
    position: "absolute",
    textAlign: "center",
    width: 64,
  },
  hourLabelLeft: {
    left: 0,
    textAlign: "left",
  },
  hourLabelRight: {
    left: -64,
    textAlign: "right",
  },
  placeholderCard: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.07)",
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 24,
    borderWidth: 1,
    minHeight: 220,
    justifyContent: "center",
    padding: 24,
    width: "100%",
  },
  placeholderIcon: { fontSize: 38, marginBottom: 12 },
  placeholderText: {
    color: "#cfe9ff",
    fontSize: 17,
    fontWeight: "900",
    textAlign: "center",
  },
  inletTrendCard: {
    backgroundColor: "rgba(255,255,255,0.07)",
    borderColor: "rgba(255,255,255,0.12)",
    borderRadius: 24,
    borderWidth: 1,
    marginTop: 14,
    padding: 16,
    width: "100%",
  },
  inletTrendTitle: {
    color: "#b9d7ff",
    fontSize: 15,
    fontWeight: "700",
    marginBottom: 12,
    textAlign: "center",
  },
  inletTrendEmptyText: {
    color: "#cfe9ff",
    fontSize: 13,
    fontWeight: "700",
    paddingVertical: 12,
    textAlign: "center",
  },
  inletTrendScaleColumn: {
    height: inletTrendChartHeight,
    justifyContent: "space-between",
    width: 32,
  },
  inletTrendChartArea: {
    flex: 1,
    height: inletTrendChartHeight,
    position: "relative",
  },
  inletTrendLine: {
    backgroundColor: inletTemperatureColor,
    opacity: 0.78,
    position: "absolute",
    transformOrigin: "left center",
  },
  inletTrendColumns: {
    flexDirection: "row",
    height: inletTrendChartHeight,
  },
  inletTrendColumn: {
    flex: 1,
    height: inletTrendChartHeight,
    justifyContent: "flex-end",
    position: "relative",
  },
  inletTrendDot: {
    backgroundColor: inletTemperatureColor,
    borderRadius: 999,
    height: 6,
    left: "50%",
    marginBottom: -3,
    marginLeft: -3,
    position: "absolute",
    shadowColor: inletTemperatureColor,
    shadowOpacity: 0.7,
    shadowRadius: 6,
    width: 6,
  },
  inletTrendSelectedMarkerLine: {
    backgroundColor: "rgba(247,251,255,0.38)",
    bottom: 0,
    height: inletTrendChartHeight,
    position: "absolute",
    width: 1,
    zIndex: 4,
  },
  inletTrendTooltip: {
    backgroundColor: "rgba(5,8,22,0.92)",
    borderColor: "rgba(255,255,255,0.18)",
    borderRadius: 12,
    borderWidth: 1,
    bottom: inletTrendChartHeight + 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    position: "absolute",
    width: tooltipWidth,
    zIndex: 5,
  },
  inletTrendTooltipTime: {
    color: "#f7fbff",
    fontSize: 12,
    fontWeight: "900",
    marginBottom: 4,
  },
  inletTrendTooltipValue: {
    color: inletTemperatureColor,
    fontSize: 11,
    fontWeight: "900",
  },
});
