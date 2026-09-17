import { normalizeStoredHeatingPlanHours } from "./heatingPlanMarkers";
import {
  getFinnishDateKey,
  getHelsinkiHourNumber,
  type HourlyPrice,
} from "./heatingLogic";
import {
  simulateHeatingPlan,
  type ConsumptionSpike,
  type HeatingOptimizationHour,
  type HeatingOptimizationSettings,
  type HourlyHeatingForecast,
} from "./heatingOptimizer";
import type { HourlyTemperatureDropProfile } from "./tankTemperatureForecast";
import { V2_RECOMMENDED_PREHEAT_PERCENT } from "./v2HomeReservePresentation";

export type HeatingPlanReasonKind =
  | "early-for-safety"
  | "fallback"
  | "fixed"
  | "max-hours-insufficient"
  | "no-heating"
  | "standard";

export type HeatingPlanForecastDetails = {
  currentShowersLabel: string;
  finalShowersLabel: string;
  finalShowersTimeLabel: string;
  minimumShowersLabel: string;
  minimumShowersTimeLabel: string | null;
};

export type HeatingPlanPresentation = {
  emptyPlanLabel: string | null;
  forecastDetails: HeatingPlanForecastDetails | null;
  forecastSectionLabel: string;
  forecastSummary: string;
  heatingSummary: string | null;
  limitsSectionLabel: string;
  limitsSummary: string;
  priceToleranceSummary: string | null;
  reason: string;
  reasonKind: HeatingPlanReasonKind;
  selectedHours: {
    estimatedCostEuros?: number | null;
    label: string;
    period: "Huomenna" | "Tänään";
    price?: number | null;
  }[];
  statusSummary: string;
};

function formatFinnishDecimal(value: number) {
  return value.toFixed(1).replace(".", ",");
}

function formatFinnishCurrency(value: number) {
  return value.toFixed(2).replace(".", ",");
}

function formatHeatingHourPrice(price: number | null | undefined) {
  if (typeof price !== "number" || !Number.isFinite(price)) return null;
  return `${formatFinnishDecimal(price)} c/kWh`;
}

function formatEstimatedCost(costEuros: number | null | undefined) {
  if (typeof costEuros !== "number" || !Number.isFinite(costEuros)) return null;
  return `n. ${formatFinnishCurrency(costEuros)} €`;
}

function formatPriceToleranceSummary(priceToleranceCents: number) {
  return priceToleranceCents > 0
    ? `Hintatoleranssi ${formatFinnishDecimal(priceToleranceCents)} c/kWh`
    : "Hintatoleranssi pois käytöstä";
}

export function findMinimumShowersBeforeNextHeating(
  forecast: Pick<
    HourlyHeatingForecast,
    | "isHeatingSelected"
    | "showersLeftAfter"
    | "showersLeftBefore"
    | "segmentHours"
    | "startDate"
  >[],
): { date: Date; value: number } | null {
  let minimum: { date: Date; value: number } | null = null;
  const updateMinimum = (value: number, date: Date) => {
    if (!minimum || value < minimum.value) minimum = { date, value };
  };

  for (const hour of forecast) {
    const startDate = new Date(hour.startDate);
    updateMinimum(hour.showersLeftBefore, startDate);
    if (hour.isHeatingSelected) break;
    updateMinimum(
      hour.showersLeftAfter,
      new Date(startDate.getTime() + hour.segmentHours * 60 * 60 * 1000),
    );
  }
  return minimum;
}

export function buildHeatingPlanForecastFields({
  currentShowers,
  finalShowers,
  forecastEndLabel,
  minimumShowersBeforeNextHeating,
  minimumShowersTimeLabel,
}: {
  currentShowers: number | null;
  finalShowers: number;
  forecastEndLabel: string;
  minimumShowersBeforeNextHeating: number;
  minimumShowersTimeLabel: string | null;
}): {
  forecastDetails: HeatingPlanForecastDetails;
  forecastSummary: string;
} {
  const currentShowersLabel =
    currentShowers === null ? "--" : formatFinnishDecimal(currentShowers);
  return {
    forecastDetails: {
      currentShowersLabel,
      finalShowersLabel: formatFinnishDecimal(finalShowers),
      finalShowersTimeLabel: forecastEndLabel,
      minimumShowersLabel: formatFinnishDecimal(minimumShowersBeforeNextHeating),
      minimumShowersTimeLabel,
    },
    forecastSummary: `Nyt ${currentShowersLabel} · alimmillaan ${formatFinnishDecimal(minimumShowersBeforeNextHeating)} · ${forecastEndLabel} ${formatFinnishDecimal(finalShowers)} suihkua`,
  };
}

