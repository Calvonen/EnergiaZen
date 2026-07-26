import {
  createHeatingOptimizationInputKey,
  createHeatingOptimizationRunController,
  HeatingOptimizationInputSnapshot,
  materializeHeatingOptimizationHours,
} from "./heatingOptimizationRun";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertClose(actual: number, expected: number, message: string) {
  if (Math.abs(actual - expected) > 0.000001) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function createSnapshot(): HeatingOptimizationInputSnapshot {
  return {
    currentBottomTemperature: 51,
    currentTopTemperature: 64,
    currentWeightedTemperature: 60.1,
    heatingHistory: [
      {
        bottom_temp: 40,
        created_at: "2026-07-26T06:00:00.000Z",
        heating: true,
        top_temp: 50,
      },
    ],
    hourlyDrops: Object.fromEntries(
      Array.from({ length: 24 }, (_, hour) => [hour, 0.2]),
    ),
    hours: [
      {
        date: new Date("2026-07-26T10:00:00.000Z"),
        endDate: new Date("2026-07-26T11:00:00.000Z"),
        id: "2026-07-26:13",
        isCurrentHour: false,
        price: 4,
        segmentHours: 1,
        startDate: "2026-07-26T10:00:00.000Z",
      },
    ],
    isCurrentlyHeating: false,
    manualRefreshRevision: 0,
    mode: "automatic",
    readingCreatedAt: "2026-07-26T07:18:00.000Z",
    settings: {
      absoluteMinimumTemperature: 10,
      fallbackHeatingGainPerHour: 4.5,
      fullTankAverageTemperature: 70,
      fullTankShowers: 6,
      maxHeatingHours: 3,
      maxTankTemperature: 80,
      safetyShowerReserve: 2,
      targetShowerReserve: 3,
    },
  };
}

export function runHeatingOptimizationRunUnitTests() {
  const base = createSnapshot();
  const baseKey = createHeatingOptimizationInputKey(base);

  {
    const controller = createHeatingOptimizationRunController();
    const firstRun = controller.start(baseKey);
    const repeatedRun = controller.start(
      createHeatingOptimizationInputKey(createSnapshot()),
    );

    assertEqual(typeof firstRun, "number", "ensimmainen snapshot kaynnistaa ajon");
    assertEqual(repeatedRun, null, "sama snapshot ei kaynnista uutta ajoa");
  }

  {
    const changedTemperature = createSnapshot();
    changedTemperature.currentTopTemperature = 63.5;

    assertEqual(
      createHeatingOptimizationInputKey(changedTemperature) !== baseKey,
      true,
      "muuttunut lampotila kaynnistaa uuden ajon",
    );
  }

  {
    const changedSettings = createSnapshot();
    changedSettings.settings = {
      ...changedSettings.settings,
      targetShowerReserve: 4,
    };

    assertEqual(
      createHeatingOptimizationInputKey(changedSettings) !== baseKey,
      true,
      "muuttuneet asetukset kaynnistavat uuden ajon",
    );
  }

  {
    const changedPrices = createSnapshot();
    changedPrices.hours = changedPrices.hours.map((hour) => ({
      ...hour,
      price: 5,
    }));

    assertEqual(
      createHeatingOptimizationInputKey(changedPrices) !== baseKey,
      true,
      "muuttuneet hinnat kaynnistavat uuden ajon",
    );
  }

  {
    const atMinute18 = createSnapshot();
    atMinute18.hours = materializeHeatingOptimizationHours(
      atMinute18.hours,
      new Date("2026-07-26T10:18:00.000Z"),
    );
    const atMinute18And30Seconds = createSnapshot();
    atMinute18And30Seconds.hours = materializeHeatingOptimizationHours(
      atMinute18And30Seconds.hours,
      new Date("2026-07-26T10:18:30.000Z"),
    );

    assertClose(
      atMinute18.hours[0].segmentHours,
      42 / 60,
      "segmentin kesto lasketaan ajon todellisesta aloitushetkesta",
    );
    assertEqual(
      atMinute18.hours[0].segmentHours !==
        atMinute18And30Seconds.hours[0].segmentHours,
      true,
      "materialisoitu segmentin kesto seuraa ajon tarkkaa aloitushetkea",
    );
    assertEqual(
      createHeatingOptimizationInputKey(atMinute18),
      createHeatingOptimizationInputKey(atMinute18And30Seconds),
      "pelkka ajan kuluminen saman hintatunnin sisalla ei muuta snapshot-avainta",
    );

    const controller = createHeatingOptimizationRunController();
    assertEqual(
      typeof controller.start(createHeatingOptimizationInputKey(atMinute18)),
      "number",
      "ensimmainen tuntinsisainen snapshot kaynnistaa ajon",
    );
    assertEqual(
      controller.start(
        createHeatingOptimizationInputKey(atMinute18And30Seconds),
      ),
      null,
      "30 sekunnin kellopaivitys ei kaynnista uutta optimointia",
    );
  }

  {
    const changedReading = createSnapshot();
    changedReading.readingCreatedAt = "2026-07-26T07:18:30.000Z";
    assertEqual(
      createHeatingOptimizationInputKey(changedReading) !== baseKey,
      true,
      "uusi mittaus kaynnistaa optimoinnin vaikka lampotila olisi sama",
    );

    const changedHour = createSnapshot();
    changedHour.hours = [
      {
        ...changedHour.hours[0],
        date: new Date("2026-07-26T11:00:00.000Z"),
        endDate: new Date("2026-07-26T12:00:00.000Z"),
        id: "2026-07-26:14",
        startDate: "2026-07-26T11:00:00.000Z",
      },
    ];
    assertEqual(
      createHeatingOptimizationInputKey(changedHour) !== baseKey,
      true,
      "hintatunnin vaihtuminen kaynnistaa optimoinnin",
    );

    const manualRefresh = createSnapshot();
    manualRefresh.manualRefreshRevision += 1;
    assertEqual(
      createHeatingOptimizationInputKey(manualRefresh) !== baseKey,
      true,
      "manuaalinen paivitys kaynnistaa optimoinnin",
    );
  }

  {
    const controller = createHeatingOptimizationRunController();
    const runId = controller.start(baseKey);
    const optimizationResult = { plannedHours: [], projectedShowers: 3.4 };

    assertEqual(
      controller.start(baseKey),
      null,
      "optimoinnin tulos ei kuulu syotteeseen eika kaynnista silmukkaa",
    );
    assertEqual(
      optimizationResult.plannedHours,
      [],
      "testin optimointitulos on kayttamaton syotededuplikoinnissa",
    );
    assertEqual(
      controller.canCommit(runId ?? -1),
      true,
      "ainoa ajo saa julkaista tuloksen",
    );
  }

  {
    const controller = createHeatingOptimizationRunController();
    const olderRun = controller.start(baseKey);
    const changedTemperature = createSnapshot();
    changedTemperature.currentBottomTemperature = 50;
    const newerRun = controller.start(
      createHeatingOptimizationInputKey(changedTemperature),
    );

    assertEqual(
      controller.canCommit(olderRun ?? -1),
      false,
      "vanhempi rinnakkainen ajo ei saa julkaista tulosta",
    );
    assertEqual(
      controller.canCommit(newerRun ?? -1),
      true,
      "vain uusin rinnakkainen ajo saa julkaista tuloksen",
    );
  }
}
