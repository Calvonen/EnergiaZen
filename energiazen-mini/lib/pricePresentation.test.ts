import { getPriceTheme } from "./pricePresentation";

function assertEqual(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

export function runPricePresentationUnitTests() {
  assertEqual(
    getPriceTheme(-5),
    { ringColor: "#72ff9d" },
    "negatiivinen hinta kuuluu halvimpaan vyohykkeeseen",
  );
  assertEqual(
    getPriceTheme(0),
    { ringColor: "#72ff9d" },
    "nollahinta kuuluu halvimpaan vyohykkeeseen",
  );
  assertEqual(
    getPriceTheme(3),
    { ringColor: "#72ff9d" },
    "raja-arvo 3 kuuluu viela halvimpaan vyohykkeeseen",
  );
  assertEqual(
    getPriceTheme(3.01),
    { ringColor: "#36f4d4" },
    "juuri 3:n ylapuolella siirrytaan seuraavaan vyohykkeeseen",
  );
  assertEqual(
    getPriceTheme(8),
    { ringColor: "#36f4d4" },
    "raja-arvo 8 kuuluu viela toiseen vyohykkeeseen",
  );
  assertEqual(
    getPriceTheme(8.01),
    { ringColor: "#ffad4d" },
    "juuri 8:n ylapuolella siirrytaan kolmanteen vyohykkeeseen",
  );
  assertEqual(
    getPriceTheme(14.99),
    { ringColor: "#ffad4d" },
    "juuri alle 15 kuuluu viela kolmanteen vyohykkeeseen",
  );
  assertEqual(
    getPriceTheme(15),
    { ringColor: "#ff5f6d" },
    "raja-arvo 15 kuuluu jo kalleimpaan vyohykkeeseen",
  );
  assertEqual(
    getPriceTheme(20),
    { ringColor: "#ff5f6d" },
    "selvasti korkea hinta kuuluu kalleimpaan vyohykkeeseen",
  );
}
