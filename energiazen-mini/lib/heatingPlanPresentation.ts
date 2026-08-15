import { normalizeStoredHeatingPlanHours } from "./heatingPlanMarkers";
import {
  getFinnishDateKey,
  getHelsinkiHourNumber,
  type HourlyPrice,
} from "./heatingLogic";

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
  const currentShowersLabel =
    currentShowers === null ? "--" : formatFinnishDecimal(currentShowers);

  return {
    emptyPlanLabel:
      selectedHours.length === 0 ? "Ei lämmitystarvetta" : null,
    forecastDetails: {
      currentShowersLabel,
      finalShowersLabel: formatFinnishDecimal(finalShowers),
      finalShowersTimeLabel: forecastEndLabel,
      minimumShowersLabel: formatFinnishDecimal(minimumShowersBeforeNextHeating),
      minimumShowersTimeLabel,
    },
    forecastSectionLabel: "Ennuste",
    forecastSummary: `Nyt ${currentShowersLabel} · alimmillaan ${formatFinnishDecimal(minimumShowersBeforeNextHeating)} · ${forecastEndLabel} ${formatFinnishDecimal(finalShowers)} suihkua`,
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
  selectedHours,
}: {
  // Nykyinen paikallinen optimointiesitys (esim. activeOptimizerPresentation),
  // jolla rikastetaan vain Käytetyt rajat -tiedot. targetShowerReserve/
  // safetyShowerReserve tulevat suoraan asetuksista eivatka riipu valituista
  // tunneista, joten ne pysyvat oikeina vaikka esitys on eri optimointiajosta.
  //
  // Ennustetta (forecastDetails/forecastSummary) EI rikasteta samoin: sen
  // "alimmillaan" ja "lopussa"-arvot on simuloitu (simulateHeatingPlan)
  // paikallisen optimoijan OMILLA selectedHeatingHourIds-tunneilla, ei
  // tallennetun backend-suunnitelman tunneilla. Jos nama kaksi tuntijoukkoa
  // eroavat (juuri se tilanne jossa tallennettua suunnitelmaa naytetaan
  // autoritatiivisena), rikastettu ennuste vaittaisi tankin tyhjenevan tai
  // taytyvan eri hetkella kuin mita naytetyt (tallennetun suunnitelman)
  // tunnit oikeasti aiheuttaisivat. Siksi ennuste jatetaan neutraaliksi
  // tekstiksi, kunnes se voidaan laskea nimenomaan backend-tunteja vasten.
  currentOptimizerPresentation?: HeatingPlanPresentation | null;
  selectedHours: HeatingPlanPresentation["selectedHours"];
}): HeatingPlanPresentation {
  return {
    emptyPlanLabel:
      selectedHours.length === 0 ? "Ei lämmitystarvetta" : null,
    forecastDetails: null,
    forecastSectionLabel: "Ennuste",
    forecastSummary:
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
