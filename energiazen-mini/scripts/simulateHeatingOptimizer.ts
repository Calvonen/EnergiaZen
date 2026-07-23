import {
  HeatingOptimizationHour,
  HeatingOptimizationSettings,
  optimizeHeatingPlan,
  simulateHeatingPlan,
} from "../lib/heatingOptimizer";
import { HourlyTemperatureDropProfile } from "../lib/tankTemperatureForecast";

declare const process: {
  argv: string[];
  exitCode?: number;
};

type TemperatureInput =
  | { currentWeightedTemperature: number }
  | { bottomTemperature: number; topTemperature: number };

type SimulationScenario = TemperatureInput & {
  cheaperRejectedHeatingHourIndexes?: number[];
  description: string;
  fullTankAverageTemperature: number;
  fullTankShowers: number;
  heatingGainPerHour: number;
  hourlyPrices: number[];
  hourlyTemperatureDrops: number[];
  id: string;
  maxHeatingHours: number;
  name: string;
  safetyShowerReserve: number;
  startDate: string;
  targetShowerReserve: number;
  windowHours: number;
};

const millisecondsPerHour = 60 * 60 * 1000;
const helsinkiDateTimeFormatter = new Intl.DateTimeFormat("fi-FI", {
  day: "2-digit",
  hour: "2-digit",
  hour12: false,
  minute: "2-digit",
  month: "2-digit",
  timeZone: "Europe/Helsinki",
});
const helsinkiHourFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  hour12: false,
  timeZone: "Europe/Helsinki",
});

const commonScenario = {
  fullTankAverageTemperature: 70,
  fullTankShowers: 6,
  safetyShowerReserve: 2,
  startDate: "2026-07-22T09:00:00.000Z",
  targetShowerReserve: 4,
} as const;

const scenarios: SimulationScenario[] = [
  {
    ...commonScenario,
    currentWeightedTemperature: 50,
    description: "Varaus saa laskea tavoitteen alle ennen halvinta tuntia.",
    heatingGainPerHour: 10,
    hourlyPrices: [10, 1],
    hourlyTemperatureDrops: [5, 5],
    id: "1",
    maxHeatingHours: 1,
    name: "Tavoitteen hetkellinen alitus",
    windowHours: 2,
  },
  {
    ...commonScenario,
    currentWeightedTemperature: 40,
    cheaperRejectedHeatingHourIndexes: [1],
    description: "Halpaa tuntia ei voida odottaa turvarajan rikkoutumatta.",
    heatingGainPerHour: 12,
    hourlyPrices: [10, 1],
    hourlyTemperatureDrops: [11, 1],
    id: "2",
    maxHeatingHours: 1,
    name: "Turvaraja ennen halpaa tuntia",
    targetShowerReserve: 3,
    windowHours: 2,
  },
  {
    ...commonScenario,
    currentWeightedTemperature: 50,
    description: "Yksi lämmitystunti palauttaa loppuvarauksen tavoitteeseen.",
    heatingGainPerHour: 10,
    hourlyPrices: [9, 1],
    hourlyTemperatureDrops: [5, 5],
    id: "3",
    maxHeatingHours: 2,
    name: "Yksi tunti riittää",
    windowHours: 2,
  },
  {
    ...commonScenario,
    currentWeightedTemperature: 50,
    description: "Yksi tunti ei riitä, mutta kaksi tuntia palauttaa tavoitteen.",
    heatingGainPerHour: 10,
    hourlyPrices: [8, 2, 1],
    hourlyTemperatureDrops: [5, 5, 5],
    id: "4",
    maxHeatingHours: 3,
    name: "Kaksi tuntia tarvitaan",
    windowHours: 3,
  },
  {
    ...commonScenario,
    currentWeightedTemperature: 40,
    cheaperRejectedHeatingHourIndexes: [1],
    description: "Kallis ensimmäinen tunti valitaan turvarajan säilyttämiseksi.",
    heatingGainPerHour: 12,
    hourlyPrices: [20, 1, 2],
    hourlyTemperatureDrops: [11, 1, 0],
    id: "5",
    maxHeatingHours: 1,
    name: "Kallis turvatunti",
    targetShowerReserve: 3,
    windowHours: 3,
  },
  {
    ...commonScenario,
    currentWeightedTemperature: 50,
    description: "Kaksi sallittua tuntia eivät riitä tavoitevarauksen palauttamiseen.",
    heatingGainPerHour: 8,
    hourlyPrices: [3, 2, 1],
    hourlyTemperatureDrops: [10, 10, 10],
    id: "6",
    maxHeatingHours: 2,
    name: "Enimmäistunnit eivät riitä",
    windowHours: 3,
  },
  ...[4, 6, 8].map(
    (heatingGainPerHour): SimulationScenario => ({
      ...commonScenario,
      currentWeightedTemperature: 50,
      description: `Sama tilanne heatingGain-arvolla ${heatingGainPerHour} °C/h.`,
      heatingGainPerHour,
      hourlyPrices: [8, 4, 2, 1],
      hourlyTemperatureDrops: [3, 3, 3, 3],
      id: `7-${heatingGainPerHour}`,
      maxHeatingHours: 4,
      name: `HeatingGain-vertailu ${heatingGainPerHour} °C/h`,
      windowHours: 4,
    }),
  ),
];

