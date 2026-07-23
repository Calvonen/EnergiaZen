import {
  createHeatingOptimizationSettings,
  estimateHeatingGainPerHour,
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

function optimizationHour(helsinkiDate: string, helsinkiHour: number, price: number) {
  const [year, month, day] = helsinkiDate.split("-").map(Number);
  const startDate = new Date(
    Date.UTC(year, month - 1, day, helsinkiHour - 3),
  );

  return {
    date: startDate,
    endDate: new Date(startDate.getTime() + 60 * 60 * 1000),
    id: `${helsinkiDate}:${String(helsinkiHour).padStart(2, "0")}`,
    price,
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
    safetyShowerReserve: 3,
    targetShowerReserve: 3,
    ...overrides,
  };
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
    const settings = createHeatingOptimizationSettings(
      {
        fullTankAverageTemperature: 70,
        fullTankShowers: 6,
        heatingHoursPerDay: 3,
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
        reading("2026-07-01T01:00:00.000Z", 50, true),
        reading("2026-07-01T01:05:00.000Z", 50, false),
        reading("2026-07-02T00:00:00.000Z", 42, true),
        reading("2026-07-02T01:00:00.000Z", 48, true),
        reading("2026-07-02T01:05:00.000Z", 48, false),
        reading("2026-07-03T00:00:00.000Z", 43, true),
        reading("2026-07-03T01:00:00.000Z", 51, true),
      ],
      7,
    );

    assertEqual(gainEstimate.fallbackUsed, false, "heating gain kayttaa historiaa");
    assertClose(gainEstimate.gainPerHour, 8, "heating gain kayttaa mediaania");
  }

  {
    const result = optimizeHeatingPlan({
      currentWeightedTemperature: 46,
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
      ["2026-07-23:02"],
      "illan lammitys voidaan siirtaa aamuyohon kun suihkuvaraus riittaa",
    );
    assertClose(
      result.minimumPredictedShowersLeft,
      3.1,
      "siirron alin suihkuvaraus pysyy kayttajan rajalla",
    );
  }

  {
    const result = optimizeHeatingPlan({
      currentWeightedTemperature: 44,
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
      currentWeightedTemperature: 40,
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
      currentWeightedTemperature: 40,
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
      currentWeightedTemperature: 40,
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
      currentWeightedTemperature: 48,
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
      ["2026-07-22:14"],
      "turvallisista vaihtoehdoista valitaan halvin myos kulutuspiikin kohdalla",
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
      currentWeightedTemperature: 53,
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
      ["2026-07-23:01"],
      "halvin tunti valitaan kun lampotilaehdot tayttyvat",
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
      currentWeightedTemperature: 50.75,
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
      currentWeightedTemperature: 50.75,
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
      [],
      "oletusarvolla live-datan kaltainen reserve 2 tuottaa 0 tuntia",
    );
    assertEqual(
      reserve3.selectedHeatingHourIds,
      ["2026-07-23:04"],
      "oletusarvolla live-datan kaltainen reserve 3 tuottaa 1 tunnin",
    );
  }

  {
    const result = optimizeHeatingPlan({
      currentWeightedTemperature: 65,
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
      ["2026-07-23:00"],
      "vuorokauden vaihde kasitellaan yhtena optimointi-ikkunana",
    );
    assertEqual(result.selectedHeatingHourIds.length, 1, "paiville ei anneta erillisia taytta kiintiota");
  }

  {
    const result = optimizeHeatingPlan({
      currentWeightedTemperature: 12,
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
      currentWeightedTemperature: 50,
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
        safetyShowerReserve: 3,
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
      currentWeightedTemperature: 50,
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
        safetyShowerReserve: 3,
      }),
    });

    assertEqual(
      result.selectedHeatingHourIds,
      ["2026-07-22:00", "2026-07-22:02", "2026-07-22:03"],
      "kun kaksi tuntia ei riita, valitaan halvin validi kolmen tunnin yhdistelma",
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
      currentWeightedTemperature: 70,
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
      currentWeightedTemperature: 50,
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
        safetyShowerReserve: 3,
      }),
    });

    assertEqual(
      result.selectedHeatingHourIds,
      [
        "2026-07-22:01",
        "2026-07-22:02",
        "2026-07-22:03",
        "2026-07-22:04",
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
      3,
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
      10,
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
      currentWeightedTemperature: 50,
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
      ["2026-07-22:13"],
      "varaus saa kayda tavoitteen alapuolella ennen halpaa lammitystuntia",
    );
    assertClose(
      result.minimumPredictedShowersLeft,
      3.5,
      "tavoitteen alitus ei hylkaa muuten turvallista suunnitelmaa",
    );
  }

  {
    const result = simulateHeatingPlan({
      currentWeightedTemperature: 30,
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
      currentWeightedTemperature: 50,
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
      ["2026-07-22:13"],
      "saman tuntimaaran vaihtoehdoista valitaan halvin",
    );
  }

  {
    const result = optimizeHeatingPlan({
      currentWeightedTemperature: 50,
      heatingGainPerHour: 10,
      hourlyDrops: createHourlyDrops(5),
      hours: [
        optimizationHour("2026-07-22", 12, 8),
        optimizationHour("2026-07-22", 13, 2),
        optimizationHour("2026-07-22", 14, 1),
      ],
      settings: defaultSettings({
        maxHeatingHours: 3,
        safetyShowerReserve: 2,
        targetShowerReserve: 4,
      }),
    });

    assertEqual(
      result.diagnostics.firstValidSelectionCount,
      2,
      "kaksi tuntia valitaan kun yksi ei palauta tavoitevarausta",
    );
    assertEqual(
      result.selectedHeatingHourIds,
      ["2026-07-22:13", "2026-07-22:14"],
      "halvin validi kahden tunnin yhdistelma valitaan",
    );
  }
}
