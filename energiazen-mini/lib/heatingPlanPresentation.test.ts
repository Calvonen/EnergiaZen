import {
  buildHeatingPlanPresentation,
  hasCheaperSafetyRejectedPlan,
} from "./heatingPlanPresentation";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const baseInput = {
  automaticMaxHeatingHours: 3,
  cheaperPlanRejectedForSafety: false,
  currentShowers: 3.1,
  fallbackInUse: false,
  finalShowers: 4.4,
  fixedHeatingHoursPerDay: 2,
  forecastEndLabel: "huomenna vuorokauden lopussa",
  heatingNeedMode: "automatic" as const,
  minimumShowers: 2.3,
  planValid: true,
  safetyShowerReserve: 2,
  selectedHours: [
    { label: "23–00", period: "Tänään" as const },
    { label: "00–01", period: "Huomenna" as const },
  ],
  targetShowerReserve: 4,
};

export function runHeatingPlanPresentationUnitTests() {
  const standard = buildHeatingPlanPresentation(baseInput);
  assertEqual(standard.reasonKind, "standard", "tavallinen suunnitelma tunnistetaan");
  assertEqual(
    standard.reason,
    "Halvin suunnitelma, jolla turvaraja säilyy ja tavoite saavutetaan.",
    "tavallinen onnistunut suunnitelma perustellaan",
  );
  assertEqual(
    standard.heatingSummary,
    "Lämmitystä 2 tuntia",
    "valittujen tuntien maara naytetaan luonnollisesti",
  );
  assertEqual(
    {
      statusSummary: standard.statusSummary,
    },
    { statusSummary: "Tavoite ja turvaraja täyttyvät" },
    "tavoite- ja turvarajojen tayttyminen raportoidaan",
  );

  const rejectedForSafety = hasCheaperSafetyRejectedPlan({
    rejectedPlans: [
      {
        cost: 1,
        laterThanSelected: true,
        selectedHourCount: 1,
        violations: ["safety shower reserve would be violated"],
      },
    ],
    selectedCost: 10,
    selectedHourCount: 1,
  });
  assertEqual(rejectedForSafety, true, "halvempi turvarajan rikkova suunnitelma tunnistetaan");
  assertEqual(
    buildHeatingPlanPresentation({
      ...baseInput,
      cheaperPlanRejectedForSafety: rejectedForSafety,
      selectedHours: [baseInput.selectedHours[0]],
    }).reasonKind,
    "early-for-safety",
    "aikaisempi kallis tunti perustellaan turvarajalla",
  );

  const noHeating = buildHeatingPlanPresentation({
    ...baseInput,
    selectedHours: [],
  });
  assertEqual(noHeating.reasonKind, "no-heating", "lammitysta tarvitsematon suunnitelma perustellaan");
  assertEqual(
    noHeating.reason,
    "Nykyinen lämminvesivaraus riittää turvarajan yläpuolella pysymiseen ja tavoite saavutetaan ilman lisälämmitystä.",
    "lammitykseton suunnitelma perustellaan suoraan",
  );
  assertEqual(noHeating.emptyPlanLabel, "Ei lämmitystarvetta", "nollan tunnin suunnitelma nimetaan selkeasti");
  assertEqual(noHeating.heatingSummary, null, "nollan tunnin teknista tuntirivia ei nayteta");
  assertEqual(
    buildHeatingPlanPresentation({ ...baseInput, planValid: false }).reasonKind,
    "max-hours-insufficient",
    "riittamaton enimmaistuntimaara perustellaan",
  );
  assertEqual(
    buildHeatingPlanPresentation({ ...baseInput, fallbackInUse: true }).reasonKind,
    "fallback",
    "varakaytto perustellaan",
  );
  assertEqual(
    buildHeatingPlanPresentation({
      ...baseInput,
      finalShowers: 3.5,
    }).statusSummary,
    "Turvaraja täyttyy, mutta tavoitetta ei saavuteta",
    "vain turvarajan tayttyminen ilmaistaan luonnollisesti",
  );
  assertEqual(
    standard.forecastSummary.includes("· lopussa"),
    false,
    "loppuarvion ajankohta ei ole pelkka lopussa",
  );
  const visibleContent = JSON.stringify(standard);
  assertEqual(
    visibleContent.includes("nousuarvio") || visibleContent.includes("fallback-arvo"),
    false,
    "nousuarviota tai fallback-arvoa ei sisallyteta etusivun esitysmalliin",
  );
}
