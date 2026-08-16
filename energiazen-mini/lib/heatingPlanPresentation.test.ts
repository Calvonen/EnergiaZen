import {
  buildHeatingPlanForecastFields,
  buildHeatingPlanPresentation,
  buildStoredHeatingPlanPresentation,
  hasCheaperSafetyRejectedPlan,
  hasAmbiguousStoredHeatingPlanHour,
  selectActiveHeatingPlanPresentation,
  simulateStoredHeatingPlanForecast,
} from "./heatingPlanPresentation";
import {
  calculateStratifiedShowersLeft,
  createHeatingOptimizationSettings,
  HeatingOptimizationHour,
} from "./heatingOptimizer";
import { HourlyTemperatureDropProfile } from "./tankTemperatureForecast";

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
  priceToleranceCents: 2,
  safetyShowerReserve: 2,
  selectedHours: [
    { label: "23–00", period: "Tänään" as const },
    { label: "00–01", period: "Huomenna" as const },
  ],
  targetShowerReserve: 4,
};

function forecastTestOptimizationHour(
  helsinkiHour: number,
  price: number,
): HeatingOptimizationHour {
  const startDate = new Date(Date.UTC(2026, 7, 15, helsinkiHour - 3));

  return {
    date: startDate,
    endDate: new Date(startDate.getTime() + 60 * 60 * 1000),
    id: `2026-08-15:${String(helsinkiHour).padStart(2, "0")}`,
    isCurrentHour: false,
    price,
    segmentHours: 1,
    startDate: startDate.toISOString(),
  };
}

function uniformHourlyDrops(drop: number): HourlyTemperatureDropProfile {
  return Object.fromEntries(
    Array.from({ length: 24 }, (_, hour) => [hour, drop]),
  );
}

