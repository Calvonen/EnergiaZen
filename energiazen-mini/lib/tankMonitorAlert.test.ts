import {
  computeTankReadingAgeMinutes,
  isTankReadingStale,
  tankMonitorAlertThresholdMinutes,
} from "./tankMonitorAlert";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function runTankMonitorAlertUnitTests() {
  const now = new Date("2026-08-02T12:00:00.000Z");

  assertEqual(
    computeTankReadingAgeMinutes(null, now),
    null,
    "puuttuva aikaleima ei tuota ikää",
  );
  assertEqual(
    computeTankReadingAgeMinutes("not-a-date", now),
    null,
    "virheellinen aikaleima ei tuota ikää",
  );
  assertEqual(
    computeTankReadingAgeMinutes("2026-08-02T11:55:00.000Z", now),
    5,
    "ikä lasketaan minuutteina nykyhetkestä",
  );
  assertEqual(
    computeTankReadingAgeMinutes("2026-08-02T12:05:00.000Z", now),
    -5,
    "tulevaisuudessa oleva aikaleima tuottaa negatiivisen iän",
  );

  assertEqual(
    isTankReadingStale(null),
    true,
    "puuttuva ikä tulkitaan vanhentuneeksi",
  );
  assertEqual(
    isTankReadingStale(-1),
    true,
    "negatiivinen ikä (kellovirhe) tulkitaan vanhentuneeksi",
  );
  assertEqual(
    isTankReadingStale(0),
    false,
    "juuri nyt saatu lukema ei ole vanhentunut",
  );
  assertEqual(
    isTankReadingStale(tankMonitorAlertThresholdMinutes),
    false,
    "kynnysarvo itsessään ei vielä ole vanhentunut",
  );
  assertEqual(
    isTankReadingStale(tankMonitorAlertThresholdMinutes + 0.01),
    true,
    "kynnysarvon ylittävä ikä on vanhentunut",
  );
}