function getWeightedTemperature(scenario: SimulationScenario) {
  if ("currentWeightedTemperature" in scenario) {
    return scenario.currentWeightedTemperature;
  }

  return scenario.topTemperature * 0.7 + scenario.bottomTemperature * 0.3;
}

function getHelsinkiHour(date: Date) {
  const hour = Number(helsinkiHourFormatter.format(date));

  return hour === 24 ? 0 : hour;
}

function buildInputs(scenario: SimulationScenario) {
  if (
    scenario.hourlyPrices.length !== scenario.windowHours ||
    scenario.hourlyTemperatureDrops.length !== scenario.windowHours
  ) {
    throw new Error(
      `Skenaarion ${scenario.id} hinta- ja pudotuslistojen pituuden pitää vastata tarkasteluikkunaa.`,
    );
  }

  const startDate = new Date(scenario.startDate);
  const hourlyDrops: HourlyTemperatureDropProfile = Object.fromEntries(
    Array.from({ length: 24 }, (_, hour) => [hour, 0]),
  );
  const hours = Array.from(
    { length: scenario.windowHours },
    (_, index): HeatingOptimizationHour => {
      const date = new Date(startDate.getTime() + index * millisecondsPerHour);
      const endDate = new Date(date.getTime() + millisecondsPerHour);

      hourlyDrops[getHelsinkiHour(date)] =
        scenario.hourlyTemperatureDrops[index];

      return {
        date,
        endDate,
        id: `${scenario.id}:${date.toISOString()}`,
        price: scenario.hourlyPrices[index],
        startDate: date.toISOString(),
      };
    },
  );
  const settings: HeatingOptimizationSettings = {
    absoluteMinimumTemperature: 10,
    fallbackHeatingGainPerHour: 8,
    fullTankAverageTemperature: scenario.fullTankAverageTemperature,
    fullTankShowers: scenario.fullTankShowers,
    maxHeatingHours: scenario.maxHeatingHours,
    safetyShowerReserve: scenario.safetyShowerReserve,
    targetShowerReserve: scenario.targetShowerReserve,
  };

  return { hourlyDrops, hours, settings };
}

function formatNumber(value: number) {
  return value.toFixed(1).replace(".", ",");
}

function formatBoolean(value: boolean) {
  return value ? "kyllä" : "ei";
}

