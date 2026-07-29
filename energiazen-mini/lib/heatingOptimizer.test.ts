import {
  calculateStratifiedShowersLeft,
  createHeatingOptimizationSettings,
  estimateHeatingGainPerHour,
  getHeatingOptimizationSegmentHours,
  HeatingOptimizationHour,
  HeatingOptimizationSettings,
  optimizeHeatingPlan,
  simulateHeatingPlan,
} from "./heatingOptimizer";
import { HourlyTemperatureDropProfile, TankTemperatureReading } from "./tankTemperatureForecast";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertClose(
  actual: number,
  expected: number,
  message: string,
  precision = 0.000001,
) {
  if (Math.abs(actual - expected) > precision) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function createHourlyDrops(defaultDrop: number, overrides: Record<number, number> = {}) {
  return Object.fromEntries(
    Array.from({ length: 24 }, (_, hour) => [
      hour,
      overrides[hour] ?? defaultDrop,
    ]),
  ) as HourlyTemperatureDropProfile;
}

function optimizationHour(
  helsinkiDate: string,
  helsinkiHour: number,
  price: number,
  segmentHours = 1,
) {
  const [year, month, day] = helsinkiDate.split("-").map(Number);
  const startDate = new Date(
    Date.UTC(year, month - 1, day, helsinkiHour - 3),
  );

  return {
    date: startDate,
    endDate: new Date(startDate.getTime() + 60 * 60 * 1000),
    id: `${helsinkiDate}:${String(helsinkiHour).padStart(2, "0")}`,
    isCurrentHour: false,
    price,
    segmentHours,
    startDate: startDate.toISOString(),
  } satisfies HeatingOptimizationHour;
}

function defaultSettings(
  overrides: Partial<HeatingOptimizationSettings> = {},
): HeatingOptimizationSettings {
  return {
    absoluteMinimumTemperature: 10,
    fallbackHeatingGainPerHour: 12,
    fullTankAverageTemperature: 70,
    fullTankShowers: 6,
    maxHeatingHours: 1,
    maxTankTemperature: 80,
    safetyShowerReserve: 3,
    targetShowerReserve: 3,
    ...overrides,
  };
}

function stratifiedTemperatureInput(weightedTemperature: number) {
  const topTemperature = 70;
  const bottomTemperature = (weightedTemperature - topTemperature * 0.7) / 0.3;

  return {
    currentBottomTemperature: bottomTemperature,
    currentTopTemperature: topTemperature,
    currentWeightedTemperature: weightedTemperature,
  };
}

function uniformTemperatureForShowers(
  showers: number,
  settings: HeatingOptimizationSettings,
) {
  let lower = 42;
  let upper = settings.fullTankAverageTemperature;

  for (let iteration = 0; iteration < 80; iteration += 1) {
    const temperature = (lower + upper) / 2;
    const estimate = calculateStratifiedShowersLeft({
      bottomTemperature: temperature,
      fullTankAverageTemperature: settings.fullTankAverageTemperature,
      fullTankShowers: settings.fullTankShowers,
      maxTankTemperature: settings.maxTankTemperature,
      minTankTemperature: settings.absoluteMinimumTemperature,
      topTemperature: temperature,
    }).showersLeft;

    if (estimate < showers) {
      lower = temperature;
    } else {
      upper = temperature;
    }
  }

  return (lower + upper) / 2;
}

function reading(
  createdAt: string,
  temperature: number,
  heating: boolean,
): TankTemperatureReading {
  return {
    bottom_temp: temperature,
    created_at: createdAt,
    heating,
    top_temp: temperature,
  };
}

export function runHeatingOptimizerUnitTests() {
  {
    const runStartThresholdScenario = (
      currentShowers: number,
      isCurrentlyHeating = false,
    ) => {
      const settings = defaultSettings({
        maxHeatingHours: 1,
        safetyShowerReserve: 0,
        targetShowerReserve: Math.max(currentShowers - 0.1, 0),
      });
      const temperature = uniformTemperatureForShowers(
        currentShowers,
        settings,
      );
      const currentHour = {
        ...optimizationHour("2026-07-22", 12, 1),
        isCurrentHour: true,
      };

      return optimizeHeatingPlan({
        currentBottomTemperature: temperature,
        currentTopTemperature: temperature,
        currentWeightedTemperature: temperature,
        heatingGainPerHour: 10,
        hourlyDrops: createHourlyDrops(0, { 12: 5, 13: 5 }),
        hours: [currentHour, optimizationHour("2026-07-22", 13, 2)],
        isCurrentlyHeating,
        settings,
      });
    };

    const fullTank = runStartThresholdScenario(6);
    assertEqual(
      fullTank.selectedHeatingHourIds,
      ["2026-07-22:13"],
      "taysi varaaja estaa nykyisen tunnin mutta sallii tulevan tunnin",
    );
    assertEqual(
      fullTank.diagnostics.currentHourStartBlockedByFillRatio,
      true,
      "100 prosentin tayttoaste aktivoi aloitusportin",
    );

    const exactlyAtThreshold = runStartThresholdScenario(5.4);
    assertEqual(
      exactlyAtThreshold.selectedHeatingHourIds,
      ["2026-07-22:13"],
      "tasan 90 prosenttia estaa nykyisen tunnin aloituksen",
    );
    assertClose(
      exactlyAtThreshold.diagnostics.startHeatingThresholdShowers,
      5.4,
      "aloitusraja on 90 prosenttia tayden varaajan suihkuista",
    );

    const belowThreshold = runStartThresholdScenario(5.39);
    assertEqual(
      belowThreshold.selectedHeatingHourIds,
      ["2026-07-22:12"],
      "hieman alle 90 prosenttia sallii nykyisen halvimman tunnin",
    );

    const alreadyHeating = runStartThresholdScenario(6, true);
    assertEqual(
      alreadyHeating.selectedHeatingHourIds,
      ["2026-07-22:12"],
      "jo kaynnissa oleva lammitys saa jatkua tayttoasterajasta huolimatta",
    );
    assertEqual(
      alreadyHeating.diagnostics.currentHourStartBlockedByFillRatio,
      false,
      "kaynnissa oleva lammitys ohittaa uuden aloituksen portin",
    );
    assertEqual(
      alreadyHeating.diagnostics.heatingStartFillRatioDiagnostics[0]
        ?.alreadyHeatingAtSegmentStart,
      true,
      "nykyisen segmentin heating-tila tunnistetaan jatkumiseksi",
    );

    const settings = defaultSettings({
      maxHeatingHours: 1,
      safetyShowerReserve: 0,
      targetShowerReserve: 5.9,
    });
    const fullTemperature = uniformTemperatureForShowers(6, settings);
    const currentHour = {
      ...optimizationHour("2026-07-22", 12, 1),
      isCurrentHour: true,
    };
    const delayedStart = optimizeHeatingPlan({
      currentBottomTemperature: fullTemperature,
      currentTopTemperature: fullTemperature,
      currentWeightedTemperature: fullTemperature,
      heatingGainPerHour: 10,
      hourlyDrops: createHourlyDrops(0, { 12: 0.1, 13: 5 }),
      hours: [
        currentHour,
        optimizationHour("2026-07-22", 13, 2),
        optimizationHour("2026-07-22", 14, 3),
      ],
      settings,
    });
    const currentDecision =
      delayedStart.diagnostics.heatingStartFillRatioDiagnostics.find(
        (item) => item.candidateHour === "2026-07-22:12",
      );
    const nextDecision =
      delayedStart.diagnostics.heatingStartFillRatioDiagnostics.find(
        (item) => item.candidateHour === "2026-07-22:13",
      );
    const laterDecision =
      delayedStart.diagnostics.heatingStartFillRatioDiagnostics.find(
        (item) => item.candidateHour === "2026-07-22:14",
      );

    if (!currentDecision || !nextDecision || !laterDecision) {
      throw new Error("aloitusrajan tuntikohtainen diagnostiikka puuttuu");
    }

    assertEqual(
      currentDecision.blockedByStartFillRatio,
      true,
      "100 prosentin nykyinen tunti estyy",
    );
    assertEqual(
      nextDecision.blockedByStartFillRatio,
      true,
      "seuraava tunti estyy kun ennustettu tayttoaste on yha vahintaan 90 prosenttia",
    );
    assertEqual(
      nextDecision.projectedFillRatioBeforeHeating >= 0.9,
      true,
      "seuraavan tunnin aloitustaytto raportoidaan",
    );
    assertEqual(
      laterDecision.blockedByStartFillRatio,
      false,
      "myohempi tunti sallitaan tayttoasteen pudottua alle 90 prosentin",
    );
    assertEqual(
      laterDecision.projectedFillRatioBeforeHeating < 0.9,
      true,
      "myohemman tunnin sallittu aloitustaytto raportoidaan",
    );
    assertEqual(
      delayedStart.selectedHeatingHourIds,
      ["2026-07-22:14"],
      "optimizer valitsee myohemman sallitun tunnin halvempien estettyjen sijaan",
    );
    assertEqual(
      laterDecision.selected,
      true,
      "valittu myohempi tunti sisaltyy diagnostiikkaan",
    );
  }

  {
    const startDate = new Date("2026-07-22T07:00:00.000Z");
    const endDate = new Date("2026-07-22T08:00:00.000Z");
    const segmentHoursAtMinute = (minute: number) =>
      getHeatingOptimizationSegmentHours({
        endDate,
        forecastStart: new Date(
          startDate.getTime() + minute * 60 * 1000,
        ),
        startDate,
      });

    assertClose(segmentHoursAtMinute(0), 1, "tasatunti kayttaa tayden segmentin");
    assertClose(segmentHoursAtMinute(15), 0.75, "xx.15 kayttaa 0,75 tuntia");
    assertClose(segmentHoursAtMinute(30), 0.5, "xx.30 kayttaa 0,5 tuntia");
    assertClose(segmentHoursAtMinute(45), 0.25, "xx.45 kayttaa 0,25 tuntia");
  }

  {
    const result = simulateHeatingPlan({
      ...stratifiedTemperatureInput(60),
      heatingGainPerHour: 8,
      hourlyDrops: createHourlyDrops(1, { 12: 4, 13: 6 }),
      hours: [
        optimizationHour("2026-07-22", 12, 1, 0.5),
        optimizationHour("2026-07-22", 13, 1),
      ],
      selectedHeatingHourIds: ["2026-07-22:12"],
      settings: defaultSettings({
        safetyShowerReserve: 0,
        targetShowerReserve: 0,
      }),
    });
    const [partialHour, fullHour] = result.forecast;

    assertClose(partialHour.segmentHours, 0.5, "ensimmainen segmentti valittyy ennusteeseen");
    assertClose(partialHour.hourlyDrop, 4, "Helsingin kellotunnin profiiliarvo sailyy");
    assertClose(partialHour.appliedDrop, 2, "ensimmaisen tunnin pudotus skaalautuu kestolla");
    assertClose(
      partialHour.temperatureBefore - partialHour.temperatureBeforeHeating,
      2,
      "skaalattu pudotus vahennetaan simuloidusta lampotilasta",
    );
    assertClose(partialHour.heatingGain, 4, "osittainen tunti skaalaa myos lammitysnousun");
    assertClose(
      partialHour.temperatureAfter - partialHour.temperatureBeforeHeating,
      4,
      "skaalattu lammitysnousu lisataan simuloituun lampotilaan",
    );
    assertClose(fullHour.segmentHours, 1, "myohempi tunti on taysi segmentti");
    assertClose(fullHour.appliedDrop, 6, "myohempi tunti kayttaa koko pudotuksen");
    assertClose(
      fullHour.temperatureBefore - fullHour.temperatureBeforeHeating,
      6,
      "myohemman tayden tunnin lampotilalaskenta ei muutu",
    );
  }

  {
    const result = simulateHeatingPlan({
      ...stratifiedTemperatureInput(60),
      heatingGainPerHour: 0,
      hourlyDrops: {} as HourlyTemperatureDropProfile,
      hours: [optimizationHour("2026-07-22", 12, 1, 0.5)],
      selectedHeatingHourIds: [],
      settings: defaultSettings({
        safetyShowerReserve: 0,
        targetShowerReserve: 0,
      }),
    });
    const hour = result.forecast[0];

    assertClose(hour.hourlyDrop, 0.25, "puuttuva profiilitunti kayttaa 0,25 fallbackia");
    assertClose(hour.appliedDrop, 0.125, "fallback skaalautuu segmentin kestolla");
    assertClose(
      hour.temperatureBefore - hour.temperatureBeforeHeating,
      0.125,
      "skaalattu fallback vahennetaan simuloidusta lampotilasta",
    );
  }

  {
    const settings = defaultSettings();
    const estimate = calculateStratifiedShowersLeft({
      bottomTemperature: 40,
      fullTankAverageTemperature: settings.fullTankAverageTemperature,
      fullTankShowers: settings.fullTankShowers,
      maxTankTemperature: settings.maxTankTemperature,
      minTankTemperature: settings.absoluteMinimumTemperature,
      topTemperature: 50,
    });

    assertClose(estimate.weightedTemperature, 47, "vanha korttikaava kayttaa 70/30 painotusta");
    assertClose(
      estimate.energyRatio,
      (47 - 10) / (70 - 10),
      "vanha korttikaava kayttaa minTankTemperature-pohjaista energyRatio-arvoa",
    );
    assertClose(
      estimate.topUsability,
      (50 - 42) / (70 - 42),
      "vanha korttikaava kayttaa 42 asteen topUsability-rajaa",
    );
    assertClose(
      estimate.showersLeft,
      ((47 - 10) / (70 - 10)) * ((50 - 42) / (70 - 42)) * 6,
      "nykyinen getStratifiedWarmWaterEstimate-kaava antaa saman tuloksen refaktoroinnin jalkeen",
    );
  }

  {
    const settings = defaultSettings();
    const currentEstimate = calculateStratifiedShowersLeft({
      bottomTemperature: 9.866666666666674,
      fullTankAverageTemperature: settings.fullTankAverageTemperature,
      fullTankShowers: settings.fullTankShowers,
      maxTankTemperature: settings.maxTankTemperature,
      minTankTemperature: settings.absoluteMinimumTemperature,
      topTemperature: 67.2,
    });
    const result = simulateHeatingPlan({
      currentBottomTemperature: 9.866666666666674,
      currentTopTemperature: 67.2,
      heatingGainPerHour: 0,
      hourlyDrops: createHourlyDrops(0),
      hours: [],
      selectedHeatingHourIds: [],
      settings,
    });

    assertClose(currentEstimate.showersLeft, 3.6, "tunnettu top/bottom-tapaus antaa 3,6 suihkua");
    assertClose(
      result.minimumPredictedShowersLeft,
      currentEstimate.showersLeft,
      "sama top/bottom-asetus antaa kortissa ja optimoinnin lahtoarvossa saman suihkumaaran",
    );
  }

  {
    const settings = defaultSettings();
    const result = simulateHeatingPlan({
      currentBottomTemperature: 9.866666666666674,
      currentTopTemperature: 67.2,
      heatingGainPerHour: 8,
      hourlyDrops: createHourlyDrops(0.55),
      hours: [optimizationHour("2026-07-22", 12, 1)],
      selectedHeatingHourIds: ["2026-07-22:12"],
      settings,
    });
    const hour = result.forecast[0];

    if (result.minimumPredictedShowersLeft >= 4) {
      throw new Error("nykyinen 3,6 suihkua antoi minimiksi 4,0 tai enemman");
    }
    assertClose(
      hour.temperatureBefore - hour.temperatureBeforeHeating,
      0.55,
      "hourlyDrop 0,55 astetta muuttaa weightedTemperature-arvoa vain 0,55 astetta",
    );
    assertClose(
      hour.temperatureAfter - hour.temperatureBeforeHeating,
      8,
      "heatingGain lisataan weightedTemperature-arvoon vain kerran",
    );
    assertClose(
      hour.topTemperatureBeforeHeating * 0.7 +
        hour.bottomTemperatureBeforeHeating * 0.3,
      hour.temperatureBeforeHeating,
      "top/bottom-arvot tuottavat ennen lammitysta oikean weightedTemperature-arvon",
    );
    assertClose(
      hour.topTemperatureAfter * 0.7 + hour.bottomTemperatureAfter * 0.3,
      hour.temperatureAfter,
      "top/bottom-arvot tuottavat lammityksen jalkeen oikean weightedTemperature-arvon",
    );
  }

  {
    const settings = defaultSettings();

    assertClose(
      calculateStratifiedShowersLeft({
        bottomTemperature: 0,
        fullTankAverageTemperature: settings.fullTankAverageTemperature,
        fullTankShowers: settings.fullTankShowers,
        maxTankTemperature: settings.maxTankTemperature,
        minTankTemperature: settings.absoluteMinimumTemperature,
        topTemperature: 0,
      }).showersLeft,
      0,
      "suihkumaara rajautuu nollaan",
    );
    assertClose(
      calculateStratifiedShowersLeft({
        bottomTemperature: 90,
        fullTankAverageTemperature: settings.fullTankAverageTemperature,
        fullTankShowers: settings.fullTankShowers,
        maxTankTemperature: settings.maxTankTemperature,
        minTankTemperature: settings.absoluteMinimumTemperature,
        topTemperature: 90,
      }).showersLeft,
      settings.fullTankShowers,
      "suihkumaara rajautuu fullTankShowers-arvoon",
    );
  }

  {
    const settings = createHeatingOptimizationSettings(
      {
        fullTankAverageTemperature: 70,
        fullTankShowers: 6,
        automaticMaxHeatingHours: 3,
        maxTankTemperature: 80,
        minTankTemperature: 10,
        safetyShowerReserve: 2,
        targetShowerReserve: 4,
      },
      8,
    );

    assertEqual(
      settings.targetShowerReserve,
      4,
      "optimizer kayttaa nykyista vahimmaisvaraus suihkuina -asetusta",
    );
    assertEqual(
      settings.absoluteMinimumTemperature,
      10,
      "10 astetta mapataan vain tekniseksi turvarajaksi",
    );
  }

  {
    const gainEstimate = estimateHeatingGainPerHour(
      [
        reading("2026-07-01T00:00:00.000Z", 40, true),
        reading("2026-07-01T00:10:00.000Z", 41.3333333333, true),
        reading("2026-07-01T00:20:00.000Z", 42.6666666667, true),
        reading("2026-07-01T00:30:00.000Z", 44, true),
        reading("2026-07-01T00:35:00.000Z", 44, false),
        reading("2026-07-02T00:00:00.000Z", 42, true),
        reading("2026-07-02T00:10:00.000Z", 43, true),
        reading("2026-07-02T00:20:00.000Z", 44, true),
        reading("2026-07-02T00:30:00.000Z", 45, true),
        reading("2026-07-02T00:35:00.000Z", 45, false),
        reading("2026-07-03T00:00:00.000Z", 43, true),
        reading("2026-07-03T00:10:00.000Z", 44.3333333333, true),
        reading("2026-07-03T00:20:00.000Z", 45.6666666667, true),
        reading("2026-07-03T00:30:00.000Z", 47, true),
      ],
      7,
    );

    assertEqual(gainEstimate.fallbackUsed, false, "heating gain kayttaa historiaa");
    assertClose(gainEstimate.gainPerHour, 8, "heating gain kayttaa mediaania");
  }

  {
    const result = optimizeHeatingPlan({
      ...stratifiedTemperatureInput(46),
      heatingGainPerHour: 20,
      hourlyDrops: createHourlyDrops(1),
      hours: [
        optimizationHour("2026-07-22", 21, 9),
        optimizationHour("2026-07-22", 22, 8),
        optimizationHour("2026-07-22", 23, 7),
        optimizationHour("2026-07-23", 0, 6),
        optimizationHour("2026-07-23", 1, 5),
        optimizationHour("2026-07-23", 2, 1),
      ],
      settings: defaultSettings({
        safetyShowerReserve: 3.1,
        targetShowerReserve: 3.1,
      }),
    });

    assertEqual(
      result.selectedHeatingHourIds,
      ["2026-07-22:22"],
      "illan lammitys aikaistuu kun kerrostunut suihkuvaraus ei riita aamuyohon",
    );
    assertClose(
      result.minimumPredictedShowersLeft,
      3.1571428571428566,
      "siirron alin suihkuvaraus pysyy kayttajan rajan ylapuolella",
    );
  }

  {
    const result = optimizeHeatingPlan({
      ...stratifiedTemperatureInput(44),
      heatingGainPerHour: 20,
      hourlyDrops: createHourlyDrops(1),
      hours: [
        optimizationHour("2026-07-22", 6, 10),
        optimizationHour("2026-07-22", 7, 20),
        optimizationHour("2026-07-22", 8, 20),
        optimizationHour("2026-07-22", 9, 20),
        optimizationHour("2026-07-22", 10, 20),
        optimizationHour("2026-07-22", 11, 20),
        optimizationHour("2026-07-22", 12, 20),
        optimizationHour("2026-07-22", 13, 20),
        optimizationHour("2026-07-22", 14, 1),
      ],
      settings: defaultSettings(),
    });

    assertEqual(
      result.selectedHeatingHourIds,
      ["2026-07-22:06"],
      "aamuyon tuntia ei voi siirtaa iltapaivaan jos suihkuvaraus alittuu",
    );
  }

  {
    const reserve2 = optimizeHeatingPlan({
      ...stratifiedTemperatureInput(40),
      heatingGainPerHour: 10,
      hourlyDrops: createHourlyDrops(0.2, { 14: 10 }),
      hours: [
        optimizationHour("2026-07-22", 12, 10),
        optimizationHour("2026-07-22", 13, 5),
        optimizationHour("2026-07-22", 14, 1),
      ],
      settings: defaultSettings({
        safetyShowerReserve: 2,
        targetShowerReserve: 2,
      }),
    });
    const reserve3 = optimizeHeatingPlan({
      ...stratifiedTemperatureInput(40),
      heatingGainPerHour: 10,
      hourlyDrops: createHourlyDrops(0.2, { 14: 10 }),
      hours: [
        optimizationHour("2026-07-22", 12, 10),
        optimizationHour("2026-07-22", 13, 5),
        optimizationHour("2026-07-22", 14, 1),
      ],
      settings: defaultSettings({
        safetyShowerReserve: 3,
      }),
    });

    assertEqual(
      reserve2.spikes[0]?.requiredShowersBefore,
      2,
      "reserve 2 ei vaadi reserve 3:a ennen kulutuspiikkia",
    );
    assertEqual(
      reserve3.spikes[0]?.requiredShowersBefore,
      3,
      "reserve 3 ei vaadi reserve 4:aa ennen kulutuspiikkia",
    );
  }

  {
    const defaultMargin = optimizeHeatingPlan({
      ...stratifiedTemperatureInput(40),
      heatingGainPerHour: 10,
      hourlyDrops: createHourlyDrops(0.2, { 14: 10 }),
      hours: [
        optimizationHour("2026-07-22", 12, 10),
        optimizationHour("2026-07-22", 13, 5),
        optimizationHour("2026-07-22", 14, 1),
      ],
      settings: defaultSettings({
        safetyShowerReserve: 3,
      }),
    });
    assertEqual(
      defaultMargin.spikes[0]?.requiredShowersBefore,
      3,
      "kulutuspiikin diagnostiikka kayttaa turvarajaa ilman erillista kovaa lisavarausta",
    );
  }

  {
    const result = optimizeHeatingPlan({
      ...stratifiedTemperatureInput(48),
      heatingGainPerHour: 15,
      hourlyDrops: createHourlyDrops(0.2, { 14: 10 }),
      hours: [
        optimizationHour("2026-07-22", 12, 10),
        optimizationHour("2026-07-22", 13, 5),
        optimizationHour("2026-07-22", 14, 1),
      ],
      settings: defaultSettings({
        safetyShowerReserve: 3,
      }),
    });

    assertEqual(
      result.selectedHeatingHourIds,
      ["2026-07-22:13"],
      "turvallisista vaihtoehdoista valitaan halvin ennen kulutuspiikkia",
    );
    assertEqual(result.diagnostics.largestSpike?.hour, 14, "suurin piikki tunnistetaan profiilista");
    if (result.diagnostics.largestSpike) {
      if (
        result.diagnostics.largestSpike.showersLeftBefore <
        result.diagnostics.largestSpike.requiredShowersBefore
      ) {
        throw new Error("piikin edella ei ollut riittavaa suihkuvarausta");
      }
    }
  }

  {
    const result = optimizeHeatingPlan({
      ...stratifiedTemperatureInput(53),
      heatingGainPerHour: 5,
      hourlyDrops: createHourlyDrops(1),
      hours: [
        optimizationHour("2026-07-23", 0, 5),
        optimizationHour("2026-07-23", 1, 1),
        optimizationHour("2026-07-23", 2, 2),
      ],
      settings: defaultSettings({
        safetyShowerReserve: 4.1,
        targetShowerReserve: 4.1,
      }),
    });

    assertEqual(
      result.selectedHeatingHourIds,
      ["2026-07-23:00"],
      "lammitys aikaistuu kun halvin tunti alittaisi yhteisen suihkuvarauksen",
    );
  }

  {
    const liveLikeHours = [
      optimizationHour("2026-07-22", 17, 2),
      optimizationHour("2026-07-22", 18, 2),
      optimizationHour("2026-07-22", 19, 2),
      optimizationHour("2026-07-22", 20, 2),
      optimizationHour("2026-07-22", 21, 2),
      optimizationHour("2026-07-22", 22, 2),
      optimizationHour("2026-07-22", 23, 2),
      optimizationHour("2026-07-23", 0, 2),
      optimizationHour("2026-07-23", 1, 2),
      optimizationHour("2026-07-23", 2, 2),
      optimizationHour("2026-07-23", 3, 3),
      optimizationHour("2026-07-23", 4, 1),
      optimizationHour("2026-07-23", 5, 2),
      optimizationHour("2026-07-23", 6, 2),
      optimizationHour("2026-07-23", 7, 2),
      optimizationHour("2026-07-23", 8, 2),
      optimizationHour("2026-07-23", 9, 2),
      optimizationHour("2026-07-23", 10, 2),
      optimizationHour("2026-07-23", 11, 2),
      optimizationHour("2026-07-23", 12, 2),
      optimizationHour("2026-07-23", 13, 2),
      optimizationHour("2026-07-23", 14, 2),
      optimizationHour("2026-07-23", 15, 2),
      optimizationHour("2026-07-23", 16, 2),
      optimizationHour("2026-07-23", 17, 2),
      optimizationHour("2026-07-23", 18, 2),
      optimizationHour("2026-07-23", 19, 2),
      optimizationHour("2026-07-23", 20, 2),
      optimizationHour("2026-07-23", 21, 2),
      optimizationHour("2026-07-23", 22, 2),
      optimizationHour("2026-07-23", 23, 2),
    ];
    const liveLikeDrops = createHourlyDrops(0.5, {
      3: 0.435,
      4: 0.54,
      12: 0.725,
      13: 0.71,
      14: 1.94,
    });
    const reserve2 = optimizeHeatingPlan({
      ...stratifiedTemperatureInput(50.75),
      heatingGainPerHour: 8,
      hourlyDrops: liveLikeDrops,
      hours: liveLikeHours,
      settings: defaultSettings({
        maxHeatingHours: 3,
        safetyShowerReserve: 2,
        targetShowerReserve: 2,
      }),
    });
    const reserve3 = optimizeHeatingPlan({
      ...stratifiedTemperatureInput(50.75),
      heatingGainPerHour: 8,
      hourlyDrops: liveLikeDrops,
      hours: liveLikeHours,
      settings: defaultSettings({
        maxHeatingHours: 3,
        safetyShowerReserve: 3,
      }),
    });

    assertEqual(
      reserve2.selectedHeatingHourIds,
      ["2026-07-23:04"],
      "oletusarvolla live-datan kaltainen reserve 2 huomioi yhteisen suihkuvarauskaavan",
    );
    assertEqual(
      reserve3.selectedHeatingHourIds,
      ["2026-07-22:17", "2026-07-23:04"],
      "oletusarvolla live-datan kaltainen reserve 3 tuottaa yhteisella kaavalla kaksi tuntia",
    );
  }

  {
    const result = optimizeHeatingPlan({
      ...stratifiedTemperatureInput(65),
      heatingGainPerHour: 6,
      hourlyDrops: createHourlyDrops(1),
      hours: [
        optimizationHour("2026-07-22", 22, 10),
        optimizationHour("2026-07-22", 23, 9),
        optimizationHour("2026-07-23", 0, 1),
        optimizationHour("2026-07-23", 1, 2),
      ],
      settings: defaultSettings({
        safetyShowerReserve: 5.2,
        targetShowerReserve: 5.2,
      }),
    });

    assertEqual(
      result.selectedHeatingHourIds,
      ["2026-07-22:23"],
      "vuorokauden vaihde kasitellaan yhtena ikkunana ja aloitus odottaa alle 90 prosentin tayttoastetta",
    );
    assertEqual(result.selectedHeatingHourIds.length, 1, "paiville ei anneta erillisia taytta kiintiota");
  }

  {
    const result = optimizeHeatingPlan({
      ...stratifiedTemperatureInput(12),
      heatingGainPerHour: 0,
      hourlyDrops: createHourlyDrops(3),
      hours: [optimizationHour("2026-07-22", 12, 1)],
      settings: defaultSettings({ safetyShowerReserve: 0, targetShowerReserve: 0 }),
    });

    assertEqual(
      result.valid,
      false,
      "10 astetta toimii vain teknisena absoluuttisena turvarajana",
    );
  }

  {
    const result = optimizeHeatingPlan({
      ...stratifiedTemperatureInput(50),
      heatingGainPerHour: 10,
      hourlyDrops: createHourlyDrops(10),
      hours: [
        optimizationHour("2026-07-22", 0, -100),
        optimizationHour("2026-07-22", 1, 3),
        optimizationHour("2026-07-22", 2, 2),
        optimizationHour("2026-07-22", 3, 1),
      ],
      settings: defaultSettings({
        maxHeatingHours: 4,
        safetyShowerReserve: 1,
        targetShowerReserve: 1,
      }),
    });

    assertEqual(
      result.selectedHeatingHourIds.length,
      3,
      "negatiivinen neljas tunti ei lisaa ylimaaraisia lammitystunteja",
    );
    assertEqual(
      result.diagnostics.firstValidSelectionCount,
      3,
      "ensimmainen validi tuntimaara raportoidaan",
    );
    assertEqual(
      result.diagnostics.validCombinationCountsBySelectionCount[4],
      undefined,
      "suurempia tuntimaaria ei kokeilla ensimmaisen validin jalkeen",
    );
  }

  {
    const result = optimizeHeatingPlan({
      ...stratifiedTemperatureInput(50),
      heatingGainPerHour: 10,
      hourlyDrops: createHourlyDrops(10),
      hours: [
        optimizationHour("2026-07-22", 0, 0),
        optimizationHour("2026-07-22", 1, 10),
        optimizationHour("2026-07-22", 2, 1),
        optimizationHour("2026-07-22", 3, 2),
      ],
      settings: defaultSettings({
        maxHeatingHours: 3,
        safetyShowerReserve: 1,
        targetShowerReserve: 1,
      }),
    });

    assertEqual(
      result.selectedHeatingHourIds,
      ["2026-07-22:00", "2026-07-22:01", "2026-07-22:02"],
      "kun kaksi tuntia ei riita, valitaan halvin validi kolmen tunnin yhdistelma joka huomioi havion ennen lammitysta",
    );
    assertEqual(
      result.diagnostics.firstValidSelectionCount,
      3,
      "kolme tuntia on ensimmainen validi tuntimaara",
    );
    assertEqual(
      result.diagnostics.validCombinationCountsBySelectionCount[2],
      0,
      "kahden tunnin validit yhdistelmat raportoidaan nollaksi",
    );
  }

  {
    const result = optimizeHeatingPlan({
      ...stratifiedTemperatureInput(70),
      heatingGainPerHour: 10,
      hourlyDrops: createHourlyDrops(1),
      hours: [
        optimizationHour("2026-07-22", 0, -100),
        optimizationHour("2026-07-22", 1, -100),
        optimizationHour("2026-07-22", 2, -100),
      ],
      settings: defaultSettings({
        maxHeatingHours: 3,
        safetyShowerReserve: 5,
        targetShowerReserve: 5,
      }),
    });

    assertEqual(
      result.selectedHeatingHourIds,
      [],
      "jos nolla tuntia riittaa, negatiiviset hinnat eivat lisaa lammitysta",
    );
    assertEqual(
      result.diagnostics.firstValidSelectionCount,
      0,
      "nolla tuntia voi olla ensimmainen validi tuntimaara",
    );
  }

  {
    const result = optimizeHeatingPlan({
      ...stratifiedTemperatureInput(50),
      heatingGainPerHour: 10,
      hourlyDrops: createHourlyDrops(10),
      hours: [
        optimizationHour("2026-07-22", 0, 10),
        optimizationHour("2026-07-22", 1, 4),
        optimizationHour("2026-07-22", 2, 3),
        optimizationHour("2026-07-22", 3, 2),
        optimizationHour("2026-07-22", 4, 1),
      ],
      settings: defaultSettings({
        maxHeatingHours: 4,
        safetyShowerReserve: 1,
        targetShowerReserve: 1,
      }),
    });

    assertEqual(
      result.selectedHeatingHourIds,
      [
        "2026-07-22:00",
        "2026-07-22:01",
        "2026-07-22:02",
        "2026-07-22:03",
      ],
      "jos kolme tuntia ei riita mutta nelja riittaa, tulos on nelja tuntia",
    );
    assertEqual(
      result.diagnostics.firstValidSelectionCount,
      4,
      "nelja tuntia raportoidaan ensimmaiseksi validiksi tuntimaaraksi",
    );
    assertClose(
      result.diagnostics.minimumPredictedShowersLeft,
      1.9285714285714293,
      "diagnostiikka raportoi alimman ennustetun suihkuvarauksen",
    );
    assertClose(
      result.diagnostics.heatingGainEstimate.gainPerHour,
      10,
      "diagnostiikka raportoi heating gain -arvion",
    );
    assertEqual(
      result.diagnostics.heatingGainEstimate.fallbackUsed,
      false,
      "diagnostiikka raportoi kaytettiinko fallbackia",
    );
    assertEqual(
      result.diagnostics.selectedPlanCost,
      19,
      "diagnostiikka raportoi valitun suunnitelman hinnan",
    );
  }

  {
    const settings = defaultSettings({
      maxHeatingHours: 1,
      safetyShowerReserve: 2,
      targetShowerReserve: 4,
    });
    const result = optimizeHeatingPlan({
      ...stratifiedTemperatureInput(50),
      heatingGainPerHour: 10,
      hourlyDrops: createHourlyDrops(5),
      hours: [
        optimizationHour("2026-07-22", 12, 10),
        optimizationHour("2026-07-22", 13, 1),
      ],
      settings,
    });

    assertEqual(
      result.selectedHeatingHourIds,
      ["2026-07-22:12"],
      "lammitys aikaistuu jos yhteinen suihkuvaraus alittuisi ennen halpaa tuntia",
    );
    assertClose(
      result.minimumPredictedShowersLeft,
      2.875,
      "tavoitteen alitus huomioi havion ennen halpaa lammitystuntia hylkaamatta muuten turvallista suunnitelmaa",
    );
  }

  {
    const result = simulateHeatingPlan({
      ...stratifiedTemperatureInput(30),
      heatingGainPerHour: 0,
      hourlyDrops: createHourlyDrops(1),
      hours: [optimizationHour("2026-07-22", 12, 1)],
      selectedHeatingHourIds: [],
      settings: defaultSettings({
        safetyShowerReserve: 2,
        targetShowerReserve: 2,
      }),
    });

    assertEqual(
      result.valid,
      false,
      "ennustettu varaus ei saa alittaa turvarajaa",
    );
    assertEqual(
      result.violations.includes("safety shower reserve would be violated"),
      true,
      "turvarajan alitus raportoidaan",
    );
  }

  {
    const result = optimizeHeatingPlan({
      ...stratifiedTemperatureInput(50),
      heatingGainPerHour: 10,
      hourlyDrops: createHourlyDrops(5),
      hours: [
        optimizationHour("2026-07-22", 12, 9),
        optimizationHour("2026-07-22", 13, 1),
      ],
      settings: defaultSettings({
        maxHeatingHours: 2,
        safetyShowerReserve: 2,
        targetShowerReserve: 4,
      }),
    });

    assertEqual(
      result.diagnostics.firstValidSelectionCount,
      1,
      "yksi tunti valitaan kun se palauttaa tavoitevarauksen",
    );
    assertEqual(
      result.selectedHeatingHourIds,
      ["2026-07-22:12"],
      "saman tuntimaaran vaihtoehdoista valitaan halvin turvallinen tunti",
    );
  }

  {
    const settings = defaultSettings({
      maxHeatingHours: 3,
      safetyShowerReserve: 2,
      targetShowerReserve: 4,
    });
    const result = optimizeHeatingPlan({
      ...stratifiedTemperatureInput(50),
      heatingGainPerHour: 10,
      hourlyDrops: createHourlyDrops(5),
      hours: [
        optimizationHour("2026-07-22", 12, 8),
        optimizationHour("2026-07-22", 13, 2),
        optimizationHour("2026-07-22", 14, 1),
      ],
      settings,
    });

    // Tavoite tarkistetaan viimeisen valitun lammitystunnin jalkeen, ei enaa
    // koko horisontin (tassa: tunnin 14) lopusta. Yksi tunti (12) riittaa jo
    // yksinaan tayttamaan tavoitteen sielta katsottuna, joten tarpeetonta
    // toista lammitystuntia ei enaa valita.
    assertEqual(
      result.diagnostics.firstValidSelectionCount,
      1,
      "yksi tunti riittaa, koska tavoite tarkistetaan heti viimeisen valitun lammitystunnin jalkeen",
    );
    assertEqual(
      result.selectedHeatingHourIds,
      ["2026-07-22:12"],
      "halvin yhden tunnin yhdistelma, joka tayttaa tavoitteen tavoitehetkella, valitaan",
    );
    assertEqual(
      result.finalShowersLeft < settings.targetShowerReserve,
      true,
      "horisontin aivan viimeinen arvo jaa alle tavoitteen, mutta se ei enaa tee suunnitelmasta invalidia",
    );
  }

  {
    const currentHour = {
      ...optimizationHour("2026-07-22", 0, -100),
      isCurrentHour: true,
    };
    const baseHours = [
      currentHour,
      optimizationHour("2026-07-22", 1, -100),
      optimizationHour("2026-07-22", 2, -100),
    ];
    const baseSettings = defaultSettings({
      maxHeatingHours: 3,
      safetyShowerReserve: 5,
      targetShowerReserve: 5,
    });

    const heatingRunning = optimizeHeatingPlan({
      ...stratifiedTemperatureInput(70),
      heatingGainPerHour: 10,
      hourlyDrops: createHourlyDrops(1),
      hours: baseHours,
      isCurrentlyHeating: true,
      settings: baseSettings,
    });

    assertEqual(
      heatingRunning.selectedHeatingHourIds,
      ["2026-07-22:00"],
      "kaynnissa oleva nykyinen tunti pysyy suunnitelmassa vaikka nolla valinnaista tuntia riittaisi",
    );
    assertEqual(
      heatingRunning.diagnostics.firstValidSelectionCount,
      0,
      "lukittu tunti ei kuluta valinnaista tuntibudjettia kun nolla valinnaista tuntia riittaa",
    );

    const heatingNotRunning = optimizeHeatingPlan({
      ...stratifiedTemperatureInput(70),
      heatingGainPerHour: 10,
      hourlyDrops: createHourlyDrops(1),
      hours: baseHours,
      isCurrentlyHeating: false,
      settings: baseSettings,
    });

    assertEqual(
      heatingNotRunning.selectedHeatingHourIds,
      [],
      "nykyinen tunti ei ole automaattisesti pakollinen jos lammitys ei ole kaynnissa",
    );
  }

  {
    const currentHour = {
      ...optimizationHour("2026-07-22", 10, 5),
      isCurrentHour: true,
    };
    const result = optimizeHeatingPlan({
      ...stratifiedTemperatureInput(50),
      heatingGainPerHour: 10,
      hourlyDrops: createHourlyDrops(20),
      hours: [
        currentHour,
        optimizationHour("2026-07-22", 11, 4),
        optimizationHour("2026-07-22", 12, 3),
        optimizationHour("2026-07-22", 13, 2),
      ],
      isCurrentlyHeating: true,
      settings: defaultSettings({
        maxHeatingHours: 3,
        safetyShowerReserve: 5.9,
        targetShowerReserve: 5.9,
      }),
    });

    assertEqual(
      Object.keys(result.diagnostics.validCombinationCountsBySelectionCount)
        .map(Number)
        .sort((first, second) => first - second),
      [0, 1, 2],
      "lukittu nykyinen tunti vahentaa vapaasti valittavien tuntien maaran kahteen kun automaticMaxHeatingHours on kolme",
    );
    assertEqual(
      result.selectedHeatingHourIds.includes("2026-07-22:10"),
      true,
      "nykyinen tunti on mukana myos silloin kun mikaan yhdistelma ei tayta tavoitetta",
    );
  }

  {
    const partialCurrentHour = {
      ...optimizationHour("2026-07-22", 12, 5, 0.25),
      isCurrentHour: true,
    };
    const result = optimizeHeatingPlan({
      ...stratifiedTemperatureInput(50),
      heatingGainPerHour: 8,
      hourlyDrops: createHourlyDrops(0),
      hours: [partialCurrentHour],
      isCurrentlyHeating: true,
      settings: defaultSettings({ maxHeatingHours: 1 }),
    });

    assertEqual(
      result.selectedHeatingHourIds,
      [partialCurrentHour.id],
      "lukittu tunti on ainoa ehdokas kun muita tunteja ei ole",
    );
    assertEqual(
      result.forecast[0].segmentHours,
      0.25,
      "segmentHours sailyy lukitulle tunnille alkuperaisena jaljella olevana murto-osana",
    );
    assertClose(
      result.forecast[0].heatingGain,
      8 * 0.25,
      "kaynnissa olevan tunnin jaljella oleva 0,25h skaalaa lammitysvaikutuksen oikein taydeksi tunniksi pyoristamatta",
    );
  }

  {
    const currentHour = {
      ...optimizationHour("2026-07-22", 20, 6),
      isCurrentHour: true,
    };
    const optionalHour = optimizationHour("2026-07-22", 21, 1);
    const rerunArgs = {
      heatingGainPerHour: 6,
      hourlyDrops: createHourlyDrops(2),
      hours: [currentHour, optionalHour],
      isCurrentlyHeating: true,
      settings: defaultSettings({
        maxHeatingHours: 2,
        safetyShowerReserve: 2,
        targetShowerReserve: 3,
      }),
    };

    const beforeNewReading = optimizeHeatingPlan({
      ...stratifiedTemperatureInput(45.12),
      ...rerunArgs,
    });
    const afterNewReading = optimizeHeatingPlan({
      ...stratifiedTemperatureInput(45.19),
      ...rerunArgs,
    });

    assertEqual(
      beforeNewReading.selectedHeatingHourIds.includes(currentHour.id),
      true,
      "ensimmainen mittaus: nykyinen kaynnissa oleva tunti on mukana",
    );
    assertEqual(
      afterNewReading.selectedHeatingHourIds.includes(currentHour.id),
      true,
      "hieman muuttunut uusi mittaus kaynnistaa uuden optimoinnin, mutta nykyinen tunti sailyy edelleen mukana",
    );
  }

  // Testi A: varaaja riittaa huomisen halpaan jaksoon, tarpeetonta illan
  // tuntia ei valita.
  {
    const tonightHour = optimizationHour("2026-07-22", 21, 9);
    const tomorrowCheapHour = optimizationHour("2026-07-23", 13, 1);
    const settings = defaultSettings({
      maxHeatingHours: 2,
      safetyShowerReserve: 0,
      targetShowerReserve: 4,
    });
    const result = optimizeHeatingPlan({
      currentBottomTemperature: 70,
      currentTopTemperature: 70,
      currentWeightedTemperature: 70,
      heatingGainPerHour: 100,
      hourlyDrops: createHourlyDrops(30),
      hours: [tonightHour, tomorrowCheapHour],
      settings,
    });

    assertEqual(
      result.selectedHeatingHourIds,
      ["2026-07-23:13"],
      "varaaja riittaa huomisen halpaan jaksoon asti eika tarpeetonta illan tuntia valita",
    );
    assertEqual(
      result.valid,
      true,
      "halvan huomisen tunnin lammitys yksinaan riittaa tayttamaan tavoitteen",
    );
  }

  // Testi B: kaksi huomisen halpaa peräkkäistä tuntia palauttavat tavoitteen
  // niiden jalkeen, vaikka horisontin lopussa (viela myohemman erillisen
  // hukkatunnin jalkeen) varaus on alle tavoitteen.
  {
    const todayExpensive = optimizationHour("2026-07-22", 21, 9);
    const tomorrowCheapA = optimizationHour("2026-07-23", 13, 2);
    const tomorrowCheapB = optimizationHour("2026-07-23", 14, 1);
    const tomorrowAfter = optimizationHour("2026-07-23", 15, 5);
    const settings = defaultSettings({
      maxHeatingHours: 3,
      safetyShowerReserve: 0,
      targetShowerReserve: 4,
    });
    const result = optimizeHeatingPlan({
      currentBottomTemperature: 70,
      currentTopTemperature: 70,
      currentWeightedTemperature: 70,
      heatingGainPerHour: 100,
      hourlyDrops: createHourlyDrops(0, { 21: 30, 13: 10, 14: 10, 15: 200 }),
      hours: [todayExpensive, tomorrowCheapA, tomorrowCheapB, tomorrowAfter],
      settings,
    });

    assertEqual(
      result.selectedHeatingHourIds,
      ["2026-07-23:13", "2026-07-23:14"],
      "kaksi huomisen halpaa perakkaista tuntia valitaan kalliin illan tunnin sijaan",
    );
    assertEqual(
      result.valid,
      true,
      "suunnitelma on valid, koska tavoite tayttyy heti viimeisen valitun tunnin jalkeen",
    );
    assertEqual(
      result.finalShowersLeft < settings.targetShowerReserve,
      true,
      "horisontin aivan viimeinen arvo jaa todistetusti alle tavoitteen (vanha tarkistus olisi hylannyt taman suunnitelman)",
    );
    assertEqual(
      result.targetCheckShowersLeft >= settings.targetShowerReserve,
      true,
      "tavoitehetken (viimeisen valitun lammitystunnin jalkeinen) arvo tayttaa tavoitteen",
    );
  }

  // Testi C: horisontin lopussa varaus on alle tavoitteen, mutta turvaraja ei
  // alitu yhdellakaan tunnilla koko horisontin aikana - suunnitelma on valid.
  {
    const heatedHour = optimizationHour("2026-07-22", 10, 3);
    const afterHour = optimizationHour("2026-07-22", 11, 7);
    const settings = defaultSettings({
      maxHeatingHours: 1,
      safetyShowerReserve: 0,
      targetShowerReserve: 4,
    });
    const result = optimizeHeatingPlan({
      currentBottomTemperature: 50,
      currentTopTemperature: 50,
      currentWeightedTemperature: 50,
      heatingGainPerHour: 100,
      hourlyDrops: createHourlyDrops(0, { 10: 5, 11: 120 }),
      hours: [heatedHour, afterHour],
      settings,
    });

    assertEqual(
      result.selectedHeatingHourIds,
      ["2026-07-22:10"],
      "ainoa validi yhden tunnin yhdistelma valitaan",
    );
    assertEqual(
      result.valid,
      true,
      "suunnitelma voi olla valid vaikka horisontin loppu jaa alle tavoitteen",
    );
    assertEqual(
      result.finalShowersLeft < settings.targetShowerReserve,
      true,
      "horisontin loppuarvo on todistetusti alle tavoitteen",
    );
    assertEqual(
      result.forecast.every(
        (entry) =>
          entry.showersLeftAfter >= settings.safetyShowerReserve &&
          entry.showersLeftBefore >= settings.safetyShowerReserve,
      ),
      true,
      "turvaraja ei alitu yhdellakaan tunnilla koko horisontin aikana",
    );
  }

  // Testi D: tavoite ei tayty viimeisen valitun lammitystunnin jalkeen ->
  // suunnitelma on invalid.
  {
    const heatedHour = optimizationHour("2026-07-22", 10, 3);
    const settings = defaultSettings({
      safetyShowerReserve: 0,
      targetShowerReserve: 3,
    });
    const result = simulateHeatingPlan({
      currentBottomTemperature: 50,
      currentTopTemperature: 50,
      currentWeightedTemperature: 50,
      heatingGainPerHour: 10,
      hourlyDrops: createHourlyDrops(0, { 10: 2 }),
      hours: [heatedHour],
      selectedHeatingHourIds: [heatedHour.id],
      settings,
    });

    assertEqual(
      result.valid,
      false,
      "tavoite ei tayty viimeisen valitun lammitystunnin jalkeen, joten suunnitelma on invalid",
    );
    assertEqual(
      result.violations.includes("target shower reserve would not be restored"),
      true,
      "tavoitteen alitus raportoidaan viallisena",
    );
    assertClose(
      result.targetCheckShowersLeft,
      96 / 35,
      "tavoitehetken arvo lasketaan viimeisen valitun lammitystunnin jalkeisesta tilasta, ei horisontin lopusta",
    );
  }
}