export function simulateStoredHeatingPlanForecast({
  currentBottomTemperature,
  currentTopTemperature,
  currentWeightedTemperature,
  heatingGainPerHour,
  hourlyDrops,
  hours,
  isCurrentlyHeating = false,
  recoveryDropEnabled = false,
  recoveryDropPerHour,
  selectedHeatingHourIds,
  settings,
  spikes,
}: {
  currentBottomTemperature: number;
  currentTopTemperature: number;
  currentWeightedTemperature?: number;
  heatingGainPerHour: number;
  hourlyDrops: HourlyTemperatureDropProfile;
  hours: HeatingOptimizationHour[];
  isCurrentlyHeating?: boolean;
  recoveryDropEnabled?: boolean;
  recoveryDropPerHour?: number;
  selectedHeatingHourIds: string[];
  settings: HeatingOptimizationSettings;
  spikes?: ConsumptionSpike[];
}): {
  finalShowers: number;
  minimumShowersBeforeNextHeating: number;
  minimumShowersBeforeNextHeatingDate: Date | null;
} {
  const result = simulateHeatingPlan({
    currentBottomTemperature,
    currentTopTemperature,
    currentWeightedTemperature,
    heatingGainPerHour,
    hourlyDrops,
    hours,
    isCurrentlyHeating,
    recoveryDropEnabled,
    recoveryDropPerHour,
    selectedHeatingHourIds,
    settings,
    spikes,
  });
  const finalShowers =
    result.forecast[result.forecast.length - 1]?.showersLeftAfter ??
    result.minimumPredictedShowersLeft;
  const minimumBeforeNextHeating = findMinimumShowersBeforeNextHeating(result.forecast);
  return {
    finalShowers,
    minimumShowersBeforeNextHeating:
      minimumBeforeNextHeating?.value ?? result.minimumPredictedShowersLeft,
    minimumShowersBeforeNextHeatingDate: minimumBeforeNextHeating?.date ?? null,
  };
}

export function buildHeatingPlanPresentation({
  automaticMaxHeatingHours,
  cheaperPlanRejectedForSafety,
  currentShowers,
  forecastEndLabel,
  fallbackInUse,
  finalShowers,
  fixedHeatingHoursPerDay,
  heatingNeedMode,
  minimumShowers,
  minimumShowersBeforeNextHeating = minimumShowers,
  minimumShowersTimeLabel = null,
  planValid,
  priceToleranceCents,
  safetyShowerReserve,
  selectedHours,
  targetCheckShowersLeft,
  targetShowerReserve,
}: {
  automaticMaxHeatingHours: number;
  cheaperPlanRejectedForSafety: boolean;
  currentShowers: number | null;
  fallbackInUse: boolean;
  finalShowers: number;
  fixedHeatingHoursPerDay: number;
  forecastEndLabel: string;
  heatingNeedMode: "automatic" | "fixed";
  minimumShowers: number;
  minimumShowersBeforeNextHeating?: number;
  minimumShowersTimeLabel?: string | null;
  planValid: boolean;
  priceToleranceCents: number;
  safetyShowerReserve: number;
  selectedHours: HeatingPlanPresentation["selectedHours"];
  targetCheckShowersLeft?: number;
  targetShowerReserve: number;
}): HeatingPlanPresentation {
  let reasonKind: HeatingPlanReasonKind;
  let reason: string;

  if (fallbackInUse) {
    reasonKind = "fallback";
    reason = "Pörssisähköohjaus ei voinut muodostaa kelvollista suunnitelmaa, joten käytetään valittuja varakäyttötunteja.";
  } else if (heatingNeedMode === "fixed") {
    reasonKind = "fixed";
    reason = `Kiinteä lämmitys ${fixedHeatingHoursPerDay} h/vrk vuorokauden halvimmilla tunneilla.`;
  } else if (!planValid) {
    reasonKind = "max-hours-insufficient";
    reason = `Tavoitevarausta ei saavuteta asetetulla enintään ${automaticMaxHeatingHours} tunnin lämmityksellä. Valittu suunnitelma on paras mahdollinen käytettävissä olevilla tunneilla.`;
  } else if (selectedHours.length === 0) {
    reasonKind = "no-heating";
    reason = "Nykyinen lämminvesivaraus riittää turvarajan yläpuolella pysymiseen ja tavoite saavutetaan ilman lisälämmitystä.";
  } else if (cheaperPlanRejectedForSafety) {
    reasonKind = "early-for-safety";
    reason = "Lämmitys aloitetaan aikaisemmin, koska myöhempään odottaminen alittaisi turvarajan.";
  } else {
    reasonKind = "standard";
    reason = "Halvin suunnitelma, jolla turvaraja säilyy ja tavoite saavutetaan.";
  }

  const safetyReserveMet = minimumShowers >= safetyShowerReserve;
  const targetReserveMet =
    (targetCheckShowersLeft ?? finalShowers) >= targetShowerReserve;
  const statusSummary =
    safetyReserveMet && targetReserveMet
      ? "Tavoite ja turvaraja täyttyvät"
      : safetyReserveMet
        ? "Turvaraja täyttyy, mutta tavoitetta ei saavuteta"
        : targetReserveMet
          ? "Tavoite saavutetaan, mutta turvaraja ei täyty"
          : "Tavoitetta eikä turvarajaa saavuteta";
  const { forecastDetails, forecastSummary } = buildHeatingPlanForecastFields({
    currentShowers,
    finalShowers,
    forecastEndLabel,
    minimumShowersBeforeNextHeating,
    minimumShowersTimeLabel,
  });

  return {
    emptyPlanLabel: selectedHours.length === 0 ? "Ei lämmitystarvetta" : null,
    forecastDetails,
    forecastSectionLabel: "Ennuste",
    forecastSummary,
    heatingSummary:
      selectedHours.length === 0
        ? null
        : `Lämmitystä ${selectedHours.length} ${selectedHours.length === 1 ? "tunti" : "tuntia"}`,
    limitsSectionLabel: "Käytetyt rajat",
    limitsSummary: `Tavoite ${targetShowerReserve} suihkua · turvaraja ${safetyShowerReserve} suihkua`,
    priceToleranceSummary: formatPriceToleranceSummary(priceToleranceCents),
    reason,
    reasonKind,
    selectedHours: selectedHours.map(formatSelectedHour),
    statusSummary,
  };
}

