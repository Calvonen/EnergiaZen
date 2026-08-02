import {
  buildStaleReadingAlertEmail,
  computeReadingAgeMinutes,
  isReadingStale,
  shouldSendStaleAlert,
  staleReadingAlertThresholdMinutes,
} from "./alertLogic";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function runTankMonitorAlertLogicUnitTests() {
  const nowIso = "2026-08-02T12:00:00.000Z";

  assertEqual(
    computeReadingAgeMinutes(null, nowIso),
    null,
    "puuttuva aikaleima ei tuota ikää",
  );
  assertEqual(
    computeReadingAgeMinutes("not-a-date", nowIso),
    null,
    "virheellinen aikaleima ei tuota ikää",
  );
  assertEqual(
    computeReadingAgeMinutes("2026-08-02T11:29:00.000Z", nowIso),
    31,
    "ikä lasketaan minuutteina nykyhetkestä",
  );

  assertEqual(isReadingStale(null), true, "puuttuva ikä on vanhentunut");
  assertEqual(
    isReadingStale(staleReadingAlertThresholdMinutes),
    false,
    "kynnysarvo itsessään ei vielä ole vanhentunut",
  );
  assertEqual(
    isReadingStale(staleReadingAlertThresholdMinutes + 0.01),
    true,
    "kynnysarvon ylittävä ikä on vanhentunut",
  );

  assertEqual(
    shouldSendStaleAlert({ isStaleNow: true, wasStale: false }),
    true,
    "siirtymä terveestä vanhentuneeksi laukaisee hälytyksen",
  );
  assertEqual(
    shouldSendStaleAlert({ isStaleNow: true, wasStale: true }),
    false,
    "jo tiedossa oleva vika ei laukaise uutta hälytystä joka ajolla",
  );
  assertEqual(
    shouldSendStaleAlert({ isStaleNow: false, wasStale: true }),
    false,
    "palautuminen ei laukaise sähköpostia - se näkyy appin bannerista",
  );
  assertEqual(
    shouldSendStaleAlert({ isStaleNow: false, wasStale: false }),
    false,
    "terve tila ei koskaan laukaise hälytystä",
  );

  // Sisällön rakentaminen ei enää ota kantaa vastaanottajiin - jokainen
  // saa saman sisällön, mutta kukin lähetetään erikseen (index.ts) ettei
  // kukaan näe muiden osoitteita samassa to-kentässä.
  const email = buildStaleReadingAlertEmail({ ageMinutes: 45 });
  assertEqual(
    email.subject,
    "EnergyZen: varaajan mittaus ei toimi",
    "aihe kertoo suoraan mistä on kyse",
  );
  assertEqual(
    email.html.includes("45 minuuttia"),
    true,
    "viesti sisältää mittauksen iän",
  );

  const missingReadingEmail = buildStaleReadingAlertEmail({ ageMinutes: null });
  assertEqual(
    missingReadingEmail.html.includes("Mittausta ei löytynyt lainkaan"),
    true,
    "täysin puuttuva mittaus kerrotaan selkeästi eri tekstillä kuin vanhentunut",
  );
}
