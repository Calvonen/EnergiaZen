import {
  buildElectricityPriceTrend,
  buildPriceAxis,
} from "./electricityPriceTrend";
import { offsetDateKey } from "./electricityPrices";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertTrue(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

export function runElectricityPriceTrendUnitTests() {
  const todayKey = "2026-07-24";
  const priceDays = Array.from({ length: 30 }, (_, index) => ({
    averageTotalPrice: index + 1,
    dateKey: offsetDateKey(todayKey, index - 29),
  }));
  const heatedDays = priceDays.map((day, index) => ({
    dateKey: day.dateKey,
    weightedAveragePrice: 100 + index,
  }));

  const sevenDayTrend = buildElectricityPriceTrend({
    dataFilter: "all",
    heatedDays,
    priceDays,
    range: 7,
    todayKey,
  });
  assertEqual(
    sevenDayTrend.points.length,
    7,
    "7 päivän data muodostaa 7 pisteen sarjan",
  );
  assertEqual(
    sevenDayTrend.points.map((point) => point.value),
    [24, 25, 26, 27, 28, 29, 30],
    "Kaikki hinnat käyttää päivän kokonaishintaista keskihintaa",
  );
  assertEqual(
    sevenDayTrend.dateLabels.map((label) => label.label).length,
    7,
    "7 päivän näkymä näyttää seitsemän päivämäärämerkintää",
  );

  const thirtyDayTrend = buildElectricityPriceTrend({
    dataFilter: "heated",
    heatedDays,
    priceDays,
    range: 30,
    todayKey,
  });
  assertEqual(
    thirtyDayTrend.points.length,
    30,
    "30 päivän data muodostaa 30 pisteen sarjan",
  );
  assertEqual(
    [thirtyDayTrend.points[0].value, thirtyDayTrend.points[29].value],
    [100, 129],
    "Lämmitetyt tunnit käyttää päivän lämmitettyä keskihintaa",
  );
  assertTrue(
    thirtyDayTrend.dateLabels.length >= 6 &&
      thirtyDayTrend.dateLabels.length <= 7,
    "30 päivän näkymä näyttää noin kuusi päivämäärämerkintää",
  );
  assertEqual(
    [
      thirtyDayTrend.dateLabels[0].dateKey,
      thirtyDayTrend.dateLabels[thirtyDayTrend.dateLabels.length - 1].dateKey,
    ],
    [thirtyDayTrend.points[0].dateKey, thirtyDayTrend.points[29].dateKey],
    "30 päivän asteikko näyttää aina ensimmäisen ja viimeisen päivän",
  );

  const trendWithMissingDay = buildElectricityPriceTrend({
    dataFilter: "all",
    heatedDays: [],
    priceDays: priceDays.filter((_, index) => index !== 27),
    range: 7,
    todayKey,
  });
  assertEqual(
    [trendWithMissingDay.points.length, trendWithMissingDay.points[4].value],
    [7, null],
    "puuttuva päivä säilyttää aikavälin mutta jättää käyrään aukon",
  );
  assertEqual(
    trendWithMissingDay.dateLabels[4].index,
    4,
    "puuttuva päivä säilyttää oikean paikan vaaka-akselilla",
  );
  assertEqual(
    [
      trendWithMissingDay.lowest,
      trendWithMissingDay.highest,
      trendWithMissingDay.latest,
    ],
    [24, 30, 30],
    "tunnusluvut ohittavat puuttuvan päivädatan",
  );

  const negativeAxis = buildPriceAxis([-4.2, -2.1, 1.3]);
  assertTrue(
    negativeAxis.ticks.length >= 4 && negativeAxis.ticks.length <= 5,
    "hintojen pystyakselissa on 4–5 luettavaa tasoa",
  );
  assertTrue(
    negativeAxis.minimum < 0 && negativeAxis.maximum > 0,
    "hintojen pystyakseli tukee negatiivisia arvoja",
  );

  const narrowPositiveAxis = buildPriceAxis([9.1, 9.2, 9.3]);
  assertTrue(
    narrowPositiveAxis.minimum > 0,
    "pieni positiivinen hintavaihtelu ei pakota asteikkoa alkamaan nollasta",
  );
  assertTrue(
    narrowPositiveAxis.minimum < 9.1 && narrowPositiveAxis.maximum > 9.3,
    "asteikko jättää tilaa minimin alle ja maksimin päälle",
  );

  const emptyTrend = buildElectricityPriceTrend({
    dataFilter: "heated",
    heatedDays: [],
    priceDays: [],
    range: 7,
    todayKey,
  });
  assertEqual(
    [emptyTrend.points.length, emptyTrend.axisTicks.length, emptyTrend.latest],
    [7, 0, null],
    "tyhjä data ei riko kuvaajamallia",
  );
}