export function buildStoredHeatingPlanPresentation({
  currentOptimizerPresentation: _currentOptimizerPresentation = null,
  forecast: _forecast = null,
  selectedHours,
  v2EnergyReserve = null,
}: {
  currentOptimizerPresentation?: HeatingPlanPresentation | null;
  forecast?: {
    forecastDetails: HeatingPlanForecastDetails;
    forecastSummary: string;
  } | null;
  selectedHours: HeatingPlanPresentation["selectedHours"];
  v2EnergyReserve?: {
    available: boolean;
    capacityKwh: number | null;
    energyKwh: number | null;
    forecastMinimumEnergyKwh: number | null;
    forecastMinimumPercent: number | null;
    forecastFinalEnergyKwh: number | null;
    forecastFinalPercent: number | null;
    percent: number | null;
    safetyReservePercent: number | null;
    targetReservePercent: number | null;
    recommendedPreheatPercent?: number;
    isFallback?: boolean;
  } | null;
}): HeatingPlanPresentation {
  const recommendedPreheatPercent =
    v2EnergyReserve?.recommendedPreheatPercent ?? V2_RECOMMENDED_PREHEAT_PERCENT;
  const v2ForecastAvailable =
    v2EnergyReserve?.available === true &&
    v2EnergyReserve.percent !== null &&
    v2EnergyReserve.energyKwh !== null &&
    v2EnergyReserve.capacityKwh !== null &&
    v2EnergyReserve.forecastMinimumPercent !== null &&
    v2EnergyReserve.forecastFinalEnergyKwh !== null &&
    v2EnergyReserve.forecastFinalPercent !== null &&
    v2EnergyReserve.safetyReservePercent !== null;
  const v2ForecastSummary = v2ForecastAvailable
    ? v2EnergyReserve?.isFallback
      ? `Viimeisin varma arvio ${formatFinnishDecimal(v2EnergyReserve.percent as number)} % (${formatFinnishDecimal(v2EnergyReserve.energyKwh as number)} kWh) · huomenna lopussa ${formatFinnishDecimal(v2EnergyReserve.forecastFinalPercent as number)} % (${formatFinnishDecimal(v2EnergyReserve.forecastFinalEnergyKwh as number)} kWh) · ennusteen alin ${formatFinnishDecimal(v2EnergyReserve.forecastMinimumPercent as number)} %`
      : `Nyt ${formatFinnishDecimal(v2EnergyReserve?.percent as number)} % (${formatFinnishDecimal(v2EnergyReserve?.energyKwh as number)} kWh) · huomenna lopussa ${formatFinnishDecimal(v2EnergyReserve?.forecastFinalPercent as number)} % (${formatFinnishDecimal(v2EnergyReserve?.forecastFinalEnergyKwh as number)} kWh) · ennusteen alin ${formatFinnishDecimal(v2EnergyReserve?.forecastMinimumPercent as number)} %`
    : "V2-energiavara ei ole juuri nyt saatavilla. Vanhaa suihkuennustetta ei enää käytetä.";
  const safetyReservePercent = v2EnergyReserve?.safetyReservePercent;
  const limitsSummary =
    typeof safetyReservePercent === "number" && Number.isFinite(safetyReservePercent)
      ? `Suositus ${formatFinnishDecimal(recommendedPreheatPercent)} % · turvaraja ${formatFinnishDecimal(safetyReservePercent)} %`
      : `Pehmeä esilämmityssuositus ${formatFinnishDecimal(recommendedPreheatPercent)} %. Turvaraja ei ole juuri nyt saatavilla.`;

  return {
    emptyPlanLabel:
      selectedHours.length === 0 ? "Ei valittuja lämmitystunteja" : null,
    forecastDetails: null,
    forecastSectionLabel: "V2-energiavara",
    forecastSummary: v2ForecastSummary,
    heatingSummary:
      selectedHours.length === 0
        ? null
        : `Lämmitystä ${selectedHours.length} ${selectedHours.length === 1 ? "tunti" : "tuntia"}`,
    limitsSectionLabel: "V2-rajat",
    limitsSummary,
    priceToleranceSummary: null,
    reason: "V2 optimoi energiavaran turvallisuusrajan ja hinnan perusteella; 90 % on pehmeä esilämmityssuositus.",
    reasonKind: selectedHours.length === 0 ? "no-heating" : "standard",
    selectedHours: selectedHours.map(formatSelectedHour),
    statusSummary: v2ForecastAvailable
      ? v2EnergyReserve?.isFallback
        ? "V2-energiavara · viimeisin varma arvio"
        : "V2-energiavara"
      : "V2-energiavara · ennuste ei saatavilla",
  };
}

