import {
  getFallbackSettingsSummary,
  getShowerCalculationSummary,
  getTankSettingsSummary,
  getWarmWaterReserveSummary,
  isWarmWaterReserveSectionVisible,
  toggleExpandedSection,
} from "./settingsSectionSummaries";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function runSettingsSectionSummaryUnitTests() {
  assertEqual(
    getTankSettingsSummary({
      fullTankAverageTemperature: 70,
      maxTankTemperature: 70,
      tankSizeLiters: 290,
    }),
    "290 l · maksimi 70 °C · täysi keskilämpö 70 °C",
    "varaajan perusasetusten yhteenveto muodostetaan nykyarvoista",
  );
  assertEqual(
    getShowerCalculationSummary(6),
    "Täysi varaaja 6 suihkua",
    "suihkulaskennan yhteenveto muodostetaan nykyarvosta",
  );
  assertEqual(
    getWarmWaterReserveSummary({
      automaticMaxHeatingHours: 3,
      safetyShowerReserve: 2,
      targetShowerReserve: 4,
    }),
    "Tavoite 4 · turvaraja 2 · enintään 3 h",
    "lampimavesivarauksen yhteenveto muodostetaan nykyarvoista",
  );
  assertEqual(
    getFallbackSettingsSummary({ backupHours: [2, 3, 4], fallbackEnabled: false }),
    "Pois käytöstä",
    "pois kytketty varakaytto naytetaan yhteenvedossa",
  );
  assertEqual(
    getFallbackSettingsSummary({ backupHours: [2, 3, 4], fallbackEnabled: true }),
    "Käytössä · tunnit 02–03, 03–04 ja 04–05",
    "lyhyt varatuntilista naytetaan yhteenvedossa",
  );
  assertEqual(
    getFallbackSettingsSummary({
      backupHours: [1, 2, 3, 4, 5],
      fallbackEnabled: true,
    }),
    "Käytössä · 5 valittua tuntia",
    "pitka varatuntilista lyhennetaan lukumaaraksi",
  );
  assertEqual(
    isWarmWaterReserveSectionVisible("fixed"),
    false,
    "lampimavesivaraus piilotetaan kiinteassa tilassa",
  );

  const settings = { targetShowerReserve: 4 };
  const toggled = toggleExpandedSection(
    { fallback: false, tank: false },
    "tank",
  );

  assertEqual(
    toggled,
    { fallback: false, tank: true },
    "kortin avaustila vaihtuu",
  );
  assertEqual(
    settings,
    { targetShowerReserve: 4 },
    "kortin avaaminen ei muuta asetusarvoja",
  );
}
