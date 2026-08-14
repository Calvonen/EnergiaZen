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
  forecastSummary: string;
  heatingSummary: string | null;
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
    forecastSummary: `Nyt ${currentShowersLabel} · alimmillaan ${formatFinnishDecimal(minimumShowersBeforeNextHeating)} · ${forecastEndLabel} ${formatFinnishDecimal(finalShowers)} suihkua`,
    heatingSummary:
      selectedHours.length === 0
        ? null
        : `Lämmitystä ${selectedHours.length} ${selectedHours.length === 1 ? "tunti" : "tuntia"}`,
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
  currentShowers,
  safetyShowerReserve,
  selectedHours,
  targetShowerReserve,
}: {
  currentShowers: number | null;
  safetyShowerReserve: number;
  selectedHours: HeatingPlanPresentation["selectedHours"];
  targetShowerReserve: number;
}) {
  const currentShowersValue = currentShowers ?? 0;
  const presentation = buildHeatingPlanPresentation({
    automaticMaxHeatingHours: selectedHours.length,
    cheaperPlanRejectedForSafety: false,
    currentShowers,
    fallbackInUse: false,
    finalShowers: currentShowersValue,
    fixedHeatingHoursPerDay: selectedHours.length,
    forecastEndLabel: "ennusteen paivittyessa",
    heatingNeedMode: "automatic",
    minimumShowers: currentShowersValue,
    planValid: true,
    safetyShowerReserve,
    selectedHours,
    targetShowerReserve,
  });

  return {
    ...presentation,
    forecastDetails: null,
    forecastSummary: "Ennustetta päivitetään uusilla lämpötilatiedoilla.",
    reason: "Näytetään viimeksi tallennettu lämmityssuunnitelma.",
    statusSummary: "Viimeksi tallennettu suunnitelma",
  };
}

export function selectActiveHeatingPlanPresentation(
  freshOptimizerPresentation: HeatingPlanPresentation | null,
  storedPresentation: HeatingPlanPresentation | null,
  {
    settingsUpdatedAt = null,
    storedPlanIsAuthoritative = false,
    storedPlanUpdatedAts = [],
  }: {
    settingsUpdatedAt?: string | null;
    storedPlanIsAuthoritative?: boolean;
    storedPlanUpdatedAts?: (string | null | undefined)[];
  } = {},
) {
  if (!storedPlanIsAuthoritative) {
    return freshOptimizerPresentation ?? storedPresentation;
  }

  const settingsUpdatedAtMs = settingsUpdatedAt
    ? Date.parse(settingsUpdatedAt)
    : Number.NaN;
  const storedPlanIsFresh =
    storedPresentation !== null &&
    Number.isFinite(settingsUpdatedAtMs) &&
    storedPlanUpdatedAts.length > 0 &&
    storedPlanUpdatedAts.every((updatedAt) => {
      const updatedAtMs = updatedAt ? Date.parse(updatedAt) : Number.NaN;

      return Number.isFinite(updatedAtMs) && updatedAtMs >= settingsUpdatedAtMs;
    });

  return storedPlanIsFresh ? storedPresentation : freshOptimizerPresentation;
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
