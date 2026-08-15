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
  // Rajat-osion otsikko. Tallennetulle backend-suunnitelmalle rikastettu
  // "Nykyiset rajat" kertoo etta kyseessa ovat nykyiset paikalliset
  // tavoite-/turvarajat, ei valttamatta ne joilla tallennettu suunnitelma
  // alun perin optimoitiin (rajat itse eivat kuitenkaan riipu valituista
  // tunneista, joten arvot ovat oikeat niin kauan kuin asetukset eivat ole
  // muuttuneet suunnitelman tallentamisen jalkeen).
  limitsSectionLabel: string;
  limitsSummary: string;
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
  if (typeof price !== "number" || !Number.isFinite(price)) {
    return null;
  }

  return `${formatFinnishDecimal(price)} c/kWh`;
}

function formatEstimatedCost(costEuros: number | null | undefined) {
  if (typeof costEuros !== "number" || !Number.isFinite(costEuros)) {
    return null;
  }

  return `n. ${formatFinnishCurrency(costEuros)} €`;
}

// "Alimmillaan"-lukeman pitaa kuvata lahiaikaista pohjaa - alinta
// ennustettua suihkumaaraa ennen SEURAAVAA suunniteltua lammitysta - eika
// koko ennustejakson minimia. Koko jakson minimi osuu usein jakson
// viimeiseen tuntiin (nayttaen samalta kuin "lopussa"-rivi), varsinkin
// kun tulevaisuudessa ei viela ole toista lammityskertaa naissa. Siksi
// haku pysahtyy ensimmaiseen valittuun lammitystuntiin: sen showersLeftBefore
// otetaan viela mukaan (pohja juuri ennen lammityksen alkua), mutta
// showersLeftAfter (lammityksen jalkeinen, jo noussut arvo) ei enaa.
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
    if (!minimum || value < minimum.value) {
      minimum = { date, value };
    }
  };

  for (const hour of forecast) {
    const startDate = new Date(hour.startDate);

    updateMinimum(hour.showersLeftBefore, startDate);

    if (hour.isHeatingSelected) {
      break;
    }

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

// Simuloi ennusteen (simulateHeatingPlan - sama helper jota aktiivinen
// optimoija itse kayttaa) BACKENDIN tallennetuilla selectedHeatingHourIds-
// tunneilla nykyisen optimoinnin lahtotilaa, asetuksia ja ennustemallia
// (heatingGainPerHour, spikes, hourlyDrops, settings) vasten. Kutsujan
// vastuulla on antaa samat nama arvot kuin aktiivinen optimointiajo kaytti,
// jotta ainoa ero optimoijan omaan ennusteeseen on valittu tuntijoukko.
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
  const minimumBeforeNextHeating = findMinimumShowersBeforeNextHeating(
    result.forecast,
  );

  return {
    finalShowers,
    minimumShowersBeforeNextHeating:
      minimumBeforeNextHeating?.value ?? result.minimumPredictedShowersLeft,
    minimumShowersBeforeNextHeatingDate:
      minimumBeforeNextHeating?.date ?? null,
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
  // Koko ennustejakson minimi - kaytetaan turvarajan tayttymisen
  // (statusSummary) laskentaan, joka koskee koko jaksoa.
  minimumShowers: number;
  // Alin ennustettu suihkumaara ennen seuraavaa suunniteltua lammitysta -
  // nain "Alimmillaan"-lukema nayttaa kayttajalle merkityksellisen,
  // lahiaikaisen pohjan sen sijaan etta se toistaisi koko jakson minimin
  // (joka voi osua esim. seuraavan paivan loppuun eika kerro mitaan
  // seuraavaa lammityskertaa edeltavasta pohjasta).
  minimumShowersBeforeNextHeating?: number;
  minimumShowersTimeLabel?: string | null;
  planValid: boolean;
  safetyShowerReserve: number;
  selectedHours: HeatingPlanPresentation["selectedHours"];
  // Suihkumaara heti viimeisen valitun lammitystunnin jalkeen - tama on se
  // hetki jota optimoija (simulateHeatingPlan) itse kayttaa tavoitteen
  // tayttymisen tarkistukseen, ei koko (jopa ~30h) ennustejakson loppua.
  // "statusSummary" kaytetaan tata finalShowersin sijaan, jottei kortti
  // vaita tavoitteen jaavan saavuttamatta pelkastaan siksi etta suunnitelma
  // ei kata viela lammittamatonta myohaisiltaa/-yota, jota se ei koskaan
  // luvannutkaan kattaa. Oletuksena finalShowers, jos tata ei anneta
  // (esim. buildStoredHeatingPlanPresentation, jolla ei ole erillista
  // tarkistuspistetta).
  targetCheckShowersLeft?: number;
  targetShowerReserve: number;
}): HeatingPlanPresentation {
  let reasonKind: HeatingPlanReasonKind;
  let reason: string;

  if (fallbackInUse) {
    reasonKind = "fallback";
    reason =
      "Pörssisähköohjaus ei voinut muodostaa kelvollista suunnitelmaa, joten käytetään valittuja varakäyttötunteja.";
  } else if (heatingNeedMode === "fixed") {
    reasonKind = "fixed";
    reason = `Kiinteä lämmitys ${fixedHeatingHoursPerDay} h/vrk vuorokauden halvimmilla tunneilla.`;
  } else if (!planValid) {
    reasonKind = "max-hours-insufficient";
    reason = `Tavoitevarausta ei saavuteta asetetulla enintään ${automaticMaxHeatingHours} tunnin lämmityksellä. Valittu suunnitelma on paras mahdollinen käytettävissä olevilla tunneilla.`;
  } else if (selectedHours.length === 0) {
    reasonKind = "no-heating";
    reason =
      "Nykyinen lämminvesivaraus riittää turvarajan yläpuolella pysymiseen ja tavoite saavutetaan ilman lisälämmitystä.";
  } else if (cheaperPlanRejectedForSafety) {
    reasonKind = "early-for-safety";
    reason =
      "Lämmitys aloitetaan aikaisemmin, koska myöhempään odottaminen alittaisi turvarajan.";
  } else {
    reasonKind = "standard";
    reason =
      "Halvin suunnitelma, jolla turvaraja säilyy ja tavoite saavutetaan.";
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
    emptyPlanLabel:
      selectedHours.length === 0 ? "Ei lämmitystarvetta" : null,
    forecastDetails,
    forecastSectionLabel: "Ennuste",
    forecastSummary,
    heatingSummary:
      selectedHours.length === 0
        ? null
        : `Lämmitystä ${selectedHours.length} ${selectedHours.length === 1 ? "tunti" : "tuntia"}`,
    limitsSectionLabel: "Käytetyt rajat",
    limitsSummary: `Tavoite ${targetShowerReserve} suihkua · turvaraja ${safetyShowerReserve} suihkua`,
    reason,
    reasonKind,
    selectedHours: selectedHours.map((hour) => {
      const priceLabel = formatHeatingHourPrice(hour.price);
      const costLabel = formatEstimatedCost(hour.estimatedCostEuros);

      return {
        ...hour,
        label: [hour.label, priceLabel, costLabel]
          .filter((label): label is string => Boolean(label))
          .join(" · "),
      };
    }),
    statusSummary,
  };
}