function runScenario(scenario: SimulationScenario) {
  const { hourlyDrops, hours, settings } = buildInputs(scenario);
  const result = optimizeHeatingPlan({
    currentWeightedTemperature: getWeightedTemperature(scenario),
    heatingGainPerHour: scenario.heatingGainPerHour,
    hourlyDrops,
    hours,
    settings,
  });
  const pricesByStartDate = new Map(
    hours.map((hour) => [hour.startDate, hour.price]),
  );
  const finalShowers =
    result.forecast[result.forecast.length - 1]?.showersLeftAfter ??
    result.minimumPredictedShowersLeft;
  const cheaperRejectedResult = scenario.cheaperRejectedHeatingHourIndexes
    ? simulateHeatingPlan({
        currentWeightedTemperature: getWeightedTemperature(scenario),
        heatingGainPerHour: scenario.heatingGainPerHour,
        hourlyDrops,
        hours,
        selectedHeatingHourIds:
          scenario.cheaperRejectedHeatingHourIndexes.map(
            (index) => hours[index].id,
          ),
        settings,
      })
    : null;
  const resultSource =
    result.diagnostics.firstValidSelectionCount !== null && result.valid
      ? "bestResult"
      : result.diagnostics.firstValidSelectionCount === null && !result.valid
        ? "bestInvalidResult"
        : "fallback-simulaatio";

  if (
    cheaperRejectedResult &&
    (cheaperRejectedResult.valid ||
      cheaperRejectedResult.totalCost >= result.totalCost)
  ) {
    throw new Error(
      `Skenaarion ${scenario.id} vertailuvaihtoehdon pitää olla valittua suunnitelmaa halvempi mutta invalidi.`,
    );
  }

  console.log(`\n=== ${scenario.id}: ${scenario.name} ===`);
  console.log(scenario.description);
  console.log(
    `Lähtölämpö ${formatNumber(getWeightedTemperature(scenario))} °C | tavoite ${formatNumber(scenario.targetShowerReserve)} | turvaraja ${formatNumber(scenario.safetyShowerReserve)} | max ${scenario.maxHeatingHours} h`,
  );
  console.table(
    result.forecast.map((hour) => ({
      aika: helsinkiDateTimeFormatter.format(new Date(hour.startDate)),
      hinta: formatNumber(pricesByStartDate.get(hour.startDate) ?? 0),
      "lämpö ennen": formatNumber(hour.temperatureBefore),
      "lämpö jälkeen": formatNumber(hour.temperatureAfter),
      "suihkut ennen": formatNumber(hour.showersLeftBefore),
      "suihkut jälkeen": formatNumber(hour.showersLeftAfter),
      lasku: formatNumber(hour.hourlyDrop),
      nousu: formatNumber(hour.heatingGain),
      lämmitys: formatBoolean(hour.isHeatingSelected),
      "alle tavoitteen": formatBoolean(
        Math.min(hour.showersLeftBefore, hour.showersLeftAfter) <
          scenario.targetShowerReserve,
      ),
      "alle turvarajan": formatBoolean(hour.violatedReserve),
    })),
  );
  console.log("Yhteenveto");
  console.log(
    `  Valitut tunnit: ${
      result.selectedHeatingHourIds.length > 0
        ? result.forecast
            .filter((hour) => hour.isHeatingSelected)
            .map((hour) => helsinkiDateTimeFormatter.format(new Date(hour.startDate)))
            .join(", ")
        : "ei valittuja tunteja"
    }`,
  );
  console.log(`  Lämmitystunteja: ${result.selectedHeatingHourIds.length}`);
  console.log(`  Kokonaiskustannus: ${formatNumber(result.totalCost)}`);
  console.log(
    `  TargetShowerReserve: ${formatNumber(scenario.targetShowerReserve)}`,
  );
  console.log(
    `  SafetyShowerReserve: ${formatNumber(scenario.safetyShowerReserve)}`,
  );
  console.log(
    `  Alin ennustettu suihkuvaraus: ${formatNumber(result.minimumPredictedShowersLeft)}`,
  );
  console.log(`  Ennustettu loppuvaraus: ${formatNumber(finalShowers)}`);
  console.log(`  Suunnitelma validi: ${formatBoolean(result.valid)}`);
  console.log(
    `  FirstValidSelectionCount: ${result.diagnostics.firstValidSelectionCount ?? "ei löytynyt"}`,
  );
  console.log(`  Optimizer-tulos: ${resultSource}`);
  console.log(
    `  HeatingGain: ${formatNumber(result.heatingGainEstimate.gainPerHour)} °C/h (simulaation eksplisiittinen arvo)`,
  );
  if (!result.valid) {
    console.log(`  Hylkäyssyyt: ${result.violations.join("; ")}`);
  }
  if (cheaperRejectedResult) {
    const rejectedHours = cheaperRejectedResult.forecast
      .filter((hour) => hour.isHeatingSelected)
      .map((hour) => helsinkiDateTimeFormatter.format(new Date(hour.startDate)))
      .join(", ");

    console.log("  Hylätty halvempi vertailusuunnitelma:");
    console.log(`    Valitut tunnit: ${rejectedHours}`);
    console.log(
      `    Kustannus: ${formatNumber(cheaperRejectedResult.totalCost)}`,
    );
    console.log(
      `    Alin varaus: ${formatNumber(cheaperRejectedResult.minimumPredictedShowersLeft)}`,
    );
    console.log(
      `    Hylkäyssyy: ${cheaperRejectedResult.violations.join("; ")}`,
    );
  }

  return result;
}

function printUsage() {
  console.log("Käyttö: npm run simulate:heating -- [all|list|skenaario-id]");
  console.log("Esimerkki: npm run simulate:heating -- 5");
  console.log("Skenaariot:");
  for (const scenario of scenarios) {
    console.log(`  ${scenario.id}: ${scenario.name}`);
  }
}

const requestedScenario = process.argv[2] ?? "all";

if (requestedScenario === "list") {
  printUsage();
} else {
  const selectedScenarios =
    requestedScenario === "all"
      ? scenarios
      : scenarios.filter((scenario) => scenario.id === requestedScenario);

  if (selectedScenarios.length === 0) {
    console.error(`Tuntematon skenaario: ${requestedScenario}`);
    printUsage();
    process.exitCode = 1;
  } else {
    for (const scenario of selectedScenarios) {
      runScenario(scenario);
    }
  }
}
