import { hexToRgb, mixColors, rgbToHex } from "./colorMixing";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function runColorMixingUnitTests() {
  assertEqual(
    hexToRgb("#188bff"),
    { r: 24, g: 139, b: 255 },
    "hexToRgb purkaa heksavarin kanavittain",
  );
  assertEqual(
    rgbToHex({ r: 24, g: 139, b: 255 }),
    "#188bff",
    "rgbToHex kokoaa kanavat takaisin heksamuotoon",
  );
  assertEqual(
    rgbToHex(hexToRgb("#188bff")),
    "#188bff",
    "hexToRgb ja rgbToHex ovat toistensa kaanteisfunktioita",
  );
  assertEqual(
    mixColors("#000000", "#ffffff", 0),
    "#000000",
    "mixColors palauttaa alkuvarin suhteella 0",
  );
  assertEqual(
    mixColors("#000000", "#ffffff", 1),
    "#ffffff",
    "mixColors palauttaa loppuvarin suhteella 1",
  );
  assertEqual(
    mixColors("#000000", "#ffffff", 0.5),
    "#808080",
    "mixColors sekoittaa varit suhteessa puolivalissa",
  );
}
