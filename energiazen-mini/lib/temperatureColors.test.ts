import { defaultSettings } from "./settings";
import {
  clamp,
  getTemperatureBarSegmentColor,
  getTemperatureColor,
} from "./temperatureColors";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function runTemperatureColorsUnitTests() {
  assertEqual(clamp(5, 0, 10), 5, "clamp palauttaa arvon sellaisenaan valilla");
  assertEqual(clamp(-3, 0, 10), 0, "clamp rajaa alarajaan");
  assertEqual(clamp(42, 0, 10), 10, "clamp rajaa ylarajaan");

  // defaultSettings: minTankTemperature 10, maxTankTemperature 70
  // -> greenThreshold 30, orangeThreshold 50 (kolmasosat valista)
  assertEqual(
    getTemperatureColor(10, defaultSettings),
    "#188bff",
    "minimilampotilassa vari on asteikon alkuvari",
  );
  assertEqual(
    getTemperatureColor(-50, defaultSettings),
    "#188bff",
    "minimin alle menevä lampotila rajataan minimiin asti",
  );
  assertEqual(
    getTemperatureColor(70, defaultSettings),
    "#ff3f46",
    "maksimilampotilassa vari on asteikon loppuvari",
  );
  assertEqual(
    getTemperatureColor(200, defaultSettings),
    "#ff3f46",
    "maksimin yli menevä lampotila rajataan maksimiin asti",
  );
  assertEqual(
    getTemperatureColor(30, defaultSettings),
    "#26d9a2",
    "vihrean kynnysarvon kohdalla vari on tarkalleen vihrea",
  );
  assertEqual(
    getTemperatureColor(50, defaultSettings),
    "#ff9b30",
    "oranssin kynnysarvon kohdalla vari on tarkalleen oranssi",
  );
  assertEqual(
    getTemperatureColor(29, defaultSettings),
    "#25d5a7",
    "juuri vihrean kynnysarvon alapuolella varitys on siirtymassa oranssiin",
  );
  assertEqual(
    getTemperatureColor(31, defaultSettings),
    "#31d69c",
    "juuri vihrean kynnysarvon ylapuolella siirrytaan vihrea-oranssi-liukuun",
  );
  assertEqual(
    getTemperatureColor(51, defaultSettings),
    "#ff9631",
    "juuri oranssin kynnysarvon ylapuolella siirrytaan oranssi-puna-liukuun",
  );

  assertEqual(
    getTemperatureBarSegmentColor(0, 8, 65, 20, defaultSettings),
    getTemperatureColor(65, defaultSettings),
    "ensimmainen segmentti vastaa ylalampotilaa",
  );
  assertEqual(
    getTemperatureBarSegmentColor(7, 8, 65, 20, defaultSettings),
    getTemperatureColor(20, defaultSettings),
    "viimeinen segmentti vastaa alalampotilaa",
  );
  assertEqual(
    getTemperatureBarSegmentColor(0, 1, 65, 20, defaultSettings),
    getTemperatureColor(65, defaultSettings),
    "yhden segmentin palkki kayttaa ylalampotilaa",
  );
}
