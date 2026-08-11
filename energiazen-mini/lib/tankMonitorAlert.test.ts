import {
  computeTankReadingAgeMinutes,
  computeTankReadingUiAgeMinutes,
  isTankReadingStale,
  shouldShowTankMonitorFault,
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
    "yleinen ikälaskenta säilyttää tulevan aikaleiman kellovirheenä",
  );
  const slightlyFutureReadingAge = computeTankReadingUiAgeMinutes(
    "2026-08-02T12:00:15.000Z",
    now,
  );
  assertEqual(
    slightlyFutureReadingAge,
    0,
    "currentTime-tikkia hieman uudempi aikaleima rajataan nollaan",
  );
  assertEqual(
    isTankReadingStale(slightlyFutureReadingAge),
    false,
    "uuden Supabase-rivin ja currentTime-tikin valinen ero ei nayta banneria",
  );

  assertEqual(
    isTankReadingStale(null),
    true,
    "puuttuva ikä tulkitaan vanhentuneeksi",
  );
  assertEqual(
    isTankReadingStale(-1),
    true,
    "suoraan annettu negatiivinen ikä tulkitaan yhä virheelliseksi",
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
  assertEqual(
    shouldShowTankMonitorFault({
      ageMinutes: tankMonitorAlertThresholdMinutes + 1,
      hasInitialFetchSettled: false,
      isFocusRefreshPending: true,
      isResumeRefreshPending: false,
    }),
    false,
    "vanha valimuistilukema ei nayta varoitusta ensimmaisen haun aikana",
  );
  assertEqual(
    shouldShowTankMonitorFault({
      ageMinutes: 0,
      hasInitialFetchSettled: true,
      isFocusRefreshPending: false,
      isResumeRefreshPending: false,
    }),
    false,
    "tuoreeksi paivittynyt lukema ei nayta varoitusta haun valmistuttua",
  );
  assertEqual(
    shouldShowTankMonitorFault({
      ageMinutes: tankMonitorAlertThresholdMinutes + 1,
      hasInitialFetchSettled: true,
      isFocusRefreshPending: false,
      isResumeRefreshPending: true,
    }),
    false,
    "vanhaa valimuistilukemaa ei nayteta vikana paluupaivityksen aikana",
  );
  assertEqual(
    shouldShowTankMonitorFault({
      ageMinutes: tankMonitorAlertThresholdMinutes + 1,
      hasInitialFetchSettled: true,
      isFocusRefreshPending: false,
      isResumeRefreshPending: false,
    }),
    true,
    "vanha lukema naytetaan vikana kun paluupaivitys on valmistunut",
  );
  assertEqual(
    shouldShowTankMonitorFault({
      ageMinutes: tankMonitorAlertThresholdMinutes + 1,
      hasInitialFetchSettled: true,
      isFocusRefreshPending: true,
      isResumeRefreshPending: false,
    }),
    false,
    "vanha cached lukema ei nayta varoitusta uuden focus-refreshin aikana",
  );
  assertEqual(
    shouldShowTankMonitorFault({
      ageMinutes: tankMonitorAlertThresholdMinutes + 1,
      hasInitialFetchSettled: true,
      isFocusRefreshPending: false,
      isResumeRefreshPending: false,
    }),
    true,
    "stale lukema nayttaa varoituksen focus-refreshin valmistuttua",
  );
}
