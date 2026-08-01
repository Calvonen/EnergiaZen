import { defaultSettings } from "./settings";
import {
  formatWeeklyMinimumInletTemperatureLabel,
  getTemperatureCardTheme,
} from "./temperaturePresentation";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function themeFromAccents(accent: string, deepAccent: string) {
  return {
    accent,
    backgroundColor: `${accent}33`,
    borderColor: `${accent}b8`,
    shadowColor: deepAccent,
  };
}

export function runTemperaturePresentationUnitTests() {
  // defaultSettings: minTankTemperature 10, maxTankTemperature 70

  assertEqual(
    getTemperatureCardTheme(10, defaultSettings),
    themeFromAccents("#188bff", "#0b4f9f"),
    "minimilampotilassa teema on tarkalleen alkuvari",
  );
  assertEqual(
    getTemperatureCardTheme(9, defaultSettings),
    themeFromAccents("#188bff", "#0b4f9f"),
    "minimin alle menevä lampotila rajataan minimiin asti",
  );
  assertEqual(
    getTemperatureCardTheme(-50, defaultSettings),
    themeFromAccents("#188bff", "#0b4f9f"),
    "kaukana minimin alla oleva lampotila rajataan silti minimiin asti",
  );
  assertEqual(
    getTemperatureCardTheme(11, defaultSettings),
    themeFromAccents("#1c8afc", "#0d4e9d"),
    "juuri minimin ylapuolella teema on hyvin lahella alkuvaria",
  );
  assertEqual(
    getTemperatureCardTheme(40, defaultSettings),
    themeFromAccents("#8c65a3", "#4d325e"),
    "puolivalissa lampotila-asteikkoa teema on tasan puolivalissa vareja",
  );
  assertEqual(
    getTemperatureCardTheme(69, defaultSettings),
    themeFromAccents("#fb4049", "#8d161f"),
    "juuri maksimin alapuolella teema on hyvin lahella loppuvaria",
  );
  assertEqual(
    getTemperatureCardTheme(70, defaultSettings),
    themeFromAccents("#ff3f46", "#8f151d"),
    "maksimilampotilassa teema on tarkalleen loppuvari",
  );
  assertEqual(
    getTemperatureCardTheme(71, defaultSettings),
    themeFromAccents("#ff3f46", "#8f151d"),
    "maksimin yli menevä lampotila rajataan maksimiin asti",
  );
  assertEqual(
    getTemperatureCardTheme(200, defaultSettings),
    themeFromAccents("#ff3f46", "#8f151d"),
    "kaukana maksimin ylla oleva lampotila rajataan silti maksimiin asti",
  );

  assertEqual(
    formatWeeklyMinimumInletTemperatureLabel(null),
    "--",
    "puuttuva viikon tulovesiminimi näyttää placeholderin ilman astemerkkiä",
  );
  assertEqual(
    formatWeeklyMinimumInletTemperatureLabel(7.8),
    "8°",
    "viikon tulovesiminimi pyöristetään ja astemerkki lisätään",
  );
  assertEqual(
    formatWeeklyMinimumInletTemperatureLabel(16.4),
    "16°",
    "viikon tulovesiminimi pyöristetään alaspäin puolikkaan alle mennessä",
  );
  assertEqual(
    formatWeeklyMinimumInletTemperatureLabel(0),
    "0°",
    "arvo 0 ei saa näyttäytyä puuttuvana arvona",
  );
}
