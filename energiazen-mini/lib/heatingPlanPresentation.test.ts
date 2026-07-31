import {
  buildHeatingPlanPresentation,
  buildStoredHeatingPlanPresentation,
  hasCheaperSafetyRejectedPlan,
  selectActiveHeatingPlanPresentation,
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
  const stored = buildStoredHeatingPlanPresentation({
    currentShowers: 5.8,
    safetyShowerReserve: 2,
    selectedHours: [
      { label: "06-07", period: "Tänään", price: 2 },
    ],
    targetShowerReserve: 3,
  });
  assertEqual(
    stored.statusSummary,
    "Viimeksi tallennettu suunnitelma",
    "tallennettu suunnitelma tarjoaa vakaan kortin optimoinnin ajaksi",
  );
  assertEqual(
    stored.selectedHours.length,
    1,
    "tallennetun suunnitelman tunnit sailyvat odotusnakymaan",
  );

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
    buildHeatingPlanPresentation({
      ...baseInput,
      selectedHours: [
        { label: "15–16", period: "Huomenna", price: 0.9 },
      ],
    }).selectedHours,
    [{ label: "15–16 · 0,9 c/kWh", period: "Huomenna", price: 0.9 }],
    "yhden valitun tunnin hinta naytetaan tunnin perassa",
  );
  assertEqual(
    buildHeatingPlanPresentation({
      ...baseInput,
      selectedHours: [
        { label: "15–16", period: "Huomenna", price: 0.9 },
        { label: "16–17", period: "Huomenna", price: 1 },
      ],
    }).selectedHours.map((hour) => hour.label),
    ["15–16 · 0,9 c/kWh", "16–17 · 1,0 c/kWh"],
    "usean valitun tunnin hinnat naytetaan aikajarjestyksessa",
  );
  const planWithCosts = buildHeatingPlanPresentation({
    ...baseInput,
    selectedHours: [
      {
        estimatedCostEuros: 0.2856,
        label: "15–16",
        period: "Huomenna",
        price: 0.9,
      },
      {
        estimatedCostEuros: 0.2886,
        label: "16–17",
        period: "Huomenna",
        price: 1,
      },
    ],
  });
  assertEqual(
    planWithCosts.selectedHours.map((hour) => hour.label),
    [
      "15–16 · 0,9 c/kWh · n. 0,29 €",
      "16–17 · 1,0 c/kWh · n. 0,29 €",
    ],
    "valitun tunnin arvioitu eurohinta naytetaan spot-hinnan jalkeen",
  );
  assertEqual(
    planWithCosts.planCostSummary,
    "Suunnitelman arvioitu hinta n. 0,57 €",
    "suunnitelman arvioitu hinta naytetaan valittujen tuntien summana",
  );
  assertEqual(
    buildHeatingPlanPresentation({
      ...baseInput,
      selectedHours: [
        { label: "03–04", period: "Tänään", price: 12.34 },
      ],
    }).selectedHours[0].label,
    "03–04 · 12,3 c/kWh",
    "hinta muotoillaan suomalaisella desimaalipilkulla ja yhdella desimaalilla",
  );
  assertEqual(
    buildHeatingPlanPresentation({
      ...baseInput,
      selectedHours: [
        { label: "04–05", period: "Tänään", price: null },
        { label: "05–06", period: "Tänään" },
        { label: "06–07", period: "Tänään", price: Number.NaN },
      ],
    }).selectedHours.map((hour) => hour.label),
    ["04–05", "05–06", "06–07"],
    "puuttuvaa hintaa ei korvata virheellisella nolla-arvolla",
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
  assertEqual(
    standard.forecastDetails,
    {
      currentShowersLabel: "3,1",
      finalShowersLabel: "4,4",
      finalShowersTimeLabel: "huomenna vuorokauden lopussa",
      minimumShowersLabel: "2,3",
      minimumShowersTimeLabel: null,
    },
    "ennusteen tiedot tarjotaan myos rakenteisena ilman minimin ajankohtaa",
  );
  const withMinimumTime = buildHeatingPlanPresentation({
    ...baseInput,
    minimumShowersTimeLabel: "tänään klo 14:00",
  });
  assertEqual(
    withMinimumTime.forecastDetails?.minimumShowersTimeLabel,
    "tänään klo 14:00",
    "minimin ajankohta valittyy rakenteiseen esitykseen kun se on saatavilla",
  );
  const withMinimumBeforeNextHeating = buildHeatingPlanPresentation({
    ...baseInput,
    minimumShowersBeforeNextHeating: 3.7,
    minimumShowersTimeLabel: "tänään klo 14:00",
  });
  assertEqual(
    withMinimumBeforeNextHeating.forecastDetails?.minimumShowersLabel,
    "3,7",
    "'alimmillaan' nayttaa pohjan ennen seuraavaa lammitysta, ei koko jakson minimia",
  );
  assertEqual(
    withMinimumBeforeNextHeating.statusSummary,
    standard.statusSummary,
    "turvarajan tayttyminen lasketaan yha koko jakson minimista (minimumShowers), ei lahiajan pohjasta",
  );
  assertEqual(
    stored.forecastDetails,
    null,
    "tallennetulla suunnitelmalla ei ole tuoretta tuntikohtaista ennustetta minimin ajankohdalle",
  );
  const visibleContent = JSON.stringify(standard);
  assertEqual(
    visibleContent.includes("nousuarvio") || visibleContent.includes("fallback-arvo"),
    false,
    "nousuarviota tai fallback-arvoa ei sisallyteta etusivun esitysmalliin",
  );

  assertEqual(
    selectActiveHeatingPlanPresentation(standard, stored) === standard,
    true,
    "tuore optimointitulos voittaa tallennetun suunnitelman",
  );
  assertEqual(
    selectActiveHeatingPlanPresentation(null, stored) === stored,
    true,
    "tallennettua suunnitelmaa kaytetaan varavaihtoehtona, kun tuoretta tulosta ei ole",
  );
  assertEqual(
    selectActiveHeatingPlanPresentation(null, null),
    null,
    "molempien puuttuessa aktiivista esitysta ei ole",
  );
}
