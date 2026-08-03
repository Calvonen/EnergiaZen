import {
  isTankReadingFreshForCalculation,
  tankReadingCalculationMaxAgeMinutes,
} from "./tankReadingFreshness";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function runTankReadingFreshnessUnitTests() {
  const now = new Date("2026-08-03T12:00:00.000Z");

  assertEqual(
    isTankReadingFreshForCalculation(null, now),
    false,
    "puuttuva aikaleima ei ole laskentakelpoinen",
  );
  assertEqual(
    isTankReadingFreshForCalculation("not-a-date", now),
    false,
    "virheellinen aikaleima ei ole laskentakelpoinen",
  );
  assertEqual(
    isTankReadingFreshForCalculation(now.toISOString(), now),
    true,
    "juuri saapunut lukema on laskentakelpoinen",
  );
  assertEqual(
    tankReadingCalculationMaxAgeMinutes,
    30,
    "raja on 30 minuuttia, sama kuin vikabannerin kynnys",
  );

  const exactlyAtLimit = new Date(
    now.getTime() - tankReadingCalculationMaxAgeMinutes * 60 * 1000,
  );
  assertEqual(
    isTankReadingFreshForCalculation(exactlyAtLimit.toISOString(), now),
    true,
    "tasan 30 minuutin ikainen lukema on viela laskentakelpoinen",
  );

  const justOverLimit = new Date(
    now.getTime() - (tankReadingCalculationMaxAgeMinutes * 60 * 1000 + 1000),
  );
  assertEqual(
    isTankReadingFreshForCalculation(justOverLimit.toISOString(), now),
    false,
    "juuri rajan yli mennyt lukema ei ole enaa laskentakelpoinen",
  );

  const futureReading = new Date(now.getTime() + 5 * 60 * 1000);
  assertEqual(
    isTankReadingFreshForCalculation(futureReading.toISOString(), now),
    false,
    "tulevaisuuteen osoittava aikaleima (kellovirhe) ei ole laskentakelpoinen",
  );
}