export function buildStoredHeatingPlanPresentation({
  currentOptimizerPresentation = null,
  forecast = null,
  selectedHours,
}: {
  // Nykyinen paikallinen optimointiesitys (esim. activeOptimizerPresentation),
  // jolla rikastetaan vain Käytetyt rajat -tiedot. targetShowerReserve/
  // safetyShowerReserve tulevat suoraan asetuksista eivatka riipu valituista
  // tunneista, joten ne pysyvat oikeina vaikka esitys on eri optimointiajosta.
  currentOptimizerPresentation?: HeatingPlanPresentation | null;
  // Ennuste (forecastDetails/forecastSummary) BACKENDIN tallennetuille
  // tunneille - kutsujan on laskettava tama simulateStoredHeatingPlanForecast-
  // funktiolla (tai vastaavalla) juuri backendin selectedHours-tunteja
  // vasten, ei paikallisen optimoijan omilla valituilla tunneilla. Jos jatetaan
  // pois (null), ennuste jaa neutraaliksi tekstiksi.
  forecast?: {
    forecastDetails: HeatingPlanForecastDetails;
    forecastSummary: string;
  } | null;
  selectedHours: HeatingPlanPresentation["selectedHours"];
}): HeatingPlanPresentation {
  return {
    emptyPlanLabel:
      selectedHours.length === 0 ? "Ei lämmitystarvetta" : null,
    forecastDetails: forecast?.forecastDetails ?? null,
    forecastSectionLabel: "Ennuste",
    forecastSummary:
      forecast?.forecastSummary ??
      "Tallennetulle suunnitelmalle ei ole saatavilla luotettavaa ennustetta.",
    heatingSummary:
      selectedHours.length === 0
        ? null
        : `Lämmitystä ${selectedHours.length} ${selectedHours.length === 1 ? "tunti" : "tuntia"}`,
    limitsSectionLabel: currentOptimizerPresentation
      ? "Nykyiset rajat"
      : "Käytetyt rajat",
    limitsSummary: currentOptimizerPresentation
      ? currentOptimizerPresentation.limitsSummary
      : "Tavoite- ja turvarajat eivät sisälly tallennettuun suunnitelmaan.",
    reason: "Näytetään viimeksi tallennetut lämmitystunnit.",
    reasonKind: selectedHours.length === 0 ? "no-heating" : "standard",
    selectedHours: selectedHours.map((hour) => {
      const priceLabel = formatHeatingHourPrice(hour.price);
      const costLabel = formatEstimatedCost(hour.estimatedCostEuros);

      return {
        ...hour,
        label: [hour.label, priceLabel, costLabel]
          .filter((label): label is string => Boolean(label))
          .join(" · "),
      };
    }),
    statusSummary: "Viimeksi tallennettu suunnitelma",
  };
}

export function selectActiveHeatingPlanPresentation(
  freshOptimizerPresentation: HeatingPlanPresentation | null,
  storedPresentation: HeatingPlanPresentation | null,
  storedPlanIsAuthoritative = false,
) {
  if (storedPlanIsAuthoritative) {
    return storedPresentation ?? freshOptimizerPresentation;
  }

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
        (priceIntervalsByDateHour.get(`${plan.plan_date}:${hour}`)?.size ?? 0) >
        1,
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