function formatSelectedHour(hour: HeatingPlanPresentation["selectedHours"][number]) {
  const priceLabel = formatHeatingHourPrice(hour.price);
  const costLabel = formatEstimatedCost(hour.estimatedCostEuros);
  return {
    ...hour,
    label: [hour.label, priceLabel, costLabel]
      .filter((label): label is string => Boolean(label))
      .join(" · "),
  };
}

export function selectActiveHeatingPlanPresentation(
  freshOptimizerPresentation: HeatingPlanPresentation | null,
  storedPresentation: HeatingPlanPresentation | null,
  storedPlanIsAuthoritative = false,
) {
  if (storedPlanIsAuthoritative) return storedPresentation ?? freshOptimizerPresentation;
  return freshOptimizerPresentation ?? storedPresentation;
}

export function hasAmbiguousStoredHeatingPlanHour({
  hourlyPrices,
  storedPlans,
}: {
  hourlyPrices: Pick<HourlyPrice, "date" | "startDate">[];
  storedPlans: { plan_date?: string | null; planned_hours?: unknown }[];
}) {
  const priceIntervalsByDateHour = new Map<string, Set<number>>();
  for (const price of hourlyPrices) {
    const dateHour = `${getFinnishDateKey(price.startDate)}:${getHelsinkiHourNumber(price.date)}`;
    const intervalStarts = priceIntervalsByDateHour.get(dateHour) ?? new Set();
    intervalStarts.add(price.date.getTime());
    priceIntervalsByDateHour.set(dateHour, intervalStarts);
  }
  return storedPlans.some((plan) =>
    normalizeStoredHeatingPlanHours(plan.planned_hours).some(
      (hour) =>
        (priceIntervalsByDateHour.get(`${plan.plan_date}:${hour}`)?.size ?? 0) > 1,
    ),
  );
}

export function hasCheaperSafetyRejectedPlan({
  rejectedPlans,
  selectedCost,
  selectedHourCount,
}: {
  rejectedPlans: {
    cost: number;
    laterThanSelected: boolean;
    selectedHourCount: number;
    violations: string[];
  }[];
  selectedCost: number;
  selectedHourCount: number;
}) {
  return rejectedPlans.some(
    (plan) =>
      plan.selectedHourCount === selectedHourCount &&
      plan.cost < selectedCost &&
      plan.laterThanSelected &&
      plan.violations.includes("safety shower reserve would be violated"),
  );
}