export function runHeatingPlanPresentationUnitTests() {
  const priceInterval = (startsAt: string) => ({
    date: new Date(startsAt),
    startDate: startsAt,
  });
  const rollbackPrices = [
    priceInterval("2026-10-25T00:00:00.000Z"),
    priceInterval("2026-10-25T01:00:00.000Z"),
  ];

  assertEqual(
    hasAmbiguousStoredHeatingPlanHour({
      hourlyPrices: [
        priceInterval("2026-10-24T00:00:00.000Z"),
        priceInterval("2026-10-24T01:00:00.000Z"),
      ],
      storedPlans: [{ plan_date: "2026-10-24", planned_hours: [3] }],
    }),
    false,
    "normaalipaivan tallennettu tunti ei ole monitulkintainen",
  );
  assertEqual(
    hasAmbiguousStoredHeatingPlanHour({
      hourlyPrices: rollbackPrices,
      storedPlans: [{ plan_date: "2026-10-25", planned_hours: [3] }],
    }),
    true,
    "DST-palautuspaivan kahdesti esiintyva tallennettu tunti vaatii optimizer-varavaihtoehdon",
  );
  assertEqual(
    hasAmbiguousStoredHeatingPlanHour({
      hourlyPrices: rollbackPrices,
      storedPlans: [{ plan_date: "2026-10-25", planned_hours: [4] }],
    }),
    false,
    "DST-paivan duplikaatti ei estä tallennettua suunnitelmaa kun suunnitelma ei viittaa siihen",
  );

  const stored = buildStoredHeatingPlanPresentation({
    selectedHours: [
      { label: "06-07", period: "Tänään", price: 2 },
    ],
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
  assertEqual(
    stored.selectedHours[0]?.label,
    "06-07 · 2,0 c/kWh",
    "tallennettujen tuntien hintatieto sailyy esityksessa - tunnit tulevat aina tallennetusta backend-suunnitelmasta",
  );
  assertEqual(
    stored.forecastDetails,
    null,
    "ilman nykyista optimointiesitysta ennusteen rakenteista dataa ei ole",
  );
  assertEqual(
    stored.forecastSectionLabel,
    "Ennuste",
    "ilman rikastusta ennusteotsikko pysyy oletuksena",
  );
  assertEqual(
    stored.forecastSummary,
    "Tallennetulle suunnitelmalle ei ole saatavilla luotettavaa ennustetta.",
    "ilman nykyista optimointiesitysta ennustetieto pysyy neutraalina",
  );
  assertEqual(
    stored.limitsSummary,
    "Tavoite- ja turvarajat eivät sisälly tallennettuun suunnitelmaan.",
    "ilman nykyista optimointiesitysta rajatieto pysyy neutraalina",
  );
  assertEqual(
    stored.limitsSectionLabel,
    "Käytetyt rajat",
    "ilman rikastusta rajaotsikko pysyy oletuksena",
  );
  assertEqual(
    stored.priceToleranceSummary,
    null,
    "ilman nykyista optimointiesitysta hintatoleranssia ei nayteta",
  );

  // Todistaa etta stored-planin rikastus kayttaa nykyista paikallista
  // optimizer-presentationia (esim. activeOptimizerPresentation) VAIN
  // Käytetyt rajat -tietoihin - ei selectedHours-tuntien, hintojen tai
  // kustannusten laskentaan (nama tulevat aina tallennetusta
  // backend-suunnitelmasta), eika myoskaan ennusteeseen. Ennuste jatetaan
  // tahallaan neutraaliksi silloinkin kun optimointiesitys annetaan, koska
  // sen "alimmillaan"/"lopussa"-arvot on simuloitu paikallisen optimoijan
  // OMILLA valituilla tunneilla (simulateHeatingPlan), eivat tallennetun
  // backend-suunnitelman tunneilla - naiden rikastaminen vaittaisi tankin
  // tyhjenevan/taytyvan eri hetkella kuin mita naytetyt tunnit oikeasti
  // aiheuttaisivat.
  const currentOptimizerPresentation = buildHeatingPlanPresentation(baseInput);
  const enrichedStored = buildStoredHeatingPlanPresentation({
    currentOptimizerPresentation,
    selectedHours: [
      { label: "06-07", period: "Tänään", price: 2 },
    ],
  });
  assertEqual(
    enrichedStored.selectedHours,
    stored.selectedHours,
    "nykyinen optimointiesitys ei koskaan muuta tallennetun suunnitelman tunteja, hintoja tai kustannuksia",
  );
  assertEqual(
    enrichedStored.forecastDetails,
    null,
    "ennustetta ei rikasteta optimointiesityksesta, koska sen alimmillaan-/lopussa-arvot on simuloitu eri (paikallisen optimoijan) tunneilla kuin naytetyt tallennetun suunnitelman tunnit",
  );
  assertEqual(
    enrichedStored.forecastSummary,
    "Tallennetulle suunnitelmalle ei ole saatavilla luotettavaa ennustetta.",
    "ennusteyhteenveto pysyy neutraalina rikastuksesta huolimatta",
  );
  assertEqual(
    enrichedStored.forecastSectionLabel,
    "Ennuste",
    "ennusteotsikko pysyy neutraalina rikastuksesta huolimatta - ei vaita nayttavansa nykyista ennustetta",
  );
  assertEqual(
    enrichedStored.forecastSummary === currentOptimizerPresentation.forecastSummary,
    false,
    "optimointiesityksen forecastSummary-teksti (joka perustuu paikallisen optimoijan omiin tunteihin) ei koskaan paady tallennetun suunnitelman presentaatioon",
  );
  assertEqual(
    enrichedStored.limitsSummary,
    currentOptimizerPresentation.limitsSummary,
    "rajatieto rikastetaan nykyisesta optimizer-presentationista - tavoite-/turvaraja eivat riipu valituista tunneista",
  );
  assertEqual(
    enrichedStored.limitsSectionLabel,
    "Nykyiset rajat",
    "rikastetut rajat nimetaan neutraalisti nykyisiksi eika vaiteta niiden olevan tallennetun suunnitelman alkuperaiset rajat",
  );
  assertEqual(
    enrichedStored.priceToleranceSummary,
    currentOptimizerPresentation.priceToleranceSummary,
    "hintatoleranssi rikastetaan nykyisesta optimizer-presentationista samalla tavalla kuin tavoite-/turvaraja",
  );
  assertEqual(
    enrichedStored.reason,
    stored.reason,
    "rikastus ei muuta tallennetun suunnitelman perustelua",
  );
  assertEqual(
    enrichedStored.statusSummary,
    stored.statusSummary,
    "rikastus ei muuta tallennetun suunnitelman tilaotsikkoa",
  );

  const standard = buildHeatingPlanPresentation(baseInput);
  assertEqual(
    selectActiveHeatingPlanPresentation(
      standard,
      hasAmbiguousStoredHeatingPlanHour({
        hourlyPrices: rollbackPrices,
        storedPlans: [{ plan_date: "2026-10-25", planned_hours: [3] }],
      })
        ? null
        : stored,
      true,
    ),
    standard,
    "monitulkintainen tallennettu DST-tunti johtaa optimizer-esityksen varavaihtoehtoon",
  );
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
    standard.priceToleranceSummary,
    "Hintatoleranssi 2,0 c/kWh",
    "kaytossa oleva hintatoleranssi naytetaan suomalaisella desimaalipilkulla",
  );
  assertEqual(
    buildHeatingPlanPresentation({
      ...baseInput,
      priceToleranceCents: 0,
    }).priceToleranceSummary,
    "Hintatoleranssi pois käytöstä",
    "nolla-hintatoleranssi naytetaan pois kaytosta -tekstina, ei 0,0 c/kWh",
  );
  assertEqual(
    buildHeatingPlanPresentation({
      ...baseInput,
      priceToleranceCents: 0.5,
    }).priceToleranceSummary,
    "Hintatoleranssi 0,5 c/kWh",
    "hintatoleranssin desimaali pyoristyy ja muotoillaan suomalaisittain",
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
    "planCostSummary" in planWithCosts,
    false,
    "suunnitelman arvioitua kokonaishintaa ei enaa lasketa - vain tuntikohtainen hinta sailyy",
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

  // Optimoija tarkistaa tavoitteen tayttymisen heti viimeisen valitun
  // lammitystunnin jalkeen (targetCheckShowersLeft), ei koko ~30h
  // ennustejakson lopusta (finalShowers) - katso simulateHeatingPlan.
  // Nayttoarvo (esim. "huomenna vuorokauden lopussa") on silti finalShowers
  // sellaisenaan, koska se on hyodyllista tietoa siita mihin tankki
  // paatyisi ilman lisalammitysta, vaikka se ei ole se hetki jota
  // suunnitelma lupasi kattaa.
  const lowFinalButTargetMetAtCheckpoint = buildHeatingPlanPresentation({
    ...baseInput,
    finalShowers: 2.6,
    targetCheckShowersLeft: 5,
  });
  assertEqual(
    lowFinalButTargetMetAtCheckpoint.statusSummary,
    "Tavoite ja turvaraja täyttyvät",
    "tavoitteen tayttyminen tarkistetaan viimeisen lammitystunnin jalkeisesta arvosta, ei koko jakson lopun matalasta arvosta",
  );
  assertEqual(
    lowFinalButTargetMetAtCheckpoint.forecastDetails?.finalShowersLabel,
    "2,6",
    "nayttoarvo pysyy koko jakson lopun lukemana riippumatta tarkistuspisteesta",
  );
  assertEqual(
    buildHeatingPlanPresentation({
      ...baseInput,
      finalShowers: 10,
      minimumShowers: 5,
      targetCheckShowersLeft: 1,
    }).statusSummary,
    "Turvaraja täyttyy, mutta tavoitetta ei saavuteta",
    "targetCheckShowersLeft maaraa tavoitteen tayttymisen, ei enaa finalShowers suoraan",
  );
  assertEqual(
    buildHeatingPlanPresentation(baseInput).statusSummary,
    "Tavoite ja turvaraja täyttyvät",
    "targetCheckShowersLeftin puuttuessa pysytaan finalShowers-oletuksessa (esim. tallennettu suunnitelma)",
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
    "legacy-tilassa tuore optimointitulos voittaa tallennetun suunnitelman",
  );
  assertEqual(
    selectActiveHeatingPlanPresentation(standard, stored, true) === stored,
    true,
    "backend-primary-tilassa tallennettu suunnitelma voittaa tuoreen optimointituloksen",
  );
  assertEqual(
    selectActiveHeatingPlanPresentation(standard, null, true) === standard,
    true,
    "backend-primary-tilassa tuore optimointitulos toimii varavaihtoehtona, kun tallennettua suunnitelmaa ei ole",
  );
  // Product scenario (app-side shared price source PR): backend-primary
  // mode, today's real backend plan is published but tomorrow's is not
  // (e.g. tomorrow's prices are not yet complete in electricity_prices, so
  // run-heating-optimizer has not published a tomorrow row - see PR #209's
  // tomorrowHasCompletePriceData). The today-only stored presentation must
  // still win over the local optimizer preview - app/(tabs)/index.tsx's
  // storedHeatingPlanPresentation must not return null just because
  // tomorrow is missing, which would otherwise let this same authoritative
  // branch fall through to the app's own unpublished tomorrow guess.
  const todayOnlyStored = buildStoredHeatingPlanPresentation({
    selectedHours: [
      { label: "14:00-15:00 · 5,0 c/kWh", period: "Tänään", price: 5 },
    ],
  });
  assertEqual(
    selectActiveHeatingPlanPresentation(standard, todayOnlyStored, true) ===
      todayOnlyStored,
    true,
    "backend-primary-tilassa tanaan julkaistu tallennettu suunnitelma voittaa paikallisen optimoijan esityksen, vaikka huomisen rivia ei viela ole",
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

  // Todistaa etta stored-planin ennuste lasketaan simulateStoredHeatingPlanForecast-
  // funktiolla (sama simulateHeatingPlan-helper jota aktiivinen optimoija itse
  // kayttaa) nimenomaan BACKENDIN tallennetuilla tunneilla - ei paikallisen
  // optimoijan omilla valituilla tunneilla, eika kopioimalla optimoijan omaa
  // ennustetta sellaisenaan.
  const forecastHours: HeatingOptimizationHour[] = [
    forecastTestOptimizationHour(10, 5),
    forecastTestOptimizationHour(11, 1),
    forecastTestOptimizationHour(12, 2),
  ];
  const forecastSettings = createHeatingOptimizationSettings(
    {
      automaticMaxHeatingHours: 2,
      fullTankAverageTemperature: 70,
      fullTankShowers: 6,
      maxTankTemperature: 80,
      minTankTemperature: 10,
      safetyShowerReserve: 1,
      targetShowerReserve: 5,
    },
    10,
  );
  const forecastCurrentShowers = calculateStratifiedShowersLeft({
    bottomTemperature: 30,
    fullTankAverageTemperature: 70,
    fullTankShowers: 6,
    maxTankTemperature: 80,
    minTankTemperature: 10,
    topTemperature: 50,
  }).showersLeft;
  const forecastCommonInputs = {
    currentBottomTemperature: 30,
    currentTopTemperature: 50,
    heatingGainPerHour: 10,
    hourlyDrops: uniformHourlyDrops(0.3),
    hours: forecastHours,
    settings: forecastSettings,
  };

  // "Paikallinen optimoija" olisi valinnut vain ensimmaisen (kalleimman) tunnin.
  const localOptimizerSelectedHourIds = [forecastHours[0].id];
  // Backend on kuitenkin tallentanut TOISEN, eri kokoisen tuntijoukon (kaksi
  // myohaisempaa, halvempaa tuntia) - juuri tama tilanne, jossa
  // storedHeatingPlanPresentation-kortin pitaa naytta ennuste noiden
  // backend-tuntien, ei paikallisen optimoijan omien tuntien, mukaan.
  const backendSelectedHourIds = [forecastHours[1].id, forecastHours[2].id];
  assertEqual(
    JSON.stringify(backendSelectedHourIds) ===
      JSON.stringify(localOptimizerSelectedHourIds),
    false,
    "testiskenaarion backend-tunnit eroavat tarkoituksella paikallisen optimoijan tunneista",
  );

  const localOptimizerSimulation = simulateStoredHeatingPlanForecast({
    ...forecastCommonInputs,
    selectedHeatingHourIds: localOptimizerSelectedHourIds,
  });
  const backendSimulation = simulateStoredHeatingPlanForecast({
    ...forecastCommonInputs,
    selectedHeatingHourIds: backendSelectedHourIds,
  });
  assertEqual(
    localOptimizerSimulation.finalShowers === backendSimulation.finalShowers,
    false,
    "stored-planin backend-tunneilla simuloitu ennuste (finalShowers) muuttuu ja eroaa paikallisen optimoijan omilla tunneilla simuloidusta ennusteesta",
  );

  const localOptimizerForecastFields = buildHeatingPlanForecastFields({
    currentShowers: forecastCurrentShowers,
    finalShowers: localOptimizerSimulation.finalShowers,
    forecastEndLabel: "tänään klo 13:00",
    minimumShowersBeforeNextHeating:
      localOptimizerSimulation.minimumShowersBeforeNextHeating,
    minimumShowersTimeLabel: null,
  });
  const backendForecastFields = buildHeatingPlanForecastFields({
    currentShowers: forecastCurrentShowers,
    finalShowers: backendSimulation.finalShowers,
    forecastEndLabel: "tänään klo 13:00",
    minimumShowersBeforeNextHeating:
      backendSimulation.minimumShowersBeforeNextHeating,
    minimumShowersTimeLabel: null,
  });
  assertEqual(
    backendForecastFields.forecastSummary ===
      localOptimizerForecastFields.forecastSummary,
    false,
    "stored-planin ennusteteksti ei ole sama kuin aktiivisen (paikallisen) optimoijan oma forecastSummary, kun tuntijoukot eroavat",
  );

  const backendSelectedHourLabels = [
    { label: "11–12", period: "Tänään" as const, price: 1 },
    { label: "12–13", period: "Tänään" as const, price: 2 },
  ];
  const storedBackendPresentation = buildStoredHeatingPlanPresentation({
    forecast: backendForecastFields,
    selectedHours: backendSelectedHourLabels,
  });
  assertEqual(
    storedBackendPresentation.forecastSummary,
    backendForecastFields.forecastSummary,
    "stored-planin kortti nayttaa juuri backend-tunneille simuloidun ennusteen (ei neutraalia oletustekstia eika optimoijan omaa)",
  );
  assertEqual(
    storedBackendPresentation.forecastSummary ===
      localOptimizerForecastFields.forecastSummary,
    false,
    "stored-planin kortin ennuste ei ole kopio aktiivisen (paikallisen) optimoijan omasta ennusteesta - ainoa oikotie jota tehtava kielsi",
  );
  assertEqual(
    storedBackendPresentation.selectedHours.map((hour) => hour.label),
    ["11–12 · 1,0 c/kWh", "12–13 · 2,0 c/kWh"],
    "stored-planin nayttamat tunnit (selectedHours) pysyvat backendin tunneissa myos ennusteen laskennan jalkeen - ennuste ei muuta niita",
  );
}
